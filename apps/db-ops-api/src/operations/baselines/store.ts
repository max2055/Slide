import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import type { ActorContext } from '../../auth/actor-context.js';
import { freezeInvestigationCaller } from '../../investigations/authorization.js';
import { dbConnection } from '../../db-connection.js';
import { OutboxService } from '../../workflows/outbox-service.js';
import { OperationsAuthorization } from '../authorization.js';
import { operationsContentHash, OperationsError } from '../contracts.js';
import { operationsFlags, assertOperationsEnabled, type OperationsFlags } from '../feature-flags.js';
import { baselineInputSchema, formalBaselineSource, type BaselineInput, type BaselineSource } from './source-adapter.js';
import { BASELINE_METHOD, calculateBaseline, invalidateBaseline, type BaselineCalculation } from './calculator.js';

export interface StoredBaseline {
  schemaVersion: 1; id: string; version: number; contentHash: string; result: BaselineCalculation;
}
type Snapshot = { fence: string; targetVersion: string; targetSince: string | null; resourceVersion: number; collectionEnabled: boolean };
const decode = (v: unknown): any => typeof v === 'string' ? JSON.parse(v) : v;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const sqlDate = (value: string) => new Date(value);
const absent = () => new OperationsError('OPERATIONS_NOT_FOUND');
const targetSql = {
  instance: 'SELECT id,host,port,db_type,db_version,created_at,status FROM database_instances WHERE id=? FOR SHARE',
  server: 'SELECT id,host,port,host_key_fingerprint,created_at,collection_enabled FROM servers WHERE id=? FOR SHARE',
  network_device: 'SELECT id,host,snmp_port,serial_number,vendor,model,created_at,collection_enabled FROM network_devices WHERE id=? FOR SHARE',
} as const;

/** Immutable P01 rows, no metric observation/history tables of our own. New
 * calculations are opt-in; old records survive disable/rollback. The final
 * projection is delivered synchronously while current ACL/control locks hold. */
export class BaselineStore {
  constructor(private readonly poolProvider: () => Pool | null = () => dbConnection.getPool(),
    private readonly sourceProvider: (pool: Pool) => BaselineSource = formalBaselineSource,
    private readonly authorization: OperationsAuthorization = new OperationsAuthorization(),
    private readonly flags: () => Readonly<OperationsFlags> = operationsFlags,
    private readonly clock = () => new Date()) {}

  private async transaction<T>(work: (c: PoolConnection, pool: Pool) => Promise<T>): Promise<T> {
    const pool = this.poolProvider(); if (!pool) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
    const c = await pool.getConnection();
    try {
      await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await c.beginTransaction();
      // Same serialization boundary as integrated metrics control. All slow
      // source IO runs outside these short snapshot/append transactions.
      const [lock] = await c.execute<RowDataPacket[]>('SELECT id FROM metric_policy_lock WHERE id=1 FOR UPDATE');
      if (lock.length !== 1) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
      const value = await work(c, pool); await c.commit(); return value;
    } catch (error) { await c.rollback(); throw error; }
    finally { c.release(); }
  }

