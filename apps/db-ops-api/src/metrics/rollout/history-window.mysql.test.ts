import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql, { type Pool } from 'mysql2/promise';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { identify, sample } from '../../contracts/metrics/fixtures.js';
import type { MetricDefinition, NormalizedObservation } from '../../contracts/metrics/index.js';
import { MysqlMetricStorage, seriesHash } from '../storage.js';
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
      readHistoryWindow: (...args) => formal.readHistoryWindow(...args),
      readHistoryChart: (...args) => formal.readHistoryChart(...args),
      latestObservations: (...args) => formal.latestObservations(...args),
      historyDimensions: (...args) => formal.historyDimensions(...args),
      readObservationPage: (...args) => formal.readObservationPage(...args),
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

  it('retains accepted history after configuration change, retirement and unbinding, while current reads and revoked actors stay fenced', async () => {
    const [bindings] = await pool.query<any[]>('SELECT * FROM metric_policy_bindings WHERE resource_key=?', ['instance:1']);
    const [rollout] = await pool.query<any[]>('SELECT * FROM metric_rollout WHERE series_hash=?', [seriesHash(series)]);
    await pool.execute('INSERT INTO metric_source_acceptance(resource_key,revision,generation,evidence) VALUES(?,1,1,?)',
      ['instance:1', JSON.stringify({ validation: 'controlled_read_fixture', sample_ids: seeded.map(o => o.id) })]);
    try {
      // Controlled persisted producer state only; no real target is disabled or unbound.
      await pool.execute("UPDATE metric_policy_bindings SET payload=JSON_SET(payload,'$.binding.overrides.enabled',CAST(? AS JSON)) WHERE resource_key=?",
        [JSON.stringify('disable'), 'instance:1']);
      const disabled = await request(query({ history: true }));
      expect(disabled.status).toBe(200);
      expect(disabled.body.metrics[0].state).toBe('disabled');
      expect(disabled.body.metrics[0].series[0].buckets).toHaveLength(1440);
      await pool.execute("UPDATE metric_rollout SET source='retired',read_mode='pending',generation=2,published_revision=2,applied_revision=NULL WHERE series_hash=?", [seriesHash(series)]);
      await pool.execute('DELETE FROM metric_policy_bindings WHERE resource_key=?', ['instance:1']);
      expect(await formal.readWindow(series, iso(from), iso(to))).toEqual([]);
      const result = await request(query({ history: true }));
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.metrics[0].state).toBe('not_covered');
      const buckets = result.body.metrics[0].series[0].buckets;
      expect(buckets).toHaveLength(1440);
      expect(buckets[720].stats.max.value).toBe(999999);
      expect(buckets[1400].value).toBeNull();
      const raw = await formal.readObservationPage(series, iso(from), iso(to), { limit: 1000, after: null });
      expect(raw.total).toBe(seeded.length);
      expect(raw.observations.every(o => !excluded.some(e => e.id === o.id))).toBe(true);
      actor = { ...admin, permissions: ['instance:view'], instanceScopes: {} };
      expect((await request(query({ history: true }))).status).toBe(403);
      actor = admin;
      // A new display label / package version never enters the series identity.
      expect(seriesHash({ ...series, label: 'renamed', package_version: '9.0.0' } as any)).toBe(seriesHash(series));
    } finally {
      actor = admin;
      await pool.execute('DELETE FROM metric_source_acceptance WHERE resource_key=?', ['instance:1']);
      await pool.execute('DELETE FROM metric_policy_bindings WHERE resource_key=?', ['instance:1']);
      await pool.execute('INSERT INTO metric_policy_bindings(resource_key,group_id,payload,capabilities) VALUES(?,?,?,?)',
        [bindings[0].resource_key, bindings[0].group_id, JSON.stringify(bindings[0].payload), JSON.stringify(bindings[0].capabilities)]);
      await pool.execute('UPDATE metric_rollout SET source=?,read_mode=?,generation=?,published_revision=?,applied_revision=? WHERE series_hash=?',
        [rollout[0].source,rollout[0].read_mode,rollout[0].generation,rollout[0].published_revision,rollout[0].applied_revision,seriesHash(series)]);
    }
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

  it('joins pruned trends and recent details through the chart route without filling gaps or raw tables', async () => {
    const hour = 60 * MINUTE, old = Math.floor((to - 70 * DAY) / hour) * hour;
    const earlier = [observation(old, 5, 'retained-1'), observation(old + MINUTE, 17, 'retained-2')];
    const late = observation(old + 8 * MINUTE, 29, 'detail-in-same-hour', { stored_at: iso(from) });
    await seed([...earlier, late]);
    expect(await new MysqlMetricStorage(pool).prune()).toMatchObject({ normalized: 2 });

    const wide = { resource: ref, series: { metric: series.metric, dimensions: {} }, history: true,
      include_retained_trends: true, from: iso(old), to: iso(to), bucket_ms: hour };
    const chart = await request(wide);
    expect(chart.status, JSON.stringify(chart.body)).toBe(200);
    const buckets = chart.body.metrics[0].series[0].buckets;
    expect(buckets[0]).toMatchObject({ value: { value: 17 }, retained_sample_count: 2, sample_count: 3,
      stats: { min: { value: 5 }, max: { value: 29 }, count: 3 } });
    expect(buckets[0].sources.map((source: { id: string }) => source.id)).toEqual([late.id]);
    expect(buckets[1]).toMatchObject({ value: null, sample_count: 0 });
    expect(buckets.at(-1).value).not.toBeNull();
    expect(buckets.at(-1)).not.toHaveProperty('retained_sample_count');

    // An idempotent replay can restore a normalized row while its receipt and publication still exist.
    await seed([earlier[1]], { publication: 'none' });
    try {
      expect((await request(wide)).body.metrics[0].series[0].buckets[0]).toMatchObject({
        retained_sample_count: 2, sample_count: 3, stats: { count: 3 },
      });
      const clipped = await request({ ...wide, from: iso(old + 30_000) });
      expect(clipped.body.metrics[0].series[0].buckets[0]).toMatchObject({
        sample_count: 2, stats: { count: 2, min: { value: 17 }, max: { value: 29 } },
      });
    } finally {
      await pool.execute('DELETE FROM metric_observations WHERE id=?', [earlier[1].id]);
    }

    const rawBody = { resource: ref, metric: series.metric, dimensions: {}, from: iso(old), to: iso(old + hour) };
    const raw = await app.inject({ method: 'POST', url: '/api/metrics/observations', payload: rawBody });
    expect(raw.statusCode).toBe(200);
    expect(raw.json()).toMatchObject({ total: 1, observations: [{ value: { value: 29 } }] });
    const assessment = await app.inject({ method: 'POST', url: '/api/metrics/evaluate', payload: { query: wide, policies: [] } });
    expect(assessment.statusCode).toBe(400);

    const partial = observation(old + 2 * MINUTE, 41, 'partial-replay', { quality: { status: 'partial', reason: 'partial_input' } });
    await seed([partial]);
    expect(await new MysqlMetricStorage(pool).prune(1)).toMatchObject({ normalized: 1 });
    const changed = { ...earlier[0], value: { encoding: 'float64' as const, value: 80 }, quality: partial.quality };
    await seed([changed], { publication: 'none' });
    try {
      const replayed = (await request(wide)).body.metrics[0].series[0].buckets[0];
      expect(replayed.stats).toMatchObject({ count: 3, max: { value: 29 }, avg: { value: 17 } });
      expect(replayed.sources).not.toContainEqual(expect.objectContaining({ id: changed.id }));
    } finally {
      await pool.execute('DELETE FROM metric_observations WHERE id=?', [changed.id]);
    }
    await seed([partial], { publication: 'none' });
    try {
      const replayed = (await request(wide)).body.metrics[0].series[0].buckets[0];
      expect(replayed).toMatchObject({ retained_sample_count: 2, sample_count: 4,
        stats: { count: 4, min: { value: 5 }, max: { value: 41 }, avg: { value: 23 } } });
      expect(replayed.sources).toEqual(expect.arrayContaining([expect.objectContaining({ id: partial.id })]));
    } finally {
      await pool.execute('DELETE FROM metric_observations WHERE id=?', [partial.id]);
    }

    const failed = observation(old + 10 * MINUTE, 0, 'failed-replay',
      { value: null, accuracy: 'unknown', quality: { status: 'unknown', reason: 'source_error' } });
    await seed([failed]);
    expect(await new MysqlMetricStorage(pool).prune(1)).toMatchObject({ normalized: 1 });
    await seed([failed], { publication: 'none' });
    try {
      const replayed = (await request(wide)).body.metrics[0].series[0].buckets[0];
      expect(replayed).toMatchObject({ value: null, quality: { reason: 'source_error' }, stats: { count: 3, avg: { value: 17 } },
        sources: [expect.objectContaining({ id: failed.id })] });
    } finally {
      await pool.execute('DELETE FROM metric_observations WHERE id=?', [failed.id]);
    }

    await pool.execute('INSERT INTO metric_item_retention(resource_key,metric_key,history_ms,trends_ms) VALUES(?,?,NULL,0)',
      ['instance:1', `${series.metric.id}@${series.metric.semantic_version}`]);
    try {
      const disabled = await request(wide);
      expect(disabled.status).toBe(200);
      expect(disabled.body.metrics[0].series[0].buckets[0]).toMatchObject({ sample_count: 1, value: { value: 29 } });
      expect(disabled.body.metrics[0].series[0].buckets[0]).not.toHaveProperty('retained_sample_count');
    } finally {
      await pool.execute('DELETE FROM metric_item_retention WHERE resource_key=?', ['instance:1']);
    }
    actor = { ...admin, permissions: ['instance:view'], instanceScopes: {} };
    try { expect((await request(wide)).status).toBe(403); } finally { actor = admin; }
  }, 120_000);

  it('independent review: uses still-present trend inputs across the item cutoff and the pruning commit', async () => {
    const hour = 60 * MINUTE, old = Math.floor((to - 71 * DAY) / hour) * hour;
    const rows = [observation(old + MINUTE, 8, 'cutoff-1'), observation(old + 2 * MINUTE, 16, 'cutoff-2')];
    await seed(rows);
    const key = `${series.metric.id}@${series.metric.semantic_version}`;
    await pool.execute('INSERT INTO metric_item_retention(resource_key,metric_key,history_ms,trends_ms) VALUES(?,?,?,?)',
      ['instance:1', key, 30 * DAY, 90 * DAY]);
    const chart = { resource: ref, series: { metric: series.metric, dimensions: {} }, history: true,
      include_retained_trends: true, from: iso(old + 30_000), to: iso(old + hour), bucket_ms: hour };
    const read = async () => {
      const result = await request(chart);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      return result.body.metrics[0].series[0].buckets[0];
    };
    const expected = { value: { value: 12 }, sample_count: 2, retained_sample_count: 2, sources: [],
      stats: { count: 2, min: { value: 8 }, max: { value: 16 } } };
    try {
      expect(await read()).toMatchObject(expected);
      const raw = await app.inject({ method: 'POST', url: '/api/metrics/observations', payload: {
        resource: ref, metric: series.metric, dimensions: {}, from: chart.from, to: chart.to,
      } });
      expect(raw.json()).toMatchObject({ total: 0, observations: [] });
      let enterPrune!: () => void, releasePrune!: () => void;
      const entered = new Promise<void>(resolve => { enterPrune = resolve; });
      const release = new Promise<void>(resolve => { releasePrune = resolve; });
      const prune = new MysqlMetricStorage(pool).prune(2, async (_connection, phase) => {
        if (phase === 'commit') { enterPrune(); await release; }
      });
      try {
        await Promise.race([entered, prune.then(() => { throw new Error('Expected a paused pruning transaction'); })]);
        // The HTTP catalog takes the policy lock. Exercise the reader directly while pruning's writes are uncommitted.
        const snapshot = await formal.readHistoryChart(series, chart.from, chart.to, new Date());
        expect(snapshot).toMatchObject({ points: [], retained: [], trendOnly: rows.map(row => ({ id: row.id })) });
      } finally { releasePrune(); }
      expect(await prune).toMatchObject({ normalized: 2 });
      expect(await read()).toMatchObject(expected);
      const [receipts] = await pool.query<any[]>('SELECT COUNT(*) AS total FROM metric_trend_receipts WHERE observation_id IN (?,?)',
        rows.map(row => row.id));
      expect(Number(receipts[0].total)).toBe(2);

      // Reproduce a bucket written by the old bounded cleanup, before it marked incomplete statistics.
      await pool.execute('DELETE FROM metric_trend_receipts WHERE observation_id=?', [rows[0].id]);
      await seed([rows[0]], { publication: 'none' });
      expect(await read()).toMatchObject({ sample_count: 1, value: { value: 8 }, stats: { count: 1 } });
      await pool.execute('DELETE FROM metric_observations WHERE id=?', [rows[0].id]);
      await pool.execute('INSERT INTO metric_trend_receipts(observation_id,series_hash,bucket_ms,value_class) VALUES(?,?,?,?)',
        [rows[0].id, seriesHash(series), old, 'float64']);

      // The first bounded batch hides the bucket. Subsequent batches finish cleanup even after re-enabling trends.
      await pool.execute('UPDATE metric_item_retention SET trends_ms=0 WHERE resource_key=? AND metric_key=?', ['instance:1', key]);
      expect(await new MysqlMetricStorage(pool).prune(1)).toMatchObject({ retainedTrends: 0, trendReceipts: 1 });
      await pool.execute('UPDATE metric_item_retention SET history_ms=NULL, trends_ms=? WHERE resource_key=? AND metric_key=?',
        [90 * DAY, 'instance:1', key]);
      await seed([rows[0]], { publication: 'none' });
      const replayed = await read();
      expect(replayed).toMatchObject({ sample_count: 1, value: { value: 8 }, stats: { count: 1 } });
      expect(replayed).not.toHaveProperty('retained_sample_count');
      expect(await new MysqlMetricStorage(pool).prune(1)).toMatchObject({ normalized: 0, retainedTrends: 1, trendReceipts: 1 });
      expect(await new MysqlMetricStorage(pool).prune(1)).toMatchObject({ normalized: 1 });
      expect(await read()).toMatchObject({ sample_count: 1, retained_sample_count: 1, value: { value: 8 }, stats: { count: 1 } });
    } finally {
      await pool.execute('DELETE FROM metric_item_retention WHERE resource_key=? AND metric_key=?', ['instance:1', key]);
    }
  }, 120_000);

  it('upgrades existing trend receipts without rewriting them and can rerun migration safely', async () => {
    const schema = `${database}_upgrade`;
    const legacyMigrations = await mkdtemp(join(tmpdir(), 'slide-trend-receipts-'));
    const directory = new URL('../../../sql/migrations/', import.meta.url);
    let legacy: Pool | undefined;
    try {
      for (const name of await readdir(directory)) {
        if (name.endsWith('.sql') && name < '164_') await copyFile(new URL(name, directory), join(legacyMigrations, name));
      }
      await root.query(`CREATE DATABASE ${schema}`);
      legacy = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database: schema });
      await new MigrationRunner(legacy as unknown as MigrationPool, legacyMigrations).run();
      const existing = ['fixture-before-164', seriesHash(series), 300_000, 'float64'];
      await legacy.execute('INSERT INTO metric_trend_receipts VALUES(?,?,?,?)', existing);
      const current = new MigrationRunner(legacy as unknown as MigrationPool);
      await current.run();
      await current.run();
      expect((await current.inspect()).find(migration => migration.migration_id === '164_metric_trend_receipt_quality.sql'))
        .toMatchObject({ status: 'completed' });
      const [rows] = await legacy.query<any[]>('SELECT * FROM metric_trend_receipts');
      expect(rows).toEqual([{ observation_id: existing[0], series_hash: existing[1], bucket_ms: existing[2], value_class: existing[3],
        archive_invalid: null, archive_estimated: null }]);
    } finally {
      await legacy?.end();
      await root.query(`DROP DATABASE IF EXISTS ${schema}`);
      await rm(legacyMigrations, { recursive: true, force: true });
    }
  }, 120_000);
});
