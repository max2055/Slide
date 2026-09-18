import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBuiltinRegistry, builtinReleases } from '../packages/builtins.js';
import { PolicyService } from './service.js';
import { registerMetricPolicyRoutes } from './routes.js';
import { MemoryPolicyStore, testResources, admin, pin, at } from './test-support.js';
import type { ActorContext } from '../../auth/actor-context.js';

describe('policy API', () => {
  let app: ReturnType<typeof Fastify>, store: MemoryPolicyStore, actor: ActorContext | undefined;
  const base = '/api/metrics-v2/policy';
  const post = (path: string, payload: unknown) => app.inject({ method: 'POST', url: `${base}${path}`, payload: payload as object });
  const get = (path: string) => app.inject({ method: 'GET', url: `${base}${path}` });
  const create = (id = 1, extra = {}) => post(`/resources/instance/${id}/publish`, { expected_revision: 0, package: pin, ...extra });
  beforeEach(async () => {
    store = new MemoryPolicyStore(); actor = admin; app = Fastify();
    await registerMetricPolicyRoutes(app, async request => { (request as any).user = actor; }, new PolicyService(store, createBuiltinRegistry(), testResources, () => at));
  });
  afterEach(async () => { await app.close(); });
  it('preview has no side effects; publish is queryable with pending application and atomic audit', async () => {
    const preview = await post('/resources/instance/1/preview', { expected_revision: 0, package: pin });
    expect(preview.statusCode).toBe(200); expect(preview.json().published).toBe(false); expect(store.bindings.size).toBe(0);
    const published = await create(); expect(published.statusCode).toBe(200);
    const value = (await get('/resources/instance/1')).json(); expect(value.binding.revision).toBe(1);
    expect(value.application).toEqual({ status: 'pending', applied_revision: null, reported_at: null, error_code: null });
    expect((await get('/resources/instance/1/audit')).json()).toMatchObject([{ actor_id: 1, revision: 1, action: 'binding.publish' }]);
  });
  it('only one concurrent expected-revision update commits', async () => {
    await create();
    const results = await Promise.all([0, 1].map(() => post('/resources/instance/1/publish', { expected_revision: 1 })));
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]); expect(store.logs).toHaveLength(2);
  });
  it('separates object policy from global package, scopes readers and publishers', async () => {
    await create(1); await create(2);
    actor = { ...admin, permissions: ['instance:manage'], instanceScopes: { 1: 'read-write' } };
    expect((await post('/resources/instance/1/publish', { expected_revision: 1, overrides: { enabled: 'disable' } })).statusCode).toBe(200);
    expect((await get('/resources/instance/2')).statusCode).toBe(403);
    expect((await post('/resources/instance/2/publish', { expected_revision: 1 })).statusCode).toBe(403);
    actor = { ...admin, permissions: ['instance:view'], instanceScopes: { 1: 'read-only' } };
    expect((await get('/resources/instance/1')).statusCode).toBe(200);
    expect((await post('/resources/instance/1/publish', { expected_revision: 2 })).statusCode).toBe(403);
    actor = admin; expect((await get('/resources/instance/2')).json().resolved.settings.enabled).toBe(true);
    actor = undefined; expect((await create(3)).statusCode).toBe(401);
  });
  it('group preview contains impact, applies atomically and rejects partial management permission', async () => {
    expect((await post('/groups/g/publish', { expected_revision: 0, overrides: {} })).statusCode).toBe(200);
    await create(1, { group_id: 'g' }); await create(2, { group_id: 'g' });
    const group = (await get('/groups/g')).json();
    const change = { expected_revision: group.revision, overrides: { interval_ms: { mode: 'set', value: 30000 } } };
    const preview = await post('/groups/g/preview', change); expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ affected_resources: 2, requests_per_hour_before: 120, requests_per_hour_after: 240 });
    actor = { ...admin, permissions: ['instance:manage'], instanceScopes: { 1: 'admin' } };
    expect((await post('/groups/g/publish', change)).statusCode).toBe(403);
    actor = admin;
    expect((await post('/groups/g/publish', change)).statusCode).toBe(200);
    expect((await get('/resources/instance/1')).json().binding.revision).toBe(2);
    expect((await get('/resources/instance/2')).json().resolved.sources.interval_ms.layer).toBe('group');
    expect((await post('/groups/g/publish', change)).statusCode).toBe(409);
  });
  it('rejects invalid dependencies, non-existing resources, supplied capability and credentials without echo', async () => {
    expect((await create(404)).statusCode).toBe(404);
    for (const extra of [{ password: 'canary-secret' }, { credential_ref: 'credential:canary-secret' }, { capabilities: [] }, { resource: { type: 'instance', id: 2 } }]) {
      const result = await create(1, extra); expect(result.statusCode).toBe(400); expect(result.body).not.toContain('canary-secret');
    }
    const result = await create(1, { overrides: { metrics: { 'mysql.queries.total@1.0.0': 'disable' } } });
    expect(result.statusCode).toBe(400); expect(store.bindings.size).toBe(0);
  });
  it('rolls back publishing if audit fails and sanitizes errors', async () => {
    store.failAudit = true; const result = await create(); expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('secret'); expect(store.bindings.size).toBe(0);
  });
  it('validates empty group constraints and prevents stale group impact after a resource override', async () => {
    expect((await post('/groups/g/publish', { expected_revision: 0, overrides: { interval_ms: { mode: 'set', value: 1000 }, timeout_ms: { mode: 'set', value: 5000 } } })).statusCode).toBe(400);
    await post('/groups/g/publish', { expected_revision: 0, overrides: {} }); await create(1, { group_id: 'g' });
    const prior = (await get('/groups/g')).json();
    await post('/resources/instance/1/publish', { expected_revision: 1, overrides: { enabled: 'disable' } });
    expect((await post('/groups/g/publish', { expected_revision: prior.revision, overrides: {} })).statusCode).toBe(409);
    expect((await get('/resources/instance/1/effective')).json()).toMatchObject({ published_revision: 2, application: { applied_revision: null }, resolved: { settings: { enabled: false } } });
  });
  it.each([['server', 'servers', 1], ['network_device', 'network_devices', 2]] as const)('requires the matching %s management permission', async (type, permission, index) => {
    const { id, version, digest } = builtinReleases()[index].package;
    const payload = { expected_revision: 0, package: { id, version, digest } };
    actor = { ...admin, permissions: [`${permission}:view`] };
    expect((await post(`/resources/${type}/1/publish`, payload)).statusCode).toBe(403);
    actor = { ...admin, permissions: [`${permission}:manage`] };
    expect((await post(`/resources/${type}/1/publish`, payload)).statusCode).toBe(200);
    actor = { ...admin, permissions: [`${permission}:view`] };
    expect((await get(`/resources/${type}/1`)).statusCode).toBe(200);
    actor = { ...admin, permissions: ['instance:*'] };
    expect((await get(`/resources/${type}/1`)).statusCode).toBe(403);
  });
});