  private async snapshot(c: PoolConnection, actor: ActorContext, input: BaselineInput): Promise<Snapshot> {
    await this.authorization.authorize(c as never, actor, [input.resource], 'context:read');
    const [target] = await c.execute<RowDataPacket[]>(targetSql[input.resource.type], [input.resource.id]);
    if (target.length !== 1) throw absent();
    const [binding] = await c.execute<RowDataPacket[]>('SELECT group_id,payload,capabilities FROM metric_policy_bindings WHERE resource_key=? FOR SHARE', [`${input.resource.type}:${input.resource.id}`]);
    const [groups] = binding[0]?.group_id ? await c.execute<RowDataPacket[]>('SELECT payload FROM metric_policy_groups WHERE id=? FOR SHARE', [binding[0].group_id]) : [[]];
    const [rollout] = await c.execute<RowDataPacket[]>(`SELECT series_hash,source,generation,read_mode,published_revision,applied_revision,package_pin,latest_payload
      FROM metric_rollout WHERE resource_type=? AND resource_id=? ORDER BY series_hash FOR SHARE`, [input.resource.type, String(input.resource.id)]);
    const { status, collection_enabled, ...identity } = target[0];
    const targetVersion = operationsContentHash(plain(identity));
    const [history] = await c.execute<RowDataPacket[]>(`SELECT reference_bands FROM behavior_baseline_versions
      WHERE resource_type=? AND resource_id=?
      ORDER BY CAST(reference_bands->>'$.resourceVersion' AS UNSIGNED) DESC,created_at DESC,version DESC,id LIMIT 1 FOR SHARE`, [input.resource.type, input.resource.id]);
    const previous = history[0] ? decode(history[0].reference_bands) : null;
    const targetSince = previous && previous.targetVersion !== targetVersion ? this.clock().toISOString() : previous?.targetSince ?? null;
    // Per-id versions and millisecond timestamps cannot order different metric
    // series. The shared control lock serializes this persisted resource order;
    // legacy envelopes without it precede all newly appended versions.
    return { targetVersion, targetSince, resourceVersion: Number(previous?.resourceVersion ?? 0),
      collectionEnabled: input.resource.type === 'instance' ? status === 'active' : Boolean(collection_enabled),
      fence: operationsContentHash(plain({ target, binding, groups, rollout })) };
  }

