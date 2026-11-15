import { dbConnection } from './db-connection.js';
import { metricsDatabaseService } from './metrics-database-service.js';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import { describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from './migrations/runner.js';

// Explicit opt-in: injected configuration only; never read private credentials
// during default test collection. Full server + real JWT + disposable MySQL schema.
describe.skipIf(!process.env.CAPACITY_TEST_MYSQL_CONFIG)('MAX-511 / #501 / #527 real HTTP/JWT/MySQL', () => {
  it('rejects invalid prediction periods and preserves complete capacity snapshots across failed and concurrent writes (D1)', async () => {
    const config = JSON.parse(process.env.CAPACITY_TEST_MYSQL_CONFIG!);
    if (Number(config.port) === 3306) throw new Error('Use an isolated test MySQL, not the platform database');
    const schema = `max511_${randomBytes(6).toString('hex')}`;
    const admin = mysql.createPool(config);
    const pool = mysql.createPool({ ...config, database: schema, timezone: 'Z' });
    // Two real writer connections expose leaks and concurrent uncommitted snapshots.
    const writers = mysql.createPool({ ...config, database: schema, timezone: 'Z', connectionLimit: 2 });
    const poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(writers);
    const password = randomBytes(24).toString('hex');
    const secret = randomBytes(32).toString('hex');
    const encryptionKey = randomBytes(32).toString('hex');
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<unknown> | undefined;
    let created = false;
    async function freePort() {
      const server = createServer();
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as { port: number }).port;
      await new Promise<void>(resolve => server.close(() => resolve()));
      return port;
    }
    try {
      await admin.query(`CREATE DATABASE ${schema}`);
      created = true;
      await new MigrationRunner(pool as any).run();
      await pool.execute('UPDATE llm_providers SET enabled=FALSE,is_default=FALSE');
      await pool.execute("INSERT INTO database_instances(id,name,host,port,username,password_encrypted,status) VALUES (10,'max511-a','192.0.2.10',3306,'fixture','fixture','inactive'),(11,'max511-b','192.0.2.11',3306,'fixture','fixture','inactive')");
      const hash = await bcrypt.hash(password, 10);
      const [user] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO users(username,password_hash,status) VALUES ('max511',?,'active')", [hash]);
      const [role] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO roles(name) VALUES ('max511')");
      await pool.execute('INSERT INTO user_roles(user_id,role_id) VALUES (?,?)', [user.insertId, role.insertId]);
      for (const code of ['instance:view', 'capacity:view', 'ai:manage']) {
        await pool.execute('INSERT IGNORE INTO permissions(code,name,resource,action) VALUES (?,?,?,?)', [code, code, ...code.split(':')]);
        await pool.execute('INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code=?', [role.insertId, code]);
      }
      await pool.execute("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES (?,10,'read-only')", [user.insertId]);
      const httpPort = await freePort(), wsPort = await freePort();
      child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
        cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, NODE_ENV: 'test', DB_HOST: config.host, DB_PORT: String(config.port), DB_USER: config.user,
          DB_PASSWORD: config.password, DB_NAME: schema, JWT_SECRET_KEY: secret, ENCRYPTION_KEY: encryptionKey,
          PORT: String(httpPort), AGENT_WS_PORT: String(wsPort), PROMPT_HOT_RELOAD: 'false' },
      });
      closed = once(child, 'close');
      const base = `http://127.0.0.1:${httpPort}`;
      let ready = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('isolated server exited before readiness');
        try { ready = (await fetch(base + '/api/health/ready')).ok; } catch {}
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(ready).toBe(true);
      console.info(`isolated server pid=${child.pid}, HTTP=${httpPort}, WS=${wsPort}, cwd=${process.cwd()}, schema=${schema}`);
      const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'max511', password }) });
      expect(login.status).toBe(200);
      const token = (await login.json() as any).token;
      expect(token).toBeTypeOf('string');
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const details = async (id = 10) => {
        const response = await fetch(base + `/api/database/instances/${id}/capacity/databases`, { headers });
        expect(response.status).toBe(200);
        return (await response.json() as any).databases;
      };
      const history = async () => {
        const response = await fetch(base + '/api/database/instances/10/capacity/history?hours=8784', { headers });
        expect(response.status).toBe(200);
        return (await response.json() as any).history;
      };
      const snapshot = async (at: string, names: string[], instance = 10) => {
        const [result] = await pool.execute<mysql.ResultSetHeader>(
          'INSERT INTO capacity_history(instance_id,recorded_at,db_count) VALUES (?,?,?)', [instance, at, names.length]);
        if (names.length) await pool.query(
          'INSERT INTO capacity_databases(capacity_id,instance_id,db_name,size_gb,table_count,recorded_at) VALUES ?',
          [names.map((name, index) => [result.insertId, instance, name, index + 1, index, at])]);
        return result.insertId;
      };
      expect(await details()).toEqual([]);
      await snapshot('2026-01-01 00:00:00', ['db_a', 'db_b']);
      expect(await details()).toHaveLength(2);
      await snapshot('2026-01-02 00:00:00', ['db_a']);
      expect((await details()).map((r: any) => r.db_name)).toEqual(['db_a']);
      // Newer ID wins identical timestamps; later insertion of an older time must not win.
      await snapshot('2026-01-02 00:00:00', ['tie_winner']);
      await snapshot('2026-01-01 12:00:00', ['backfill']);
      await snapshot('2026-02-01 00:00:00', ['other_instance'], 11);
      expect((await details()).map((r: any) => r.db_name)).toEqual(['tie_winner']);
      await snapshot('2026-01-03 00:00:00', []);
      expect(await details()).toEqual([]);
      const names = Array.from({ length: 151 }, (_, index) => `db_${index}`);
      await snapshot('2026-01-04 00:00:00', names);
      const rows = await details();
      expect(rows).toHaveLength(151);
      expect(new Set(rows.map((r: any) => r.db_name))).toEqual(new Set(names));
      expect(rows[0]).toEqual({ db_name: 'db_150', size_gb: 151, table_count: 150 });
      expect((await fetch(base + '/api/database/instances/11/capacity/databases', { headers })).status).toBe(403);
      expect((await fetch(base + '/api/database/instances/10/capacity/databases')).status).toBe(401);
      console.info('PASS #527: consecutive snapshots, deleted DB, timestamp/id tie, backfill, empty snapshot, 151 DBs, cross-instance isolation, 401/403');
      const [[before]] = await pool.query<any[]>('SELECT COUNT(*) AS n FROM ai_analysis');
      for (const horizon of ['1y', '', '7D', 'toString', '__proto__']) {
        for (const suffix of ['', '/all']) {
          const response = await fetch(base + '/api/ai/capacity/predict' + suffix + '?instance_id=10&metric=connections&horizon=' + encodeURIComponent(horizon), { headers });
          expect(response.status).toBe(400);
        }
        const response = await fetch(base + '/api/ai/analysis', { method: 'POST', headers,
          body: JSON.stringify({ analysis_type: 'capacity_prediction', instance_id: 10, metric: 'connections', horizon }) });
        expect(response.status).toBe(400);
      }
      for (const horizon of [null, false, 0, [], {}]) {
        const response = await fetch(base + '/api/ai/analysis', { method: 'POST', headers,
          body: JSON.stringify({ analysis_type: 'capacity_prediction', instance_id: 10, metric: 'connections', horizon }) });
        expect(response.status).toBe(400);
      }
      const [[after]] = await pool.query<any[]>('SELECT COUNT(*) AS n FROM ai_analysis');
      expect(after.n).toBe(before.n);
      const [[version]] = await pool.query<any[]>('SELECT VERSION() AS version, @@transaction_isolation AS isolation');
      console.info('SQL environment', JSON.stringify(version));
      const good = await metricsDatabaseService.recordCapacity({instance_id:10,total_size_gb:21,db_count:1,databases:[{name:'previous_complete',size_gb:21}]});
      expect(good.success).toBe(true);
      const previous = await details(); expect(previous.map((r:any)=>r.db_name)).toEqual(['previous_complete']);
      const previousHistory = await history();
      const [[beforeFault]] = await pool.query<any[]>('SELECT COUNT(*) AS n FROM capacity_history WHERE instance_id=10');
      await pool.query("CREATE TRIGGER max257_reject_capacity_detail BEFORE INSERT ON capacity_databases FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MAX257_CONTROLLED_DETAIL_FAILURE'");
      const failedWrite = await metricsDatabaseService.recordCapacity({instance_id:10,total_size_gb:99,db_count:1,databases:[{name:'should_not_publish',size_gb:99}]});
      expect(failedWrite.success).toBe(false);
      const actual = await details();
      const [[afterFault]] = await pool.query<any[]>('SELECT COUNT(*) AS n FROM capacity_history WHERE instance_id=10');
      console.log('MAX257_CAPACITY_ATOMICITY',JSON.stringify({before:previous,after:actual,beforeHeaders:beforeFault.n,afterHeaders:afterFault.n,failedWrite:failedWrite.success}));
      expect(actual).toEqual(previous);
      expect(afterFault.n).toBe(beforeFault.n);
      expect(await history()).toEqual(previousHistory);
      // More failures than the pool size, then success: failed transactions return
      // their connections and never leave an uncommitted header in the next lease.
      for (let i = 0; i < 3; i++) {
        expect((await metricsDatabaseService.recordCapacity({ instance_id: 10, total_size_gb: 99,
          databases: [{ name: 'rejected', size_gb: 99 }] })).success).toBe(false);
      }
      await pool.query('DROP TRIGGER max257_reject_capacity_detail');
      expect(await metricsDatabaseService.recordCapacity({ instance_id: 10, total_size_gb: 22,
        databases: [{ name: 'after_rollback', size_gb: 22 }] })).toEqual({ success: true });
      expect(await details()).toEqual([{ db_name: 'after_rollback', size_gb: 22, table_count: 0 }]);
      const [[counts]] = await pool.query<any[]>('SELECT db_count FROM capacity_history WHERE instance_id=10 ORDER BY recorded_at DESC,id DESC LIMIT 1');
      expect(counts.db_count).toBe(1);
      console.info('PASS D1: 4 detail failures rolled back; two-connection pool reused; SQL count and authenticated HTTP preserved complete results');

      // Pause both production commits after real INSERTs. Every HTTP read while
      // those transactions are in flight must still observe one old full snapshot.
      let resume!: () => void, bothInserted!: () => void;
      const gate = new Promise<void>(resolve => { resume = resolve; });
      const inserted = new Promise<void>(resolve => { bothInserted = resolve; });
      let arrivals = 0;
      const acquire = writers.getConnection.bind(writers);
      const acquireSpy = vi.spyOn(writers, 'getConnection').mockImplementation(async () => {
        const connection = await acquire();
        const commit = connection.commit.bind(connection);
        connection.commit = async () => {
          if (++arrivals === 2) bothInserted();
          await gate;
          await commit();
        };
        return connection;
      });
      const pending = ['a', 'b'].map(prefix => metricsDatabaseService.recordCapacity({ instance_id: 10,
        total_size_gb: 151, databases: Array.from({ length: 151 }, (_, i) => ({ name: `${prefix}_${i}`, size_gb: 1 })) }));
      try {
        await Promise.race([inserted, new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('concurrent writers did not reach commit')), 5000);
          inserted.finally(() => clearTimeout(timer));
        })]);
        for (let i = 0; i < 5; i++) expect(await details()).toEqual([{ db_name: 'after_rollback', size_gb: 22, table_count: 0 }]);
      } finally {
        resume();
        acquireSpy.mockRestore();
        expect(await Promise.all(pending)).toEqual([{ success: true }, { success: true }]);
      }
      const [[latest]] = await pool.query<any[]>('SELECT id FROM capacity_history WHERE instance_id=10 ORDER BY recorded_at DESC,id DESC LIMIT 1');
      const [latestDetails] = await pool.query<any[]>('SELECT db_name FROM capacity_databases WHERE capacity_id=?', [latest.id]);
      const concurrent = await details();
      expect(concurrent).toHaveLength(151);
      expect(new Set(concurrent.map((r: any) => r.db_name))).toEqual(new Set(latestDetails.map((r: any) => r.db_name)));
      const [audit] = await pool.query<any[]>(`SELECT h.id,h.db_count,COUNT(d.id) AS details
        FROM capacity_history h LEFT JOIN capacity_databases d ON d.capacity_id=h.id
        WHERE h.instance_id=10 GROUP BY h.id ORDER BY h.id`);
      expect(audit.every(row => Number(row.db_count) === Number(row.details))).toBe(true);
      console.info('SQL snapshot completeness audit', JSON.stringify(audit));
      console.info('PASS D1 concurrency: 2 real same-instance transactions; 5 JWT/HTTP reads before commits; final SQL-selected snapshot has all 151 databases');

      // Historical headers with a positive count prove missing details; a zero
      // or NULL count supplies no such evidence and must remain compatible.
      await pool.execute('DELETE FROM capacity_databases WHERE instance_id=10');
      await pool.execute('DELETE FROM capacity_history WHERE instance_id=10');
      const legacy = await snapshot('2026-01-01 00:00:00', ['legacy_complete']);
      await pool.execute('UPDATE capacity_history SET db_count=NULL WHERE id=?', [legacy]);
      await pool.execute("UPDATE capacity_databases SET recorded_at='2026-01-01 00:00:01' WHERE capacity_id=?", [legacy]);
      expect((await details()).map((r: any) => r.db_name)).toEqual(['legacy_complete']);
      expect((await metricsDatabaseService.getCapacityDatabases(10, new Date('2026-01-01T00:00:00Z'))).map(r => r.db_name)).toEqual(['legacy_complete']);
      const half = await snapshot('2026-01-02 00:00:00', ['partial']);
      await pool.execute('UPDATE capacity_history SET db_count=2 WHERE id=?', [half]);
      await pool.execute("INSERT INTO capacity_history(instance_id,recorded_at,db_count,total_size_gb) VALUES(10,'2026-01-03',1,99)");
      expect((await details()).map((r: any) => r.db_name)).toEqual(['legacy_complete']);
      expect(await metricsDatabaseService.getCapacityDatabases(10, new Date('2026-01-02T00:00:00Z'))).toEqual([]);
      const tie = await snapshot('2026-01-01 00:00:00', ['legacy_tie']);
      expect((await metricsDatabaseService.getCapacityDatabases(10, new Date('2026-01-01T00:00:00Z'))).map(r => r.db_name)).toEqual(['legacy_tie']);
      expect(await metricsDatabaseService.getCapacityHistory(10, 24 * 366)).toHaveLength(2);
      expect(await history()).toHaveLength(2);
      await snapshot('2026-01-04 00:00:00', []);
      expect(await details()).toEqual([]);
      expect(await metricsDatabaseService.getCapacityHistory(10, 24 * 366)).toHaveLength(3);
      expect(await history()).toHaveLength(3);
      await pool.execute('UPDATE capacity_history SET db_count=0 WHERE id=?', [tie]);
      expect((await metricsDatabaseService.getCapacityDatabases(10, new Date('2026-01-01T00:00:00Z'))).map(r => r.db_name)).toEqual(['legacy_tie']);
      // Real writer empty snapshot (including an omitted databases argument)
      // must publish and supersede the previous full result.
      for (const databases of [[], undefined]) {
        expect(await metricsDatabaseService.recordCapacity({ instance_id: 10, total_size_gb: 0, databases })).toEqual({ success: true });
        expect(await details()).toEqual([]);
      }
      console.info('PASS D1 legacy: NULL/zero counts, header/detail time drift, count-positive missing/partial details, timestamp tie, real empty and omitted lists; history excludes only identifiable incomplete snapshots');
      // The same JWT must observe live instance-scope revocation.
      await pool.execute('DELETE FROM instance_permissions WHERE user_id=?', [user.insertId]);
      expect((await fetch(base + '/api/database/instances/10/capacity/databases', { headers })).status).toBe(403);
      console.info('PASS #501: three production routes reject malformed periods; no analysis writes; live scope revocation; LLM disabled');
    } finally {
      if (child && closed) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        const timer = setTimeout(() => {
          if (child!.exitCode === null && child!.signalCode === null) child!.kill('SIGKILL');
        }, 15000);
        try { await closed; } finally { clearTimeout(timer); }
      }
      poolSpy.mockRestore();
      await writers.end();
      await pool.end();
      if (created) {
        await admin.query(`DROP DATABASE ${schema}`);
        const [[remaining]] = await admin.query<any[]>('SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name=?', [schema]);
        expect(remaining.n).toBe(0);
      }
      await admin.end();
      console.info('cleanup: owned server stopped, disposable schema dropped');
    }
  }, 120000);
});
