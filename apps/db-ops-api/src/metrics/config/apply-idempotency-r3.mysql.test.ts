import Fastify from 'fastify';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../auth/actor-context.js';
import { dbConnection } from '../../db-connection.js';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { configurationInventory } from './inventory.js';
import { createConfigurationRegistry } from './registry.js';
import { createTrialStore, registerMetricConfigurationRoutes } from './routes.js';
import { MetricConfigurationService } from './service.js';
import { configurationReader } from './status-store.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore, type PolicyStore } from '../policy/store.js';
import { refKey, type Ref } from '../policy/model.js';
import { registerMetricPolicyRoutes } from '../policy/routes.js';
import { admin } from '../policy/test-support.js';

/**
 * MAX238-APPLY-IDEMPOTENCY-R3 transport evidence on a disposable schema
 * (METRICS_TEST_MYSQL_PORT, never 3306). It uses the real migrations, the real
 * MysqlPolicyStore, real Fastify routes and the real operation journal. The
 * identity source is injected so a grant can change while a request waits for
 * the policy lock; the trial boundary is a stub and no target is connected.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const database = `max238_apply_idempotency_r3_${process.pid}`;
const refs: Ref[] = [1, 2, 3, 4].map(id => ({ type: 'instance' as const, id }));
const [replayRef, intentRef, activateRef, readRef] = refs;

describe.skipIf(!port)('MAX-238 R3 public-entry authorization on a disposable MySQL schema', () => {
  let root: Pool, pool: Pool, packages: ReturnType<typeof createConfigurationRegistry>;
  let pin: { id: string; version: string; digest: string };
  let poolSpy: ReturnType<typeof vi.spyOn>;
  const revoked: ActorContext = { ...admin, permissions: [], instanceScopes: {} };
  const rows = async (sql: string, values: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, values as never))[0];
  const count = async (sql: string, values: unknown[] = []) => Number((await rows(sql, values))[0]!.n);
  const audits = (ref: Ref) => count('SELECT COUNT(*) AS n FROM metric_policy_audit WHERE target = ?', [refKey(ref)]);
  const journal = async (key: string) => (await rows(`SELECT operation_key, resource_key, actor_id, target_revision,
    intent_digest, configuration_digest, state, claimed_at, committed_at FROM metric_policy_apply_operations
    WHERE operation_key = ?`, [key]))[0] ?? null;
  const bindingRevision = async (ref: Ref) => {
    const payload = (await rows('SELECT payload FROM metric_policy_bindings WHERE resource_key = ?', [refKey(ref)]))[0]?.payload;
    if (payload === undefined) return null;
    return Number((typeof payload === 'string' ? JSON.parse(payload) : payload).binding.revision);
  };
  const trial = { trial: true, persisted: false, decision: 'attempted' as const,
    attempts: [{ id: 'attempt-1', collector_id: 'fixture', status: 'succeeded' }], capabilities: [],
    applicability: [], lifecycle_evidence: 'available' as const,
    samples: [{ metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, value: 60, quality: { status: 'good' }, unit: 's' }] };

  beforeAll(async () => {
    vi.stubEnv('METRICS_COLLECTION_ENABLED', 'true');
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 20, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    for (const ref of refs) {
      await pool.execute(`INSERT INTO database_instances
        (id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state)
        VALUES (?,?,?,?,?,3306,'fixture','','fixture','8.0.46','active','available')`,
        [ref.id, `idempotency-r3-${ref.id}`, 'production', 'mysql', '127.0.0.1']);
    }
    packages = createConfigurationRegistry();
    const policy = new PolicyService(new MysqlPolicyStore(() => pool), packages,
      { exists: async () => true, inventory: configurationInventory });
    const recommendations = await new MetricConfigurationService(policy, packages,
      createTrialStore(() => pool, packages), { resolve: async () => { throw new Error('status must not collect'); } },
      configurationReader(() => pool)).recommendations(admin, replayRef);
    const release = recommendations.packages.find(entry => entry.compatibility === 'compatible')?.release.package;
    expect(release, 'the fixture resource must have a compatible release').toBeDefined();
    pin = { id: release!.id, version: release!.version, digest: release!.digest };
  }, 180000);

  afterAll(async () => {
    poolSpy?.mockRestore();
    await pool?.end();
    if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
    vi.unstubAllEnvs();
  }, 60000);

  /** A policy store that holds the next transaction at its admission boundary. */
  const gated = (real: PolicyStore) => {
    let block = false, enter!: () => void, release!: () => void;
    let entered = new Promise<void>(resolve => { enter = resolve; });
    let gate = new Promise<void>(resolve => { release = resolve; });
    const store: PolicyStore = { transaction: async fn => {
      if (block) { block = false; enter(); await gate; }
      return real.transaction(fn);
    } };
    return { store, arm() {
      block = true;
      entered = new Promise<void>(resolve => { enter = resolve; });
      gate = new Promise<void>(resolve => { release = resolve; });
      return { entered, release: () => release() };
    } };
  };

  const surface = async (reload: () => Promise<ActorContext>) => {
    const gatedStore = gated(new MysqlPolicyStore(() => pool));
    const policy = new PolicyService(gatedStore.store, packages, { exists: async () => true, inventory: configurationInventory });
    const service = new MetricConfigurationService(policy, packages, createTrialStore(() => pool, packages), {} as never,
      configurationReader(() => pool), async () => reload());
    let trials = 0;
    service.trial = async () => { trials++; return trial as never; };
    const app = Fastify();
    await registerMetricPolicyRoutes(app, async request => { (request as unknown as { user?: ActorContext }).user = admin; }, policy, async () => reload());
    await registerMetricConfigurationRoutes(app, async request => { (request as unknown as { user?: ActorContext }).user = admin; }, service);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/metrics`;
    return { app, base, gated: gatedStore, trials: () => trials };
  };
  const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('refuses a committed keyed replay whose grants changed during the lock wait', async () => {
    let current: ActorContext = admin, reloads = 0;
    const { app, base, gated: lock } = await surface(async () => { reloads++; return current; });
    const input = { expected_revision: 0, package: pin, operation_key: 'r3-replay-r1' };
    const url = `${base}/policy/resources/instance/1/publish`;
    try {
      expect((await post(url, input)).status).toBe(200);
      expect(await bindingRevision(replayRef)).toBe(1); expect(await audits(replayRef)).toBe(1);
      const before = await journal('r3-replay-r1');
      expect(before).toMatchObject({ state: 'committed', target_revision: 1 });

      const wait = lock.arm();
      const response = post(url, input);
      await wait.entered;
      current = revoked;
      wait.release();
      expect((await response).status).toBe(403);
      expect(reloads).toBeGreaterThan(0);
      // The denial adds no repeat write and reveals no protected history.
      expect(await bindingRevision(replayRef)).toBe(1); expect(await audits(replayRef)).toBe(1);
      expect(await journal('r3-replay-r1')).toEqual(before);
    } finally { await app.close(); }
  }, 60000);

  it('refuses a new keyed intent and does not burn its key or write anything', async () => {
    let current: ActorContext = revoked;
    const { app, base, gated: lock } = await surface(async () => current);
    const input = { expected_revision: 0, package: pin, operation_key: 'r3-new-intent' };
    const url = `${base}/policy/resources/instance/2/publish`;
    try {
      // Revoked before admission: the request snapshot cannot authorize the entry.
      expect((await post(url, input)).status).toBe(403);
      expect(await journal('r3-new-intent')).toBeNull();

      current = admin;
      const wait = lock.arm();
      const response = post(url, input);
      await wait.entered;
      current = revoked;
      wait.release();
      expect((await response).status).toBe(403);
      expect(await journal('r3-new-intent')).toBeNull();
      expect(await bindingRevision(intentRef)).toBeNull(); expect(await audits(intentRef)).toBe(0);

      // The key was never claimed, so the same intent is still usable once authorized.
      current = admin;
      expect((await post(url, input)).status).toBe(200);
      expect(await bindingRevision(intentRef)).toBe(1); expect(await audits(intentRef)).toBe(1);
      expect(await journal('r3-new-intent')).toMatchObject({ state: 'committed', target_revision: 1 });
    } finally { await app.close(); }
  }, 60000);

  it('refuses keyless publications and protected reads after a grant change during the lock wait', async () => {
    let current: ActorContext = admin;
    const { app, base, gated: lock } = await surface(async () => current);
    const url = `${base}/policy/resources/instance/4`;
    try {
      expect((await post(`${url}/publish`, { expected_revision: 0, package: pin })).status).toBe(200);
      const attempts: Array<[string, string, unknown?]> = [
        ['GET', url], ['GET', `${url}/effective`], ['GET', `${url}/audit`],
        ['POST', `${url}/preview`, { expected_revision: 1 }],
        ['POST', `${url}/publish`, { expected_revision: 1, overrides: { enabled: 'disable' } }],
      ];
      for (const [method, target, payload] of attempts) {
        current = admin;
        const wait = lock.arm();
        const response = payload === undefined
          ? fetch(target, { method })
          : fetch(target, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        await wait.entered;
        current = revoked;
        wait.release();
        expect((await response).status, `${method} ${target}`).toBe(403);
      }
      expect(await bindingRevision(readRef)).toBe(1); expect(await audits(readRef)).toBe(1);
    } finally { await app.close(); }
  }, 60000);

  it('refuses config activate before any trial and the intent query after a lock-wait revocation', async () => {
    let current: ActorContext = revoked;
    const { app, base, gated: lock, trials } = await surface(async () => current);
    const activate = `${base}/config/resources/instance/3/activate`;
    const input = { expected_revision: 0, package: pin, overrides: { enabled: 'disable' }, operation_key: 'r3-activate' };
    try {
      expect((await post(activate, input)).status).toBe(403);
      expect(trials()).toBe(0); expect(await journal('r3-activate')).toBeNull(); expect(await audits(activateRef)).toBe(0);

      current = admin;
      expect((await post(activate, input)).status).toBe(200);
      expect(trials()).toBe(1); expect(await audits(activateRef)).toBe(1);

      const query = `${base}/config/resources/instance/3/operations/r3-activate`;
      const wait = lock.arm();
      const response = fetch(query);
      await wait.entered;
      current = revoked;
      wait.release();
      const denied = await response;
      expect(denied.status).toBe(403);
      expect(await denied.text()).not.toContain('committed');
    } finally { await app.close(); }
  }, 60000);
});
