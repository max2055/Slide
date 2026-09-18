import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { PolicyService } from '../policy/service.js';
import { MemoryPolicyStore, admin, pin, resource, testResources } from '../policy/test-support.js';
import { MetricConfigurationService } from './service.js';
import { registerMetricConfigurationRoutes } from './routes.js';
import type { ActorContext } from '../../auth/actor-context.js';
import { AdapterError } from '../packages/adapters.js';

describe('configuration HTTP routes', () => {
  let app: ReturnType<typeof Fastify>, actor: ActorContext | undefined, store: MemoryPolicyStore;
  let held: boolean, calls: number, fail: boolean, pending: (() => Promise<void>) | undefined;
  const base = '/api/metrics-v2/config';
  const payload = { expected_revision: 0, package: pin };
  const trial = (body = payload) => app.inject({ method: 'POST', url: `${base}/resources/instance/1/trial`, payload: body });
  beforeEach(async () => {
    held = false; calls = 0; fail = false; pending = undefined; actor = admin; store = new MemoryPolicyStore();
    const registry = createBuiltinRegistry(), policy = new PolicyService(store, registry, testResources);
    const implementation = new MetricConfigurationService(policy, registry, {
      reserve: async () => { if (held) return null; held = true; return { connection: { ping: async () => {} }, release: async () => { held = false; } }; },
      attempts: async () => [],
    }, { resolve: async () => ({ resource: resource(), credential_ref: 'credential:canary-secret',
      evidence: { counter: { bits: '64', start_at: '2026-09-01T00:00:00.000Z' } },
      resolve: async () => ({ method: 'sql', pool: { query: async () => {
        calls++; if (pending) await pending(); if (fail) throw new AdapterError('timeout');
        return [[{ Variable_name: 'Uptime', Value: '1000' }, { Variable_name: 'Queries', Value: '9007199254740993' }], []];
      } } }),
    }) });
    app = Fastify();
    await registerMetricConfigurationRoutes(app, async request => { (request as any).user = actor; }, implementation);
  });
  afterEach(async () => { await app.close(); });
  it('lists stable catalog and trial samples without secrets or persistence', async () => {
    const catalog = await app.inject(`${base}/catalog`); expect(catalog.statusCode).toBe(200);
    expect(catalog.json().metrics.some((m: any) => m.category === 'canonical')).toBe(true);
    const result = await trial(); expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ trial: true, persisted: false, decision: 'attempted' });
    expect(result.json().attempts[0].status).toBe('succeeded');
    expect(result.json().samples.some((s: any) => s.value === null && s.quality.reason === 'counter_baseline')).toBe(true);
    expect(result.body).not.toContain('canary-secret'); expect(store.bindings.size).toBe(0); expect(store.logs).toHaveLength(0);
  });
  it('denies unauthenticated, read-only and malicious requests before transport', async () => {
    actor = undefined; expect((await trial()).statusCode).toBe(401);
    actor = { ...admin, permissions: ['instance:view'], instanceScopes: { 1: 'read-only' } };
    expect((await trial()).statusCode).toBe(403);
    actor = admin; expect((await trial({ ...payload, credential_ref: 'secret' } as any)).statusCode).toBe(400);
    expect(calls).toBe(0);
  });
  it('timeout is a failed attempt with unknown capability, never unsupported', async () => {
    fail = true; const result = (await trial()).json();
    expect(result.attempts[0]).toMatchObject({ status: 'failed', error: 'timeout' });
    expect(result.capabilities.every((c: any) => c.status !== 'unsupported')).toBe(true);
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
