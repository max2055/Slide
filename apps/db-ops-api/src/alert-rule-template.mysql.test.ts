/** Explicit opt-in: production route slice/JWT/permissions/full migrations/isolated MySQL. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import ts from 'typescript';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import { dbConnection } from './db-connection.js';
import { MigrationRunner } from './migrations/runner.js';
import { createOwnedDatabase } from './testing/owned-fixture.js';
import { actorContextService, signAccessToken } from './auth/actor-context.js';
import { createVerifyToken } from './auth-middleware.js';
import { requirePermission } from './auth/require-permission.js';
import { strictBody } from './utils/strict-body.js';
import { alertRuleTemplateService } from './alert-rule-template-service.js';

describe.skipIf(process.env.SLIDE_TEMPLATE_MYSQL !== '1')('MAX-579 #486/#487 real template API', () => {
  let root: mysql.Pool, pool: mysql.Pool, token: string;
  let owned: Awaited<ReturnType<typeof createOwnedDatabase>>;
  const app = Fastify();
  beforeAll(async () => {
    const file = process.env.SLIDE_TEST_PROFILES_FILE, handleDir = process.env.SLIDE_TEST_HANDLE_DIR;
    if (!file || !handleDir) throw Error('explicit profile and handle directory required');
    const c = JSON.parse(readFileSync(file, 'utf8'))['mysql-test'];
    if (Number(c.port) !== 3308) throw Error('expected authorized test port 3308');
    root = mysql.createPool({ host: c.host, port: c.port, user: c.user, password: c.password });
    owned = await createOwnedDatabase(root as any, { nonce: randomBytes(8).toString('hex'), purpose: 'max579', handleDir });
    pool = mysql.createPool({ host: c.host, port: c.port, user: c.user, password: c.password, database: owned.database, connectionLimit: 2 });
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    await new MigrationRunner(pool as any).run();
    await pool.query("INSERT INTO users(id,username,password_hash) VALUES(701,'template-fixture','no-login')");
    await pool.query("INSERT INTO roles(id,name) VALUES(701,'template-fixture')");
    await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 701,id FROM permissions WHERE code='alert:manage'");
    await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(701,701)');
    const secret = randomBytes(32).toString('hex');
    token = signAccessToken(await actorContextService.loadActiveActor(701), secret);
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const start = source.indexOf('  // 创建告警模板\n'), end = source.indexOf('  // 删除告警模板\n', start);
    if (start < 0 || end < 0) throw Error('route boundary missing');
    new Function('fastify', 'verifyToken', 'requirePermission', 'alertRuleTemplateService', 'strictBody',
      ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    )(app, createVerifyToken(secret), requirePermission, alertRuleTemplateService, strictBody);
  }, 120000);
  afterAll(async () => {
    await app.close(); vi.restoreAllMocks(); await pool?.end();
    try { await owned?.drop(); } finally { await root?.end(); }
  });
  const request = (method: 'POST' | 'PUT', payload: unknown, id?: number) => app.inject({
    method, url: '/api/alert-rule-templates' + (id ? '/' + id : ''), headers: { authorization: 'Bearer ' + token }, payload: payload as any,
  });
  const valid = { name: '即时模板', metric_name: 'cpu_usage', operator: '>=', threshold_template: { warning: 0, critical: 12.5 } };
  it('persists zero/default, rejects invalid writes without changing rows, recovers and enforces live permissions', async () => {
    const created = await request('POST', { ...valid, duration_seconds: 0 });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    expect((await alertRuleTemplateService.getTemplate(id))?.duration_seconds).toBe(0);
    const omitted = await request('POST', valid);
    expect(omitted.statusCode).toBe(200);
    expect((await alertRuleTemplateService.getTemplate(omitted.json().id))?.duration_seconds).toBe(60);
    const before = await pool.query('SELECT * FROM alert_rule_templates ORDER BY id');
    const execute = vi.spyOn(pool, 'execute');
    for (const patch of [
      { operator: 'invalid' }, { target_type: [] }, { severity: 'fatal' },
      { threshold_template: [] }, { threshold_template: { warning: '5' } }, { threshold_template: { unknown: 1 } },
      ...[-1, 0.5, 2147483648, '0', null, {}].map(duration_seconds => ({ duration_seconds })),
    ]) {
      execute.mockClear();
      expect((await request('POST', { ...valid, ...patch })).statusCode).toBe(400);
      expect((await request('PUT', patch, id)).statusCode).toBe(400);
      expect(execute.mock.calls.some(([sql]) => /INSERT|UPDATE/.test(String(sql)))).toBe(false);
    }
    expect((await pool.query('SELECT * FROM alert_rule_templates ORDER BY id'))[0]).toEqual(before[0]);
    expect((await request('PUT', { duration_seconds: 60 }, id)).statusCode).toBe(200);
    expect((await request('PUT', { duration_seconds: 0 }, id)).statusCode).toBe(200);
    expect((await alertRuleTemplateService.getTemplate(id))?.duration_seconds).toBe(0);
    expect((await app.inject({ method: 'POST', url: '/api/alert-rule-templates', payload: valid })).statusCode).toBe(401);
    await pool.query('DELETE FROM role_permissions WHERE role_id=701');
    expect((await request('POST', valid)).statusCode).toBe(403);
    expect((await request('PUT', { duration_seconds: 5 }, id)).statusCode).toBe(403);
    expect((await alertRuleTemplateService.getTemplate(id))?.duration_seconds).toBe(0);
  });
});
