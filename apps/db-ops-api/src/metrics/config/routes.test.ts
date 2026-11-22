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
  let accessError: AdapterError | undefined;
  let held: boolean, calls: number, fail: boolean, pending: (() => Promise<void>) | undefined;
  const base = '/api/metrics/config';
  const payload = { expected_revision: 0, package: pin };
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
  it('keeps read-only metric configuration endpoints', async () => {
    const catalog = await app.inject(`${base}/catalog`);
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().metrics.some((metric: any) => metric.category === 'canonical')).toBe(true);
    expect((await app.inject(`${base}/resources/instance/1/status`)).statusCode).toBe(200);
  });
  it.each(['trial', 'activate'])('retires the package %s endpoint', async operation => {
    const reply = await app.inject({ method: 'POST', url: `${base}/resources/instance/1/${operation}`, payload });
    expect(reply.statusCode).toBe(404);
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
  });
});
