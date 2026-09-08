import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerEvidenceRoutes } from './evidence-api.js';

describe('evidence HTTP boundary', () => {
  it('uses the authenticated actor and validated resource on every lookup', async () => {
    const app = Fastify(); const actor = { userId: 3 };
    const service = { getBundle: vi.fn(async () => ({ facts: [], gaps: ['NO_EVIDENCE'] })), getItem: vi.fn(async () => null) };
    await registerEvidenceRoutes(app, async request => { (request as any).user = actor; }, service);
    const response = await app.inject('/api/resources/server/4/evidence?limit=10');
    expect(response.statusCode).toBe(200);
    expect(service.getBundle).toHaveBeenCalledWith(actor, { type: 'server', id: 4 }, expect.objectContaining({ limit: 10 }));
    expect((await app.inject('/api/resources/server/0/evidence')).statusCode).toBe(400);
    expect((await app.inject('/api/resources/server/4/evidence?limit=nan')).statusCode).toBe(400);
    expect((await app.inject('/api/resources/server/4/evidence/' + 'a'.repeat(64))).statusCode).toBe(404);
    await app.close();
  });
  it('does not leak internal errors and respects authorization denial', async () => {
    const app = Fastify(); const service = { getBundle: vi.fn(async () => { throw new Error('RESOURCE_FORBIDDEN'); }), getItem: vi.fn() };
    await registerEvidenceRoutes(app, async request => { (request as any).user = { userId: 3 }; }, service);
    expect((await app.inject('/api/resources/instance/1/evidence')).statusCode).toBe(403);
    service.getBundle.mockRejectedValueOnce(new Error('mysql://secret'));
    const result = await app.inject('/api/resources/instance/1/evidence');
    expect(result.statusCode).toBe(503); expect(result.body).not.toContain('mysql'); await app.close();
  });
});
