import { randomBytes } from 'node:crypto';
import type { ExecuteValues } from 'mysql2';
import mysql, { type Pool } from 'mysql2/promise';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActorContextService, signAccessToken } from '../../auth/actor-context.js';
import { createVerifyToken } from '../../auth-middleware.js';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { identify, sample } from '../../contracts/metrics/fixtures.js';
import type { MetricDefinition, NormalizedObservation } from '../../contracts/metrics/index.js';
import { LatestMetricObservationsSchema, MetricObservationPageSchema } from '../../contracts/metrics/public-api.js';
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
const readerId = 719;
const ticket = { source: 'semantic', generation: 1, revision: 1 } as const;

describe.skipIf(!port)('formal raw observation pages over MySQL and the real HTTP entry', () => {
  const database = `max240_raw_page_${process.pid}`;
  let root: Pool, pool: Pool;
  let app: ReturnType<typeof Fastify>, bounded: ReturnType<typeof Fastify>, base: string, boundedBase: string;
  let control: RolloutControl, readerToken: string;
  let formalVersions: NormalizedObservation['versions'];
  let definition: MetricDefinition, series: { resource_type: 'instance'; resource_id: string;
    metric: { id: string; semantic_version: string }; dimensions: Record<string, string> };
  let from = 0, to = 0;
  const seeded: NormalizedObservation[] = [], excluded: NormalizedObservation[] = [];
  const inventory = () => ({ type: 'instance' as const, id: '1', attributes: {
    'db.engine': { value: 'mysql', observed_at: new Date().toISOString(), source: 'fixture' },
    'db.version': { value: '9.6.0', observed_at: new Date().toISOString(), source: 'fixture' } } });
  const iso = (ms: number) => new Date(ms).toISOString();
  const now = () => to + 121 * MINUTE + 123;
  const sqlTime = (value: string) => new Date(value).toISOString().slice(0, 23).replace('T', ' ');
  const fixture = sample('db.uptime_seconds');
  const observation = (ms: number, value: number, tag: string, overrides: Partial<NormalizedObservation> = {}) =>
    identify({ ...fixture, resource_id: '1', observed_at: iso(ms), collected_at: iso(ms), stored_at: iso(ms),
      value: { encoding: 'float64', value }, source: { ...fixture.source, attempt_id: `raw-page-${tag}` }, ...overrides });
  const grantRead = () => pool.execute("INSERT INTO instance_permissions (user_id, instance_id, access_level) VALUES (?, ?, 'read-only')", [readerId, ref.id]);

  const seed = async (rows: NormalizedObservation[], options: { publication?: 'current' | 'none'; generation?: number } = {}) => {
    if (!rows.length) return;
    await pool.query(`INSERT INTO metric_observations
      (id, series_hash, stage, observed_at, stored_at, valid_value, payload, payload_hash, evidence_expires_at)
      VALUES ${rows.map(() => '(?,?,?,?,?,?,?,?,NULL)').join(',')}`,
    rows.flatMap(o => [o.id, seriesHash(o), o.stage, sqlTime(o.observed_at), sqlTime(o.stored_at!), 1,
      JSON.stringify(o), 'fixture']));
    if (options.publication === 'none') return;
    await pool.query(`INSERT INTO metric_publications (observation_id, series_hash, generation, observed_at)
      VALUES ${rows.map(() => '(?,?,?,?)').join(',')}`,
    rows.flatMap(o => [o.id, seriesHash(o), options.generation ?? 1, sqlTime(o.observed_at)]));
  };

  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, timezone: '+05:30', connectionLimit: 10 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    await pool.execute("INSERT INTO database_instances (id, name, db_type, host, port, username, password_encrypted) VALUES (1, 'isolated', 'mysql', '127.0.0.1', 1, 'fixture', 'fixture')");
    await pool.execute("INSERT INTO users (id, username, password_hash) VALUES (?, 'raw-page-reader', 'disabled-test-login')", [readerId]);
    await pool.execute("INSERT INTO roles (id, name) VALUES (?, 'raw-page-reader')", [readerId]);
    await pool.execute('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [readerId, readerId]);
    await pool.execute("INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code = 'instance:view'", [readerId]);
    await grantRead();
    const actors = new ActorContextService(() => ({
      execute: (sql, values) => pool.execute(sql, values as ExecuteValues),
    }));
    const secret = randomBytes(32).toString('hex');
    readerToken = signAccessToken(await actors.loadActiveActor(readerId), secret);
    const auth = createVerifyToken(secret, actors);
    const registry = createConfigurationRegistry();
    const policy = new PolicyService(new MysqlPolicyStore(() => pool), registry,
      { exists: async resource => resource.type === ref.type && resource.id === ref.id, inventory: async () => inventory() });
    const pin = registry.list().find(r => r.package.id === 'mysql-basic' && r.package.version === '2.0.0')!.package;
    formalVersions = { ...fixture.versions, package_id: pin.id, package_version: pin.version, config_revision: ticket.revision };
    await policy.changeBinding(admin, ref, { expected_revision: 0,
      package: { id: pin.id, version: pin.version, digest: pin.digest },
      overrides: { interval_ms: { mode: 'set', value: 60_000 }, timeout_ms: { mode: 'set', value: 5000 } } }, true);
    const service = (store: MysqlFormalMetricStore) => new MetricConsumerService(policy, registry, {
      readWindow: (...args) => store.readWindow(...args),
      queryWindow: (...args) => store.queryWindow(...args),
      readObservationPage: (...args) => store.readObservationPage(...args),
      latestObservations: (...args) => store.latestObservations(...args),
      dimensions: (...args) => store.dimensions(...args),
      inventory: async () => inventory(),
      attempts: async () => [],
    } satisfies ConsumerStore, () => iso(now()), undefined, actor => actors.revalidateActor(actor));
    definition = (await new MetricConsumerService(policy, registry, {
      queryWindow: async () => [], inventory: async () => inventory(), dimensions: async () => [{}], attempts: async () => [],
    }).discover(admin, ref)).definitions.find(d => d.id === 'db.uptime_seconds')!;
    series = { resource_type: 'instance', resource_id: '1',
      metric: { id: definition.id, semantic_version: definition.semantic_version }, dimensions: {} };
    control = new RolloutControl(pool);
    await control.initialize(series, { source: 'semantic', read: 'semantic', revision: 1,
      package: { id: pin.id, version: pin.version, digest: pin.digest } });
    await control.applied(series, ticket);

    to = Math.floor(Date.now() / MINUTE) * MINUTE - 121 * MINUTE; from = to - DAY;
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

  const post = async (op: 'observations' | 'latest', body: object, origin = base, token: string | null = readerToken) => {
    const response = await fetch(`${origin}/api/metrics/${op}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const request = (overrides: Record<string, unknown> = {}, origin = base) =>
    post('observations', { resource: ref, metric: series.metric, dimensions: series.dimensions,
      from: iso(from), to: iso(to), ...overrides }, origin);
  const latest = async () => {
    const result = await post('latest', ref);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return LatestMetricObservationsSchema.parse(result.body).metrics.find(metric =>
      metric.definition.id === definition.id && metric.definition.semantic_version === definition.semantic_version)?.series;
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

  it('returns the latest accepted original value without a chart window', async () => {
    await seed([observation(to + 4000, 900, 'latest-shadow')], { publication: 'none' });
    await seed([observation(to + 5000, 800, 'latest-wrong-generation')], { generation: 2 });
    await seed([observation(to + 6000, 700, 'latest-wrong-revision', { versions: { ...fixture.versions, config_revision: 2 } })]);
    expect(await latest()).toMatchObject([{ dimensions: {}, observed_at: iso(to), value: { value: 6 }, unit: 's' }]);
    await seed([observation(to + 1000, 0, 'latest-null', {
      value: null, quality: { status: 'unknown', reason: 'source_error' }, accuracy: 'unknown',
    })]);
    expect(await latest()).toMatchObject([{ dimensions: {}, observed_at: iso(to + 1000), value: null,
      quality: { status: 'unknown', reason: 'source_error' }, unit: 's' }]);
  });

  it('MAX-719: identifies the selected out-of-window observation among same-millisecond formal publications', async () => {
    const observedAt = now() - 120 * MINUTE;
    // Publish the lower ID first so the existing descending ID tie-break changes the selected row.
    const observations = ['max719-a', 'max719-b'].map(tag => observation(observedAt, 318711, tag, { versions: formalVersions }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(observations[0].id).not.toBe(observations[1].id);
    for (const [index, observation] of observations.entries()) {
      await control.publish(observation, definition, ticket);
      const selected = await latest();
      expect(selected).toMatchObject([{ observation_id: observation.id, observed_at: iso(observedAt),
        dimensions: {}, value: { encoding: 'float64', value: 318711 }, unit: 's', quality: observation.quality, freshness: 'stale' }]);

      const exact = await request({ from: iso(observedAt), to: iso(observedAt + 1) });
      expect(exact.status, JSON.stringify(exact.body)).toBe(200);
      const page = MetricObservationPageSchema.parse(exact.body);
      expect(page.total).toBe(index + 1);
      expect(page.observations.map(row => row.id)).toEqual(observations.slice(0, index + 1).map(row => row.id));
      expect(page.observations.filter(row => row.id === selected?.[0].observation_id)).toMatchObject([{
        id: observation.id, observed_at: iso(observedAt), value: observation.value, quality: observation.quality,
        sources: [{ id: observation.id, source: observation.source, versions: observation.versions }],
      }]);
    }
    const defaultWindow = await request({ from: iso(now() - 60 * MINUTE), to: iso(now()) });
    expect(defaultWindow.status, JSON.stringify(defaultWindow.body)).toBe(200);
    expect(defaultWindow.body).toMatchObject({ total: 0, has_more: false, observations: [] });
  });

  it('rejects unauthorized reads of both raw pages and latest observations', async () => {
    for (const [op, body] of [['latest', ref], ['observations', {}]] as const) {
      expect((await post(op, body, base, null)).status).toBe(401);
    }
    await pool.execute('DELETE FROM instance_permissions WHERE user_id = ? AND instance_id = ?', [readerId, ref.id]);
    try {
      for (const denied of [await request(), await post('latest', ref)]) {
        expect(denied.status).toBe(403);
        expect(denied.body).toEqual({ error: 'POLICY_FORBIDDEN' });
      }
    } finally { await grantRead(); }
    expect((await request()).status).toBe(200);
  }, 120_000);

  it('fails a window above max_rows with 400 instead of a truncated total', async () => {
    const tooLarge = await request({}, boundedBase);
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body).toEqual({ error: 'QUERY_LIMIT_EXCEEDED' });
  }, 120_000);
});
