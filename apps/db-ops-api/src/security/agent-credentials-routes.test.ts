import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAgentToolApprovalRoutes } from './agent-tool-approval-routes.js';
import { dbConnection } from '../db-connection.js';

// MAX-349 / #563: real route, platform registry and credential service.
beforeEach(() => vi.stubEnv('ENCRYPTION_KEY', '0123456789abcdef0123456789abcdef'));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function request(secret: unknown) {
  const app = Fastify();
  await registerAgentToolApprovalRoutes(app, async (req) => {
    (req as any).user = {
      userId: 9, username: 'admin', roles: ['admin'], permissions: ['*'],
      sessionVersion: 1, instanceScopes: {}, requestId: 'max-349',
    };
  });
  try {
    return await app.inject({ method: 'POST', url: '/api/agent/credentials',
      payload: { toolName: 'slide_add_database', secret } });
  } finally {
    await app.close();
  }
}

describe('Credential creation input and failure boundary', () => {
  it.each(['x'.repeat(16_385), '', null, 123])('rejects invalid secret before accessing storage %#', async (secret) => {
    const pool = vi.spyOn(dbConnection, 'getPool').mockImplementation(() => { throw new Error('must not access storage'); });
    const response = await request(secret);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ reasonCode: 'CREDENTIAL_REFERENCE_INPUT_INVALID' });
    expect(pool).not.toHaveBeenCalled();
  });

  it('accepts exactly 16384 characters and stores encrypted data without echoing the secret', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    const secret = 'x'.repeat(16_384);
    const response = await request(secret);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ credentialRef: expect.any(String), toolName: 'slide_add_database', expiresAt: expect.any(String) });
    expect(execute).toHaveBeenCalledOnce();
    const values = execute.mock.calls[0][1];
    expect(values[3]).not.toBe(secret);
    expect(response.body).not.toContain(secret);
  });

  it.each(['unavailable', 'database failure', 'zero rows'])('returns a stable sanitized service error: %s', async (failure) => {
    const execute = vi.fn().mockImplementation(async () => {
      if (failure === 'database failure') throw new Error('private database details');
      return [{ affectedRows: 0 }];
    });
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(failure === 'unavailable' ? null : { execute } as any);
    const response = await request('synthetic-secret');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ reasonCode: 'CREDENTIAL_REFERENCE_CREATE_FAILED' });
  });
});
