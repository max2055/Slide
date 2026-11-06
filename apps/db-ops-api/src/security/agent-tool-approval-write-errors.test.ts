import Fastify from 'fastify';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { agentExecutionConfigService } from './agent-execution-config-service.js';
import { registerAgentToolApprovalRoutes } from './agent-tool-approval-routes.js';
import { registerHttpSecurity } from './http-security.js';

const cases = [
  ['/api/agent/credentials', { toolName: 'slide_add_database', secret: 'synthetic-secret' }, 'CREDENTIAL_REFERENCE_CREATE_FAILED'],
  ['/api/agent/approvals', { toolName: 'execute_code', args: { runtime: 'shell', code: 'curl https://example.com' } }, 'AGENT_APPROVAL_SUBMIT_FAILED'],
  ['/api/agent/approvals/1/review', { action: 'approve' }, 'AGENT_APPROVAL_REVIEW_FAILED'],
  ['/api/agent/approvals/batch-review', { toolName: 'execute_code', action: 'reject' }, 'AGENT_APPROVAL_BATCH_REVIEW_FAILED'],
] as const;

beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', '0123456789abcdef0123456789abcdef');
  vi.stubEnv('AGENT_APPROVAL_HMAC_KEY', 'max350-synthetic-hmac-key-32-characters');
  vi.spyOn(agentExecutionConfigService, 'get').mockResolvedValue({
    approvalEnabled: true, restrictedNetworkEnabled: false, reasonCode: 'EXECUTION_CONFIG_READY',
  });
});

it.skipIf(!process.env.MAX350_MYSQL_PORT)('MAX-350 real HTTP and disposable MySQL: success, conflict and driver failures', async () => {
  const database = `max350_${randomUUID().replaceAll('-', '')}`;
  const pool = mysql.createPool({ host: '127.0.0.1', port: Number(process.env.MAX350_MYSQL_PORT), user: 'root', database });
  const admin = mysql.createPool({ host: '127.0.0.1', port: Number(process.env.MAX350_MYSQL_PORT), user: 'root' });
  const logs: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((_message, diagnostic) => { logs.push(JSON.stringify(diagnostic)); });
  const app = Fastify({ logger: false });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    await pool.query('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY)');
    await pool.query('INSERT INTO users VALUES (9)');
    for (const migration of ['054_agent_tool_approvals', '068_agent_tool_approval_scopes', '056_agent_credential_references']) {
      await pool.query(await readFile(new URL(`../../sql/migrations/${migration}.sql`, import.meta.url), 'utf8'));
    }
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    await registerHttpSecurity(app, { NODE_ENV: 'production', CORS_ORIGINS: 'http://localhost:5173' });
    await registerAgentToolApprovalRoutes(app, async (request) => {
      (request as any).user = { userId: 9, username: 'admin', roles: ['admin'], permissions: ['*'],
        instanceScopes: {}, sessionVersion: 1, requestId: request.id };
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const post = async (url: string, payload: unknown) => {
      const response = await fetch(`${address}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      return { status: response.status, body: await response.json() as any };
    };
    const credential = await post(cases[0][0], cases[0][1]);
    expect(credential.status).toBe(201);
    const submitted = await post(cases[1][0], cases[1][1]);
    expect(submitted.status).toBe(201);
    const url = `/api/agent/approvals/${submitted.body.approvalId}/review`;
    expect((await post(url, { action: 'approve' })).status).toBe(200);
    expect((await post(url, { action: 'reject' })).status).toBe(409);
    expect((await post(cases[1][0], cases[1][1])).status).toBe(201);
    const batch = await post(cases[3][0], cases[3][1]);
    expect(batch.status).toBe(200);
    expect(batch.body.count).toBe(1);
    expect((await post('/api/agent/approvals', {})).status).toBe(400);
    expect((await post('/api/agent/approvals', { toolName: 'unknown', args: {} })).status).toBe(403);
    expect((await post(cases[0][0], { ...cases[0][1], secret: 'x'.repeat(16_385) })).status).toBe(400);
    await pool.query('DROP TABLE agent_tool_approvals');
    await pool.query('DROP TABLE agent_credential_references');
    for (const [route, payload, reasonCode] of cases) {
      const result = await post(route, payload);
      expect(result).toEqual({ status: 503, body: { reasonCode } });
      expect(logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ reasonCode, reqId: expect.any(String) }));
      process.stdout.write(`MAX-350 real HTTP/MySQL failure: ${JSON.stringify({ route, result })}\n`);
    }
    expect(logs.join('')).not.toMatch(/ER_NO_SUCH_TABLE|doesn't exist|synthetic-secret|sqlMessage/);
    const [version] = await pool.query('SELECT VERSION() AS version');
    process.stdout.write(`MAX-350 real MySQL environment: ${JSON.stringify(version)}; success/conflict/validation and four missing-table failures passed\n`);
    process.stdout.write(`MAX-350 sanitized server diagnostics: ${JSON.stringify(logs.map(line => JSON.parse(line)).filter(line => line.reasonCode))}\n`);
  } finally {
    await app.close();
    await pool.end();
    if (created) await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  }
}, 30_000);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('MAX-350 real write routes and services, failing SQL executor', () => {
  it.each(cases)('%s returns a stable error with production HTTP hooks', async (url, payload, reasonCode) => {
    const detail = 'SIMULATED_SQL_INTERNAL_DETAIL';
    const execute = vi.fn().mockRejectedValue(Object.assign(new Error(`${detail} password=synthetic-secret`), {
      sql: 'INSERT synthetic-secret', sqlMessage: detail, code: detail, cause: new Error(detail),
    }));
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({
      execute, getConnection: async () => ({ execute, release: vi.fn(), destroy: vi.fn() }),
    } as any);
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((_message, diagnostic) => { logs.push(JSON.stringify(diagnostic)); });
    const app = Fastify({ logger: { stream: { write: (line: string) => { logs.push(line); } } } });
    await registerHttpSecurity(app, { NODE_ENV: 'production', CORS_ORIGINS: 'http://localhost:5173' });
    await registerAgentToolApprovalRoutes(app, async (request) => {
      (request as any).user = { userId: 9, username: 'admin', roles: ['admin'], permissions: ['*'],
        instanceScopes: {}, sessionVersion: 1, requestId: 'max350' };
    });
    try {
      const response = await app.inject({ method: 'POST', url, payload });
      expect(execute).toHaveBeenCalled();
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ reasonCode });
      const diagnostic = logs.map(line => JSON.parse(line)).find(line => line.reasonCode === reasonCode);
      expect(diagnostic).toMatchObject({ reqId: expect.any(String), operation: expect.any(String), reasonCode });
      expect(logs.join('')).not.toContain(detail);
      expect(logs.join('')).not.toContain('synthetic-secret');
    } finally { await app.close(); }
  });
});
