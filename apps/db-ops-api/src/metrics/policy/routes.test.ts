import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinRegistry, builtinReleases } from '../packages/builtins.js';
import { PolicyService } from './service.js';
import { registerMetricPolicyRoutes } from './routes.js';
import type { PolicyStore } from './store.js';
import { MemoryPolicyStore, testResources, admin, pin, at } from './test-support.js';
import { actorContextService, ActorAuthenticationError, type ActorContext } from '../../auth/actor-context.js';

describe('policy API', () => {
  let app: ReturnType<typeof Fastify>, store: MemoryPolicyStore, actor: ActorContext | undefined;
  const base = '/api/metrics/policy';
  const post = (path: string, payload: unknown) => app.inject({ method: 'POST', url: `${base}${path}`, payload: payload as object });
  const get = (path: string) => app.inject({ method: 'GET', url: `${base}${path}` });
  const create = (id = 1, extra = {}) => post(`/resources/instance/${id}/publish`, { expected_revision: 0, package: pin, ...extra });
  beforeEach(async () => {
    store = new MemoryPolicyStore(); actor = admin; app = Fastify();
    await registerMetricPolicyRoutes(app, async request => { (request as any).user = actor; }, new PolicyService(store, createBuiltinRegistry(), testResources, () => at), async () => actor!);
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
  it('group search does not reveal empty or partially inaccessible groups', async () => {
    store.groups.set('team',{id:'team',revision:1,overrides:{}});
    store.groups.set('empty',{id:'empty',revision:1,overrides:{}});
    await create(1,{group_id:'team'});await create(2,{group_id:'team'});
    actor={...admin,permissions:['instance:view'],instanceScopes:{1:'read-only'}};
    expect((await get('/groups')).json()).toEqual({groups:[]});
    actor=admin;
    const response=await get('/groups?query=tea');
    expect(response.statusCode).toBe(200);expect(response.json().groups).toMatchObject([{id:'team',can_manage:true}]);
    actor=undefined;expect((await get('/groups')).statusCode).toBe(401);
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

/**
 * The public policy entries can wait for admission and the policy row lock after
 * the request snapshot was authorized. Every one of them re-reads the live actor
 * inside the serialized transaction, including a keyed replay whose response was
 * lost. The gate stands in for that wait; no target or production identity is used.
 */
function gatedStore(memory: MemoryPolicyStore) {
  let block = false, enter!: () => void, release!: () => void;
  let entered = new Promise<void>(resolve => { enter = resolve; });
  let gate = new Promise<void>(resolve => { release = resolve; });
  const store: PolicyStore = { transaction: async fn => {
    if (block) { block = false; enter(); await gate; }
    return memory.transaction(fn);
  } };
  return { store, arm() {
    block = true;
    entered = new Promise<void>(resolve => { enter = resolve; });
    gate = new Promise<void>(resolve => { release = resolve; });
    return { entered, release: () => release() };
  } };
}

describe('policy API lock-wait authorization', () => {
  const revoked: ActorContext = { ...admin, permissions: [], instanceScopes: {} };
  const publish = { expected_revision: 0, package: pin };
  it('revalidates a committed keyed replay at the production publish route after its lock wait', async () => {
    const memory = new MemoryPolicyStore();
    const gated = gatedStore(memory);
    const policy = new PolicyService(gated.store, createBuiltinRegistry(), testResources, () => at);
    const input = { ...publish, operation_key: 'replay-after-lock' };
    await policy.changeBinding(admin, { type: 'instance', id: 1 }, input, true);
    let current: ActorContext = admin;
    const live = vi.spyOn(actorContextService, 'revalidateActor').mockImplementation(async () => current);
    const app = Fastify();
    // No reload argument: the registered production wiring must re-read the actor.
    await registerMetricPolicyRoutes(app, async request => { (request as any).user = admin; }, policy);
    try {
      const wait = gated.arm();
      const response = app.inject({ method: 'POST', url: '/api/metrics/policy/resources/instance/1/publish', payload: input });
      await wait.entered;
      current = revoked;
      wait.release();
      expect((await response).statusCode).toBe(403);
      expect(live).toHaveBeenCalledWith(admin, admin.requestId);
      // The denial neither repeats nor hides a second write: the recorded publication is untouched.
      expect(memory.logs).toHaveLength(1);
      expect(memory.bindings.get('instance:1')!.binding.revision).toBe(1);
      expect(memory.operations.get('replay-after-lock')!.state).toBe('committed');
    } finally { live.mockRestore(); await app.close(); }
  });
  it('refuses reads, previews and publications whose grants are revoked during the lock wait', async () => {
    const memory = new MemoryPolicyStore();
    const gated = gatedStore(memory);
    const policy = new PolicyService(gated.store, createBuiltinRegistry(), testResources, () => at);
    await policy.changeBinding(admin, { type: 'instance', id: 1 }, publish, true);
    let current: ActorContext = admin;
    const app = Fastify();
    await registerMetricPolicyRoutes(app, async request => { (request as any).user = admin; }, policy, async () => current);
    const attempts: Array<[string, string, unknown?]> = [
      ['GET', '/api/metrics/policy/resources/instance/1'],
      ['GET', '/api/metrics/policy/resources/instance/1/effective'],
      ['GET', '/api/metrics/policy/resources/instance/1/audit'],
      ['POST', '/api/metrics/policy/resources/instance/1/preview', { expected_revision: 1 }],
      ['POST', '/api/metrics/policy/resources/instance/1/publish', { expected_revision: 1, overrides: { enabled: 'disable' } }],
      ['POST', '/api/metrics/policy/resources/instance/1/publish', { expected_revision: 1, overrides: { enabled: 'disable' }, operation_key: 'revoked-new-intent' }],
      ['GET', '/api/metrics/policy/groups/missing'],
      ['GET', '/api/metrics/policy/groups/missing/access'],
      ['POST', '/api/metrics/policy/groups/missing/publish', { expected_revision: 0, overrides: {} }],
    ];
    try {
      for (const [method, url, payload] of attempts) {
        current = admin;
        const wait = gated.arm();
        const response = app.inject({ method, url, ...(payload === undefined ? {} : { payload }) } as any);
        await wait.entered;
        current = revoked;
        wait.release();
        expect((await response).statusCode, url).toBe(403);
      }
      // Permission denials leave no publication, revision, audit or journal row.
      expect(memory.bindings.get('instance:1')!.binding.revision).toBe(1);
      expect(memory.logs).toHaveLength(1);
      expect(memory.operations.size).toBe(0);
    } finally { await app.close(); }
  });
  it('treats a revoked session during the lock wait as re-authentication, not a policy refusal', async () => {
    const memory = new MemoryPolicyStore();
    const policy = new PolicyService(memory, createBuiltinRegistry(), testResources, () => at);
    await policy.changeBinding(admin, { type: 'instance', id: 1 }, publish, true);
    const app = Fastify();
    await registerMetricPolicyRoutes(app, async request => { (request as any).user = admin; }, policy,
      async () => { throw new ActorAuthenticationError(); });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/metrics/policy/resources/instance/1' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'POLICY_AUTH_REQUIRED' });
    } finally { await app.close(); }
  });
});
