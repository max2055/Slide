/** MAX-409/410/419: explicit, disposable real MySQL acceptance. No external sends. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import { dbConnection } from './db-connection.js';
import { MigrationRunner } from './migrations/runner.js';
import { createOwnedDatabase } from './testing/owned-fixture.js';
import { maintenanceWindowService as service } from './maintenance-window-service.js';
import { maintenanceBlocksDelivery } from './maintenance-notification.js';
import { registerMaintenanceRoutes } from './maintenance-routes.js';
import { actorContextService, signAccessToken } from './auth/actor-context.js';
import { createVerifyToken } from './auth-middleware.js';

const enabled = process.env.SLIDE_MAINTENANCE_MYSQL === '1';
describe.skipIf(!enabled)('MAX-409/410/419 real MySQL maintenance acceptance', () => {
  let root: mysql.Pool, pool: mysql.Pool;
  let owned: Awaited<ReturnType<typeof createOwnedDatabase>>;
  const app = Fastify();
  let token: string;
  beforeAll(async () => {
    // Explicit opt-in must fail when configuration is missing; default collection reads no credentials.
    const file = process.env.SLIDE_TEST_PROFILES_FILE;
    const handleDir = process.env.SLIDE_TEST_HANDLE_DIR;
    if (!file || !handleDir) throw Error('SLIDE_TEST_PROFILES_FILE and SLIDE_TEST_HANDLE_DIR required');
    const config = JSON.parse(readFileSync(file, 'utf8'))['mysql-test'];
    if (Number(config.port) === 3306) throw Error('platform database is forbidden for this fixture');
    console.info('maintenance acceptance phase: schema allocation');
    root = mysql.createPool({ host: config.host, port: config.port, user: config.user, password: config.password });
    owned = await createOwnedDatabase(root as any, { nonce: randomBytes(8).toString('hex'), purpose: 'maintenance', handleDir });
    pool = mysql.createPool({ host: config.host, port: config.port, user: config.user, password: config.password, database: owned.database, connectionLimit: 4 });
    pool.on('connection', c => { c.query("SET time_zone = '+00:00'"); });
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    console.info('maintenance acceptance phase: formal migrations');
    await new MigrationRunner(pool as any).run();
    console.info('maintenance acceptance phase: seed and authentication');
    await pool.query("INSERT INTO database_instances(id,name,host,port,username,password_encrypted) VALUES(701,'maintenance fixture','fixture.invalid',3307,'fixture','unused'),(702,'other fixture','other.fixture.invalid',3307,'fixture','unused')");
    await pool.query("INSERT INTO users(id,username,password_hash) VALUES(701,'maintenance-fixture','no-login')");
    await pool.query("INSERT INTO roles(id,name) VALUES(701,'maintenance-fixture')");
    await pool.query("INSERT IGNORE INTO permissions(code,name,resource,action) VALUES('maintenance:manage','维护','maintenance','manage'),('instance:manage','管理','instance','manage')");
    await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 701,id FROM permissions WHERE code IN ('maintenance:manage','instance:manage')");
    await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(701,701)');
    await pool.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(701,701,'read-write')");
    const secret = randomBytes(32).toString('hex');
    token = signAccessToken(await actorContextService.loadActiveActor(701), secret);
    await registerMaintenanceRoutes(app, createVerifyToken(secret));
  }, 120000);
  afterAll(async () => {
    console.info('maintenance acceptance phase: cleanup');
    vi.useRealTimers();
    await app.close();
    vi.restoreAllMocks();
    await pool?.end();
    try { await owned?.drop(); } finally { await root?.end(); }
  });
  it('writes, checks, suppresses and rejects invalid edits without changing stored state', async () => {
    const [zone] = await pool.query<any[]>('SELECT @@session.time_zone AS zone');
    expect(zone[0].zone).toBe('+00:00');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T15:00:00Z')); // Sunday 23:00 Shanghai
    const global = await service.createMaintenanceWindow({ name: 'global', day_of_week: '*', start_time: '23:00', end_time: '02:00', timezone: 'Asia/Shanghai' });
    const local = await service.createMaintenanceWindow({ name: 'local', instance_id: 701, day_of_week: '1', start_time: '23:00', end_time: '02:00', timezone: 'Asia/Shanghai' });
    expect(global.success).toBe(true); expect(local.success).toBe(true);
    expect((await service.isActiveMaintenanceWindow(701)).window?.id).toBe(local.id);
    expect((await service.isActiveMaintenanceWindow(702)).window?.id).toBe(global.id);
    // Exercise the production pre-transport suppression lookup, backed entirely by MySQL.
    await pool.query("INSERT INTO alerts(id,instance_id,metric_name,alert_type,level,title,message,created_at) VALUES(701,701,'fixture','performance','warning','fixture','fixture','2026-11-01 15:00:00')");
    expect(await maintenanceBlocksDelivery(701)).toBe(true);
    for (const at of ['2026-11-01T15:59:59Z', '2026-11-01T16:00:00Z', '2026-11-01T17:59:59Z']) {
      vi.setSystemTime(new Date(at));
      expect((await service.isActiveMaintenanceWindow(701)).window?.id).toBe(local.id);
      expect(await maintenanceBlocksDelivery(701)).toBe(true);
    }
    vi.setSystemTime(new Date('2026-11-01T18:00:00Z'));
    expect((await service.isActiveMaintenanceWindow(701)).active).toBe(false);
    expect(await maintenanceBlocksDelivery(701)).toBe(false);
    vi.setSystemTime(new Date('2026-11-01T14:59:59Z'));
    expect((await service.isActiveMaintenanceWindow(701)).active).toBe(false);
    expect((await service.updateMaintenanceWindow(local.id!, { day_of_week: '1,4,7', start_time: '09:00', end_time: '10:00' })).success).toBe(true);
    vi.setSystemTime(new Date('2026-11-04T01:00:00Z')); // Wednesday 09:00 Shanghai
    expect((await service.isActiveMaintenanceWindow(701)).window?.id).toBe(local.id);
    expect(await maintenanceBlocksDelivery(701)).toBe(true);
    const [before] = await pool.query<any[]>('SELECT * FROM maintenance_windows WHERE id=?', [local.id]);
    for (const changed of [{ day_of_week: 'abc' }, { day_of_week: '8' }, { start_time: '24:00' }]) {
      expect((await service.updateMaintenanceWindow(local.id!, changed)).success).toBe(false);
      const response = await app.inject({ method: 'PUT', url: `/api/maintenance-windows/${local.id}`, headers: { authorization: `Bearer ${token}` }, payload: { operation_key: 'invalid-' + randomBytes(4).toString('hex'), expected_revision: 0, value: { name: 'local', reason: '', resources: [{ type: 'instance', id: 701 }], day_of_week: '1,4,7', start_time: '09:00', end_time: '10:00', timezone: 'Asia/Shanghai', ...changed } } });
      expect(response.statusCode).toBe(400);
    }
    const [after] = await pool.query<any[]>('SELECT * FROM maintenance_windows WHERE id=?', [local.id]);
    expect(after).toEqual(before);
    // Existing live authorization and optimistic revision contracts stay in force.
    vi.useRealTimers();
    const value = { name: 'edited', reason: 'valid', resources: [{ type: 'instance', id: 701 }], day_of_week: '*', start_time: '23:00', end_time: '02:00', timezone: 'Asia/Shanghai' };
    const edit = (key: string) => app.inject({ method: 'PUT', url: `/api/maintenance-windows/${local.id}`, headers: { authorization: `Bearer ${token}` }, payload: { operation_key: key, expected_revision: 0, value } });
    const responses = await Promise.all([edit('concurrent-a'), edit('concurrent-b')]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409]);
    await pool.query('DELETE FROM instance_permissions WHERE user_id=701');
    expect((await edit('revoked')).statusCode).toBe(403);
    const [history] = await pool.query<any[]>('SELECT COUNT(*) AS n FROM maintenance_weekly_history WHERE id=?', [local.id]);
    expect(Number(history[0].n)).toBe(1);
  }, 30000);
});
