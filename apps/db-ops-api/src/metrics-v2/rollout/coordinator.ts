import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { RefSchema, refKey, type Ref } from '../policy/model.js';
import { rolloutAlertLockName } from './alert-publication-fence.js';

const PackagePinSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
const ActorSchema = z.strictObject({
  userId: z.number().int().nonnegative(),
  requestId: z.string().min(1).max(128),
});
const ShadowGateSchema = z.strictObject({
  sample_count: z.number().int().positive(),
  source_conflicts: z.number().int().nonnegative(),
  duplicate_formal_writes: z.number().int().nonnegative(),
  duplicate_alerts: z.number().int().nonnegative(),
  value_mismatches: z.number().int().nonnegative(),
  unit_mismatches: z.number().int().nonnegative(),
  dimension_mismatches: z.number().int().nonnegative(),
  quality_mismatches: z.number().int().nonnegative(),
  freshness_mismatches: z.number().int().nonnegative(),
  missing_mismatches: z.number().int().nonnegative(),
  derived_mismatches: z.number().int().nonnegative(),
  performance_regressions: z.number().int().nonnegative(),
});
const CasSchema = z.strictObject({
  expected_revision: z.number().int().positive(),
  expected_generation: z.number().int().positive(),
});
const CutoverSchema = z.strictObject({
  expected_shadow_revision: z.number().int().positive(),
  expected_generation: z.number().int().positive(),
});

type Actor = z.infer<typeof ActorSchema>;
type ShadowGate = z.infer<typeof ShadowGateSchema>;
type Phase = 'shadow' | 'cutover_pending' | 'v2' | 'legacy';
type PublishedPolicy = {
  binding: { resource: Ref; package: z.infer<typeof PackagePinSchema>; revision: number };
};

export type RolloutResourceStatus = {
  phase: Phase;
  revision: number;
  generation: number;
  series_count: number;
  applied_series: number;
  gate: ShadowGate | null;
};

const decode = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) : value;
function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}

export class MysqlRolloutCoordinator {
  constructor(private readonly pool: Pool) {}

  private async lock(connection: PoolConnection): Promise<void> {
    const [rows] = await connection.execute<RowDataPacket[]>('SELECT id FROM metric_v2_policy_lock WHERE id = 1 FOR UPDATE');
    check(rows.length === 1, 'ROLLOUT_LOCK_UNAVAILABLE');
  }

  private async transaction<T>(run: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await this.lock(connection);
      const result = await run(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  private async fencedTransaction<T>(ref: Ref, run: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    const held: string[] = [];
    let started = false;
    try {
      const [series] = await connection.execute<RowDataPacket[]>(
        'SELECT series_hash FROM metric_v2_rollout WHERE resource_type = ? AND resource_id = ? ORDER BY series_hash',
        [ref.type, String(ref.id)],
      );
      check(series.length > 0, 'ROLLOUT_NOT_REGISTERED');
      for (const row of series) {
        const name = rolloutAlertLockName(String(row.series_hash));
        const [lock] = await connection.execute<RowDataPacket[]>('SELECT GET_LOCK(?, 10) AS acquired', [name]);
        check(Number(lock[0]?.acquired) === 1, 'ROLLOUT_ALERT_FENCE_UNAVAILABLE');
        held.push(name);
      }
      await connection.beginTransaction();
      started = true;
      await this.lock(connection);
      const result = await run(connection);
      await connection.commit();
      started = false;
      return result;
    } catch (error) {
      if (started) await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      let reusable = true;
      for (const name of held.reverse()) {
        try {
          const [rows] = await connection.execute<RowDataPacket[]>('SELECT RELEASE_LOCK(?) AS released', [name]);
          if (Number(rows[0]?.released) !== 1) reusable = false;
        } catch {
          reusable = false;
        }
      }
      if (reusable) connection.release();
      else connection.destroy();
    }
  }

  private async policy(connection: PoolConnection, ref: Ref): Promise<PublishedPolicy> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT payload FROM metric_v2_policy_bindings WHERE resource_key = ? FOR UPDATE',
      [refKey(ref)],
    );
    check(rows[0], 'ROLLOUT_POLICY_NOT_FOUND');
    const published = decode<PublishedPolicy>(rows[0].payload);
    const resource = RefSchema.parse(published.binding.resource);
    check(refKey(resource) === refKey(ref), 'ROLLOUT_POLICY_IDENTITY');
    PackagePinSchema.parse(published.binding.package);
    check(Number.isSafeInteger(published.binding.revision) && published.binding.revision > 0, 'ROLLOUT_POLICY_REVISION');
    return published;
  }

