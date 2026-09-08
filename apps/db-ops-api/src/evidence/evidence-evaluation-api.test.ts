import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerEvidenceEvaluationRoutes } from './evidence-evaluation-api.js';
it('routes evaluation and metadata writes through the authenticated actor and masks internal failures', async () => {
  const app = Fastify(); const actor = { userId: 1 };
  const service = { evaluate: vi.fn(async () => ({ rulesVersion: 0 })), rules: vi.fn(async () => ({ version: 0 })), updateRules: vi.fn(async () => { throw new Error('RULES_VERSION_CONFLICT'); }), recordDecision: vi.fn(async () => ({ id: 'd' })), decision: vi.fn(async () => null), recovery: vi.fn(async () => ({ status: 'unknown' })) };
  await registerEvidenceEvaluationRoutes(app, async request => { (request as any).user = actor; }, service);
  expect((await app.inject({ method: 'POST', url: '/api/resources/server/1/evaluation' })).statusCode).toBe(200);
  expect(service.evaluate).toHaveBeenCalledWith(actor, { type: 'server', id: 1 });
  expect((await app.inject('/api/resources/server/1/evaluation')).statusCode).toBe(200);
  expect((await app.inject({ method: 'PUT', url: '/api/resources/server/1/invariants', payload: { expectedVersion: 1, rules: [] } })).statusCode).toBe(409);
  expect((await app.inject('/api/resources/server/0/invariants')).statusCode).toBe(400);
  expect((await app.inject('/api/resources/server/1/decisions/a')).statusCode).toBe(404);
  service.evaluate.mockRejectedValueOnce(new Error('database secret'));
  const failed = await app.inject({ method: 'POST', url: '/api/resources/server/1/evaluation' });
  expect(failed.statusCode).toBe(503); expect(failed.body).not.toContain('secret');
  await app.close();
});
