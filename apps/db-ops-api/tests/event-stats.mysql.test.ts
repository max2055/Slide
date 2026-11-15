import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { dbConnection } from '../src/db-connection.js';
import { MigrationRunner } from '../src/migrations/runner.js';
import { alertEventService } from '../src/alert-event-service.js';
import { registerEventReadRoutes } from '../src/alert-event-access.js';
import { createVerifyToken } from '../src/auth-middleware.js';
import { actorContextService, signAccessToken } from '../src/auth/actor-context.js';

// Explicit injected connection only. Default CI collection needs no local credentials.
const config = process.env.EVENT_STATS_MYSQL_CONFIG;
describe.skipIf(!config)('MAX-577 full-schema event statistics / HTTP authority', () => {
  const schema = 'max577_' + process.pid + '_' + Date.now();
  const app = Fastify();
  const zero = { total: 0, open: 0, investigating: 0, handled: 0, resolved: 0, closed: 0 };
  let admin: mysql.Connection;
  let pool: mysql.Pool;
  let headers: { authorization: string };
  beforeAll(async () => {
    const options = JSON.parse(config!);
    if (Number(options.port) !== 3308) throw Error('Expected dedicated test endpoint');
    delete options.database;
    admin = await mysql.createConnection(options);
    await admin.query('CREATE DATABASE ' + schema);
    if (!await dbConnection.initialize({ ...options, database: schema })) throw Error('Test database initialization failed');
    pool = dbConnection.getPool()!;
    await new MigrationRunner(pool as any).run();
    await pool.query("INSERT INTO users(id,username,password_hash) VALUES(577,'max577','no-login')");
    await pool.query("INSERT INTO roles(id,name) VALUES(577,'max577')");
    await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(577,577)');
    await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 577,id FROM permissions WHERE code='alert:view'");
    const secret = randomBytes(32).toString('hex');
    headers = { authorization: 'Bearer ' + signAccessToken((await actorContextService.loadActiveActor(577))!, secret) };
    await registerEventReadRoutes(app, createVerifyToken(secret));
  }, 120_000);
  afterAll(async () => {
    await app.close();
    await dbConnection.close();
    if (admin) {
      await admin.query('DROP DATABASE IF EXISTS ' + schema);
      await admin.end();
    }
  });
  async function httpStats() {
    const response = await app.inject({ url: '/api/alerts/events/stats', headers });
    expect(response.statusCode).toBe(200);
    return response.json();
  }
  it('empty database and empty authorized set return six numeric zeros', async () => {
    expect(await alertEventService.getEventStats()).toEqual(zero);
    expect(await alertEventService.getEventStats([])).toEqual(zero);
    expect(await httpStats()).toEqual(zero);
  });
  it('populated database never falls back outside the authorized range; grouped counts are numbers', async () => {
    await pool.query("INSERT INTO database_instances(id,name,host,port,username,password_encrypted) VALUES(577,'allowed','fixture.invalid',3308,'fixture','unused'),(578,'hidden','hidden.invalid',3308,'fixture','unused')");
    const statuses = ['open','investigating','handled','resolved','closed'];
    for (const status of statuses) {
      await pool.execute("INSERT INTO alert_events(event_id,title,severity,status,instance_id) VALUES(?,?,'warning',?,577)", [randomBytes(16).toString('hex'), status, status]);
    }
    await pool.query("INSERT INTO alert_events(event_id,title,severity,status,instance_id) VALUES('hidden','hidden','critical','open',578)");
    expect(await alertEventService.getEventStats([], [])).toEqual(zero);
    expect(await alertEventService.getEventStats([999])).toEqual(zero);
    expect(await httpStats()).toEqual(zero);
    await pool.query("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(577,577,'read-only')");
    const expected = { total: 5, open: 1, investigating: 1, handled: 1, resolved: 1, closed: 1 };
    expect(await alertEventService.getEventStats([577], [])).toEqual(expected);
    expect(await httpStats()).toEqual(expected);
    expect(await alertEventService.getEventStats()).toEqual({ ...expected, total: 6, open: 2 });
    await pool.query('DELETE FROM instance_permissions WHERE user_id=577');
    expect(await httpStats()).toEqual(zero);
    expect((await app.inject({url:'/api/alerts/events/stats'})).statusCode).toBe(401);
    await pool.query('DELETE FROM role_permissions WHERE role_id=577');
    expect((await app.inject({url:'/api/alerts/events/stats',headers})).statusCode).toBe(403);
  });
});
