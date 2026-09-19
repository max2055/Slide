import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { definitions, sample, identify } from '../../contracts/metrics-v2/fixtures.js';
import { MysqlMetricStorage } from '../storage.js';
import { MetricStorageAdapter } from '../compatibility.js';
import { RolloutControl, type Target } from './control.js';

const port = Number(process.env.METRICS_V2_TEST_MYSQL_PORT);
describe.skipIf(!port)('isolated formal rollout and alert replay', () => {
  let root: Pool, pool: Pool, control: RolloutControl, storage: MysqlMetricStorage;
  const database = `max76_${process.pid}`;
  const definition = definitions[0];
  const target: Target = { source: 'legacy', read: 'legacy', revision: 1,
    package: { id: 'fixture', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` } };
  const ticket = { source: 'legacy', generation: 1, revision: 1 };
  const observation = (seconds = 0, revision = 1) => identify({ ...sample(definition.id), resource_id: '1',
    observed_at: new Date(Date.parse('2026-09-01T00:01:00Z') + seconds * 1000).toISOString(),
    collected_at: new Date(Date.parse('2026-09-01T00:01:00Z') + seconds * 1000).toISOString(),
    stored_at: new Date(Date.parse('2026-09-01T00:01:00Z') + seconds * 1000).toISOString(),
    versions: { ...sample(definition.id).versions, config_revision: revision } });
  const series = observation();
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 24, timezone: '+05:30' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    await pool.query("INSERT INTO database_instances (id, name, db_type, host, port, username, password_encrypted) VALUES (1, 'isolated', 'mysql', '127.0.0.1', 33376, 'fixture', 'fixture')");
    control = new RolloutControl(pool); storage = new MysqlMetricStorage(pool);
  }, 120000);
  afterAll(async () => { await pool?.end(); if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); } });
  beforeEach(async () => {
    for (const table of ['metric_v2_alert_transitions', 'metric_v2_alert_state', 'alerts', 'metric_v2_rollout', 'metric_v2_publications', 'metric_v2_observations']) await pool.query(`DELETE FROM ${table}`);
    await control.initialize(series, target); await control.applied(series, ticket);
  });
  it('serializes competing switches, pending applied revision, late sources and rollback without deleting evidence', async () => {
    await control.publish(series, definition, ticket, async () => {});
    const next = { ...target, source: 'v2', read: 'v2' as const, revision: 2, package: { ...target.package, version: '2.0.0' } };
    const newer = (seconds: number) => identify({ ...observation(seconds, 2), versions: { ...observation(seconds, 2).versions, package_version: '2.0.0' } });
    const results = await Promise.allSettled([control.switch(series, 1, next), control.switch(series, 1, next)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await control.current(series)).toMatchObject({ generation: 2, applied: null });
    const v2 = { source: 'v2', generation: 2, revision: 2 };
    await expect(control.publish(newer(1), definition, v2)).rejects.toThrow('NOT_APPLIED');
    await expect(control.applied(series, ticket)).rejects.toThrow('STALE_SOURCE');
    await control.applied(series, v2);
    await expect(control.publish(observation(2), definition, ticket)).rejects.toThrow('STALE_SOURCE');
    await control.publish(newer(2), definition, v2);
    const before = await storage.range(series, '2026-09-01T00:00:00Z', '2026-09-01T00:02:00Z');
    await control.switch(series, 2, { ...target, revision: 3 });
    expect(await control.current(series)).toMatchObject({ package: target.package, revision: 3, read: 'legacy', generation: 3 });
    expect(await storage.range(series, '2026-09-01T00:00:00Z', '2026-09-01T00:02:00Z')).toEqual(before);
    expect(await control.latest(series, async () => ({ value: 12, observed_at: '2026-08-01T00:00:00Z' })))
      .toEqual({ value: 12, observed_at: '2026-08-01T00:00:00Z' });
  });
  it('shadow adapter never publishes or calls legacy writer; formal writes rollback together', async () => {
    let writes = 0;
    const adapter = new MetricStorageAdapter(storage, { read: 'v2', write: 'shadow' }, { control, ticket });
    await adapter.write(series, definition, async () => { writes++; });
    expect(writes).toBe(0); expect((await control.current(series)).latest).toBeNull();
    await expect(control.publish(observation(1), definition, ticket, async c => {
      await c.execute('UPDATE database_instances SET name = ? WHERE id = 1', ['must-rollback']); throw new Error('fault');
    })).rejects.toThrow('fault');
    expect((await storage.range(series, '2026-09-01T00:00:00Z', '2026-09-01T00:02:00Z'))).toHaveLength(1);
    const [rows] = await pool.query<RowDataPacket[]>('SELECT name FROM database_instances WHERE id = 1');
    expect(rows[0].name).toBe('isolated');
  });
  it('20 concurrent repeats create one real alert; recovery and old-window replay cannot refire', async () => {
    await control.publish(series, definition, ticket, async () => {});
    const input = { rule: 'rule-1', ruleVersion: '1', observationId: series.id, windowEnd: Date.parse(series.observed_at),
      state: 'firing' as const, value: 3600, title: 'isolated test', level: 'warning' as const };
    const result = await Promise.all(Array.from({ length: 20 }, () => control.transition(series, ticket, input)));
    expect(result.filter(Boolean)).toHaveLength(1);
    expect(await control.transition(series, ticket, { ...input, state: 'unknown', windowEnd: input.windowEnd + 1000 })).toBe(false);
    expect(await control.transition(series, ticket, { ...input, state: 'healthy', windowEnd: input.windowEnd + 2000 })).toBe(true);
    expect(await control.transition(series, ticket, input)).toBe(false);
    const [alerts] = await pool.query<RowDataPacket[]>('SELECT status FROM alerts');
    expect(alerts).toHaveLength(1); expect(alerts[0].status).toBe('resolved');
    const [transitions] = await pool.query<RowDataPacket[]>('SELECT * FROM metric_v2_alert_transitions');
    expect(transitions).toHaveLength(2);
  });
  it('rejects wrong revision and shadow evidence; rule versions have independent identities', async () => {
    await expect(control.publish(observation(0, 2), definition, ticket, async () => {})).rejects.toThrow('OBSERVATION_REVISION');
    await control.publish(series, definition, ticket, async () => {});
    const input = { rule: 'r', ruleVersion: '1', observationId: 'shadow', windowEnd: Date.parse(series.observed_at),
      state: 'firing' as const, value: 3600, title: 'isolated', level: 'warning' as const };
    await expect(control.transition(series, ticket, input)).rejects.toThrow('STALE_EVIDENCE');
    expect(await control.transition(series, ticket, { ...input, observationId: series.id })).toBe(true);
    expect(await control.transition(series, ticket, { ...input, observationId: series.id, ruleVersion: '2' })).toBe(true);
  });
  it('uses formal history and semantic evaluator; high shadow and missing quality cannot fire or recover', async () => {
    await control.switch(series, 1, { ...target, source: 'v2', read: 'v2', revision: 2 });
    const t = { source: 'v2', generation: 2, revision: 2 }; await control.applied(series, t);
    const o = observation(0, 2); await control.publish(o, definition, t);
    const shadow = identify({ ...observation(1, 2), value: { encoding: 'float64' as const, value: 9999 } });
    await storage.write(shadow, definition);
    const query = { definition, from: o.observed_at, to: '2026-09-01T00:01:02.000Z', now: '2026-09-01T00:01:02.000Z',
      interval_ms: 60000, max_gap_ms: 300000, stale_after_ms: 120000, mode: 'last' as const, space: 'none' as const };
    const policy = { metric_id: definition.id, unit: definition.unit, operator: '>' as const, threshold: 3000,
      duration_seconds: 0, recovery_seconds: 0 };
    const rule = { id: 'semantic-rule', version: '1', title: 'semantic alert', level: 'warning' as const };
    const result = await control.evaluate(o, t, query, policy, rule);
    expect(result).toMatchObject({ state: 'firing', value: 3600, transitioned: true });
    expect(await control.evaluate(o, t, query, policy, rule)).toMatchObject({ transitioned: false });
    const history = await control.range(o, query.from, query.to, async () => []);
    expect(history).toHaveLength(1);
    const missing = identify({ ...observation(3, 2), value: null,
      quality: { status: 'unknown' as const, reason: 'missing_input' as const } });
    await control.publish(missing, definition, t);
    expect(await control.evaluate(o, t, { ...query, from: missing.observed_at, to: '2026-09-01T00:01:04.000Z', now: '2026-09-01T00:01:04.000Z' }, policy, rule))
      .toMatchObject({ state: 'unknown', recovery: false, transitioned: false });
  });
  it('retention removes expired evidence/history, preserves watermark and rejects replay after ledger pruning', async () => {
    await control.publish(series, definition, ticket, async () => {});
    const input = { rule: 'retained', ruleVersion: '1', observationId: series.id, windowEnd: Date.parse(series.observed_at),
      state: 'firing' as const, value: 3600, title: 'retention', level: 'warning' as const };
    expect(await control.transition(series, ticket, input)).toBe(true);
    const future = () => new Date('2030-01-01T00:00:00Z');
    await new MysqlMetricStorage(pool, future).prune();
    const later = new RolloutControl(pool, undefined, future); await later.prune(); await later.prune();
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM metric_v2_publications'))[0]).toHaveLength(0);
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM metric_v2_alert_transitions'))[0]).toHaveLength(0);
    expect(await later.transition(series, ticket, input)).toBe(false);
  });
  it('alert write failure rolls back transition and state, permitting safe retry', async () => {
    const o = identify({ ...series, resource_id: '999999' });
    await control.initialize(o, target); await control.applied(o, ticket); await control.publish(o, definition, ticket, async () => {});
    await pool.query("CREATE TRIGGER max76_alert_fault BEFORE INSERT ON alerts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected alert failure'");
    try {
      await expect(control.transition(o, ticket, { rule: 'fault', ruleVersion: '1', observationId: o.id,
        windowEnd: Date.parse(o.observed_at), state: 'firing', value: 3600, title: 'fault', level: 'warning' })).rejects.toThrow('ROLLOUT_ALERT_WRITE');
    } finally { await pool.query('DROP TRIGGER max76_alert_fault'); }
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM metric_v2_alert_transitions'))[0]).toHaveLength(0);
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM metric_v2_alert_state'))[0]).toHaveLength(0);
  });
});
