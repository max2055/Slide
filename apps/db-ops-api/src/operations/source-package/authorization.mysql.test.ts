/** Exclusive synthetic SQL/JWT/HTTP only; never the existing source/restore. */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import { ActorContextService, signAccessToken } from '../../auth/actor-context.js';
import { INVESTIGATION_SERVICE_PASSWORD } from '../../auth/investigation-service-identity.js';
import { InvestigationAuthorization } from '../../investigations/authorization.js';
import { InvestigationSessionBridge } from '../../investigations/session-bridge.js';
import { registerInvestigationRoutes } from '../../investigations/routes.js';
import { createVerifyToken } from '../../auth-middleware.js';
import { AgentSecurityPolicyService, DEFAULT_AGENT_ID } from '../../security/agent-security-policy-service.js';
import { authorizeSourceContinuation, sourceReadTools } from './authorization.js';
import { bytesHash } from './config.js';
import { sourceTestConfig } from './config.fixture.js';

const port = Number(process.env.V23_SOURCE_TEST_MYSQL_PORT ?? 0);
describe.skipIf(!port)('pre-consumption CLI authorization with real SQL/JWT/HTTP', () => {
  const database = `slide_v23_source_${randomBytes(8).toString('hex')}`;
  const reports: unknown[] = [];
  const secret = randomBytes(32).toString('hex');
  let root: Pool, pool: Pool, contexts: ActorContextService, bridge: InvestigationSessionBridge;
  let config: ReturnType<typeof sourceTestConfig>, token: string;
  const rows = async (sql: string, values: any[] = []) => (await pool.execute<RowDataPacket[]>(sql, values))[0];
  const snapshot = async () => {
    const tables = await rows('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME', [database]);
    const values: Record<string, string> = {};
    for (const { name } of tables) {
      const content = await rows(`SELECT * FROM \`${name}\``);
      values[name] = bytesHash(JSON.stringify(content.map(r => JSON.stringify(r)).sort()));
    }
    return values;
  };
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', timezone: 'Z' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, timezone: 'Z' });
    pool.on('connection', c => c.query("SET time_zone='+00:00'"));
    await new MigrationRunner(pool).run();
    await rows("UPDATE users SET username='synthetic-admin',password_hash='disabled' WHERE id=1");
    await rows("DELETE FROM user_roles WHERE user_id=1");
    await rows("INSERT INTO users(id,username,password_hash) VALUES(7,'slide-investigation-authority',?)", [INVESTIGATION_SERVICE_PASSWORD]);
    await rows("INSERT INTO roles(id,name) VALUES(120,'synthetic-global'),(121,'synthetic-server-reader')");
    await rows("INSERT IGNORE INTO permissions(code,name,resource,action) VALUES('*','synthetic all','*','*')");
    await rows("INSERT INTO role_permissions(role_id,permission_id) SELECT 120,id FROM permissions WHERE code='*'");
    await rows("INSERT INTO role_permissions(role_id,permission_id) SELECT 121,id FROM permissions WHERE code IN ('chat:view','servers:view')");
    await rows('INSERT INTO user_roles(user_id,role_id) VALUES(1,120),(7,121)');
    await rows("INSERT INTO servers(id,host,port,label,credential_type,credential_encrypted,host_key_fingerprint,os_type) VALUES(3,'192.168.49.130',22,'synthetic','password','unused',?,'rhel')", [sourceTestConfig().target.hostFingerprint]);
    await rows("INSERT INTO database_instances(id,name,host,port,username,password_encrypted,db_type,status) VALUES(101,'synthetic','127.0.0.1',3308,'unused','unused','mysql','active')");
    await rows('DELETE FROM alert_rules');
    await rows("INSERT INTO alert_rules(id,name,metric_name,operator,threshold,duration_seconds,severity,target_type,server_id,enabled,notification_channels) VALUES(1,'synthetic','filesystem_used_bytes','>',1,0,'warning','server',3,1,'[]')");
    contexts = new ActorContextService(() => pool as never);
    bridge = new InvestigationSessionBridge(() => pool, new InvestigationAuthorization(contexts));
    const service = { ...await contexts.loadInvestigationActorFrom(pool as never, 7, 'service', 1),
      resourceBoundary: { instanceIds: [], serverIds: [3], networkDeviceIds: [] } };
    const created = await bridge.create(service, { title: 'synthetic original', goal: 'read server3', profileId: 'ops', profileVersion: 1,
      resources: [{ type: 'server', id: 3, role: 'primary' }], idempotencyKey: randomUUID() }, { message: 'read', idempotencyKey: randomUUID() });
    config = { ...sourceTestConfig(), database, phase: 'continue', actorId: 1, serviceActorId: 7,
      investigationId: created.investigation.id, requestId: created.acceptance!.requestId };
    await rows("INSERT INTO investigation_members(investigation_id,user_id,role,granted_by,expires_at) VALUES(?,1,'viewer',7,NULL)", [config.investigationId]);
    await new AgentSecurityPolicyService(() => pool as never).update(DEFAULT_AGENT_ID, { toolAllowlist: null, skillAllowlist: null,
      allowedEffects: ['read'], resourceScope: { instanceIds: [], serverIds: [3], networkDeviceIds: [] }, changeNote: 'synthetic only' }, 1);
    token = signAccessToken(await contexts.loadActiveActor(1), secret);
  }, 120000);
  afterAll(async () => { await writeFile(resolve('.qualification/authority-sql-http-result.json'), JSON.stringify({ database, realSql: true, realJwt: true, modelSends: 0, reports }, null, 2)); await pool?.end(); if (root) { await root.query(`DROP DATABASE ${database}`); await root.end(); } });
  const authorize = (c = config, jwt = token) => authorizeSourceContinuation(pool, c, jwt, secret);
  it('read detail is permitted but a global-admin viewer cannot continue', async () => {
    const before = await snapshot();
    const caller = await contexts.authenticateAccessToken(token, secret);
    expect(caller.permissions).toContain('*');
    expect(await bridge.storeFor(caller).detail({ kind: 'user', id: 1 }, config.investigationId!)).toBeTruthy();
    await expect(authorize()).rejects.toThrow('AUTHORIZATION_REJECTED');
    expect(await snapshot()).toEqual(before);
  });
  it('operator preflight preserves original server3/service7/four-tool ceiling and writes nothing', async () => {
    await rows("UPDATE investigation_members SET role='operator',expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 5 MINUTE) WHERE investigation_id=? AND user_id=1", [config.investigationId]);
    try {
      const before = await snapshot(), result = await authorize();
      expect(result.execution.actor).toEqual({ kind: 'service', id: 7 });
      expect([...result.execution.toolAllowlist].sort()).toEqual([...sourceReadTools].sort());
      expect(result.execution.resourceBoundary).toEqual({ instanceIds: [], serverIds: [3], networkDeviceIds: [] });
      expect(result.execution.permissions).toEqual(['chat:view', 'servers:view']);
      expect(await snapshot()).toEqual(before);
      reports.push({ case: 'operator', ...result, tableCount: Object.keys(before).length, unchanged: true });
    } finally { await rows("UPDATE investigation_members SET role='viewer',expires_at=NULL WHERE investigation_id=? AND user_id=1", [config.investigationId]); }
  });
  it.each(['missing','expired','revoked','wrong-user','wrong-session','expired-jwt','invalid-jwt','disabled-user','resource','service-session','policy-tool','policy-resource'])('rejects %s without any durable write', async kind => {
    const [member] = await rows('SELECT * FROM investigation_members WHERE investigation_id=? AND user_id=1', [config.investigationId]);
    const [policy] = await rows('SELECT * FROM agent_security_policies WHERE agent_id=?', [DEFAULT_AGENT_ID]);
    let c = config, jwt = token;
    await rows("UPDATE investigation_members SET role='operator' WHERE investigation_id=? AND user_id=1", [config.investigationId]);
    try {
      if (kind === 'missing' || kind === 'revoked') await rows('DELETE FROM investigation_members WHERE investigation_id=? AND user_id=1', [config.investigationId]);
      if (kind === 'expired') await rows('UPDATE investigation_members SET expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE investigation_id=? AND user_id=1', [config.investigationId]);
      if (kind === 'wrong-user') c = { ...config, actorId: 2 };
      if (kind === 'wrong-session') c = { ...config, sessionVersion: 2 };
      if (kind === 'expired-jwt') jwt = signAccessToken(await contexts.loadActiveActor(1), secret, -1);
      if (kind === 'invalid-jwt') jwt = token + 'tampered';
      if (kind === 'disabled-user') await rows("UPDATE users SET status='inactive' WHERE id=1");
      if (kind === 'resource') await rows("UPDATE investigation_resources SET resource_id=4 WHERE investigation_id=?", [config.investigationId]);
      if (kind === 'service-session') await rows('UPDATE users SET session_version=2 WHERE id=7');
      if (kind === 'policy-tool') await rows("UPDATE agent_security_policies SET tool_allowlist='[]' WHERE agent_id=?", [DEFAULT_AGENT_ID]);
      if (kind === 'policy-resource') await rows("UPDATE agent_security_policies SET resource_scope=JSON_OBJECT('serverIds',JSON_ARRAY(4)) WHERE agent_id=?", [DEFAULT_AGENT_ID]);
      const before = await snapshot();
      await expect(authorize(c, jwt)).rejects.toThrow('AUTHORIZATION_REJECTED');
      expect(await snapshot()).toEqual(before);
    } finally {
      await rows('DELETE FROM investigation_members WHERE investigation_id=? AND user_id=1', [config.investigationId]);
      await rows('INSERT INTO investigation_members(investigation_id,user_id,role,granted_by,expires_at) VALUES(?,1,?,?,?)', [config.investigationId,member.role,member.granted_by,member.expires_at]);
      await rows("UPDATE users SET status='active',session_version=1 WHERE id IN(1,7)");
      await rows('UPDATE investigation_resources SET resource_id=3 WHERE investigation_id=?', [config.investigationId]);
      await rows('UPDATE agent_security_policies SET tool_allowlist=?,resource_scope=? WHERE agent_id=?', [policy.tool_allowlist === null ? null : JSON.stringify(policy.tool_allowlist),JSON.stringify(policy.resource_scope),DEFAULT_AGENT_ID]);
    }
  });
  it('production JWT/Bridge/HTTP still refuses membership revoked after preflight', async () => {
    await rows("UPDATE investigation_members SET role='operator' WHERE investigation_id=? AND user_id=1", [config.investigationId]);
    const result = await authorize();
    await rows("UPDATE investigation_members SET role='viewer' WHERE investigation_id=? AND user_id=1", [config.investigationId]);
    const before = await snapshot();
    const app = Fastify();
    await registerInvestigationRoutes(app, createVerifyToken(secret, contexts), bridge);
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const response = await fetch(`${address}/api/investigations/${config.investigationId}/runs`, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ expectedVersion: result.version, message: 'synthetic no send' }) });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'INVESTIGATION_OPERATION_FORBIDDEN' });
      expect(await snapshot()).toEqual(before);
    } finally { await app.close(); }
  });
  it('minimal temporary membership CAS admits one writer, rejects mismatch/expiry and restores exact viewer tuple', async () => {
    const [original] = await rows('SELECT * FROM investigation_members WHERE investigation_id=? AND user_id=1', [config.investigationId]);
    const deadline = new Date(Math.floor((Date.now() + 300000) / 1000) * 1000);
    const grant = async (id: string, grantor = 7, until = deadline) => {
      const c = await pool.getConnection();
      try {
        await c.beginTransaction();
        const sql = readFileSync(new URL('../../../../../scripts/qualification/v23-source-membership-grant.sql', import.meta.url), 'utf8');
        const [changed] = await c.execute<mysql.ResultSetHeader>(sql, [until,id,grantor,until,until,until,new Date(Date.now()+14400000)]);
        if (changed.affectedRows !== 1) throw Error('CAS_REJECTED');
        await c.commit(); return true;
      } catch (e) { await c.rollback(); throw e; } finally { c.release(); }
    };
    try {
      const before = await snapshot();
      for (const [id,by,until] of [[randomUUID(),7,deadline],[config.investigationId!,1,deadline],
        [config.investigationId!,7,new Date(0)],[config.investigationId!,7,new Date(Date.now()+14401000)]] as const)
        await expect(grant(id,by,until)).rejects.toThrow('CAS_REJECTED');
      expect(await snapshot()).toEqual(before);
      const concurrent = await Promise.allSettled([grant(config.investigationId!),grant(config.investigationId!)]);
      expect(concurrent.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect((await authorize()).execution.toolAllowlist).toHaveLength(4);
      const restoreSql = readFileSync(new URL('../../../../../scripts/qualification/v23-source-membership-restore.sql', import.meta.url), 'utf8');
      const [wrongRestore] = await pool.execute<mysql.ResultSetHeader>(restoreSql, [config.investigationId,new Date(0)]);
      expect(wrongRestore.affectedRows).toBe(0);
      const [restored] = await pool.execute<mysql.ResultSetHeader>(restoreSql, [config.investigationId,deadline]);
      expect(restored.affectedRows).toBe(1);
      expect((await rows('SELECT * FROM investigation_members WHERE investigation_id=? AND user_id=1', [config.investigationId]))[0]).toEqual(original);
      expect(await snapshot()).toEqual(before);
      await expect(authorize()).rejects.toThrow('AUTHORIZATION_REJECTED');
    } finally {
      await rows("UPDATE investigation_members SET role='viewer',granted_by=7,expires_at=NULL WHERE investigation_id=? AND user_id=1", [config.investigationId]);
    }
  });
  it.each(['viewer','missing','expired','revoked','wrong-user','wrong-session','invalid-jwt','resource','service-session','policy-tool','operator-no-parent'])('actual CLI rejects %s before audit/intent/lease/API/SSH/model side effects', async kind => {
    await rows("UPDATE investigation_members SET role='operator' WHERE investigation_id=? AND user_id=1", [config.investigationId]);
    if (kind === 'viewer') await rows("UPDATE investigation_members SET role='viewer' WHERE investigation_id=? AND user_id=1", [config.investigationId]);
    if (kind === 'missing' || kind === 'revoked') await rows('DELETE FROM investigation_members WHERE investigation_id=? AND user_id=1', [config.investigationId]);
    if (kind === 'expired') await rows('UPDATE investigation_members SET expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE investigation_id=? AND user_id=1', [config.investigationId]);
    if (kind === 'service-session') await rows('UPDATE users SET session_version=2 WHERE id=7');
    if (kind === 'resource') await rows('UPDATE investigation_resources SET resource_id=4 WHERE investigation_id=?', [config.investigationId]);
    if (kind === 'policy-tool') await rows("UPDATE agent_security_policies SET tool_allowlist='[]' WHERE agent_id=?", [DEFAULT_AGENT_ID]);
    try {
    const before = await snapshot();
    const dir = await mkdtemp(resolve('.qualification/authority-cli-'));
    const file = join(dir, 'config.json'), lock = join(dir, 'lock.json'), jwt = join(dir, 'jwt');
    const c = { ...config, ...(kind === 'wrong-user' ? { actorId: 2 } : {}), ...(kind === 'wrong-session' ? { sessionVersion: 2 } : {}), operationId: randomUUID(), deadline: new Date(Date.now() + 120000).toISOString() }, bytes = JSON.stringify(c);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await writeFile(file, bytes, { mode: 0o600 }); await writeFile(jwt, kind === 'invalid-jwt' ? token + 'tampered' : token, { mode: 0o600 });
    await writeFile(lock, JSON.stringify({ issue: 'MAX-203', operationId: c.operationId, configHash: bytesHash(bytes), head,
      target: '192.168.49.130:22/mysql:3308', expiresAt: c.deadline }), { mode: 0o600 });
    const { auditFixture } = await import('./audit.fixture.js');
    await writeFile(join(dir, 'synthetic-parent-envelope.json'), auditFixture().authorize().envelope, { mode: 0o600 });
    const child = spawn(process.execPath, ['--import', 'tsx', '../../scripts/qualification/v23-source-package.ts', '--config', file], {
      env: { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'root', DB_PASSWORD: '', DB_NAME: database,
        JWT_SECRET_KEY: secret, ENCRYPTION_KEY: randomBytes(32).toString('hex'),
        V23_SOURCE_PARENT_AUDIT_FILE: join(dir, kind === 'operator-no-parent' ? 'not-provisioned.json' : 'synthetic-parent-envelope.json'), V23_SOURCE_TARGET_LOCK_FILE: lock, V23_SOURCE_JWT_FILE: jwt,
        OPERATIONS_ACTION_DISPATCH_ENABLED: 'false', OPERATIONS_STOP_NEW_DISPATCH: 'true',
        INVESTIGATION_OPS_AUTO_ENABLED: 'false', METRICS_COLLECTION_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout!.on('data', b => output += b); child.stderr!.on('data', b => output += b);
    const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    const [exit] = await once(child, 'exit'); clearTimeout(timer);
    await writeFile(join(dir, 'cli.log'), output);
    expect(exit).toBe(1);
    const audit = await readFile(`/Users/max/Coding/40-Slide/outputs/2026-10-18-v23-source/${c.operationId}/result.jsonl`, 'utf8');
    expect(audit).toContain(kind === 'operator-no-parent' ? 'V23_SOURCE_AUTHORIZATION_CHECKED' : 'V23_SOURCE_AUTHORIZATION_REJECTED');
    expect(audit).not.toContain('"api"');
    expect(await snapshot()).toEqual(before);
    reports.push({ case: `actual-cli-${kind}`, pid: child.pid, exit, tableCount: Object.keys(before).length, allTablesUnchanged: true, apiStarted: false, auditConsumed: false, leaseWritten: false });
    expect((await rows("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB=? AND COMMAND<>'Sleep' AND ID<>CONNECTION_ID()", [database]))[0].n).toBe(0);
    } finally {
      await rows('DELETE FROM investigation_members WHERE investigation_id=? AND user_id=1', [config.investigationId]);
      await rows("INSERT INTO investigation_members(investigation_id,user_id,role,granted_by) VALUES(?,1,'viewer',7)", [config.investigationId]);
      await rows('UPDATE users SET session_version=1 WHERE id=7');
      await rows('UPDATE investigation_resources SET resource_id=3 WHERE investigation_id=?', [config.investigationId]);
      await rows('UPDATE agent_security_policies SET tool_allowlist=NULL WHERE agent_id=?', [DEFAULT_AGENT_ID]);
    }
  }, 45000);
});
