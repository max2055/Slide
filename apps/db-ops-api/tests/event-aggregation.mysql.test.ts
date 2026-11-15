import { randomBytes } from 'node:crypto';
import { actorContextService, signAccessToken } from '../src/auth/actor-context.js';
import { createVerifyToken } from '../src/auth-middleware.js';
import { requirePermission } from '../src/auth/require-permission.js';
import { requireUnrestrictedInstanceAccess } from '../src/auth/require-instance-access.js';
import Fastify from 'fastify';
import { transpileModule } from 'typescript';
import mysql, { type Pool } from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { MigrationRunner } from '../src/migrations/runner.js';
import type { MigrationPool } from '../src/migrations/types.js';
const state = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock('../src/db-connection', () => ({ dbConnection: { getPool: () => state.pool } }));
// External model admission has its own persisted ownership tests. Never send LLM requests here.
vi.mock('../src/investigations/automatic-alert-admission.js', () => ({ recoverAutomaticAlertAdmissions: vi.fn() }));
import { eventAggregator } from '../src/event-aggregator.js';
const profilePath = process.env.AGGREGATION_MYSQL_PROFILE;
describe.skipIf(!profilePath)('MAX-566 full-schema MySQL aggregation', () => {
  let admin: Pool, pool: Pool, smallPool: Pool;
  const database = `max566_${process.pid}`;
  beforeAll(async () => {
    const profile = JSON.parse(readFileSync(profilePath!, 'utf8'))['mysql-test'];
    if (Number(profile.port) !== 3308) throw new Error('Expected dedicated test endpoint');
    const options = { host: profile.host, port: profile.port, user: profile.user, password: profile.password };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database, connectionLimit: 2 });
    smallPool = mysql.createPool({ ...options, database, connectionLimit: 1 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    state.pool = pool;
    await pool.query("INSERT INTO database_instances (id,name,host,port,username,password_encrypted,db_type) VALUES (1,'max566','127.0.0.1',3308,'fixture','fixture','mysql')");
  }, 120_000);
  afterAll(async () => {
    state.pool = null;
    await smallPool?.end();
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });
  beforeEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS fail_member');
    await pool.query('DROP TRIGGER IF EXISTS fail_log');
    for (const table of ['alert_event_logs','alert_event_members','alert_events','alerts']) await pool.query(`DELETE FROM ${table}`);
    await pool.query("INSERT INTO alerts(instance_id,alert_type,metric_name,level,title,message) VALUES (1,'performance','cpu','warning','fixture','fixture'),(1,'performance','cpu','critical','fixture','fixture')");
  });
  async function counts() {
    const [rows] = await pool.query<any[]>(`SELECT (SELECT COUNT(*) FROM alert_events) events, (SELECT COUNT(*) FROM alert_event_members) members, (SELECT COUNT(*) FROM alert_event_logs) logs`);
    return rows[0];
  }
  it('concurrent manual/scheduled callers commit one group, repeat is idempotent', async () => {
    const app = Fastify();
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const start = source.indexOf("  fastify.post('/api/alerts/aggregate'");
    const routes = source.slice(start, source.indexOf('  const startWorkers', start));
    await pool.query("INSERT INTO users(id,username,password_hash) VALUES(566,'aggregate-operator','no-login')");
    await pool.query("INSERT INTO roles(id,name) VALUES(566,'aggregate-test')");
    await pool.query("INSERT INTO user_roles(user_id,role_id) VALUES(566,566)");
    await pool.query("INSERT IGNORE INTO permissions(code,name,resource,action) VALUES('instance:*','fixture global instances','instance','*')");
    await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 566,id FROM permissions WHERE code IN ('alert:manage','instance:*')");
    const secret = randomBytes(32).toString('hex');
    const token = signAccessToken((await actorContextService.loadActiveActor(566))!,secret);
    new Function('fastify','verifyToken','requirePermission','requireUnrestrictedInstanceAccess','eventAggregator',
      transpileModule(routes, {}).outputText)(app, createVerifyToken(secret), requirePermission, requireUnrestrictedInstanceAccess, eventAggregator);
    let results;
    try {
      const [http, scheduled] = await Promise.all([app.inject({method:'POST',url:'/api/alerts/aggregate',headers:{authorization:`Bearer ${token}`}}), eventAggregator.aggregate()]);
      expect(http.statusCode).toBe(200);
      results = [http.json(), scheduled];
      expect((await app.inject({method:'POST',url:'/api/alerts/aggregate'})).statusCode).toBe(401);
      await pool.query('DELETE FROM role_permissions WHERE role_id=566');
      expect((await app.inject({method:'POST',url:'/api/alerts/aggregate',headers:{authorization:`Bearer ${token}`}})).statusCode).toBe(403);
    } finally { await app.close(); }
    expect(results.reduce((n,r) => n+r.eventsCreated,0)).toBe(1);
    expect(results.reduce((n,r) => n+r.alertsAggregated,0)).toBe(2);
    expect(await counts()).toEqual({events:1,members:2,logs:1});
    expect(await eventAggregator.aggregate()).toEqual({eventsCreated:0,alertsAggregated:0});
  });
  it('MAX-566 counts only the first committed group when the second log fails', async () => {
    await pool.query("INSERT INTO alerts(instance_id,alert_type,metric_name,level,title,message) VALUES (1,'performance','disk','warning','next','next'),(1,'performance','disk','warning','next','next')");
    await pool.query(`CREATE TRIGGER fail_log BEFORE INSERT ON alert_event_logs FOR EACH ROW BEGIN
      IF EXISTS(SELECT 1 FROM alert_event_members m JOIN alerts a ON a.id=m.alert_id WHERE m.event_id=NEW.event_id AND a.metric_name='disk') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected';
      END IF; END`);
    expect(await eventAggregator.aggregate()).toEqual({eventsCreated:1,alertsAggregated:2});
    expect(await counts()).toEqual({events:1,members:2,logs:1});
  });
  it('supports pool size one without nested acquisition', async () => {
    state.pool = smallPool;
    try { expect(await eventAggregator.aggregate()).toEqual({eventsCreated:1,alertsAggregated:2}); }
    finally { state.pool = pool; }
  });
  it('absorbs into the existing event atomically, retaining previous committed members on failure', async () => {
    expect(await eventAggregator.aggregate()).toEqual({eventsCreated:1,alertsAggregated:2});
    await pool.query("INSERT INTO alerts(instance_id,alert_type,metric_name,level,title,message) VALUES (1,'performance','cpu','warning','next','next'),(1,'performance','cpu','warning','next','next')");
    await pool.query("CREATE TRIGGER fail_log BEFORE INSERT ON alert_event_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected'");
    expect(await eventAggregator.aggregate()).toEqual({eventsCreated:0,alertsAggregated:0});
    expect(await counts()).toEqual({events:1,members:2,logs:1});
    await pool.query('DROP TRIGGER fail_log');
    expect(await eventAggregator.aggregate()).toEqual({eventsCreated:0,alertsAggregated:2});
    expect(await counts()).toEqual({events:1,members:4,logs:2});
  });
  for (const [trigger,table] of [['fail_member','alert_event_members'],['fail_log','alert_event_logs']]) {
    it(`rolls back event and all members on ${table} error then recovers`, async () => {
      const condition = table === 'alert_event_members' ? '(SELECT COUNT(*) FROM alert_event_members)>0' : 'TRUE';
      await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW BEGIN IF ${condition} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected'; END IF; END`);
      expect(await eventAggregator.aggregate()).toEqual({eventsCreated:0,alertsAggregated:0});
      expect(await counts()).toEqual({events:0,members:0,logs:0});
      await pool.query(`DROP TRIGGER ${trigger}`);
      expect(await eventAggregator.aggregate()).toEqual({eventsCreated:1,alertsAggregated:2});
    });
  }
});