  private async resource(connection: PoolConnection, ref: Ref, lock = false): Promise<RowDataPacket> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT * FROM metric_v2_rollout_resources WHERE resource_key = ?${lock ? ' FOR UPDATE' : ''}`,
      [refKey(ref)],
    );
    check(rows[0], 'ROLLOUT_RESOURCE_NOT_FOUND');
    return rows[0];
  }

  private async event(connection: PoolConnection, ref: Ref, action: string, revision: number,
    generation: number, actor: Actor, evidence: unknown): Promise<void> {
    await connection.execute(`INSERT INTO metric_v2_rollout_events
      (resource_key, action, revision, generation, actor_id, request_id, evidence) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [refKey(ref), action, revision, generation, actor.userId, actor.requestId, JSON.stringify(evidence)]);
  }

  async startShadow(input: Ref, expectedRevision: number, actorInput: Actor): Promise<RolloutResourceStatus> {
    const ref = RefSchema.parse(input);
    const actor = ActorSchema.parse(actorInput);
    check(Number.isSafeInteger(expectedRevision) && expectedRevision > 0, 'ROLLOUT_REVISION');
    await this.transaction(async connection => {
      const published = await this.policy(connection, ref);
      check(published.binding.revision === expectedRevision, 'ROLLOUT_POLICY_REVISION_CONFLICT');
      const [existing] = await connection.execute<RowDataPacket[]>(
        'SELECT phase, revision FROM metric_v2_rollout_resources WHERE resource_key = ? FOR UPDATE', [refKey(ref)],
      );
      if (existing.length) {
        check(existing[0].phase === 'shadow' && Number(existing[0].revision) === expectedRevision, 'ROLLOUT_PHASE_CONFLICT');
        return;
      }
      const [series] = await connection.execute<RowDataPacket[]>(`SELECT DISTINCT series_hash
        FROM metric_v2_observations WHERE stage = 'normalized' AND payload IS NOT NULL
        AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.resource_type')) = ?
        AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.resource_id')) = ?
        AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.versions.package_id')) = ?
        AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.versions.package_version')) = ?
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.versions.config_revision')) AS UNSIGNED) = ?
        ORDER BY series_hash`, [ref.type, String(ref.id), published.binding.package.id,
        published.binding.package.version, expectedRevision]);
      check(series.length > 0, 'ROLLOUT_SHADOW_EMPTY');
      for (const row of series) {
        await connection.execute(`INSERT INTO metric_v2_rollout
          (series_hash, source, generation, read_mode, package_pin, published_revision, applied_revision, resource_type, resource_id)
          VALUES (?, 'legacy', 1, 'legacy', ?, ?, ?, ?, ?)`, [row.series_hash,
          JSON.stringify(published.binding.package), expectedRevision, expectedRevision, ref.type, String(ref.id)]);
      }
      await connection.execute(`INSERT INTO metric_v2_rollout_resources
        (resource_key, resource_type, resource_id, phase, revision, generation, gate_json, actor_id, request_id)
        VALUES (?, ?, ?, 'shadow', ?, 1, NULL, ?, ?)`,
      [refKey(ref), ref.type, String(ref.id), expectedRevision, actor.userId, actor.requestId]);
      await this.event(connection, ref, 'shadow_started', expectedRevision, 1, actor, { series_count: series.length });
    });
    return this.status(ref);
  }

  async acceptShadow(input: Ref, expectedRevision: number, gateInput: ShadowGate, actorInput: Actor): Promise<RolloutResourceStatus> {
    const ref = RefSchema.parse(input);
    const actor = ActorSchema.parse(actorInput);
    const gate = ShadowGateSchema.parse(gateInput);
    const failures = Object.entries(gate).filter(([key, value]) => key !== 'sample_count' && value !== 0);
    check(failures.length === 0, 'ROLLOUT_SHADOW_GATE_FAILED');
    await this.transaction(async connection => {
      const resource = await this.resource(connection, ref, true);
      check(resource.phase === 'shadow' && Number(resource.revision) === expectedRevision, 'ROLLOUT_PHASE_CONFLICT');
      await connection.execute(`UPDATE metric_v2_rollout_resources SET gate_json = ?, actor_id = ?, request_id = ?
        WHERE resource_key = ?`, [JSON.stringify(gate), actor.userId, actor.requestId, refKey(ref)]);
      await this.event(connection, ref, 'shadow_accepted', expectedRevision, Number(resource.generation), actor, gate);
    });
    return this.status(ref);
  }

  async cutover(input: Ref, requestInput: z.infer<typeof CutoverSchema>, actorInput: Actor): Promise<RolloutResourceStatus> {
    const ref = RefSchema.parse(input);
    const request = CutoverSchema.parse(requestInput);
    const actor = ActorSchema.parse(actorInput);
    await this.fencedTransaction(ref, async connection => {
      const published = await this.policy(connection, ref);
      const resource = await this.resource(connection, ref, true);
      check(resource.phase === 'shadow' && Number(resource.revision) === request.expected_shadow_revision
        && Number(resource.generation) === request.expected_generation, 'ROLLOUT_CAS_CONFLICT');
      check(resource.gate_json, 'ROLLOUT_SHADOW_GATE_REQUIRED');
      check(published.binding.revision > request.expected_shadow_revision, 'ROLLOUT_REVISION_MUST_INCREASE');
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT * FROM metric_v2_rollout
        WHERE resource_type = ? AND resource_id = ? ORDER BY series_hash FOR UPDATE`, [ref.type, String(ref.id)]);
      check(rows.length > 0 && rows.every(row => row.source === 'legacy' && row.read_mode === 'legacy'
        && Number(row.applied_revision) === Number(row.published_revision)
        && Number(row.generation) === request.expected_generation), 'ROLLOUT_CAS_CONFLICT');
      const oldPin = JSON.stringify(decode(rows[0].package_pin));
      check(rows.every(row => JSON.stringify(decode(row.package_pin)) === oldPin)
        && oldPin === JSON.stringify(published.binding.package), 'ROLLOUT_PACKAGE_CHANGED');
      const generation = request.expected_generation + 1;
      await connection.execute(`UPDATE metric_v2_rollout SET source = 'v2', read_mode = 'v2', generation = ?,
        package_pin = ?, published_revision = ?, applied_revision = NULL
        WHERE resource_type = ? AND resource_id = ?`, [generation, JSON.stringify(published.binding.package),
        published.binding.revision, ref.type, String(ref.id)]);
      await connection.execute(`UPDATE metric_v2_rollout_resources SET phase = 'cutover_pending', revision = ?, generation = ?,
        actor_id = ?, request_id = ? WHERE resource_key = ?`, [published.binding.revision, generation,
        actor.userId, actor.requestId, refKey(ref)]);
      await this.event(connection, ref, 'cutover_started', published.binding.revision, generation, actor,
        { shadow_revision: request.expected_shadow_revision, series_count: rows.length, gate: decode(resource.gate_json) });
    });
    return this.status(ref);
  }

  async confirmApplied(input: Ref, expectedRevision: number, actorInput: Actor): Promise<RolloutResourceStatus> {
    const ref = RefSchema.parse(input);
    const actor = ActorSchema.parse(actorInput);
    await this.transaction(async connection => {
      const resource = await this.resource(connection, ref, true);
      check(resource.phase === 'cutover_pending' && Number(resource.revision) === expectedRevision, 'ROLLOUT_PHASE_CONFLICT');
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT source, read_mode, published_revision, applied_revision, generation
        FROM metric_v2_rollout WHERE resource_type = ? AND resource_id = ? ORDER BY series_hash FOR UPDATE`,
      [ref.type, String(ref.id)]);
      check(rows.length > 0 && rows.every(row => row.source === 'v2' && row.read_mode === 'v2'
        && Number(row.published_revision) === expectedRevision && Number(row.applied_revision) === expectedRevision
        && Number(row.generation) === Number(resource.generation)), 'ROLLOUT_NOT_APPLIED');
      await connection.execute(`UPDATE metric_v2_rollout_resources SET phase = 'v2', actor_id = ?, request_id = ?
        WHERE resource_key = ?`, [actor.userId, actor.requestId, refKey(ref)]);
      await this.event(connection, ref, 'cutover_applied', expectedRevision, Number(resource.generation), actor,
        { series_count: rows.length });
    });
    return this.status(ref);
  }

  async rollback(input: Ref, requestInput: z.infer<typeof CasSchema>, actorInput: Actor): Promise<RolloutResourceStatus> {
    const ref = RefSchema.parse(input);
    const request = CasSchema.parse(requestInput);
    const actor = ActorSchema.parse(actorInput);
    await this.fencedTransaction(ref, async connection => {
      const published = await this.policy(connection, ref);
      const resource = await this.resource(connection, ref, true);
      check(['v2', 'cutover_pending'].includes(String(resource.phase))
        && Number(resource.revision) === request.expected_revision
        && Number(resource.generation) === request.expected_generation, 'ROLLOUT_CAS_CONFLICT');
      check(published.binding.revision > request.expected_revision, 'ROLLOUT_REVISION_MUST_INCREASE');
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT generation FROM metric_v2_rollout
        WHERE resource_type = ? AND resource_id = ? ORDER BY series_hash FOR UPDATE`, [ref.type, String(ref.id)]);
      check(rows.length > 0 && rows.every(row => Number(row.generation) === request.expected_generation), 'ROLLOUT_CAS_CONFLICT');
      const generation = request.expected_generation + 1;
      await connection.execute(`UPDATE metric_v2_rollout SET source = 'legacy', read_mode = 'legacy', generation = ?,
        package_pin = ?, published_revision = ?, applied_revision = ?
        WHERE resource_type = ? AND resource_id = ?`, [generation, JSON.stringify(published.binding.package),
        published.binding.revision, published.binding.revision, ref.type, String(ref.id)]);
      await connection.execute(`UPDATE metric_v2_rollout_resources SET phase = 'legacy', revision = ?, generation = ?,
        gate_json = NULL, actor_id = ?, request_id = ? WHERE resource_key = ?`, [published.binding.revision,
        generation, actor.userId, actor.requestId, refKey(ref)]);
      await this.event(connection, ref, 'rollback_applied', published.binding.revision, generation, actor,
        { previous_revision: request.expected_revision, series_count: rows.length, history_preserved: true });
    });
    return this.status(ref);
  }

  async collectionEnabled(input: Ref): Promise<boolean> {
    const ref = RefSchema.parse(input);
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT phase FROM metric_v2_rollout_resources WHERE resource_key = ?', [refKey(ref)],
    );
    return rows[0]?.phase !== 'legacy';
  }

  async status(input: Ref): Promise<RolloutResourceStatus> {
    const ref = RefSchema.parse(input);
    const [resources] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM metric_v2_rollout_resources WHERE resource_key = ?', [refKey(ref)],
    );
    check(resources[0], 'ROLLOUT_RESOURCE_NOT_FOUND');
    const resource = resources[0];
    const [counts] = await this.pool.execute<RowDataPacket[]>(`SELECT COUNT(*) AS series_count,
      SUM(applied_revision = published_revision) AS applied_series,
      MIN(generation) AS min_generation, MAX(generation) AS max_generation,
      MIN(published_revision) AS min_revision, MAX(published_revision) AS max_revision
      FROM metric_v2_rollout WHERE resource_type = ? AND resource_id = ?`, [ref.type, String(ref.id)]);
    const count = counts[0];
    check(Number(count.series_count) > 0
      && Number(count.min_generation) === Number(count.max_generation)
      && Number(count.min_revision) === Number(count.max_revision), 'ROLLOUT_RESOURCE_MIXED');
    return {
      phase: resource.phase as Phase,
      revision: Number(resource.revision),
      generation: Number(resource.generation),
      series_count: Number(count.series_count),
      applied_series: Number(count.applied_series),
      gate: resource.gate_json ? ShadowGateSchema.parse(decode(resource.gate_json)) : null,
    };
  }
}
