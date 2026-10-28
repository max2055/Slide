import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { dbConnection } from '../../db-connection.js';
import { CapabilitySchema, TimestampSchema, type Capability } from '../../contracts/metrics/index.js';
import { BindingPersistenceError } from '../bindings/persistence-codec.js';
import { readLegacyPublished, TemplateBindingUnsupportedError } from '../bindings/package-reader.js';
import { type ApplyOperation, type Audit, type Group, type Published, type Ref, ConfigurationDigestSchema, OperationKeySchema, PolicyError, refKey, rule } from './model.js';
import { PolicyTemplateGateway, type PolicyTemplateGatewayOptions } from './template-gateway.js';

export interface PolicyTransaction {
  groups(): Promise<Group[]>;
  group(id: string): Promise<Group | null>;
  members(id: string): Promise<Published[]>;
  binding(ref: Ref): Promise<Published | null>;
  capabilities(ref: Ref): Promise<Capability[]>;
  saveCapabilities(ref: Ref, capabilities: Capability[]): Promise<void>;
  saveGroup(group: Group): Promise<void>;
  saveBinding(value: Published, resetCapabilities: boolean): Promise<void>;
  audit(value: Audit): Promise<void>;
  audits(target: string, requestId?: string): Promise<Audit[]>;
  applyOperation(operationKey: string): Promise<ApplyOperation | null>;
  saveApplyOperation(value: ApplyOperation): Promise<void>;
}
export interface PolicyStore { transaction<T>(fn: (tx: PolicyTransaction) => Promise<T>): Promise<T> }
const decode = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) : value;

/**
 * A legacy reader never casts a stored row straight to `Published`: the shared
 * fence rejects a template row and every corrupt/unknown payload. The policy
 * boundary keeps its existing error contract by mapping those stable codes.
 */
const storedPublished = (raw: unknown): Published => {
  try { return readLegacyPublished(raw); }
  catch (error) {
    if (error instanceof TemplateBindingUnsupportedError) throw new PolicyError('TEMPLATE_BINDING_UNSUPPORTED', 409);
    if (error instanceof BindingPersistenceError) throw new PolicyError('POLICY_BINDING_INVALID', 409);
    throw error;
  }
};

/**
 * Template operation audits carry the B2E operation identity and template pins;
 * a legacy `Audit` never does. The legacy audit reader refuses them explicitly
 * rather than casting them (or dropping them) as legacy configuration.
 */
const isTemplateAudit = (value: Record<string, unknown>): boolean =>
  ['candidate_digest', 'resolution_identity', 'dependency_digest', 'receipt_id', 'operation_key']
    .some(key => Object.hasOwn(value, key))
  || (typeof value.configuration === 'object' && value.configuration !== null
    && Object.hasOwn(value.configuration, 'template_pins'));

const storedAudit = (raw: unknown): Audit => {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { throw new PolicyError('POLICY_AUDIT_INVALID', 500); }
  }
  if (isTemplateAudit((parsed ?? {}) as Record<string, unknown>)) throw new PolicyError('TEMPLATE_BINDING_UNSUPPORTED', 409);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new PolicyError('POLICY_AUDIT_INVALID', 500);
  const value = parsed as Record<string, unknown>;
  if (typeof value.actor_id !== 'number' || typeof value.request_id !== 'string' || typeof value.target !== 'string'
    || typeof value.revision !== 'number' || typeof value.at !== 'string'
    || !['binding.publish', 'group.publish'].includes(String(value.action))) {
    throw new PolicyError('POLICY_AUDIT_INVALID', 500);
  }
  return value as unknown as Audit;
};

/**
 * One recorded client intent. The result is the exact publication response, so
 * a replay never recomputes a snapshot; its stored resources pass the same
 * shared fence as a stored binding.
 */
const storedApplyOperation = (raw: Record<string, unknown>): ApplyOperation => {
  const invalid = (): never => { throw new PolicyError('POLICY_OPERATION_INVALID', 500); };
  const key = OperationKeySchema.safeParse(raw.operation_key);
  const digest = ConfigurationDigestSchema.safeParse(raw.configuration_digest);
  const actorId = Number(raw.actor_id), target = Number(raw.target_revision);
  if (!key.success || !digest.success || typeof raw.resource_key !== 'string' || raw.resource_key.length === 0
    || typeof raw.committed_at !== 'string' || !Number.isSafeInteger(actorId) || actorId <= 0
    || !Number.isSafeInteger(target) || target <= 0) return invalid();
  let result: unknown;
  try { result = decode<unknown>(raw.result); } catch { return invalid(); }
  const envelope = z.object({ published: z.literal(true), resources: z.array(z.unknown()).length(1),
    affected_resources: z.number().int().nonnegative(), requests_per_hour_before: z.number(),
    requests_per_hour_after: z.number() }).safeParse(result);
  if (!envelope.success) return invalid();
  return { operation_key: key.data, resource_key: raw.resource_key, actor_id: actorId, target_revision: target,
    configuration_digest: digest.data, committed_at: raw.committed_at,
    result: { ...envelope.data, resources: envelope.data.resources.map(storedPublished) } };
};

