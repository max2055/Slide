import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { seriesHash, MysqlMetricStorage, type Series, type StoredObservation } from '../storage.js';
import type { MetricDefinition } from '../../contracts/metrics-v2/definitions.js';
import { validateObservation } from '../../contracts/metrics-v2/validation.js';
import { alertDatabaseService } from '../../alert-database-service.js';
import { SemanticQueryService, type SemanticQuery } from '../query.js';
import { evaluateMetric, type ConsumerAlertPolicy } from '../consumers/evaluation.js';
import type { NormalizedObservation } from '../../contracts/metrics-v2/observations.js';

const pin = z.strictObject({ id: z.string().min(1), version: z.string().min(1), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) });
const targetSchema = z.strictObject({ source: z.string().min(1).max(128), read: z.enum(['legacy', 'v2']),
  package: pin, revision: z.number().int().positive().max(2147483647) });
export type Target = z.infer<typeof targetSchema>;
export type Ticket = { source: string; generation: number; revision: number };
type Control = Target & { generation: number; applied: number | null; latest: StoredObservation | null };
const parse = (v: any) => typeof v === 'string' ? JSON.parse(v) : v;
const digest = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const sqlTime = (value: string) => new Date(value).toISOString().slice(0, 23).replace('T', ' ');
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }

