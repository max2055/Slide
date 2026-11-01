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

describe.skipIf(!port)('formal raw observation pages over MySQL and the real HTTP entry', () => {
  const database = `max240_raw_page_${process.pid}`;
  let root: Pool, pool: Pool;
  let app: ReturnType<typeof Fastify>, bounded: ReturnType<typeof Fastify>, base: string, boundedBase: string;
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
      value: { encoding: 'float64', value }, source: { ...fixture.source, attempt_id: `raw-page-${tag}` }, ...overrides });

  const seed = async (rows: NormalizedObservation[], options: { publication?: 'current' | 'none' } = {}) => {
    if (!rows.length) return;
    await pool.query(`INSERT INTO metric_observations
      (id, series_hash, stage, observed_at, stored_at, valid_value, payload, payload_hash, evidence_expires_at)
      VALUES ${rows.map(() => '(?,?,?,?,?,?,?,?,NULL)').join(',')}`,
    rows.flatMap(o => [o.id, seriesHash(o), o.stage, sqlTime(o.observed_at), sqlTime(o.stored_at!), 1,
      JSON.stringify(o), 'fixture']));
    if (options.publication === 'none') return;
    await pool.query(`INSERT INTO metric_publications (observation_id, series_hash, generation, observed_at)
      VALUES ${rows.map(() => '(?,?,?,?)').join(',')}`,
    rows.flatMap(o => [o.id, seriesHash(o), 1, sqlTime(o.observed_at)]));
  };

  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, timezone: '+05:30', connectionLimit: 10 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    const registry = createConfigurationRegistry();
    const policy = new PolicyService(new MysqlPolicyStore(() => pool), registry,
      { exists: async () => true, inventory: async () => inventory() });
    const pin = registry.list().find(r => r.package.id === 'mysql-basic' && r.package.version === '2.0.0')!.package;
    await policy.changeBinding(admin, ref, { expected_revision: 0,
      package: { id: pin.id, version: pin.version, digest: pin.digest },
      overrides: { interval_ms: { mode: 'set', value: 60_000 }, timeout_ms: { mode: 'set', value: 5000 } } }, true);
    const service = (store: MysqlFormalMetricStore) => new MetricConsumerService(policy, registry, {
      readWindow: (...args) => store.readWindow(...args),
      queryWindow: (...args) => store.queryWindow(...args),
      readObservationPage: (...args) => store.readObservationPage(...args),
      dimensions: (...args) => store.dimensions(...args),
      inventory: async () => inventory(),
      attempts: async () => [],
    } satisfies ConsumerStore);
    definition = (await new MetricConsumerService(policy, registry, {
      queryWindow: async () => [], inventory: async () => inventory(), dimensions: async () => [{}], attempts: async () => [],
    }).discover(admin, ref)).definitions.find(d => d.id === 'db.uptime_seconds')!;
    series = { resource_type: 'instance', resource_id: '1',
      metric: { id: definition.id, semantic_version: definition.semantic_version }, dimensions: {} };
    const control = new RolloutControl(pool);
    await control.initialize(series, { source: 'semantic', read: 'semantic', revision: 1,
      package: { id: pin.id, version: pin.version, digest: pin.digest } });
    await control.applied(series, { source: 'semantic', generation: 1, revision: 1 });

    to = Math.floor(Date.now() / MINUTE) * MINUTE; from = to - DAY;
    // Every timestamp carries three rows, so a seven-row page boundary always splits a group.
    for (let minute = 0; minute < 10; minute++) {
      for (const tag of ['a', 'b', 'c']) seeded.push(observation(from + minute * MINUTE, minute * 10 + tag.charCodeAt(0), `${minute}-${tag}`));
    }
    excluded.push(observation(from + 500 * MINUTE, 111, 'shadow'));
    excluded.push(observation(from + 501 * MINUTE, 222, 'revision-2', { versions: { ...fixture.versions, config_revision: 2 } }));
    const prior = observation(from - MINUTE, 5, 'prior'), next = observation(to, 6, 'next');
    await seed(seeded);
    await seed([excluded[0]], { publication: 'none' });
    await seed([excluded[1]]);
    await seed([prior, next]);

    const auth = async (request: unknown) => { (request as { user?: typeof admin }).user = actor; };
    app = Fastify(); await registerMetricConsumerRoutes(app, auth, service(new MysqlFormalMetricStore(pool)));
    base = await app.listen({ host: '127.0.0.1', port: 0 });
    // Small maximum proves the route fails closed instead of returning a truncated total.
    bounded = Fastify(); await registerMetricConsumerRoutes(bounded, auth,
      service(new MysqlFormalMetricStore(pool, { page_rows: 1000, max_rows: 10 })));
    boundedBase = await bounded.listen({ host: '127.0.0.1', port: 0 });
  }, 180_000);

  afterAll(async () => {
    await app?.close(); await bounded?.close();
    await pool?.end();
    if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
  });

  const request = async (overrides: Record<string, unknown> = {}, origin = base) => {
    const response = await fetch(`${origin}/api/metrics/observations`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resource: ref,
        metric: { id: definition.id, semantic_version: definition.semantic_version }, dimensions: {},
        from: iso(from), to: iso(to), ...overrides }) });
    return { status: response.status, body: await response.json() as any };
  };

  it('pages ascending same-timestamp rows without duplicates, gaps or edge neighbours', async () => {
    const seen: string[] = [];
    const observed: string[] = [];
    let cursor: string | undefined, pages = 0, hasMore = true, total = -1;
    while (hasMore) {
      const result = await request({ limit: 7, ...(cursor ? { cursor } : {}) });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      pages++;
      expect(result.body.order).toBe('observed_at,observation_id');
      total = result.body.total;
      expect(total).toBe(seeded.length);
      expect(result.body.has_more).toBe(pages < 5);
      expect(result.body.observations.length).toBeLessThanOrEqual(7);
      for (const row of result.body.observations) {
        seen.push(row.id);
        observed.push(`${row.observed_at}/${row.id}`);
        expect(row.unit).toBe('s');
        expect(row.sources).toHaveLength(1);
      }
      hasMore = result.body.has_more;
      cursor = result.body.next_cursor;
      if (!hasMore) expect(result.body.next_cursor).toBeUndefined();
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(5);
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(seeded.map(o => o.id)));
    expect(observed).toEqual([...observed].sort());
    for (const hidden of excluded) expect(seen).not.toContain(hidden.id);
    const priorNext = [observation(from - MINUTE, 5, 'prior').id, observation(to, 6, 'next').id];
    for (const edge of priorNext) expect(seen).not.toContain(edge);
  }, 120_000);

  it('returns an empty page for a window with no formal rows instead of zero fill', async () => {
    const empty = await request({ from: iso(from + 400 * MINUTE), to: iso(from + 401 * MINUTE), limit: 5 });
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ total: 0, has_more: false, observations: [] });
    expect(empty.body.next_cursor).toBeUndefined();
  }, 120_000);

  it('rejects a revoked reader before reading any page', async () => {
    actor = { ...admin, permissions: ['instance:view'], instanceScopes: {} };
    try {
      const denied = await request();
      expect(denied.status).toBe(403);
      expect(denied.body).toEqual({ error: 'POLICY_FORBIDDEN' });
    } finally { actor = admin; }
    expect((await request()).status).toBe(200);
  }, 120_000);

  it('fails a window above max_rows with 400 instead of a truncated total', async () => {
    const tooLarge = await request({}, boundedBase);
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body).toEqual({ error: 'QUERY_LIMIT_EXCEEDED' });
  }, 120_000);
});
