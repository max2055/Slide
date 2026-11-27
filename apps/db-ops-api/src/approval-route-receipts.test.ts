import { readFileSync } from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { getAccessibleInstanceIds } from './auth/require-instance-access.js';
import { requirePermission } from './auth/require-permission.js';
import { registerHttpSecurity } from './security/http-security.js';
import { strictBody } from './utils/strict-body.js';

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const routes = [
  "post('/api/approval/batch-review'",
  "get('/api/approval/pending'",
  "get('/api/approval/history'",
].map(start => {
  const index = source.indexOf(`  fastify.${start}`);
  const end = source.indexOf('\n  });', index);
  if (index < 0 || end < 0) throw new Error(`Missing inline approval route: ${start}`);
  return source.slice(index, end + '\n  });'.length);
}).join('\n');

async function setup() {
  const fastify = Fastify();
  await registerHttpSecurity(fastify, { NODE_ENV: 'test' });
  fastify.addHook('preSerialization', async (_request, _reply, payload) => {
    await new Promise<void>(resolve => setImmediate(resolve));
    return payload;
  });
  const actor = {
    userId: 17, username: 'fixture-reviewer',
    permissions: ['approval:view', 'approval:approve'], roles: [], instanceScopes: { 6: 'read-write' },
  };
  const results = [{ id: 2, success: true }, { id: 3, success: false, error: '审批请求不存在或已被认领' }];
  const pending = [{ id: 2, status: 'pending' }];
  const processed = [{ id: 3, status: 'executed' }];
  const approvalService = {
    batchReview: vi.fn(async () => results),
    getPendingRequests: vi.fn(async () => pending),
    getProcessedRequests: vi.fn(async () => processed),
    getRequestById: vi.fn(async () => null),
  };
  const access = vi.fn(async (_request: FastifyRequest, reply: FastifyReply, id: number) => {
    if (id < 4) return true;
    reply.code(403).send({ error: '无权访问该审批请求' });
    return false;
  });
  const deps = {
    fastify, strictBody, requirePermission, getAccessibleInstanceIds, approvalService,
    verifyToken: async (request: FastifyRequest) => { Object.assign(request, { user: actor }); },
    requireApprovalAccess: access,
    approvalOperationLifecycle: vi.fn(),
  };
  const code = ts.transpileModule(routes, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function(...Object.keys(deps), code)(...Object.values(deps));
  return { fastify, approvalService, access, results, pending, processed };
}

it.each([
  ['/api/approval/pending', 'pending'],
  ['/api/approval/history?limit=55', 'processed'],
] as const)('returns the scoped JSON array for %s with asynchronous serialization', async (url, kind) => {
  const harness = await setup();
  try {
    const response = await harness.fastify.inject(url);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(harness[kind]);
    if (kind === 'pending') expect(harness.approvalService.getPendingRequests).toHaveBeenCalledExactlyOnceWith([6]);
    else expect(harness.approvalService.getProcessedRequests).toHaveBeenCalledExactlyOnceWith(55, [6]);
  } finally { await harness.fastify.close(); }
});

it('returns the per-item batch receipt and never writes a batch with an out-of-scope member', async () => {
  const { fastify, approvalService, access, results } = await setup();
  try {
    const review = (ids: number[]) => fastify.inject({
      method: 'POST', url: '/api/approval/batch-review', payload: { ids, action: 'approve', execute_ids: [2] },
    });
    const accepted = await review([2, 3, 2]);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual(results);
    expect(approvalService.batchReview).toHaveBeenCalledExactlyOnceWith({
      items: [
        { id: 2, action: 'approve', execute_after_approve: true },
        { id: 3, action: 'approve', execute_after_approve: false },
      ],
      reviewed_by: 17, notes: '',
    }, expect.any(Function));
    expect(access.mock.calls.map(call => call[2])).toEqual([2, 3]);
    const denied = await review([2, 4]);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: '无权访问该审批请求' });
    expect(approvalService.batchReview).toHaveBeenCalledOnce();
  } finally { await fastify.close(); }
});
