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
  vi.spyOn(actorContextService, 'revalidateActorOn').mockResolvedValue({ permissions: ['*'] } as any);
  const store = { transaction: (f: (c: unknown, append: unknown) => unknown) => f({}, vi.fn()), detail };
  const bridge = { createOnConnection: create, storeFor: () => store };
  const metrics = { observations: vi.fn().mockResolvedValue({ total: 0, observations: [] }), query: vi.fn() };
  const events = vi.fn().mockResolvedValue(undefined);
  await registerInvestigationEntryRoutes(app, async r => { (r as any).user = { userId: 1, principalKind: 'user', permissions: ['*'] }; }, bridge as never, metrics as never, events);
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
    expect(r.statusCode).toBe(200); expect(f.create.mock.calls[0]).toHaveLength(4);
    expect(f.create.mock.calls[0][3]).toMatchObject({ idempotencyKey: 'one-original', resources: context.resourceRefs, context: { entry: context } });
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

import { actorContextService } from '../auth/actor-context.js';
import { alertEventService } from '../alert-event-service.js';
import * as eventAccess from '../alert-event-access.js';
import { dbConnection } from '../db-connection.js';
import { checkEntryEvents } from './entry-routes.js';
it('CHIEF alert:view revoked during final event IO must deny preview', async () => {
  const app = Fastify();
  let revoked = false, reads = 0;
  const actor = { userId: 1, principalKind: 'user', permissions: ['chat:view','instance:view','alert:view'], instanceScopes: {7:'read-only'}, roles: [] };
  vi.spyOn(actorContextService, 'revalidateActor').mockImplementation(async () => ({...actor, permissions:revoked ? ['chat:view','instance:view'] : actor.permissions}) as any);
  vi.spyOn(actorContextService, 'revalidateActorOn').mockImplementation(async () => ({ ...actor, permissions: revoked ? ['chat:view','instance:view'] : actor.permissions }) as any);
  vi.spyOn(alertEventService, 'getEventById').mockResolvedValue({id:8,instance_id:7} as any);
  vi.spyOn(eventAccess, 'eventResourceAccess').mockResolvedValue(true);
  vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: async () => { if (++reads === 2) revoked=true; return [[{payload:{resource:{type:'instance',id:7}}}]]; } } as any);
  // This scope checks Investigation/resource authority, not alert:view (authorization.ts).
  vi.spyOn(InvestigationAuthorization.prototype, 'authorize').mockResolvedValue({} as never);
  const bridge = { storeFor: () => ({transaction:(f:any)=>f({})}) };
  await registerInvestigationEntryRoutes(app, async r => {(r as any).user=actor;}, bridge as any,
    {observations:async()=>({total:0,observations:[]})} as any, checkEntryEvents);
  try {
    const r=await app.inject({method:'POST',url:'/api/investigations/entry-facts',payload:context});
    expect(revoked).toBe(true);
    expect(r.statusCode).toBe(404);
  } finally {await app.close();}
});
