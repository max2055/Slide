import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { PolicyService } from '../policy/service.js';
import { MemoryPolicyStore, admin, pin, resource, testResources } from '../policy/test-support.js';
import { MetricConfigurationService } from './service.js';
import { registerMetricConfigurationRoutes } from './routes.js';
import type { ActorContext } from '../../auth/actor-context.js';
import { AdapterError } from '../packages/adapters.js';
import { actorContextService, ActorAuthenticationError } from '../../auth/actor-context.js';

describe('configuration HTTP routes', () => {
  let app: ReturnType<typeof Fastify>, actor: ActorContext | undefined, store: MemoryPolicyStore;
  let accessError: AdapterError | undefined;
  let held: boolean, calls: number, fail: boolean, pending: (() => Promise<void>) | undefined;
  const base = '/api/metrics/config';
  const payload = { expected_revision: 0, package: pin };
  const trial = (body = payload) => app.inject({ method: 'POST', url: `${base}/resources/instance/1/trial`, payload: body });
  beforeEach(async () => {
    accessError = undefined; held = false; calls = 0; fail = false; pending = undefined; actor = admin; store = new MemoryPolicyStore();
    const registry = createBuiltinRegistry(), policy = new PolicyService(store, registry, testResources);
    const implementation = new MetricConfigurationService(policy, registry, {
      reserve: async () => { if (held) return null; held = true; return { connection: { ping: async () => {} }, release: async () => { held = false; } }; },
      attempts: async () => [],
    }, { resolve: async () => { if (accessError) throw accessError; return ({ resource: resource(), credential_ref: 'credential:canary-secret',
      evidence: { counter: { bits: '64', start_at: '2026-09-01T00:00:00.000Z' } },
      resolve: async () => ({ method: 'sql', pool: { query: async () => {
        calls++; if (pending) await pending(); if (fail) throw new AdapterError('timeout');
        return [[{ Variable_name: 'Uptime', Value: '1000' }, { Variable_name: 'Queries', Value: '9007199254740993' }], []];
      } } }),
    }); } }, {inventory: testResources.inventory, migration: async () => [{kind:'custom_sql',source_id:'tenant_queue',source_digest:'sha256:fixture',state:'blocked',code:'CUSTOM_SQL_REVIEW_REQUIRED',package:null,actions:['Export original definition and review immutable SQL manifest']}], evidence: async () => ({asset_enabled:true,global_enabled:true,in_flight:false,
      formal:{state:'pending',last_observed_at:null,generation:null}})});
    app = Fastify();
    await registerMetricConfigurationRoutes(app, async request => { (request as any).user = actor; }, implementation);
  });
  afterEach(async () => { await app.close(); });
  it.each(['trial', 'activate'])('production %s reloads session and delegation before accessing configuration', async operation => {
    const live = Fastify();
    const reload = vi.spyOn(actorContextService, 'revalidateActor').mockRejectedValue(new ActorAuthenticationError());
    try {
      await registerMetricConfigurationRoutes(live, async request => { (request as any).user = admin; });
      const response = await live.inject({ method: 'POST', url: `${base}/resources/instance/1/${operation}`, payload });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'POLICY_AUTH_REQUIRED' });
      expect(reload).toHaveBeenCalledWith(admin, admin.requestId);
    } finally { reload.mockRestore(); await live.close(); }
  });
  it('lists stable catalog and trial samples without secrets or persistence', async () => {
    const catalog = await app.inject(`${base}/catalog`); expect(catalog.statusCode).toBe(200);
    expect(catalog.json().metrics.some((m: any) => m.category === 'canonical')).toBe(true);
    const result = await trial(); expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ trial: true, persisted: false, decision: 'attempted' });
    expect(result.json().attempts[0].status).toBe('succeeded');
    expect(result.json().samples.some((s: any) => s.value === null && s.quality.reason === 'counter_baseline')).toBe(true);
    expect(result.body).not.toContain('canary-secret'); expect(store.bindings.size).toBe(0); expect(store.logs).toHaveLength(0);
  });
  it('replays one client intent without a second trial, revision or audit; another intent collides', async () => {
    const body = { ...payload, operation_key: 'intent-1' };
    const url = `${base}/resources/instance/1/activate`;
    const first = await app.inject({ method: 'POST', url, payload: body });
    expect(first.statusCode).toBe(200); expect(first.json()).toMatchObject({ published: true });
    expect(calls).toBe(1); expect(store.logs).toHaveLength(1);
    const revision = store.bindings.get('instance:1')!.binding.revision;
    const replay = await app.inject({ method: 'POST', url, payload: body });
    expect(replay.statusCode).toBe(200); expect(replay.json()).toMatchObject({ published: true });
    // No second trial, revision or audit row: the recorded publication is returned.
    expect(calls).toBe(1); expect(store.logs).toHaveLength(1);
    expect(store.bindings.get('instance:1')!.binding.revision).toBe(revision);
    expect((await app.inject(`${base}/resources/instance/1/operations/intent-1`)).json())
      .toMatchObject({ state: 'committed', operation: { resource: { type: 'instance', id: 1 }, target_revision: revision } });
    expect((await app.inject(`${base}/resources/instance/1/operations/unused`)).json()).toEqual({ state: 'absent', operation: null });
    const collision = await app.inject({ method: 'POST', url, payload: { ...body, overrides: { enabled: 'disable' } } });
    expect(collision.statusCode).toBe(409); expect(collision.json().error).toBe('POLICY_OPERATION_CONFLICT');
    expect(store.logs).toHaveLength(1); expect(calls).toBe(1);
  });
  it('guards the operation lookup with live read access and a valid key', async () => {
    const url = `${base}/resources/instance/1/operations/intent-1`;
    actor = { ...admin, permissions: ['instance:view'], instanceScopes: { 1: 'read-only' } };
    expect((await app.inject(url)).statusCode).toBe(200);
    actor = { ...admin, permissions: ['instance:view'], instanceScopes: {} };
    expect((await app.inject(url)).statusCode).toBe(403);
    actor = admin; expect((await app.inject(`${base}/resources/instance/1/operations/bad%20key`)).statusCode).toBe(400);
  });
  it('denies unauthenticated, read-only and malicious requests before transport', async () => {
    actor = undefined; expect((await trial()).statusCode).toBe(401);
    actor = { ...admin, permissions: ['instance:view'], instanceScopes: { 1: 'read-only' } };
    expect((await trial()).statusCode).toBe(403);
    actor = admin; expect((await trial({ ...payload, credential_ref: 'secret' } as any)).statusCode).toBe(400);
    expect(calls).toBe(0);
  });
  it('shows actionable custom migration blocks and denies a read-only actor before exposing them', async () => {
    const endpoint=`${base}/resources/instance/1/migration`;
    const migration=await app.inject(endpoint);
    expect(migration.statusCode).toBe(200);
    expect(migration.json()).toMatchObject({items:[{state:'blocked',code:'CUSTOM_SQL_REVIEW_REQUIRED'}]});
    const status=await app.inject(`${base}/resources/instance/1/status`);
    expect(status.json().blockers).toContain('LEGACY_CONFIGURATION_REVIEW_REQUIRED');
    expect(status.json().legacy_configuration[0].actions.length).toBeGreaterThan(0);
    actor = {...admin,permissions:['instance:view'],instanceScopes:{1:'read-only'}};
    expect((await app.inject(endpoint)).statusCode).toBe(403);
    expect((await app.inject(`${base}/resources/instance/1/status`)).json().legacy_configuration).toBeUndefined();
    expect(calls).toBe(0);
  });
  it('timeout is a failed attempt with unknown capability, never unsupported', async () => {
    fail = true; const result = (await trial()).json();
    expect(result.attempts[0]).toMatchObject({ status: 'failed', error: 'timeout' });
    expect(result.capabilities.every((c: any) => c.status !== 'unsupported')).toBe(true);
  });
  it('activation composes real trial and CAS publication while reporting formal source pending', async () => {
    const response=await app.inject({method:'POST',url:`${base}/resources/instance/1/activate`,payload});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({published:true,status:{binding:{state:'bound',published_revision:1},formal_visibility:{state:'pending'}}});
    expect(calls).toBe(1);
    expect((await app.inject({method:'POST',url:`${base}/resources/instance/1/activate`,payload})).statusCode).toBe(409);
    expect(calls).toBe(1);
  });
  it('failed trial does not publish a binding or audit', async () => {
    fail=true;
    const response=await app.inject({method:'POST',url:`${base}/resources/instance/1/activate`,payload});
    expect(response.statusCode).toBe(422); expect(response.json().error).toBe('CONFIGURATION_TRIAL_FAILED');
    expect(store.bindings.size).toBe(0);expect(store.logs).toHaveLength(0);
  });
  it.each(['permission_denied', 'connection_error'] as const)('reports target access %s without losing its reason or leaking details', async code => {
    accessError = new AdapterError(code);
    const result = await trial();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ decision: 'failed', error: code, persisted: false, samples: [], attempts: [] });
    expect(held).toBe(false); expect(calls).toBe(0); expect(store.bindings.size).toBe(0);
  });
  it('retains reservation through cancellation, discards late results and rejects overlap', async () => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    pending = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
    const first = trial({ ...payload, overrides: { timeout_ms: { mode: 'set', value: 250 } } } as any);
    const running = first.then(r => r);
    await started;
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(held).toBe(true); expect((await trial()).statusCode).toBe(409);
    release(); const result = await running;
    expect(result.json()).toMatchObject({ decision: 'failed', error: 'timeout', samples: [] });
    expect(held).toBe(false); expect(store.bindings.size).toBe(0);
  });
});
