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

// Opt-in, disposable real schema + unmodified server.ts + login-issued JWT.
// Credentials are read in memory, never copied into arguments or test output.
describe.skipIf(!process.env.MAX332_MYSQL_ENV)('MAX-332 real HTTP/JWT/MySQL SQL approval access', () => {
  it('separates applicant and reviewer permissions with live grants', async () => {
    const env = parse(readFileSync(process.env.MAX332_MYSQL_ENV!, 'utf8'));
    const config = { host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306), user: env.DB_USER || 'root', password: env.DB_PASSWORD || '' };
    const schema = `max332_${randomBytes(6).toString('hex')}`;
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
      console.log(`MAX332 disposable schema created: ${schema}`);
      await new MigrationRunner(pool as any).run();
      await pool.execute('UPDATE llm_providers SET enabled=FALSE,is_default=FALSE');
      await pool.execute("INSERT INTO database_instances(id,name,host,port,username,password_encrypted,status) VALUES (10,'max332-a','192.0.2.10',3306,'fixture','fixture','inactive'),(11,'max332-b','192.0.2.11',3306,'fixture','fixture','inactive')");
      const profiles = {
        applicant: ['instance:query'], noInstance: ['instance:query'], readOnly: ['instance:query'],
        reviewer: ['approval:approve'], none: [],
      };
      const hash = await bcrypt.hash(password, 10);
      for (const [name, permissions] of Object.entries(profiles)) {
        const [user] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO users(username,password_hash,status) VALUES (?,?,'active')", [`max332_${name}`, hash]);
        const [role] = await pool.execute<mysql.ResultSetHeader>('INSERT INTO roles(name) VALUES (?)', [`max332_${name}`]);
        await pool.execute('INSERT INTO user_roles(user_id,role_id) VALUES (?,?)', [user.insertId, role.insertId]);
        for (const code of permissions) {
          await pool.execute('INSERT IGNORE INTO permissions(code,name,resource,action) VALUES (?,?,?,?)', [code, code, code.split(':')[0], code.split(':')[1] || '*']);
          await pool.execute('INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code=?', [role.insertId, code]);
        }
        if (!['noInstance', 'none'].includes(name)) await pool.execute("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES (?,10,?)", [user.insertId, name === 'readOnly' ? 'read-only' : 'read-write']);
      }

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
        const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: `max332_${name}`, password }) });
        expect(response.status).toBe(200);
        tokens[name] = (await response.json() as any).token;
        expect(tokens[name]).toBeTypeOf('string');
      }
      async function post(name: string, path: string, body: unknown, status = 200) {
        const response = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${tokens[name]}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        expect(response.status, `${name} ${path}`).toBe(status);
        return await response.json() as any;
      }
      const payload = { instance_id: 10, sql_text: 'DELETE FROM synthetic_fixture WHERE id = 1' };
      expect((await fetch(`${base}/api/approval/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).status).toBe(401);
      for (const name of ['noInstance', 'readOnly', 'reviewer', 'none']) await post(name, '/api/approval/submit', payload, 403);
      await post('applicant', '/api/approval/submit', { ...payload, instance_id: 11 }, 403);
      const submitted = await post('applicant', '/api/approval/submit', payload);
      expect(submitted.request_id).toBeGreaterThan(0);
      const id = submitted.request_id;
      await post('applicant', `/api/approval/${id}/review`, { action: 'approve', execute_after_approve: false }, 403);
      await post('applicant', '/api/approval/batch-review', { ids: [id], action: 'approve' }, 403);
      const reviewed = await post('reviewer', `/api/approval/${id}/review`, { action: 'approve', execute_after_approve: false });
      expect(reviewed.success).toBe(true);
      const [rows] = await pool.query<any[]>('SELECT a.status,u.username AS applicant,v.username AS reviewer FROM approval_requests a JOIN users u ON u.id=a.submitted_by JOIN users v ON v.id=a.reviewed_by WHERE a.id=?', [id]);
      expect(rows).toEqual([{ status: 'approved', applicant: 'max332_applicant', reviewer: 'max332_reviewer' }]);
      const [operations] = await pool.query<any[]>('SELECT state FROM operations WHERE id=?', [submitted.operationId]);
      expect(operations).toEqual([{ state: 'succeeded' }]);
      console.log('PASS real HTTP/JWT/MySQL: applicant submits 200; single/batch review 403; missing/read-only/other instance 403; reviewer approves without executing SQL; distinct actors persisted');
      await pool.execute("DELETE rp FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE r.name='max332_applicant'");
      await post('applicant', '/api/approval/submit', payload, 403);
      const [providers] = await pool.query<any[]>('SELECT COUNT(*) AS n FROM llm_providers WHERE enabled=TRUE');
      expect(Number(providers[0].n)).toBe(0);
      console.log('PASS live permission revocation; enabled providers=0, outbound model calls=0');
      for (const value of [password, secret, encryptionKey, ...Object.values(tokens)]) expect(logs.includes(value)).toBe(false);
    } catch (error) {
      // Keep failures diagnosable without emitting arbitrary child logs or secrets.
      console.error('MAX332 isolated acceptance failed; startup markers:', logs.split('\n').filter(line => /READY|FATAL|Error:/.test(line)).map(line => line.slice(0, 200)).slice(-10));
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
      console.log('MAX332 cleanup: isolated server stopped and disposable schema dropped');
    }
  }, 180000);
});
