import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { dbConnection } from '../../db-connection.js';
import { CapabilitySchema, TimestampSchema, type Capability } from '../../contracts/metrics-v2/index.js';
import { type Audit, type Group, type Published, type Ref, refKey, rule } from './model.js';

export interface PolicyTransaction {
  group(id: string): Promise<Group | null>;
  members(id: string): Promise<Published[]>;
  binding(ref: Ref): Promise<Published | null>;
  capabilities(ref: Ref): Promise<Capability[]>;
  saveCapabilities(ref: Ref, capabilities: Capability[]): Promise<void>;
  saveGroup(group: Group): Promise<void>;
  saveBinding(value: Published, resetCapabilities: boolean): Promise<void>;
  audit(value: Audit): Promise<void>;
  audits(target: string): Promise<Audit[]>;
}
export interface PolicyStore { transaction<T>(fn: (tx: PolicyTransaction) => Promise<T>): Promise<T> }
const decode = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) : value;

class MysqlTransaction implements PolicyTransaction {
  constructor(private readonly connection: PoolConnection) {}
  private async rows(sql: string, values: string[]): Promise<RowDataPacket[]> {
    return (await this.connection.execute<RowDataPacket[]>(sql, values))[0];
  }
  async group(id: string): Promise<Group | null> {
    const rows = await this.rows('SELECT payload FROM metric_v2_policy_groups WHERE id = ?', [id]);
    return rows[0] ? decode(rows[0].payload) : null;
  }
  async members(id: string): Promise<Published[]> {
    const rows = await this.rows('SELECT payload FROM metric_v2_policy_bindings WHERE group_id = ? ORDER BY resource_key', [id]);
    return rows.map(r => decode<Published>(r.payload));
  }
  async binding(ref: Ref): Promise<Published | null> {
    const rows = await this.rows('SELECT payload FROM metric_v2_policy_bindings WHERE resource_key = ?', [refKey(ref)]);
    return rows[0] ? decode(rows[0].payload) : null;
  }
  async capabilities(ref: Ref): Promise<Capability[]> {
    const rows = await this.rows('SELECT capabilities FROM metric_v2_policy_bindings WHERE resource_key = ?', [refKey(ref)]);
    return rows[0] ? decode(rows[0].capabilities) : [];
  }
  async saveCapabilities(ref: Ref, capabilities: Capability[]): Promise<void> {
    await this.connection.execute('UPDATE metric_v2_policy_bindings SET capabilities = ? WHERE resource_key = ?', [JSON.stringify(capabilities), refKey(ref)]);
  }
  async saveGroup(group: Group): Promise<void> {
    await this.connection.execute('INSERT INTO metric_v2_policy_groups (id, payload) VALUES (?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)', [group.id, JSON.stringify(group)]);
  }
  async saveBinding(value: Published, resetCapabilities: boolean): Promise<void> {
    await this.connection.execute(`INSERT INTO metric_v2_policy_bindings (resource_key, group_id, payload, capabilities) VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE group_id = VALUES(group_id), payload = VALUES(payload)`,
    [refKey(value.binding.resource), value.binding.group_id, JSON.stringify(value), '[]']);
    if (resetCapabilities) await this.connection.execute('UPDATE metric_v2_policy_bindings SET capabilities = ? WHERE resource_key = ?', ['[]', refKey(value.binding.resource)]);
  }
  async audit(value: Audit): Promise<void> {
    await this.connection.execute('INSERT INTO metric_v2_policy_audit (target, payload) VALUES (?, ?)', [value.target, JSON.stringify(value)]);
  }
  async audits(target: string): Promise<Audit[]> {
    return (await this.rows('SELECT payload FROM metric_v2_policy_audit WHERE target = ? ORDER BY id DESC LIMIT 100', [target])).map(r => decode(r.payload));
  }
}

export class MysqlPolicyStore implements PolicyStore {
  constructor(private readonly provider: () => Pool | null = () => dbConnection.getPool()) {}
  async transaction<T>(fn: (tx: PolicyTransaction) => Promise<T>): Promise<T> {
    const pool = this.provider(); rule(pool, 'POLICY_STORE_UNAVAILABLE', 503);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [lock] = await connection.execute<RowDataPacket[]>('SELECT id FROM metric_v2_policy_lock WHERE id = 1 FOR UPDATE');
      rule(lock.length === 1, 'POLICY_STORE_UNAVAILABLE', 503);
      const result = await fn(new MysqlTransaction(connection));
      await connection.commit();
      return result;
    } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
    finally { connection.release(); }
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
