import mysql, { type Pool } from 'mysql2/promise';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { identify, sample } from '../../contracts/metrics/fixtures.js';
import type { MetricDefinition, NormalizedObservation } from '../../contracts/metrics/index.js';
import { seriesHash } from '../storage.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin } from '../policy/test-support.js';
import { MetricConsumerService, type ConsumerStore } from '../consumers/service.js';
import { registerMetricConsumerRoutes } from '../consumers/routes.js';
import { RolloutControl } from './control.js';
import { MysqlFormalMetricStore } from './formal-store.js';

// Isolated disposable MySQL on a non-3306 port; never the shared application schema.
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const MINUTE = 60_000, DAY = 86_400_000;
const ref = { type: 'instance' as const, id: 1 };

describe.skipIf(!port)('formal 24h history window over MySQL and the real HTTP entry', () => {
  const database = `max240_history_${process.pid}`;
  let root: Pool, pool: Pool, control: RolloutControl, formal: MysqlFormalMetricStore;
  let consumer: MetricConsumerService, app: ReturnType<typeof Fastify>, base: string;
  let actor = admin;
  let definition: MetricDefinition, series: { resource_type: 'instance'; resource_id: string;
    metric: { id: string; semantic_version: string }; dimensions: Record<string, string> };
  let from = 0, to = 0;
  const seeded: NormalizedObservation[] = [], excluded: NormalizedObservation[] = [];
  const inventory = () => ({ type: 'instance' as const, id: '1', attributes: {
    'db.engine': { value: 'mysql', observed_at: new Date().toISOString(), source: 'fixture' },
    'db.version': { value: '9.6.0', observed_at: new Date().toISOString(), source: 'fixture' } } });
  const iso = (ms: number) => new Date(ms).toISOString();
  const sqlTime = (value: string) => new Date(value).toISOString().slice(0, 23).replace('T', ' ');
  const fixture = sample('db.uptime_seconds');
  const observation = (ms: number, value: number, tag: string, overrides: Partial<NormalizedObservation> = {}) =>
    identify({ ...fixture, resource_id: '1', observed_at: iso(ms), collected_at: iso(ms), stored_at: iso(ms),
      value: { encoding: 'float64', value }, source: { ...fixture.source, attempt_id: `history-window-${tag}` }, ...overrides });

  const seed = async (rows: NormalizedObservation[], options: { publication?: 'current' | 'old-generation' | 'none' } = {}) => {
    const publication = options.publication ?? 'current';
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      await pool.query(`INSERT INTO metric_observations
        (id, series_hash, stage, observed_at, stored_at, valid_value, payload, payload_hash, evidence_expires_at)
        VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,NULL)').join(',')}`,
      chunk.flatMap(o => [o.id, seriesHash(o), o.stage, sqlTime(o.observed_at), sqlTime(o.stored_at!), 1,
        JSON.stringify(o), 'fixture']));
      if (publication === 'none') continue;
      await pool.query(`INSERT INTO metric_publications (observation_id, series_hash, generation, observed_at)
        VALUES ${chunk.map(() => '(?,?,?,?)').join(',')}`,
      chunk.flatMap(o => [o.id, seriesHash(o), publication === 'current' ? 1 : 0, sqlTime(o.observed_at)]));
    }
  };

  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    // Non-UTC session timezone proves SQL DATETIME handling does not shift the window.
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, timezone: '+05:30', connectionLimit: 10 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    const registry = createConfigurationRegistry();
    const policy = new PolicyService(new MysqlPolicyStore(() => pool), registry,
      { exists: async () => true, inventory: async () => inventory() });
    const pin = registry.list().find(r => r.package.id === 'mysql-basic' && r.package.version === '2.0.0')!.package;
    await policy.changeBinding(admin, ref, { expected_revision: 0,
      package: { id: pin.id, version: pin.version, digest: pin.digest },
      overrides: { interval_ms: { mode: 'set', value: 60_000 }, timeout_ms: { mode: 'set', value: 5000 } } }, true);
    const store: ConsumerStore = {
      readWindow: (...args) => formal.readWindow(...args),
      queryWindow: (...args) => formal.queryWindow(...args),
      dimensions: (...args) => formal.dimensions(...args),
      inventory: async () => inventory(),
      attempts: async () => [],
    };
    consumer = new MetricConsumerService(policy, registry, store);
    formal = new MysqlFormalMetricStore(pool);
    control = new RolloutControl(pool);
    definition = (await consumer.discover(admin, ref)).definitions.find(d => d.id === 'db.uptime_seconds')!;
    series = { resource_type: 'instance', resource_id: '1',
      metric: { id: definition.id, semantic_version: definition.semantic_version }, dimensions: {} };
    await control.initialize(series, { source: 'semantic', read: 'semantic', revision: 1,
      package: { id: pin.id, version: pin.version, digest: pin.digest } });
    await control.applied(series, { source: 'semantic', generation: 1, revision: 1 });

    to = Math.floor(Date.now() / MINUTE) * MINUTE; from = to - DAY;
    for (let i = 0; i < 1440; i++) {
      if (i === 1400 || i === 1401) continue; // retained gap, never zero-filled
      seeded.push(observation(from + i * MINUTE, i === 720 ? 999_999 : i % 41, `m${i}`));
    }
    // Duplicate timestamp straddling the 1,000-row page boundary; one deterministic survivor in a bucket.
    seeded.push(observation(from + 999 * MINUTE, 7, 'dup'));
    // A second semantic version, an unaccepted shadow sample, a rolled-back generation and a
    // stale configuration revision must stay outside the formal read.
    excluded.push(observation(from + 500 * MINUTE, 111, 'shadow'));
    excluded.push(observation(from + 501 * MINUTE, 222, 'rev2', { versions: { ...fixture.versions, config_revision: 2 } }));
    excluded.push(observation(from + 502 * MINUTE, 333, 'generation0'));
    excluded.push(observation(from + 503 * MINUTE, 444, 'version2', { metric: { id: 'db.uptime_seconds', semantic_version: '2.0.0' } }));
    const prior = observation(from - MINUTE, 5, 'prior'), next = observation(to, 6, 'next');
    await seed(seeded);
    await seed([excluded[0]], { publication: 'none' });
    await seed([excluded[1], excluded[3]]);
    await seed([excluded[2]], { publication: 'old-generation' });
    await seed([prior, next]);

    app = Fastify();
    await registerMetricConsumerRoutes(app, async request => { (request as unknown as { user: typeof admin }).user = actor; }, consumer);
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
  });

  const query = (overrides: Record<string, unknown> = {}) => ({ resource: ref, metric_ids: ['db.uptime_seconds'],
    from: iso(from), to: iso(to), bucket_ms: MINUTE, ...overrides });
  const request = async (body: unknown) => {
    const response = await fetch(`${base}/api/metrics/query`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };

  it('serves all 1,440 minute slots for 24h through the real HTTP entry', async () => {
    const started = performance.now();
    const result = await request(query());
    const elapsed = performance.now() - started;
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const buckets = result.body.metrics[0].series[0].buckets as any[];
    expect(buckets).toHaveLength(1440);
    expect(buckets[0].window).toEqual({ from: iso(from), to: iso(from + MINUTE) });
    expect(buckets.at(-1)!.window).toEqual({ from: iso(to - MINUTE), to: iso(to) });
    expect(buckets.reduce((n, b) => n + b.sample_count, 0)).toBe(1438);
    // Missing minutes are gaps, not zeroes; historical quality is not judged by age.
    expect(buckets[1400]).toMatchObject({ value: null, stats: null, coverage: 0, quality: { status: 'unknown', reason: 'missing_input' } });
    expect(buckets[1401]).toMatchObject({ value: null });
    expect(buckets[0]).toMatchObject({ quality: { status: 'good' }, accuracy: 'exact' });
    // The spike stays in the bucket envelope even though the consumer mode reports the last sample.
    expect(buckets[720]).toMatchObject({ value: { encoding: 'float64', value: 999_999 },
      stats: { count: 1, min: { value: 999_999 }, max: { value: 999_999 }, avg: { value: 999_999 } } });
    expect(buckets[500].value).toEqual({ encoding: 'float64', value: 500 % 41 });
    console.log(`[MAX240] 24h/1440 HTTP query ${elapsed.toFixed(0)}ms; buckets=${buckets.length}`);
    expect(elapsed).toBeLessThan(30_000);
  }, 120_000);

  it('reads the same complete window across different page boundaries with no duplicates or gaps', async () => {
    const all = await formal.readWindow(series, iso(from), iso(to));
    const ids = all.map(o => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    const expected = new Set([...seeded.map(o => o.id),
      observation(to, 6, 'next').id, observation(from - MINUTE, 5, 'prior').id]);
    expect(new Set(ids)).toEqual(expected);
    expect(ids.filter(id => id === observation(from + 999 * MINUTE, 7, 'dup').id)).toHaveLength(1);
    expect(all[0].observed_at).toBe(iso(from - MINUTE));
    expect(all.at(-1)!.observed_at).toBe(iso(to));
    const ordered = all.filter(o => Date.parse(o.observed_at) >= from && Date.parse(o.observed_at) < to)
      .map(o => `${o.observed_at}/${o.id}`);
    expect(ordered).toEqual([...ordered].sort());
    const smaller = new MysqlFormalMetricStore(pool, { page_rows: 97, max_rows: 50_000 });
    expect((await smaller.readWindow(series, iso(from), iso(to))).map(o => o.id)).toEqual(ids);
    const bounded = new MysqlFormalMetricStore(pool, { page_rows: 100, max_rows: 500 });
    await expect(bounded.readWindow(series, iso(from), iso(to))).rejects.toThrow('QUERY_LIMIT_EXCEEDED');
    expect(new Set(ids)).not.toContain(excluded[0].id);
    for (const hidden of excluded) expect(ids).not.toContain(hidden.id);
  }, 120_000);

  it('rejects a response larger than the bucket bound and a revoked reader', async () => {
    const tooFine = await request(query({ bucket_ms: 1000 }));
    expect(tooFine.status).toBe(400);
    expect(tooFine.body).toEqual({ error: 'QUERY_LIMIT_EXCEEDED' });
    actor = { ...admin, permissions: ['instance:view'], instanceScopes: {} };
    try {
      const denied = await request(query());
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({ error: 'POLICY_FORBIDDEN' });
    } finally { actor = admin; }
    expect((await request(query())).status).toBe(200);
  }, 120_000);
});