// SQL already serializes all policy transactions on one row. Admit waiters
// before checkout so they cannot consume the connections the lock holder needs
// for inventory/authorization reads. Share admission across stores using a pool.
const admission = new WeakMap<Pool, { tail: Promise<void>; waiting: number }>();

/**
 * The store's admission queue, exported so the template gateway leases through
 * exactly the same gate instead of inventing a second pool or lock order.
 */
export async function withPolicyAdmission<T>(pool: Pool, run: () => Promise<T>): Promise<T> {
  const queue = admission.get(pool) ?? { tail: Promise.resolve(), waiting: 0 };
  rule(queue.waiting < 100, 'POLICY_STORE_UNAVAILABLE', 503);
  const previous = queue.tail;
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  queue.tail = turn;
  queue.waiting++;
  admission.set(pool, queue);
  await previous;
  queue.waiting--;
  try { return await run(); }
  finally {
    release();
    if (queue.tail === turn) admission.delete(pool);
  }
}

class MysqlTransaction implements PolicyTransaction {
  constructor(private readonly connection: PoolConnection) {}
  async groups(): Promise<Group[]> {
    const [rows] = await this.connection.execute<RowDataPacket[]>('SELECT payload FROM metric_policy_groups ORDER BY id');
    return rows.map(r => decode<Group>(r.payload));
  }
  private async rows(sql: string, values: string[]): Promise<RowDataPacket[]> {
    return (await this.connection.execute<RowDataPacket[]>(sql, values))[0];
  }
  async group(id: string): Promise<Group | null> {
    const rows = await this.rows('SELECT payload FROM metric_policy_groups WHERE id = ?', [id]);
    return rows[0] ? decode(rows[0].payload) : null;
  }
  async members(id: string): Promise<Published[]> {
    const rows = await this.rows('SELECT payload FROM metric_policy_bindings WHERE group_id = ? ORDER BY resource_key', [id]);
    return rows.map(r => storedPublished(decode(r.payload)));
  }
  async binding(ref: Ref): Promise<Published | null> {
    const rows = await this.rows('SELECT payload FROM metric_policy_bindings WHERE resource_key = ?', [refKey(ref)]);
    return rows[0] ? storedPublished(decode(rows[0].payload)) : null;
  }
  async capabilities(ref: Ref): Promise<Capability[]> {
    const rows = await this.rows('SELECT capabilities FROM metric_policy_bindings WHERE resource_key = ?', [refKey(ref)]);
    return rows[0] ? decode(rows[0].capabilities) : [];
  }
  async saveCapabilities(ref: Ref, capabilities: Capability[]): Promise<void> {
    await this.connection.execute('UPDATE metric_policy_bindings SET capabilities = ? WHERE resource_key = ?', [JSON.stringify(capabilities), refKey(ref)]);
  }
  async saveGroup(group: Group): Promise<void> {
    await this.connection.execute('INSERT INTO metric_policy_groups (id, payload) VALUES (?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)', [group.id, JSON.stringify(group)]);
  }
  async saveBinding(value: Published, resetCapabilities: boolean): Promise<void> {
    // The caller already read this row, but a template row must never be
    // overwritten even if a future caller skips that read: refuse under the row
    // lock before the single-package upsert.
    const existing = await this.rows('SELECT payload FROM metric_policy_bindings WHERE resource_key = ? FOR UPDATE', [refKey(value.binding.resource)]);
    if (existing[0]) storedPublished(decode(existing[0].payload));
    await this.connection.execute(`INSERT INTO metric_policy_bindings (resource_key, group_id, payload, capabilities) VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE group_id = VALUES(group_id), payload = VALUES(payload)`,
    [refKey(value.binding.resource), value.binding.group_id, JSON.stringify(value), '[]']);
    if (resetCapabilities) await this.connection.execute('UPDATE metric_policy_bindings SET capabilities = ? WHERE resource_key = ?', ['[]', refKey(value.binding.resource)]);
  }
  async audit(value: Audit): Promise<void> {
    await this.connection.execute('INSERT INTO metric_policy_audit (target, payload) VALUES (?, ?)', [value.target, JSON.stringify(value)]);
  }
  async audits(target: string, requestId?: string): Promise<Audit[]> {
    const rows = requestId === undefined
      ? await this.rows('SELECT payload FROM metric_policy_audit WHERE target = ? ORDER BY id DESC LIMIT 100', [target])
      : await this.rows("SELECT payload FROM metric_policy_audit WHERE target = ? AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.request_id')) = ? ORDER BY id DESC LIMIT 1", [target,requestId]);
    return rows.map(r => storedAudit(decode(r.payload)));
  }
  async applyOperation(operationKey: string): Promise<ApplyOperation | null> {
    const rows = await this.rows(`SELECT operation_key, resource_key, actor_id, target_revision, configuration_digest, result, committed_at
      FROM metric_policy_apply_operations WHERE operation_key = ?`, [operationKey]);
    return rows[0] ? storedApplyOperation(rows[0]) : null;
  }
  async saveApplyOperation(value: ApplyOperation): Promise<void> {
    await this.connection.execute(`INSERT INTO metric_policy_apply_operations
      (operation_key, resource_key, actor_id, target_revision, configuration_digest, result, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [value.operation_key, value.resource_key, value.actor_id,
      value.target_revision, value.configuration_digest, JSON.stringify(value.result), value.committed_at]);
  }
}

export class MysqlPolicyStore implements PolicyStore {
  private gateway: PolicyTemplateGateway | undefined;
  constructor(private readonly provider: () => Pool | null = () => dbConnection.getPool(),
    private readonly templateOptions?: PolicyTemplateGatewayOptions) {}
  async transaction<T>(fn: (tx: PolicyTransaction) => Promise<T>): Promise<T> {
    const pool = this.provider(); rule(pool, 'POLICY_STORE_UNAVAILABLE', 503);
    return withPolicyAdmission(pool, async () => {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [lock] = await connection.execute<RowDataPacket[]>('SELECT id FROM metric_policy_lock WHERE id = 1 FOR UPDATE');
        rule(lock.length === 1, 'POLICY_STORE_UNAVAILABLE', 503);
        const result = await fn(new MysqlTransaction(connection));
        await connection.commit();
        return result;
      } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
      finally { connection.release(); }
    });
  }

  /**
   * The explicit internal template entry owned by this store. It uses this store's
   * pool provider and admission queue; without the trusted factory/clock/registry
   * injected at construction it is a stable "unavailable", never a default host.
   */
  templateGateway(): PolicyTemplateGateway {
    this.gateway ??= new PolicyTemplateGateway({
      pool: this.provider,
      admission: withPolicyAdmission,
      ...(this.templateOptions ? { options: this.templateOptions } : {}),
    });
    return this.gateway;
  }

  /** Internal MAX-70 integration port. No HTTP route. Caller must authenticate/fence the worker. */
  async reportCapabilities(ref: Ref, revision: number, next: Capability[], failure: 'timeout' | null): Promise<void> {
    await this.transaction(async tx => {
      const current = await tx.binding(ref); rule(current, 'POLICY_NOT_FOUND', 404);
      rule(current.binding.revision === revision, 'POLICY_REVISION_CONFLICT', 409);
      const caps = retainCapabilities(await tx.capabilities(ref), next, failure);
      rule(caps.length <= current.resolved.metric_templates.length, 'POLICY_CAPABILITY_LIMIT');
      const identities = new Set<string>();
      for (const c of caps) {
        const identity = `${c.metric.id}@${c.metric.semantic_version}:${c.method}`;
        rule(!identities.has(identity), 'POLICY_CAPABILITY_DUPLICATE'); identities.add(identity);
        rule(c.resource_id === String(ref.id) && Date.parse(c.evaluated_at) < Date.parse(c.valid_until)
          && current.resolved.metric_templates.some(e => e.metric.id === c.metric.id && e.metric.semantic_version === c.metric.semantic_version && e.capability.method === c.method), 'POLICY_CAPABILITY_IDENTITY');
      }
      await tx.saveCapabilities(ref, caps);
    });
  }

  async reportApplied(ref: Ref, revision: number, at: string, status: 'applied' | 'failed'): Promise<void> {
    TimestampSchema.parse(at);
    await this.transaction(async tx => {
      const current = await tx.binding(ref); rule(current, 'POLICY_NOT_FOUND', 404);
      rule(revision === current.binding.revision, 'POLICY_REVISION_CONFLICT', 409);
      rule(status === 'applied' || status === 'failed', 'POLICY_APPLICATION_STATUS');
      rule(current.application.status !== 'applied' || status === 'applied', 'POLICY_APPLICATION_TRANSITION');
      rule(Date.parse(at) >= Date.parse(current.published_at)
        && (!current.application.reported_at || Date.parse(at) >= Date.parse(current.application.reported_at)), 'POLICY_APPLICATION_TIME');
      current.application = { applied_revision: status === 'applied' ? revision : current.application.applied_revision,
        reported_at: at, status, error_code: status === 'failed' ? 'apply_failed' : null };
      await tx.saveBinding(current, false);
    });
  }
}

/** Keep the last valid assessment on a one-shot timeout; never rewrite configuration as a side effect. */
export function retainCapabilities(previous: Capability[], next: Capability[], failure: 'timeout' | null): Capability[] {
  return (failure === 'timeout' ? previous : next).map(c => CapabilitySchema.parse(c));
}
