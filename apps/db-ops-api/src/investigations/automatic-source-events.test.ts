import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actorContextService, type ActorContext } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import { registerInvestigationRoutes } from './routes.js';
import type { InvestigationSessionBridge } from './session-bridge.js';
import { InvestigationStoreError } from './store.js';

const id = '12345678-1234-4234-a234-123456781234';
const actor: ActorContext = {
  userId: 7, username: 'operator', roles: [], sessionVersion: 1, requestId: 'source-event-test',
  permissions: ['chat:view', 'alert:view', 'servers:view', 'instance:view'], instanceScopes: { 11: 'read-only' },
  resourceBoundary: { serverIds: [21], instanceIds: [11], networkDeviceIds: [] },
};

async function setup(options: {
  actor?: ActorContext; final?: ActorContext; initial?: ActorContext; manual?: number[]; denied?: boolean;
} = {}) {
  const execute = vi.fn(async (sql: string, values: unknown[]) => {
    if (sql.includes('FROM investigation_alert_owners')) {
      expect(values).toEqual([id]);
      expect(sql).toContain('m.alert_id = o.alert_id');
      expect(sql).toContain('e.id = m.event_id');
      expect(sql).toContain("o.lane = 'investigation'");
      expect(sql).toContain("JSON_UNQUOTE(JSON_EXTRACT(o.command_snapshot, '$.trigger')) = 'auto'");
      return [[{ id: 53, instance_id: 12 }, { id: 52, instance_id: null }, { id: 51, instance_id: 11 }]];
    }
    if (sql.includes('FROM metric_trigger_episodes')) return [values[0] === 52
      ? [{ payload: { resource: { type: 'server', id: '21' } } }] : []];
    throw new Error('Unexpected event query');
  });
  vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as never);
  const caller = options.actor ?? actor;
  const live = vi.spyOn(actorContextService, 'revalidateActor').mockResolvedValue(options.final ?? options.initial ?? caller)
    .mockResolvedValueOnce(options.initial ?? caller);
  const context = options.manual === undefined ? undefined : { entry: { sourceEventIds: options.manual, returnTo: '/events' } };
  const detail = vi.fn(async () => {
    if (options.denied) throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
    return { id, title: 'Existing investigation', activeRequestId: null, context };
  });
  const bridge = { storeFor: () => ({ detail }), workflowService: () => ({ canOperate: async () => false }) };
  const observation = { stream: { snapshot: async () => ({ runs: [], watermark: 0 }) },
    results: { list: async () => ({ items: [] }) }, evidence: {} };
  const app = Fastify();
  await registerInvestigationRoutes(app, async request => { Object.assign(request, { user: caller }); },
    bridge as unknown as InvestigationSessionBridge, observation as never, { read: async () => null } as never);
  return { app, read: () => app.inject({ url: `/api/investigations/${id}` }), execute, live };
}

describe('automatic sources in investigation detail', () => {
  let fixture: Awaited<ReturnType<typeof setup>> | undefined;
  afterEach(async () => { await fixture?.app.close(); vi.restoreAllMocks(); });

  it.each([{ manual: [45] }, { manual: [] }])('preserves manual entry $manual without probing automatic links', async ({ manual }) => {
    fixture = await setup({ manual });
    const response = await fixture.read();
    expect(response.statusCode).toBe(200);
    expect(response.json().context.entry.sourceEventIds).toEqual(manual);
    expect(response.json()).not.toHaveProperty('sourceEventIds');
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('projects exact auto-owner event members after the canonical event ACL', async () => {
    fixture = await setup();
    const response = await fixture.read();
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toMatchObject({ id, sourceEventIds: [52, 51] });
    expect(response.json()).not.toHaveProperty('context');
  });

  it('does not query independent refs for callers without alert:view', async () => {
    fixture = await setup({ actor: { ...actor, permissions: ['chat:view'] } });
    const response = await fixture.read();
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('sourceEventIds');
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('does not query independent refs for callers without investigation access', async () => {
    fixture = await setup({ denied: true });
    expect((await fixture.read()).statusCode).toBe(404);
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('does not upgrade the original event scope when a grant arrives during the read', async () => {
    const narrow = { ...actor, instanceScopes: {} };
    fixture = await setup({ actor: narrow, initial: actor });
    expect((await fixture.read()).json().sourceEventIds).toEqual([52]);
  });

  it.each([
    { ...actor, permissions: ['chat:view', 'servers:view', 'instance:view'] },
    { ...actor, instanceScopes: {} },
  ])('omits refs when event authority changes after the event reads', async final => {
    fixture = await setup({ final });
    const response = await fixture.read();
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('sourceEventIds');
    expect(fixture.live).toHaveBeenCalledTimes(2);
  });
});
