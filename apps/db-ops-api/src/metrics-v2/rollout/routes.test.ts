import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../auth/actor-context.js';
import { admin } from '../policy/test-support.js';
import { registerMetricRolloutRoutes } from './routes.js';

describe('rollout coordination API', () => {
  let app: ReturnType<typeof Fastify>;
  let actor: ActorContext | undefined;
  const access = vi.fn(async () => undefined);
  const coordinator = {
    status: vi.fn(async () => ({ phase: 'shadow', revision: 1, generation: 1, series_count: 2, applied_series: 2, gate: null })),
    startShadow: vi.fn(async () => ({ phase: 'shadow' })),
    acceptShadow: vi.fn(async () => ({ phase: 'shadow' })),
    cutover: vi.fn(async () => ({ phase: 'cutover_pending' })),
    confirmApplied: vi.fn(async () => ({ phase: 'v2' })),
    rollback: vi.fn(async () => ({ phase: 'legacy' })),
  };
  const portfolio = {
    status: vi.fn(async () => ({ plan_hash: `sha256:${'a'.repeat(64)}`, summary: { total: 1, supported: 1, blocked: 0, v2: 0, complete: false }, resources: [] })),
    prepare: vi.fn(async () => ({ results: [{ key: 'instance:1', outcome: 'changed' }] })),
    shadow: vi.fn(async () => ({ results: [{ key: 'instance:1', outcome: 'changed' }] })),
    cutover: vi.fn(async () => ({ results: [{ key: 'instance:1', outcome: 'changed' }] })),
    confirm: vi.fn(async () => ({ results: [{ key: 'instance:1', outcome: 'changed' }] })),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    actor = admin;
    app = Fastify();
    await registerMetricRolloutRoutes(app, async request => { (request as any).user = actor; }, coordinator as never, access, portfolio as never);
  });
  afterEach(async () => app.close());

  it('scopes reads and writes to the authenticated resource', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/metrics-v2/rollout/resources/instance/1' })).statusCode).toBe(200);
    expect(access).toHaveBeenCalledWith(admin, { type: 'instance', id: 1 }, false);
    const result = await app.inject({ method: 'POST', url: '/api/metrics-v2/rollout/resources/instance/1/shadow', payload: { expected_revision: 1 } });
    expect(result.statusCode).toBe(200);
    expect(access).toHaveBeenLastCalledWith(admin, { type: 'instance', id: 1 }, true);
    expect(coordinator.startShadow).toHaveBeenCalledWith({ type: 'instance', id: 1 }, 1,
      { userId: admin.userId, requestId: admin.requestId });
  });

  it('exposes only fixed transitions and validates bodies without echoing unknown input', async () => {
    const gate = { sample_count: 20, source_conflicts: 0, duplicate_formal_writes: 0, duplicate_alerts: 0,
      value_mismatches: 0, unit_mismatches: 0, dimension_mismatches: 0, quality_mismatches: 0,
      freshness_mismatches: 0, missing_mismatches: 0, derived_mismatches: 0, performance_regressions: 0 };
    expect((await app.inject({ method: 'POST', url: '/api/metrics-v2/rollout/resources/instance/1/gate',
      payload: { expected_revision: 1, gate } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/metrics-v2/rollout/resources/instance/1/cutover',
      payload: { expected_shadow_revision: 1, expected_generation: 1 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/metrics-v2/rollout/resources/instance/1/confirm',
      payload: { expected_revision: 2 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/metrics-v2/rollout/resources/instance/1/rollback',
      payload: { expected_revision: 2, expected_generation: 2 } })).statusCode).toBe(200);
    const invalid = await app.inject({ method: 'POST', url: '/api/metrics-v2/rollout/resources/instance/1/shadow',
      payload: { expected_revision: 1, sql: 'SELECT secret' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain('SELECT secret');
  });

  it('rejects unauthenticated and invalid resource requests before coordinator access', async () => {
    actor = undefined;
    expect((await app.inject({ method: 'GET', url: '/api/metrics-v2/rollout/resources/instance/1' })).statusCode).toBe(401);
    actor = admin;
    expect((await app.inject({ method: 'GET', url: '/api/metrics-v2/rollout/resources/unknown/1' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/metrics-v2/rollout/resources/instance/0' })).statusCode).toBe(400);
  });

  it('exposes fixed portfolio actions guarded by a server inventory plan hash', async () => {
    const current = await app.inject({ method: 'GET', url: '/api/metrics-v2/rollout/portfolio' });
    expect(current.statusCode).toBe(200);
    expect(portfolio.status).toHaveBeenCalledWith(admin);
    const expected_plan_hash = `sha256:${'a'.repeat(64)}`;
    for (const operation of ['prepare', 'shadow', 'cutover', 'confirm'] as const) {
      const response = await app.inject({ method: 'POST', url: `/api/metrics-v2/rollout/portfolio/${operation}`, payload: { expected_plan_hash } });
      expect(response.statusCode).toBe(200);
      expect(portfolio[operation]).toHaveBeenCalledWith(admin, expected_plan_hash);
    }
  });

  it('rejects unauthenticated, stale and expanded portfolio requests without echoing input', async () => {
    actor = undefined;
    expect((await app.inject({ method: 'GET', url: '/api/metrics-v2/rollout/portfolio' })).statusCode).toBe(401);
    actor = admin;
    const invalid = await app.inject({ method: 'POST', url: '/api/metrics-v2/rollout/portfolio/prepare',
      payload: { expected_plan_hash: `sha256:${'a'.repeat(64)}`, host: 'secret.internal' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain('secret.internal');
    portfolio.prepare.mockRejectedValueOnce(new Error('PORTFOLIO_PLAN_CHANGED'));
    const stale = await app.inject({ method: 'POST', url: '/api/metrics-v2/rollout/portfolio/prepare',
      payload: { expected_plan_hash: `sha256:${'b'.repeat(64)}` } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'PORTFOLIO_PLAN_CHANGED' });
  });
});
