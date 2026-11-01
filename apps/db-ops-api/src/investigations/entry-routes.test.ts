import Fastify from 'fastify';
import { afterEach, it, expect, vi } from 'vitest';
import { registerInvestigationEntryRoutes } from './entry-routes.js';
import { InvestigationAuthorization } from './authorization.js';
import { InvestigationStoreError } from './store.js';
const context = { schemaVersion: 1, resourceRefs: [{ type: 'instance', id: 7, role: 'primary' }],
  from: '2026-10-30T00:00:00.000Z', to: '2026-10-30T01:00:00.000Z',
  metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, dimensions: {}, sourceEventIds: [8], returnTo: '/instance-detail?id=7' };
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const app = Fastify(), authorize = vi.spyOn(InvestigationAuthorization.prototype, 'authorize').mockResolvedValue({} as never);
  const create = vi.fn().mockResolvedValue({ investigation: { id: '00000000-0000-4000-8000-000000000001' } });
  const detail = vi.fn().mockResolvedValue({ context: { entry: context } });
  const store = { transaction: (f: (c: unknown) => unknown) => f({}), detail };
  const bridge = { create, storeFor: () => store };
  const metrics = { observations: vi.fn().mockResolvedValue({ total: 0, observations: [] }), query: vi.fn() };
  const events = vi.fn().mockResolvedValue(undefined);
  await registerInvestigationEntryRoutes(app, async r => { (r as any).user = { userId: 1, principalKind: 'user' }; }, bridge as never, metrics as never, events);
  return { app, authorize, create, detail, metrics, events };
}
it('preview preserves exact series and window, double-checks scopes, and never calls create', async () => {
  const f = await setup();
  try {
    const r = await f.app.inject({ method: 'POST', url: '/api/investigations/entry-facts', payload: context });
    expect(r.statusCode).toBe(200); expect(r.headers['cache-control']).toBe('private, no-store');
    expect(f.create).not.toHaveBeenCalled(); expect(f.authorize).toHaveBeenCalledTimes(2); expect(f.events).toHaveBeenCalledTimes(2);
    expect(f.metrics.observations.mock.calls[0][1]).toEqual({ resource: { type: 'instance', id: 7 }, metric: context.metric,
      dimensions: {}, from: context.from, to: context.to, limit: 200 });
  } finally { await f.app.close(); }
});
it('draft calls the existing bridge with no first admission and stores full immutable source context', async () => {
  const f = await setup();
  try {
    const r = await f.app.inject({ method: 'POST', url: '/api/investigations/drafts', payload: context, headers: { 'idempotency-key': 'one-original' } });
    expect(r.statusCode).toBe(200); expect(f.create.mock.calls[0]).toHaveLength(2);
    expect(f.create.mock.calls[0][1]).toMatchObject({ idempotencyKey: 'one-original', resources: context.resourceRefs, context: { entry: context } });
  } finally { await f.app.close(); }
});
it('revocation at the final scope check returns no facts and writes no draft', async () => {
  const f = await setup(); f.authorize.mockResolvedValueOnce({} as never).mockRejectedValueOnce(new InvestigationStoreError('INVESTIGATION_NOT_FOUND'));
  try {
    const r = await f.app.inject({ method: 'POST', url: '/api/investigations/drafts', payload: context, headers: { 'idempotency-key': 'one' } });
    expect(r.statusCode).toBe(404); expect(r.json()).toEqual({ error: 'INVESTIGATION_NOT_FOUND' }); expect(f.create).not.toHaveBeenCalled();
  } finally { await f.app.close(); }
});
it('persisted context-facts checks Investigation before and after IO, and rejects arbitrary query parameters', async () => {
  const f = await setup(); const path = '/api/investigations/00000000-0000-4000-8000-000000000001/context-facts';
  try {
    expect((await f.app.inject({ url: path })).statusCode).toBe(200); expect(f.detail).toHaveBeenCalledTimes(2);
    expect((await f.app.inject({ url: path + '?resource=instance:99' })).statusCode).toBe(400);
  } finally { await f.app.close(); }
});
it('unknown series/input and infrastructure errors stay distinct and do not leak internal SQL', async () => {
  const f = await setup(); f.metrics.observations.mockRejectedValue(new Error('SQL contains secret'));
  try {
    const r = await f.app.inject({ method: 'POST', url: '/api/investigations/entry-facts', payload: context });
    expect(r.statusCode).toBe(503); expect(r.body).not.toContain('secret');
    expect((await f.app.inject({ method: 'POST', url: '/api/investigations/drafts', payload: { ...context, resourceRefs: [] }, headers: { 'idempotency-key': 'one' } })).statusCode).toBe(400);
    expect(f.create).not.toHaveBeenCalled();
  } finally { await f.app.close(); }
});
