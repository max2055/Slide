import Fastify from 'fastify';
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
  vi.stubEnv('AGENT_APPROVAL_HMAC_KEY', 'max350-synthetic-hmac-key');
  vi.spyOn(agentExecutionConfigService, 'get').mockResolvedValue({
    approvalEnabled: true, restrictedNetworkEnabled: false, reasonCode: 'EXECUTION_CONFIG_READY',
  });
});
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
      expect(diagnostic).toMatchObject({ level: 50, reqId: expect.any(String), operation: expect.any(String), reasonCode });
      expect(logs.join('')).not.toContain(detail);
      expect(logs.join('')).not.toContain('synthetic-secret');
    } finally { await app.close(); }
  });
});
