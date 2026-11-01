import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
import { PolicyService, intentFingerprint } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { refKey, type Ref } from '../policy/model.js';
import { admin } from '../policy/test-support.js';

/**
 * MAX238-APPLY-IDEMPOTENCY-R2 persistence and transport evidence on a
 * disposable schema (METRICS_TEST_MYSQL_PORT, never 3306). It uses the real
 * migrations, the real MysqlPolicyStore, a real Fastify HTTP surface and a real
 * second OS process. The trial boundary is stubbed or gated: no target is
 * connected, no collection runs, no worker starts.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const database = `max238_apply_idempotency_r2_${process.pid}`;
const refs: Ref[] = [1, 2, 3, 4].map(id => ({ type: 'instance' as const, id }));
const [restartRef, lostRef, pendingRef, rollbackRef] = refs;
const childPath = fileURLToPath(new URL('./.max238-r2-child.ts', import.meta.url));

describe.skipIf(!port)('MAX-238 R2 lifecycle on a disposable MySQL schema', () => {
  let root: Pool, pool: Pool, packages: ReturnType<typeof createConfigurationRegistry>;
  let pin: { id: string; version: string; digest: string };
  let poolSpy: ReturnType<typeof vi.spyOn>;
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
  const policyFor = () => new PolicyService(new MysqlPolicyStore(() => pool), packages,
    { exists: async () => true, inventory: configurationInventory });
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
        [ref.id, `idempotency-r2-${ref.id}`, 'production', 'mysql', '127.0.0.1']);
    }
    packages = createConfigurationRegistry();
    const recommendations = await new MetricConfigurationService(policyFor(), packages,
      createTrialStore(() => pool, packages), { resolve: async () => { throw new Error('status must not collect'); } },
      configurationReader(() => pool)).recommendations(admin, restartRef);
    const release = recommendations.packages.find(entry => entry.compatibility === 'compatible')?.release.package;
    expect(release, 'the fixture resource must have a compatible release').toBeDefined();
    pin = { id: release!.id, version: release!.version, digest: release!.digest };
  }, 180000);

  afterAll(async () => {
    poolSpy?.mockRestore();
    await pool?.end();
    if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
    vi.unstubAllEnvs();
    rmSync(childPath, { force: true });
  }, 60000);

  it('keeps an unknown trial outcome pending in a real second process', async () => {
    const input = { expected_revision: 0, package: pin, overrides: { enabled: 'disable' as const }, operation_key: 'r2-child' };
    const service = new MetricConfigurationService(policyFor(), packages, {} as never, {} as never);
    let trials = 0;
    service.trial = async () => { trials++; throw new Error('remote outcome unknown'); };
    await expect(service.activate(admin, restartRef, input)).rejects.toThrow('remote outcome unknown');
    expect(trials).toBe(1);
    expect(await journal('r2-child')).toMatchObject({ state: 'pending', configuration_digest: null, committed_at: null });
    expect(await bindingRevision(restartRef)).toBeNull(); expect(await audits(restartRef)).toBe(0);

    // A genuinely separate process reads the same schema.
    const script = `import mysql from 'mysql2/promise';
import { PolicyService } from '${new URL('../policy/service.js', import.meta.url).pathname}';
import { MysqlPolicyStore } from '${new URL('../policy/store.js', import.meta.url).pathname}';
const pool = mysql.createPool({ host: '127.0.0.1', port: ${port}, user: 'root', password: '', database: '${database}', timezone: 'Z' });
const policy = new PolicyService(new MysqlPolicyStore(() => pool), { list: () => [], get: () => { throw new Error('no registry'); }, catalog: () => [] } as never,
  { exists: async () => true, inventory: async () => ({ type: 'instance', id: '1', attributes: {} }) });
const state = await policy.operation({ userId: 1, username: 'fixture', roles: [], permissions: ['*'], instanceScopes: {}, sessionVersion: 1, requestId: 'child' } as never,
  { type: 'instance', id: 1 }, 'r2-child');
let retry = null;
try { await policy.beginOperation({ userId: 1, username: 'fixture', roles: [], permissions: ['*'], instanceScopes: {}, sessionVersion: 1, requestId: 'child' } as never,
  { type: 'instance', id: 1 }, ${JSON.stringify(input)}); } catch (error) { retry = (error as { code?: string }).code ?? String(error); }
console.log(JSON.stringify({ pid: process.pid, state, retry }));
await pool.end();
`;
    writeFileSync(childPath, script);
    const output = execFileSync('node_modules/.bin/tsx', [childPath], { encoding: 'utf8', timeout: 60000 });
    const child = JSON.parse(output.trim().split('\n').at(-1)!) as { pid: number; state: { state: string }; retry: string };
    expect(child.pid).not.toBe(process.pid);
    expect(child.state.state).toBe('pending');
    expect(child.retry).toBe('POLICY_OPERATION_PENDING');
    // Still pending here: nothing expired it into a safe retry.
    expect((await policyFor().operation(admin, restartRef, 'r2-child')).state).toBe('pending');
    expect(await bindingRevision(restartRef)).toBeNull(); expect(await audits(restartRef)).toBe(0);
  }, 120000);

  it('clears a claim only when the publication transaction provably rolled back', async () => {
    const input = { expected_revision: 0, package: pin, overrides: { enabled: 'disable' as const }, operation_key: 'r2-rollback' };
    const service = new MetricConfigurationService(policyFor(), packages, createTrialStore(() => pool, packages), {} as never, configurationReader(() => pool));
    service.trial = async () => trial as never;
    await pool.query(`CREATE TRIGGER r2_block_journal BEFORE INSERT ON metric_policy_apply_operations
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'blocked journal write'`);
    let failed: unknown = null;
    try { await service.activate(admin, rollbackRef, input); } catch (error) { failed = error; }
    await pool.query('DROP TRIGGER r2_block_journal');
    expect(failed).not.toBeNull();
    expect(await bindingRevision(rollbackRef)).toBeNull(); expect(await audits(rollbackRef)).toBe(0);
    // The row and the binding commit together: a pending row proves no publication.
    expect((await policyFor().operation(admin, rollbackRef, 'r2-rollback')).state).toBe('absent');
    const published = await service.activate(admin, rollbackRef, input);
    expect(published.resources[0].binding.revision).toBe(1);
  }, 60000);

  it('recovers a publication whose HTTP response was lost, and does not repeat it', async () => {
    const app = Fastify();
    const service = new MetricConfigurationService(policyFor(), packages, createTrialStore(() => pool, packages), {} as never,
      configurationReader(() => pool), async seed => seed);
    service.trial = async () => trial as never;
    let committed!: () => void;
    const committedAt = new Promise<void>(resolve => { committed = resolve; });
    const activate = service.activate.bind(service);
    service.activate = (actor, target, input, guard = {}) =>
      activate(actor, target, input, { ...guard, published: () => committed() });
    await registerMetricConfigurationRoutes(app, async request => {
      (request as unknown as { user?: ActorContext }).user = admin;
    }, service);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}/api/metrics`;
    const input = { expected_revision: 0, package: pin, overrides: { enabled: 'disable' as const }, operation_key: 'r2-http' };
    try {
      const controller = new AbortController();
      const lost = fetch(`${base}/config/resources/instance/2/activate`, { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      // The server committed; the client never observes the response.
      await committedAt; controller.abort();
      await lost.then(() => { throw new Error('the response must not reach the client'); }, () => undefined);
      expect(await bindingRevision(lostRef)).toBe(1); expect(await audits(lostRef)).toBe(1);
      const lookup = await fetch(`${base}/config/resources/instance/2/operations/${input.operation_key}`);
      expect(await lookup.json()).toMatchObject({ state: 'committed', operation: { target_revision: 1 } });
      // The same key over HTTP replays the recorded publication: no second
      // revision, audit or trial.
      const replay = await fetch(`${base}/config/resources/instance/2/activate`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      expect(replay.status).toBe(200);
      expect((await replay.json() as { resources: Array<{ binding: { revision: number } }> }).resources[0].binding.revision).toBe(1);
      expect(await bindingRevision(lostRef)).toBe(1); expect(await audits(lostRef)).toBe(1);
    } finally { await app.close(); }
  }, 60000);

  it('reports a keyed activate as pending over real HTTP and never starts a second trial', async () => {
    const app = Fastify();
    const service = new MetricConfigurationService(policyFor(), packages, createTrialStore(() => pool, packages), {} as never,
      configurationReader(() => pool), async seed => seed);
    let trials = 0, enter!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    service.trial = async () => { trials++; enter(); await gate; return trial as never; };
    await registerMetricConfigurationRoutes(app, async request => {
      (request as unknown as { user?: ActorContext }).user = admin;
    }, service);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/metrics`;
    const input = { expected_revision: 0, package: pin, overrides: { enabled: 'disable' as const }, operation_key: 'r2-http-pending' };
    const controller = new AbortController();
    const inFlight = fetch(`${base}/config/resources/instance/3/activate`, { method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    try {
      await started; controller.abort();
      await inFlight.then(() => { throw new Error('the response must not reach the client'); }, () => undefined);
      expect(await journal('r2-http-pending')).toMatchObject({ state: 'pending' });
      const lookup = await fetch(`${base}/config/resources/instance/3/operations/r2-http-pending`);
      expect(await lookup.json()).toMatchObject({ state: 'pending',
        operation: { target_revision: 1, configuration_digest: null, committed_at: null } });
      const duplicate = await fetch(`${base}/config/resources/instance/3/activate`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toEqual({ error: 'POLICY_OPERATION_PENDING' });
      expect(trials).toBe(1);
      expect(await bindingRevision(pendingRef)).toBeNull(); expect(await audits(pendingRef)).toBe(0);
    } finally {
      release(); await new Promise(resolve => setTimeout(resolve, 200)); await app.close();
    }
  }, 60000);
});
