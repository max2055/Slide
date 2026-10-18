/** Exclusive synthetic SQL/JWT/HTTP only; never the existing source/restore. */
import { randomBytes, randomUUID } from 'node:crypto';
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
import { bytesHash } from './config.js';
import { sourceTestConfig } from './config.fixture.js';

const port = Number(process.env.V23_SOURCE_TEST_MYSQL_PORT ?? 0);
describe.skipIf(!port)('pre-consumption CLI authorization with real SQL/JWT/HTTP', () => {
  const database = `slide_v23_source_${randomBytes(8).toString('hex')}`;
  const secret = randomBytes(32).toString('hex');
  let root: Pool, pool: Pool, contexts: ActorContextService, bridge: InvestigationSessionBridge;
  let config: ReturnType<typeof sourceTestConfig>, token: string;
  const rows = async (sql: string, values: unknown[] = []) => (await pool.execute<RowDataPacket[]>(sql, values))[0];
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
  afterAll(async () => { await pool?.end(); if (root) { await root.query(`DROP DATABASE ${database}`); await root.end(); } });
  it('actual CLI rejects global-admin viewer before audit/intent/lease/API/SSH/model side effects', async () => {
    const before = await snapshot();
    const dir = await mkdtemp(resolve('.qualification/authority-cli-'));
    const file = join(dir, 'config.json'), lock = join(dir, 'lock.json'), jwt = join(dir, 'jwt');
    const c = { ...config, deadline: new Date(Date.now() + 120000).toISOString() }, bytes = JSON.stringify(c);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await writeFile(file, bytes, { mode: 0o600 }); await writeFile(jwt, token, { mode: 0o600 });
    await writeFile(lock, JSON.stringify({ issue: 'MAX-203', operationId: c.operationId, configHash: bytesHash(bytes), head,
      target: '192.168.49.130:22/mysql:3308', expiresAt: c.deadline }), { mode: 0o600 });
    const child = spawn(process.execPath, ['--import', 'tsx', '../../scripts/qualification/v23-source-package.ts', '--config', file], {
      env: { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'root', DB_PASSWORD: '', DB_NAME: database,
        JWT_SECRET_KEY: secret, ENCRYPTION_KEY: randomBytes(32).toString('hex'),
        V23_SOURCE_PARENT_AUDIT_FILE: '', V23_SOURCE_TARGET_LOCK_FILE: lock, V23_SOURCE_JWT_FILE: jwt,
        OPERATIONS_ACTION_DISPATCH_ENABLED: 'false', OPERATIONS_STOP_NEW_DISPATCH: 'true',
        INVESTIGATION_OPS_AUTO_ENABLED: 'false', METRICS_COLLECTION_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout!.on('data', b => output += b); child.stderr!.on('data', b => output += b);
    const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    const [exit] = await once(child, 'exit'); clearTimeout(timer);
    await writeFile(join(dir, 'cli.log'), output);
    expect(exit).toBe(1);
    const audit = await readFile(`/Users/max/Coding/40-Slide/outputs/2026-10-18-v23-source/${c.operationId}/result.jsonl`, 'utf8');
    expect(audit).toContain('V23_SOURCE_AUTHORIZATION_REJECTED');
    expect(audit).not.toContain('"api"');
    expect(await snapshot()).toEqual(before);
    expect((await rows("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB=? AND COMMAND<>'Sleep' AND ID<>CONNECTION_ID()", [database]))[0].n).toBe(0);
  }, 45000);
});
