import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { requirePermission } from './auth/require-permission.js';
import { hasInstanceAccess } from './auth/require-instance-access.js';
import { strictBody } from './utils/strict-body.js';
import { classifySql } from './sql-validator.js';

// Execute the production registration verbatim; server.ts starts workers on import.
const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const route = source.slice(source.indexOf("  fastify.post('/api/approval/submit'"), source.indexOf('  async function requireApprovalAccess'));
const registration = ts.transpileModule(route, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

describe('MAX-332 production SQL submit route', () => {
  async function submit(permissions: string[], access?: string) {
    const app = Fastify();
    const submitForApproval = vi.fn(async () => ({ request_id: 9, requires_approval: true }));
    const create = vi.fn(async () => ({ id: 'operation', state: 'queued' }));
    const dependencies = {
      fastify: app, sensitiveOperationRateLimitConfig: {},
      verifyToken: async (request: any) => { request.user = { userId: 7, username: 'operator', permissions, roles: [], instancePermissions: access ? [{ instanceId: 1, accessLevel: access }] : [] }; },
      requirePermission, hasInstanceAccess, strictBody, classifySql,
      instanceDatabaseService: { getInstanceById: async () => ({ id: 1, db_type: 'mysql' }) },
      operationService: { create, setApproval: vi.fn(), transition: vi.fn() },
      approvalService: { submitForApproval }, randomUUID: () => 'test-key',
    };
    new Function(...Object.keys(dependencies), registration)(...Object.values(dependencies));
    try {
      const response = await app.inject({ method: 'POST', url: '/api/approval/submit', payload: { instance_id: 1, sql_text: 'DELETE FROM fixture WHERE id = 1' } });
      return { status: response.statusCode, body: response.json(), calls: submitForApproval.mock.calls.length, operations: create.mock.calls.length };
    } finally { await app.close(); }
  }
  it('allows SQL operators without review permission to apply', async () => {
    expect(await submit(['instance:query'], 'read-write')).toMatchObject({ status: 200, calls: 1, body: { request_id: 9 } });
  });
  it.each([undefined, 'read-only'])('denies insufficient instance access: %s', async access => {
    expect(await submit(['instance:query'], access)).toMatchObject({ status: 403, calls: 0, operations: 0 });
  });
  it('denies review-only users without SQL operation permission', async () => {
    expect(await submit(['approval:approve'], 'read-write')).toMatchObject({ status: 403, calls: 0, operations: 0 });
  });
});
