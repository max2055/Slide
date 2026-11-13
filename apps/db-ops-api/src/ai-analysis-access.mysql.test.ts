import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { parse } from 'dotenv';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import { describe, expect, it } from 'vitest';
import { MigrationRunner } from './migrations/runner.js';
import { analysisAccessSql, canReadAnalysis } from './analysis/analysis-access.js';
import type { ActorContext } from './auth/actor-context.js';

// Opt-in, disposable real schema + unmodified server.ts + login-issued JWT.
// Credentials are read in memory, never copied into arguments or test output.
describe.skipIf(!process.env.MAX331_MYSQL_ENV)('MAX-331 real HTTP/JWT/MySQL analysis access', () => {
  it('authorizes all reads, pagination, filters, counts and live revocation', async () => {
    const env = parse(readFileSync(process.env.MAX331_MYSQL_ENV!, 'utf8'));
    const config = { host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306), user: env.DB_USER || 'root', password: env.DB_PASSWORD || '' };
    const schema = `max331_${randomBytes(6).toString('hex')}`;
    const admin = mysql.createPool(config);
    const pool = mysql.createPool({ ...config, database: schema, timezone: 'Z' });
    const password = randomBytes(24).toString('hex');
    const secret = randomBytes(32).toString('hex');
    const encryptionKey = randomBytes(32).toString('hex');
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<unknown> | undefined;
    let logs = '';
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
      console.log(`MAX331 disposable schema created: ${schema}`);
      await new MigrationRunner(pool as any).run();
      await pool.execute('UPDATE llm_providers SET enabled=FALSE,is_default=FALSE');
      await pool.execute("INSERT INTO database_instances(id,name,host,port,username,password_encrypted,status) VALUES (10,'max331-a','192.0.2.10',3306,'fixture','fixture','inactive'),(11,'max331-b','192.0.2.11',3306,'fixture','fixture','inactive')");
      await pool.execute("INSERT INTO servers(id,host,os_type,credential_type,credential_encrypted,collection_enabled) VALUES (20,'192.0.2.20','linux','password','fixture',0),(21,'192.0.2.21','linux','password','fixture',0)");
      await pool.execute("INSERT INTO network_devices(id,name,host,collection_enabled) VALUES (30,'max331-a','192.0.2.30',0),(31,'max331-b','192.0.2.31',0)");
      const subjects = [
        ['instance', 10, null, null], ['instance', 11, null, null],
        ['server', null, 20, null], ['server', null, 21, null],
        ['network_device', null, null, 30], ['network_device', null, null, 31],
        ['instance', null, null, null], ['server', 10, 20, null],
      ];
      for (const [index, subject] of subjects.entries()) {
        await pool.execute(`INSERT INTO ai_analysis(id,analysis_type,target_type,instance_id,server_id,network_device_id,status,result,related_id,created_at)
          VALUES (?,'fault_diagnosis',?,?,?,?,'completed',?,77,UTC_TIMESTAMP())`, [index + 1, ...subject, JSON.stringify({ marker: `private-${index + 1}` })]);
      }
      const profiles = {
        none: [], ai: ['ai:view'], instance: ['ai:view'], server: ['ai:view', 'servers:view'],
        network: ['ai:view', 'network_devices:view'], instanceAll: ['ai:view', 'instance:*'], all: ['*'],
      };
      const hash = await bcrypt.hash(password, 10);
      for (const [name, permissions] of Object.entries(profiles)) {
        const [user] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO users(username,password_hash,status) VALUES (?,?,'active')", [`max331_${name}`, hash]);
        const [role] = await pool.execute<mysql.ResultSetHeader>('INSERT INTO roles(name) VALUES (?)', [`max331_${name}`]);
        await pool.execute('INSERT INTO user_roles(user_id,role_id) VALUES (?,?)', [user.insertId, role.insertId]);
        for (const code of permissions) {
          await pool.execute('INSERT IGNORE INTO permissions(code,name,resource,action) VALUES (?,?,?,?)', [code, code, code.split(':')[0], code.split(':')[1] || '*']);
          await pool.execute('INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code=?', [role.insertId, code]);
        }
        if (name === 'instance') await pool.execute("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES (?,10,'read-only')", [user.insertId]);
      }

      // Compare SQL with response authorization against real MySQL, including
      // delegated wildcard actors that interactive JWTs cannot manufacture.
      const [records] = await pool.query<any[]>('SELECT * FROM ai_analysis ORDER BY id');
      for (const permissions of [[], ['instance:*'], ['servers:*'], ['network_devices:view'], ['*'], ['*:view']]) {
        for (const boundary of [undefined, { instanceIds: [10], serverIds: [20], networkDeviceIds: [30] }, { instanceIds: [], serverIds: [], networkDeviceIds: [] }]) {
          const actor: ActorContext = { userId: 1, username: 'matrix', roles: [], permissions, sessionVersion: 1, instanceScopes: { 10: 'read-only' }, requestId: 'matrix', resourceBoundary: boundary };
          const access = analysisAccessSql(actor);
          const [visible] = await pool.execute<any[]>(`SELECT id FROM ai_analysis WHERE ${access.sql} ORDER BY id`, access.params);
          expect(visible.map(row => row.id)).toEqual(records.filter(row => canReadAnalysis(actor, row)).map(row => row.id));
        }
      }
      console.log('PASS real MySQL: 18 SQL/response authorization equivalence cases including delegation');

      const httpPort = await freePort(), wsPort = await freePort();
      child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
        cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'test', DB_HOST: config.host, DB_PORT: String(config.port), DB_USER: config.user, DB_PASSWORD: config.password, DB_NAME: schema,
          JWT_SECRET_KEY: secret, ENCRYPTION_KEY: encryptionKey, PORT: String(httpPort), AGENT_WS_PORT: String(wsPort), PROMPT_HOT_RELOAD: 'false' },
      });
      closed = once(child, 'close');
      child.stdout!.on('data', chunk => { logs += String(chunk); });
      child.stderr!.on('data', chunk => { logs += String(chunk); });
      const base = `http://127.0.0.1:${httpPort}`;
      let ready = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('isolated server exited before readiness');
        try { ready = (await fetch(`${base}/api/health/ready`)).ok; } catch {}
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(ready).toBe(true);
      console.log(`isolated server pid=${child.pid}, HTTP=${httpPort}, WS=${wsPort}, command=node --import tsx server.ts, schema=${schema}`);
      const tokens: Record<string, string> = {};
      for (const name of Object.keys(profiles)) {
        const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: `max331_${name}`, password }) });
        expect(response.status).toBe(200);
        tokens[name] = (await response.json() as any).token;
        expect(tokens[name]).toBeTypeOf('string');
      }
      async function get(name: string, path: string, status = 200) {
        const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${tokens[name]}` } });
        expect(response.status, `${name} ${path}`).toBe(status);
        return await response.json() as any;
      }
      expect((await fetch(`${base}/api/ai/analysis`)).status).toBe(401);
      await get('none', '/api/ai/analysis', 403);
      const expected: Record<string, number[]> = { ai: [], instance: [1], server: [4, 3], network: [6, 5], instanceAll: [2, 1], all: [6, 5, 4, 3, 2, 1] };
      for (const [name, ids] of Object.entries(expected)) {
        expect((await get(name, '/api/ai/analysis')).map((row: any) => row.id)).toEqual(ids);
        expect((await get(name, '/api/ai/analysis/history?limit=20')).records.map((row: any) => row.id)).toEqual(ids);
        const stats = await get(name, '/api/dashboard/ai-stats');
        expect(stats.today_total).toBe(ids.length);
        expect(stats.breakdown).toEqual(ids.length ? { fault_diagnosis: ids.length } : {});
        for (let page = 1; page <= ids.length + 1; page++) {
          expect((await get(name, `/api/ai/analysis?limit=1&page=${page}`)).map((row: any) => row.id)).toEqual(ids.slice(page - 1, page));
        }
      }
      console.log('PASS HTTP: 401/403, all resource positive/negative cases, history, stable pagination and counts');
      for (const query of ['server_id=20', 'network_device_id=30', 'instance_id=11', 'target_type=server', 'target_type=global', 'related_id=77&status=completed', 'analysis_type=fault_diagnosis']) {
        expect(await get('ai', `/api/ai/analysis?${query}`)).toEqual([]);
      }
      expect((await get('server', '/api/ai/analysis?target_type=server&server_id=20&related_id=77&status=completed')).map((row: any) => row.id)).toEqual([3]);
      expect((await get('network', '/api/ai/analysis/history?target_type=network_device&network_device_id=30')).records.map((row: any) => row.id)).toEqual([5]);
      expect((await get('instance', '/api/ai/analysis/recent?instance_id=10&analysis_type=fault_diagnosis')).map((row: any) => row.id)).toEqual([1]);
      await get('instance', '/api/ai/analysis/recent?instance_id=11&analysis_type=fault_diagnosis', 403);
      for (const path of ['/api/ai/analysis/3', '/api/ai/analysis/3/status', '/api/ai/analysis/status/3']) {
        await get('ai', path, 404); await get('server', path);
      }
      for (const id of [7, 8]) await get('all', `/api/ai/analysis/${id}`, 404);
      console.log('PASS HTTP: filter isolation, recent, detail/status bypass denial, malformed/global NULL rows rejected even with *');

      await pool.execute("DELETE rp FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id WHERE r.name='max331_server' AND p.code='servers:view'");
      expect(await get('server', '/api/ai/analysis')).toEqual([]);
      expect((await get('server', '/api/dashboard/ai-stats')).today_total).toBe(0);
      await get('server', '/api/ai/analysis/3', 404);
      await pool.execute("UPDATE instance_permissions ip JOIN users u ON u.id=ip.user_id SET ip.grant_expiry=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE u.username='max331_instance'");
      expect(await get('instance', '/api/ai/analysis')).toEqual([]);
      console.log('PASS HTTP: same JWT observes module revocation and expired instance grant; LLM calls=0');
      for (const value of [password, secret, encryptionKey, ...Object.values(tokens)]) expect(logs.includes(value)).toBe(false);
    } catch (error) {
      // Keep failures diagnosable without emitting arbitrary child logs or secrets.
      console.error('MAX331 isolated acceptance failed; startup markers:', logs.split('\n').filter(line => /READY|FATAL|Error:/.test(line)).map(line => line.slice(0, 200)).slice(-10));
      throw error;
    } finally {
      if (child && closed) {
        // Exact owned child only; no shared services or workspace daemon touched.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        const timer = setTimeout(() => { if (child!.exitCode === null && child!.signalCode === null) child!.kill('SIGKILL'); }, 15000);
        await closed;
        clearTimeout(timer);
      }
      await pool.end();
      if (created) await admin.query(`DROP DATABASE ${schema}`);
      await admin.end();
      console.log('MAX331 cleanup: isolated server stopped and disposable schema dropped');
    }
  }, 180000);
});
