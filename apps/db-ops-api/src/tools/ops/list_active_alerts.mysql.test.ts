/** Explicit opt-in acceptance: production tool policy + service SQL + formal migrations. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../../db-connection.js';
import { MigrationRunner } from '../../migrations/runner.js';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from '../../testing/owned-fixture.js';
import { agentExecutionConfigService } from '../../security/agent-execution-config-service.js';
import type { ActorContext } from '../../auth/actor-context.js';
import { executeToolWithPolicy } from '../policy.js';
import { listActiveAlertsTool } from './list_active_alerts.js';

const profilePath = process.env.MAX568_MYSQL_PROFILE;
describe.skipIf(!profilePath)('MAX-568 production tool on owned MySQL schema', () => {
  let admin: Pool | undefined, pool: Pool | undefined, owned: OwnedDatabase | undefined;
  const actor: ActorContext = { userId: 7, username: 'reader', roles: ['viewer'], permissions: ['alert:view'],
    sessionVersion: 1, requestId: 'max568', instanceScopes: { 1: 'read-only', 2: 'read-write' } };
  const run = async (caller = actor, args: Record<string, unknown> = { limit: 2 }) =>
    (await executeToolWithPolicy(caller, listActiveAlertsTool, args, undefined,
      { consume: async () => false }, { record: async () => {} })).result;
  const ids = (result: any) => {
    expect(result.success).toBe(true);
    return result.data.alerts.map((a: any) => a.id);
  };
  beforeAll(async () => {
    const profile = JSON.parse(readFileSync(profilePath!, 'utf8'))['mysql-test'];
    if (profile.host !== '127.0.0.1' || Number(profile.port) !== 3308 || !profile.user || typeof profile.password !== 'string') {
      throw new Error('Explicit mysql-test localhost:3308 configuration required');
    }
    const config = { host: profile.host, port: Number(profile.port), user: profile.user, password: profile.password,
      connectTimeout: 5000, timezone: 'Z' };
    admin = mysql.createPool(config);
    owned = await createOwnedDatabase(admin, { nonce: generateRunNonce(), purpose: 'max568',
      handleDir: fileURLToPath(new URL('../../../.max238-handles/', import.meta.url)) });
    console.log('MAX568 owned schema:', owned.database);
    pool = mysql.createPool({ ...config, database: owned.database, connectionLimit: 2 });
    await new MigrationRunner(pool).run();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    vi.spyOn(agentExecutionConfigService, 'get').mockResolvedValue({ approvalEnabled: true,
      restrictedNetworkEnabled: false, reasonCode: 'EXECUTION_CONFIG_READY' });
    await pool.query("INSERT INTO database_instances(id,name,host,port,username,password_encrypted,db_type) VALUES (1,'visible','fixture',3308,'fixture','fixture','mysql'),(2,'boundary','fixture2',3308,'fixture','fixture','mysql'),(3,'hidden','fixture3',3308,'fixture','fixture','mysql')");
    // The newest N are other-instance rows; null/global and typed collisions must not consume slots either.
    await pool.query(`INSERT INTO alerts(id,instance_id,target_type,alert_type,level,title,message,created_at) VALUES
      (1,1,'instance','performance','warning','older visible','fixture','2026-01-01 01:00:00'),
      (2,1,'instance','performance','warning','newer visible','fixture','2026-01-02 01:00:00'),
      (3,2,'instance','performance','critical','boundary visible','fixture','2026-01-03 01:00:00'),
      (4,3,'instance','performance','warning','hidden1','fixture','2026-01-04 01:00:00'),
      (5,3,'instance','performance','warning','hidden2','fixture','2026-01-05 01:00:00'),
      (6,NULL,'instance','performance','warning','global','fixture','2026-01-06 01:00:00'),
      (7,1,'server','performance','warning','typed collision','fixture','2026-01-07 01:00:00'),
      (8,1,'network_device','performance','warning','network collision','fixture','2026-01-08 01:00:00')`);
  }, 120_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    const errors: unknown[] = [];
    const cleanup = async (stage: string, action: () => Promise<unknown>) => {
      const started = performance.now();
      let passed = false;
      try { await action(); passed = true; } catch (error) { errors.push(error); }
      finally { console.log('MAX568 cleanup', { stage, passed, elapsedMs: Math.round(performance.now() - started) }); }
    };
    await cleanup('pool-end', async () => pool?.end());
    await cleanup('owned-schema-drop', async () => { await owned?.drop(); console.log('MAX568 owned schema cleaned'); });
    await cleanup('admin-end', async () => admin?.end());
    if (errors.length) throw new AggregateError(errors, 'MAX568 cleanup failed');
  // MAX-259 integration: the full migrated schema exceeded the default 10s
  // cleanup hook under concurrent qualification I/O. Keep a bounded local
  // budget and report each stage; business test and migration budgets stay as-is.
  }, 60_000);
  it('#393: latest N other-instance alerts cannot hide older authorized rows', async () => {
    expect(ids(await run({ ...actor, instanceScopes: { 1: 'read-only' } }))).toEqual([2, 1]);
  });
  it('intersects current grants with the task boundary before LIMIT', async () => {
    expect(ids(await run({ ...actor, resourceBoundary: { instanceIds: [1, 3], serverIds: [], networkDeviceIds: [] } }))).toEqual([2, 1]);
  });
  it('returns no alerts for empty grants, empty boundary and disjoint grants', async () => {
    for (const caller of [{ ...actor, instanceScopes: {} },
      { ...actor, resourceBoundary: { instanceIds: [], serverIds: [], networkDeviceIds: [] } },
      { ...actor, resourceBoundary: { instanceIds: [3], serverIds: [], networkDeviceIds: [] } }]) {
      expect(ids(await run(caller))).toEqual([]);
    }
  });
  it('preserves global permission and admin-role semantics, but excludes other target types', async () => {
    for (const caller of [{ ...actor, permissions: ['*'] }, { ...actor, roles: ['admin'] },
      { ...actor, permissions: ['alert:view', 'instance:*'] }]) {
      expect(ids(await run(caller))).toEqual([5, 4]);
      expect(ids(await run({ ...caller, resourceBoundary: { instanceIds: [1], serverIds: [], networkDeviceIds: [] } }))).toEqual([2, 1]);
    }
  });
  it('supports severity, since and exact limit in the authorized set', async () => {
    expect(ids(await run(actor, { severity: 'WARNING', since: '2026-01-02T00:00:00Z', limit: 1 }))).toEqual([2]);
    expect(ids(await run(actor, { since: '2027-01-01T00:00:00Z', limit: 1 }))).toEqual([]);
    expect(ids(await run(actor, { severity: 'critical', limit: 1 }))).toEqual([3]);
  });
  it('denies missing alert permission through the normal policy entry', async () => {
    const result = await run({ ...actor, permissions: [] });
    expect(result.success).toBe(false);
  });
  it('uses current grants on every invocation after revocation', async () => {
    expect(ids(await run(actor))).toEqual([3, 2]);
    expect(ids(await run({ ...actor, instanceScopes: { 1: 'read-only' } }))).toEqual([2, 1]);
  });
});
