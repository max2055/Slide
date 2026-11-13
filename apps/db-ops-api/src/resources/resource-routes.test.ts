import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerResourceRoutes } from './resource-routes.js';
import type { ActorContext } from '../auth/actor-context.js';
import { ResourceAgentDiagnosisService } from './resource-agent-diagnosis-service.js';
import { ResourceDiagnosticService } from './resource-diagnostic-service.js';
import { PolicyError } from '../metrics/policy/model.js';
import { analysisAuthorizationVersion } from '../analysis/analysis-identity.js';
const actor: ActorContext = { userId: 1, username: 'test', roles: [], permissions: ['*'], sessionVersion: 1, instanceScopes: {}, requestId: 'test' };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function setup(permissions: string[] = ['*'], overrides: Partial<ActorContext> = {}) {
  const app = Fastify(); apps.push(app);
  const result = vi.fn(async () => ({ analysisId: 7, status: 'running', result: null }));
  const diagnose = vi.fn(async (..._args: unknown[]) => ({ success: true, analysisId: 7, status: 'queued' }));
  await registerResourceRoutes(app, async request => { (request as any).user = { ...actor, permissions, ...overrides }; }, {} as any, { result, diagnose } as any);
  return { app, result, diagnose };
}
describe('resource-bound analysis routes', () => {
  // GitHub #553: the route permission gate must follow the shared permission semantics.
  it.each([
    { name: 'exact permissions', permissions: ['ai:view', 'ai:manage'] },
    { name: 'resource wildcard', permissions: ['ai:*'] },
    { name: 'action wildcards', permissions: ['*:view', '*:manage'] },
    { name: 'global wildcard', permissions: ['*'] },
    { name: 'admin role', permissions: [], roles: ['admin'] },
    { name: 'bootstrap admin identity', permissions: [], username: 'AdMiN' },
  ])('accepts $name at both AI gates', async ({ permissions, ...overrides }) => {
    const { app, result, diagnose } = await setup(permissions, overrides);
    expect((await app.inject('/api/resources/instance/2/analyses/7')).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/resources/instance/2/diagnose-agent' })).statusCode).toBe(202);
    expect(result).toHaveBeenCalledOnce();
    expect(diagnose).toHaveBeenCalledOnce();
  });
  it.each([
    [], ['servers:*'], ['ai:delete'], ['AI:*'], ['ai:view:extra'], ['*:*'], ['ai'],
  ].map(permissions => ({ permissions })))('rejects unrelated or malformed grants $permissions', async ({ permissions }) => {
    const { app, result, diagnose } = await setup(permissions);
    const read = await app.inject('/api/resources/instance/2/analyses/7');
    const submit = await app.inject({ method: 'POST', url: '/api/resources/instance/2/diagnose-agent' });
    expect(read.statusCode).toBe(403); expect(read.json().error).toBe('AI_RESULT_FORBIDDEN');
    expect(submit.statusCode).toBe(403); expect(submit.json().error).toBe('AI_DIAGNOSIS_FORBIDDEN');
    expect(result).not.toHaveBeenCalled(); expect(diagnose).not.toHaveBeenCalled();
  });
  it.each(['ai:view', '*:view'])('keeps %s read-only', async permission => {
    const { app, result, diagnose } = await setup([permission]);
    expect((await app.inject('/api/resources/instance/2/analyses/7')).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/resources/instance/2/diagnose-agent' })).statusCode).toBe(403);
    expect(result).toHaveBeenCalledOnce(); expect(diagnose).not.toHaveBeenCalled();
  });
  it.each(['ai:manage', '*:manage'])('does not infer view from %s', async permission => {
    const { app, result, diagnose } = await setup([permission]);
    expect((await app.inject('/api/resources/instance/2/analyses/7')).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/resources/instance/2/diagnose-agent' })).statusCode).toBe(202);
    expect(result).not.toHaveBeenCalled(); expect(diagnose).toHaveBeenCalledOnce();
  });
  it.each(['instance', 'server', 'network_device'])('returns actual %s state with the subject forwarded for authorization', async type => {
    const { app, result } = await setup();
    const response = await app.inject(`/api/resources/${type}/2/analyses/7`);
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ status: 'running', result: null });
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ userId: 1 }), { type, id: 2 }, 7);
  });
  it('requires ai:view for results and ai:manage for new analysis', async () => {
    const { app, result } = await setup(['ai:manage']);
    expect((await app.inject('/api/resources/server/2/analyses/7')).statusCode).toBe(403); expect(result).not.toHaveBeenCalled();
    const viewer = await setup(['ai:view']);
    expect((await viewer.app.inject({ method: 'POST', url: '/api/resources/server/2/diagnose-agent' })).statusCode).toBe(403); expect(viewer.diagnose).not.toHaveBeenCalled();
  });
  it('rejects malformed identities and preserves queued HTTP semantics', async () => {
    const { app, result } = await setup();
    expect((await app.inject('/api/resources/server/2/analyses/7x')).statusCode).toBe(400);
    expect((await app.inject('/api/resources/constructor/2/analyses/7')).statusCode).toBe(400); expect(result).not.toHaveBeenCalled();
    const response = await app.inject({ method: 'POST', url: '/api/resources/server/2/diagnose-agent' });
    expect(response.statusCode).toBe(202); expect(response.json().status).toBe('queued');
  });
  it('rejects unconfirmed unknown retries and forwards only explicit confirmation', async () => {
    const { app, diagnose } = await setup();
    for (const body of [{ retryOf: 7 }, { retryOf: 7, confirmUnknownRetry: 'true' }, { retryOf: -1, confirmUnknownRetry: true }]) {
      expect((await app.inject({ method: 'POST', url: '/api/resources/server/2/diagnose-agent', payload: body })).statusCode).toBe(400);
    }
    expect(diagnose).not.toHaveBeenCalled();
    const confirmed = await app.inject({ method: 'POST', url: '/api/resources/server/2/diagnose-agent', payload: { retryOf: 7, confirmUnknownRetry: true } });
    expect(confirmed.statusCode).toBe(202); expect(diagnose).toHaveBeenCalledWith(expect.objectContaining({ userId: 1 }), { type: 'server', id: 2 }, 7);
  });
  it('returns an unknown receipt as 409 so the client does not silently repeat billing', async () => {
    const { app, diagnose } = await setup(); diagnose.mockResolvedValue({ success: false, analysisId: 7, status: 'unknown' });
    const response = await app.inject({ method: 'POST', url: '/api/resources/server/2/diagnose-agent' });
    expect(response.statusCode).toBe(409); expect(response.json()).toMatchObject({ analysisId: 7, status: 'unknown' });
  });
});