  async compute(caller: ActorContext, raw: unknown, deliver?: (value: StoredBaseline) => void): Promise<StoredBaseline> {
    const parsed = baselineInputSchema.safeParse(raw); if (!parsed.success) throw new OperationsError('OPERATIONS_INPUT_INVALID');
    const input = parsed.data, actor = freezeInvestigationCaller(caller);
    assertOperationsEnabled(this.flags(), 'baselines');
    const before = await this.transaction(c => this.snapshot(c, actor, input));
    const pool = this.poolProvider(); if (!pool) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
    const source = await this.sourceProvider(pool).load(actor, input, before.fence, before.targetVersion);
    let result = calculateBaseline(input, source);
    if (!before.collectionEnabled) result = invalidateBaseline(result, 'resource_collection_disabled');
    if (before.targetSince && Date.parse(source.from) < Date.parse(before.targetSince)) result = invalidateBaseline(result, 'resource_changed_reaccumulating');
    const committed = await this.transaction(async c => {
      const final = await this.snapshot(c, actor, input);
      assertOperationsEnabled(this.flags(), 'baselines');
      // There may be no historical row at all on the first computation. Carry
      // the observed identity transition into the durable envelope regardless.
      if (before.targetVersion !== final.targetVersion) final.targetSince = new Date(Math.max(
        +this.clock(), Date.parse(before.targetSince ?? '') || 0, Date.parse(final.targetSince ?? '') || 0)).toISOString();
      // Other computations can commit a boundary during source IO, including
      // A -> B -> A where the final target/fence equals the original again.
      if (final.targetSince && Date.parse(source.from) < Date.parse(final.targetSince)) result = invalidateBaseline(result, 'resource_changed_reaccumulating');
      if (before.fence !== final.fence) result = invalidateBaseline(result, 'source_configuration_changed');
      if (!final.collectionEnabled) result = invalidateBaseline(result, 'resource_collection_disabled');
      if ((result.status === 'known' || result.staticComparison.status === 'known') && Date.parse(result.validUntil) <= +this.clock()) result = invalidateBaseline(result, 'expired');
      const id = operationsContentHash(input);
      const [versions] = await c.execute<RowDataPacket[]>('SELECT version FROM behavior_baseline_versions WHERE id=? ORDER BY version DESC LIMIT 1 FOR UPDATE', [id]);
      const version = Number(versions[0]?.version ?? 0) + 1;
      const resourceVersion = final.resourceVersion + 1;
      if (!Number.isSafeInteger(version) || !Number.isSafeInteger(resourceVersion)) throw new OperationsError('OPERATIONS_VERSION_CONFLICT');
      const contentHash = operationsContentHash({ input, result, version });
      const stored: StoredBaseline = { schemaVersion: 1, id, version, contentHash, result };
      await c.execute(`INSERT INTO behavior_baseline_versions(id,version,resource_type,resource_id,series_hash,series_identity,
        method_version,content_hash,state,reason,training_from,training_until,validation_from,validation_until,quality,reference_bands)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, version, input.resource.type, input.resource.id,
        result.seriesHash ?? operationsContentHash([input.resource, input.metric, input.dimensions]), JSON.stringify(result.series),
        result.methodVersion, contentHash, result.state, result.reason, sqlDate(result.training.from), sqlDate(result.training.until),
        sqlDate(result.validation.from), sqlDate(result.validation.until), JSON.stringify(result.quality),
        JSON.stringify({ input, stored, targetVersion: final.targetVersion, targetSince: final.targetSince, resourceVersion })]);
      await new OutboxService({ getConnection: async () => c as never }).append(c as never, {
        eventType: 'operations.baseline.versioned', schemaVersion: 1, aggregateType: 'behavior_baseline', aggregateId: id,
        aggregateVersion: version, idempotencyKey: `baseline:${id}:${version}`,
        payload: { schemaVersion: 1, eventId: randomUUID(), objectType: 'baseline', objectId: id, version,
          state: result.state, contentHash, occurredAt: this.clock().toISOString() },
      });
      await this.authorization.authorize(c as never, actor, [input.resource], 'context:read');
      assertOperationsEnabled(this.flags(), 'baselines');
      return stored;
    });
    // The append must commit before publishing success. Reacquire current ACL,
    // target/control locks for the exact committed version; a revoke, source
    // replacement or expiry during commit cannot authorize the response.
    return this.readCommitted(actor, committed.id, deliver, committed.version);
  }

  async read(caller: ActorContext, id: string, deliver?: (value: StoredBaseline) => void): Promise<StoredBaseline> {
    return this.readCommitted(caller, id, deliver);
  }

  private async readCommitted(caller: ActorContext, id: string, deliver?: (value: StoredBaseline) => void, version?: number): Promise<StoredBaseline> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new OperationsError('OPERATIONS_INPUT_INVALID');
    const actor = freezeInvestigationCaller(caller);
    return this.transaction(async c => {
      const [rows] = await c.execute<RowDataPacket[]>(`SELECT reference_bands FROM behavior_baseline_versions WHERE id=?${version === undefined ? '' : ' AND version=?'} ORDER BY version DESC LIMIT 1 FOR SHARE`, version === undefined ? [id] : [id, version]);
      if (!rows.length) throw absent();
      const envelope = decode(rows[0].reference_bands), input = baselineInputSchema.parse(envelope.input);
      const final = await this.snapshot(c, actor, input);
      const stored = envelope.stored as StoredBaseline;
      const reason = !final.collectionEnabled ? 'resource_collection_disabled'
        : stored.result.methodVersion !== BASELINE_METHOD ? 'method_changed'
        : stored.result.sourceFence !== final.fence ? 'source_configuration_changed'
        : final.targetSince && Date.parse(stored.result.training.from) < Date.parse(final.targetSince) ? 'resource_changed_reaccumulating'
        : !this.flags().baselines ? 'feature_disabled'
        : Date.parse(stored.result.validUntil) <= +this.clock() ? 'expired' : null;
      const value = reason ? { ...stored, result: invalidateBaseline(stored.result, reason) } : stored;
      await this.authorization.authorize(c as never, actor, [input.resource], 'context:read');
      // Authorization can await. Re-evaluate time and feature at send time.
      if ((value.result.status === 'known' || value.result.staticComparison.status === 'known') && (!this.flags().baselines || Date.parse(value.result.validUntil) <= +this.clock()))
        value.result = invalidateBaseline(value.result, this.flags().baselines ? 'expired' : 'feature_disabled');
      deliver?.(value); return value;
    });
  }
}