/** Internal opt-in boundary. Caller authorizes the resource; no public route or production activation. */
export class RolloutControl {
  constructor(private readonly pool: Pool, private readonly connection?: PoolConnection, private readonly clock = () => new Date()) {}
  private async transaction<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
    if (this.connection) return fn(this.connection);
    const c = await this.pool.getConnection();
    try { await c.beginTransaction(); const value = await fn(c); await c.commit(); return value; }
    catch (e) { await c.rollback(); throw e; } finally { c.release(); }
  }
  private async row(c: Pool | PoolConnection, series: Series, lock = false): Promise<Control> {
    const [rows] = await c.execute<RowDataPacket[]>(`SELECT * FROM metric_v2_rollout WHERE series_hash = ?${lock ? ' FOR UPDATE' : ''}`, [seriesHash(series)]);
    check(rows[0], 'ROLLOUT_NOT_REGISTERED'); const r = rows[0];
    return { source: r.source, read: r.read_mode, package: parse(r.package_pin), revision: r.published_revision,
      generation: r.generation, applied: r.applied_revision, latest: parse(r.latest_payload) };
  }
  async initialize(series: Series, input: Target): Promise<void> {
    const t = targetSchema.parse(input);
    await this.pool.execute(`INSERT INTO metric_v2_rollout
      (series_hash, source, generation, read_mode, package_pin, published_revision, resource_type, resource_id) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
    [seriesHash(series), t.source, t.read, JSON.stringify(t.package), t.revision, series.resource_type, series.resource_id]);
  }
  current(series: Series): Promise<Control> { return this.row(this.pool, series); }
  /** Run after observation retention. Keeps one latest value and monotonic alert state per identity. */
  async prune(limit = 1000): Promise<void> {
    check(Number.isInteger(limit) && limit > 0 && limit <= 1000, 'ROLLOUT_PRUNE_LIMIT');
    await this.transaction(async c => {
      const [rows] = await c.query<RowDataPacket[]>(`SELECT p.observation_id FROM metric_v2_publications p
        LEFT JOIN metric_v2_observations o ON o.id = p.observation_id WHERE o.id IS NULL LIMIT ${limit}`);
      if (rows.length) await c.execute(`DELETE FROM metric_v2_publications WHERE observation_id IN (${rows.map(() => '?').join(',')})`, rows.map(r => r.observation_id));
      await c.execute(`DELETE FROM metric_v2_alert_transitions WHERE window_ms < ? LIMIT ${limit}`, [this.clock().getTime() - 30 * 86400000]);
    });
  }
  async switch(series: Series, expected: number, input: Target): Promise<number> {
    const t = targetSchema.parse(input);
    return this.transaction(async c => {
      const old = await this.row(c, series, true);
      check(old.generation === expected, 'ROLLOUT_CAS_CONFLICT');
      check(t.revision > old.revision, 'ROLLOUT_REVISION_MUST_INCREASE');
      await c.execute(`UPDATE metric_v2_rollout SET source = ?, generation = generation + 1,
        read_mode = ?, package_pin = ?, published_revision = ?, applied_revision = NULL WHERE series_hash = ?`,
      [t.source, t.read, JSON.stringify(t.package), t.revision, seriesHash(series)]);
      return old.generation + 1;
    });
  }
  private assertTicket(r: Control, t: Ticket, applied = true) {
    check(r.source === t.source && r.generation === t.generation && r.revision === t.revision, 'ROLLOUT_STALE_SOURCE');
    if (applied) check(r.applied === r.revision, 'ROLLOUT_NOT_APPLIED');
  }
  async applied(series: Series, ticket: Ticket): Promise<void> {
    await this.transaction(async c => { const r = await this.row(c, series, true); this.assertTicket(r, ticket, false);
      await c.execute('UPDATE metric_v2_rollout SET applied_revision = published_revision WHERE series_hash = ?', [seriesHash(series)]); });
  }
  /** Legacy writes must use this connection, so switch and publication cannot race. */
  async publish(observation: StoredObservation, definition: MetricDefinition, ticket: Ticket,
    legacyWrite?: (c: PoolConnection) => Promise<void>): Promise<void> {
    validateObservation(observation, definition);
    check(observation.stage === 'normalized', 'ROLLOUT_NORMALIZED_REQUIRED');
    await this.transaction(async c => {
      const r = await this.row(c, observation, true); this.assertTicket(r, ticket);
      check(observation.versions.config_revision === ticket.revision, 'ROLLOUT_OBSERVATION_REVISION');
      check(observation.versions.package_id === r.package.id && observation.versions.package_version === r.package.version, 'ROLLOUT_PACKAGE_MISMATCH');
      const storage = new MysqlMetricStorage(c as unknown as Pool, this.clock);
      await storage.write(observation, definition);
      await c.execute(`INSERT INTO metric_v2_publications (observation_id, series_hash, generation, observed_at)
        VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE observation_id = metric_v2_publications.observation_id`,
      [observation.id, seriesHash(observation), ticket.generation, sqlTime(observation.observed_at)]);
      // A delayed value from the current generation is evidence, not the latest formal value.
      if (r.latest && Date.parse(r.latest.observed_at) >= Date.parse(observation.observed_at)) return;
      if (r.read === 'legacy') { check(legacyWrite, 'ROLLOUT_LEGACY_WRITER_REQUIRED'); await legacyWrite(c); }
      await c.execute('UPDATE metric_v2_rollout SET latest_payload = ? WHERE series_hash = ?', [JSON.stringify(observation), seriesHash(observation)]);
    });
  }
  /** Read and switch are serialized, including the compatibility read callback. */
  async latest<T>(series: Series, legacyRead: (c: PoolConnection) => Promise<T>): Promise<T | StoredObservation | null> {
    return this.transaction(async c => { const r = await this.row(c, series, true);
      return r.read === 'legacy' ? legacyRead(c) : r.applied === r.revision && r.latest?.versions.config_revision === r.revision ? r.latest : null; });
  }
  private async formalWindow(c: PoolConnection, series: Series, from: string, to: string, limit = 1000): Promise<NormalizedObservation[]> {
    check(Number.isInteger(limit) && limit > 0 && limit <= 1000 && Date.parse(to) > Date.parse(from)
      && Date.parse(to) - Date.parse(from) <= 31 * 86400000, 'ROLLOUT_QUERY_RANGE');
    const base = `SELECT o.payload FROM metric_v2_publications p JOIN metric_v2_observations o ON o.id = p.observation_id
      WHERE p.series_hash = ? AND o.payload IS NOT NULL`;
    const [prior] = await c.query<RowDataPacket[]>(`${base} AND p.observed_at < ? ORDER BY p.observed_at DESC, p.observation_id DESC LIMIT 1`, [seriesHash(series), sqlTime(from)]);
    const [rows] = await c.query<RowDataPacket[]>(`${base} AND p.observed_at >= ? AND p.observed_at < ? ORDER BY p.observed_at, p.observation_id LIMIT ${limit + 1}`, [seriesHash(series), sqlTime(from), sqlTime(to)]);
    check(rows.length <= limit, 'ROLLOUT_QUERY_LIMIT');
    const [next] = await c.query<RowDataPacket[]>(`${base} AND p.observed_at >= ? ORDER BY p.observed_at, p.observation_id DESC LIMIT 1`, [seriesHash(series), sqlTime(to)]);
    return [...prior, ...rows, ...next].map(r => parse(r.payload));
  }
  async range<T>(series: Series, from: string, to: string, legacyRead: (c: PoolConnection) => Promise<T>, limit = 200) {
    return this.transaction(async c => {
      const r = await this.row(c, series, true);
      return r.read === 'legacy' ? legacyRead(c) : r.applied !== r.revision ? [] : (await this.formalWindow(c, series, from, to, limit))
        .filter(o => Date.parse(o.observed_at) >= Date.parse(from) && Date.parse(o.observed_at) < Date.parse(to));
    });
  }
  /** Evaluate only published evidence with the existing semantic/quality rules. */
  async evaluate(series: Series, ticket: Ticket, query: Omit<SemanticQuery, 'series'>, policy: ConsumerAlertPolicy,
    rule: { id: string; version: string; title: string; level: 'warning' | 'error' | 'critical' }) {
    const { buckets, latest } = await this.transaction(async c => {
      const r = await this.row(c, series, true); this.assertTicket(r, ticket);
      const queryService = new SemanticQueryService({ queryWindow: (s, from, to, limit) => this.formalWindow(c, s, from, to, limit),
        inventory: (...args) => new MysqlMetricStorage(c as unknown as Pool).inventory(...args) }, async () => true);
      return { latest: r.latest, buckets: await queryService.query({ ...query, series: [series] }) };
    });
    const result = evaluateMetric({ definition: query.definition, capability: null, enabled: true, state: 'available',
      attempt: null, series: [{ dimensions: series.dimensions, buckets }] }, policy);
    if (!latest || result.state !== 'firing' && !result.recovery) return { ...result, transitioned: false };
    const transitioned = await this.transition(series, ticket, { rule: rule.id, ruleVersion: rule.version,
      observationId: latest.id, windowEnd: Date.parse(query.to), state: result.state === 'firing' ? 'firing' : 'healthy',
      value: result.value, title: rule.title, level: rule.level });
    return { ...result, transitioned };
  }
  async transition(series: Series, ticket: Ticket, input: {
    rule: string; ruleVersion: string; windowEnd: number; state: 'firing' | 'healthy' | 'unknown';
    observationId: string; value: number | null; title: string; level: 'warning' | 'error' | 'critical';
  }): Promise<boolean> {
    check(input.rule.length > 0 && input.ruleVersion.length > 0 && Number.isSafeInteger(input.windowEnd), 'ROLLOUT_ALERT_IDENTITY');
    if (input.state === 'unknown') return false;
    check(input.value !== null && Number.isFinite(input.value), 'ROLLOUT_ALERT_VALUE');
    const identity = digest([seriesHash(series), input.rule, input.ruleVersion]);
    return this.transaction(async c => {
      const r = await this.row(c, series, true); this.assertTicket(r, ticket);
      check(r.latest && Date.parse(r.latest.observed_at) <= input.windowEnd, 'ROLLOUT_ALERT_EVIDENCE');
      check(r.latest.id === input.observationId, 'ROLLOUT_ALERT_STALE_EVIDENCE');
      check(r.latest.versions.config_revision === ticket.revision, 'ROLLOUT_ALERT_STALE_REVISION');
      if (r.latest.quality.status !== 'good' || r.latest.value === null) return false;
      await c.execute(`INSERT INTO metric_v2_alert_state (identity_hash, last_window_ms, state)
        VALUES (?, -1, 'healthy') ON DUPLICATE KEY UPDATE identity_hash = metric_v2_alert_state.identity_hash`, [identity]);
      const [rows] = await c.execute<RowDataPacket[]>('SELECT * FROM metric_v2_alert_state WHERE identity_hash = ? FOR UPDATE', [identity]);
      const old = rows[0];
      if (input.windowEnd <= Number(old.last_window_ms)) return false;
      let alertId = old.alert_id;
      const changed = old.state !== input.state;
      if (changed) {
        await c.execute(`INSERT INTO metric_v2_alert_transitions (transition_key, identity_hash, window_ms, state, evidence)
          VALUES (?, ?, ?, ?, ?)`, [digest([identity, input.windowEnd, input.state]), identity, input.windowEnd, input.state,
          JSON.stringify({ ...ticket, package: r.package, observation: r.latest!.id })]);
        if (input.state === 'firing') {
          const id = Number(series.resource_id);
          check(Number.isSafeInteger(id) && id > 0, 'ROLLOUT_ALERT_RESOURCE');
          const result = await alertDatabaseService.createAlert({
            target_type: series.resource_type, instance_id: series.resource_type === 'instance' ? id : undefined,
            server_id: series.resource_type === 'server' ? id : undefined,
            network_device_id: series.resource_type === 'network_device' ? id : undefined,
            alert_type: 'performance', level: input.level, title: input.title, message: input.title,
            metric_name: series.metric.id, metric_value: String(input.value), source: 'metrics-v2-rollout',
            tags: { rule_id: input.rule, rule_version: input.ruleVersion, dimensions: series.dimensions, ticket },
          }, c);
          check(result.success, 'ROLLOUT_ALERT_WRITE'); alertId = result.alertId;
        } else if (alertId) {
          const result = await alertDatabaseService.resolveAlert(alertId, undefined, c);
          check(result.success, 'ROLLOUT_ALERT_WRITE');
        }
      }
      await c.execute('UPDATE metric_v2_alert_state SET last_window_ms = ?, state = ?, alert_id = ? WHERE identity_hash = ?',
        [input.windowEnd, input.state, alertId ?? null, identity]);
      return changed;
    });
  }
}