describe('GitHub #553: AI permission grants retain downstream authorization', () => {
  async function boundarySetup(initialActor: ActorContext) {
    let currentActor = initialActor;
    let liveActor = initialActor;
    const app = Fastify(); apps.push(app);
    const readAnalysis = vi.fn(async () => ({
      id: 7, instance_id: 2, server_id: 2, network_device_id: 2,
      request_actor_id: initialActor.userId, authorization_version: analysisAuthorizationVersion(initialActor),
      status: 'completed', result: 'bounded result',
    }));
    const detail = vi.fn(async (resource) => ({ resource, label: 'fixture', status: 'online' as const, attributes: {} }));
    const evidence = new ResourceDiagnosticService({
      list: async () => [], detail, observations: async () => [], relations: async () => [], alerts: async () => [],
    }, { reloadActor: async () => liveActor });
    const dispatch = vi.fn(async () => ({ success: true, analysisId: 7, cached: false }));
    const diagnosis = new ResourceAgentDiagnosisService({ evidence, dispatch, readAnalysis: readAnalysis as any, now: () => new Date() });
    await registerResourceRoutes(app, async request => { (request as any).user = currentActor; }, evidence, diagnosis);
    return { app, readAnalysis, detail, dispatch,
      setActor: (value: ActorContext) => { currentActor = value; },
      setLiveActor: (value: ActorContext) => { liveActor = value; },
    };
  }

  it.each(['instance', 'server', 'network_device'])('keeps delegated %s boundaries even with global AI grants', async type => {
    const fixture = await boundarySetup({ ...actor, resourceBoundary: { instanceIds: [], serverIds: [], networkDeviceIds: [] } });
    const read = await fixture.app.inject(`/api/resources/${type}/2/analyses/7`);
    const submit = await fixture.app.inject({ method: 'POST', url: `/api/resources/${type}/2/diagnose-agent` });
    expect(read.statusCode).toBe(403); expect(read.json().error).toBe('RESOURCE_FORBIDDEN');
    expect(submit.statusCode).toBe(403); expect(submit.json().error).toBe('POLICY_FORBIDDEN');
    expect(fixture.readAnalysis).not.toHaveBeenCalled(); expect(fixture.detail).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it('does not turn action grants into instance scope access', async () => {
    const fixture = await boundarySetup({ ...actor, permissions: ['*:view', '*:manage'] });
    expect((await fixture.app.inject('/api/resources/instance/2/analyses/7')).statusCode).toBe(403);
    expect((await fixture.app.inject({ method: 'POST', url: '/api/resources/instance/2/diagnose-agent' })).statusCode).toBe(403);
    expect(fixture.readAnalysis).not.toHaveBeenCalled(); expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it('preserves live grant revocation before evidence or dispatch', async () => {
    const fixture = await boundarySetup({ ...actor, permissions: ['*:view', '*:manage'], instanceScopes: { 2: 'read-only' } });
    fixture.setLiveActor({ ...actor, permissions: [], instanceScopes: {} });
    const response = await fixture.app.inject({ method: 'POST', url: '/api/resources/instance/2/diagnose-agent' });
    expect(response.statusCode).toBe(403); expect(response.json().error).toBe('POLICY_FORBIDDEN');
    expect(fixture.detail).not.toHaveBeenCalled(); expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it('uses each authenticated snapshot after role or permission removal', async () => {
    const fixture = await boundarySetup({ ...actor, permissions: [], roles: ['admin'] });
    fixture.setActor({ ...actor, permissions: [], roles: [] });
    expect((await fixture.app.inject('/api/resources/instance/2/analyses/7')).json().error).toBe('AI_RESULT_FORBIDDEN');
    expect((await fixture.app.inject({ method: 'POST', url: '/api/resources/instance/2/diagnose-agent' })).json().error).toBe('AI_DIAGNOSIS_FORBIDDEN');
    expect(fixture.readAnalysis).not.toHaveBeenCalled(); expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it('keeps stored result ownership and authorization snapshot binding', async () => {
    const fixture = await boundarySetup({ ...actor, permissions: ['*:view'], instanceScopes: { 2: 'read-only' } });
    fixture.setActor({ ...actor, userId: 99, permissions: ['*:view'], instanceScopes: { 2: 'read-only' } });
    expect((await fixture.app.inject('/api/resources/instance/2/analyses/7')).statusCode).toBe(404);
    fixture.setActor({ ...actor, permissions: ['*:view', 'ai:manage'], instanceScopes: { 2: 'read-only' } });
    expect((await fixture.app.inject('/api/resources/instance/2/analyses/7')).statusCode).toBe(404);
  });

  it('retains dispatch admission rejection after permitted evidence collection', async () => {
    const fixture = await boundarySetup({ ...actor, permissions: ['*:manage'], instanceScopes: { 2: 'read-only' } });
    fixture.dispatch.mockRejectedValue(new PolicyError('POLICY_FORBIDDEN', 403));
    const response = await fixture.app.inject({ method: 'POST', url: '/api/resources/instance/2/diagnose-agent' });
    expect(response.statusCode).toBe(403); expect(response.json().error).toBe('POLICY_FORBIDDEN');
    expect(fixture.detail).toHaveBeenCalledOnce(); expect(fixture.dispatch).toHaveBeenCalledOnce();
  });

  it('accepts scoped action grants through loopback HTTP and real diagnosis services', async () => {
    const fixture = await boundarySetup({ ...actor, permissions: ['*:view', '*:manage'], instanceScopes: { 2: 'read-only' } });
    const url = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    const submitted = await fetch(`${url}/api/resources/instance/2/diagnose-agent`, { method: 'POST' });
    expect(submitted.status).toBe(202); expect(await submitted.json()).toMatchObject({ analysisId: 7, status: 'queued' });
    const read = await fetch(`${url}/api/resources/instance/2/analyses/7`);
    expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ analysisId: 7, result: 'bounded result' });
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ actor: expect.objectContaining({ instanceScopes: { 2: 'read-only' } }) }));
  });
});
