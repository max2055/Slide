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
    expect((await app.inject('/api/resources/server/4/evidence?limit=101')).statusCode).toBe(400);
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

// MAX-540 / #515: duplicate query keys must never reach the reader as arrays.
describe('evidence query scalar contract', () => {
  it.each(['from', 'to', 'correlationId', 'limit'])('rejects non-string %s from a query parser', async key => {
    for (const value of [null, 1, true, {}, ['a']]) {
      const app = Fastify({ routerOptions: { querystringParser: () => ({ [key]: value }) } });
      const service = { getBundle: vi.fn(), getItem: vi.fn() };
      await registerEvidenceRoutes(app, async request => { (request as any).user = { userId: 3 }; }, service);
      try {
        expect((await app.inject('/api/resources/instance/1/evidence?test=1')).statusCode).toBe(400);
        expect(service.getBundle).not.toHaveBeenCalled();
      } finally { await app.close(); }
    }
  });
  it('passes valid single string filters and parses the numeric limit', async () => {
    const app = Fastify();
    const service = { getBundle: vi.fn(async () => ({ facts: [] })), getItem: vi.fn() };
    await registerEvidenceRoutes(app, async request => { (request as any).user = { userId: 3 }; }, service);
    try {
      expect((await app.inject('/api/resources/instance/1/evidence?from=2026-09-08&to=2026-09-09&correlationId=a&limit=10')).statusCode).toBe(200);
      expect(service.getBundle).toHaveBeenCalledWith(expect.anything(), { type: 'instance', id: 1 }, {
        from: '2026-09-08', to: '2026-09-09', correlationId: 'a', limit: 10,
      });
    } finally { await app.close(); }
  });
  it.each(['correlationId', 'from', 'to', 'limit'])('rejects repeated %s on list and item routes', async key => {
    const app = Fastify();
    const service = { getBundle: vi.fn(), getItem: vi.fn() };
    await registerEvidenceRoutes(app, async request => { (request as any).user = { userId: 3 }; }, service);
    const value = key === 'limit' ? '1' : key === 'correlationId' ? 'a' : '2026-09-08';
    try {
      for (const suffix of ['', '/' + 'a'.repeat(64)]) {
        const result = await app.inject('/api/resources/instance/1/evidence' + suffix + '?' + key + '=' + value + '&' + key + '=' + value);
        expect(result.statusCode).toBe(400);
      }
      expect(service.getBundle).not.toHaveBeenCalled();
      expect(service.getItem).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
