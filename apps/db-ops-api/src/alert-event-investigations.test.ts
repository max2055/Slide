import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerEventReadRoutes } from './alert-event-access.js';
import { actorContextService, type ActorContext } from './auth/actor-context.js';
import { dbConnection } from './db-connection.js';

const base = '/api/alerts/events';
const time = '2026-11-20T09:00:00.000Z';
const manualId = '11111111-1111-4111-a111-111111111111';
const automaticId = '22222222-2222-4222-a222-222222222222';
const otherId = '33333333-3333-4333-a333-333333333333';
const requestId = '44444444-4444-4444-a444-444444444444';
const runId = '55555555-5555-4555-a555-555555555555';
const evidenceId = '66666666-6666-4666-a666-666666666666';
const viewer: ActorContext = {
  userId: 7, username: 'operator', roles: [], sessionVersion: 1, requestId: 'event-link-read',
  permissions: ['alert:view', 'chat:view', 'instance:view', 'servers:view'],
  instanceScopes: { 10: 'read-only' },
  resourceBoundary: { instanceIds: [10], serverIds: [20], networkDeviceIds: [] },
};

function setup() {
  let caller = viewer;
  let live = viewer;
  let member = true;
  let evidencePresent = true;
  let jobState: string | null = 'completed';
  let runState: string | null = 'completed';
  let includeEvidence = true;
  let rejection: 'legacy' | 'marked' | undefined;
  let afterResult: (() => void) | undefined;
  const events = [
    { id: 101, instance_id: 10, episode: null },
    { id: 102, instance_id: null, episode: { resource: { type: 'server', id: '20' } } },
    { id: 103, instance_id: 10, episode: null },
    { id: 104, instance_id: 11, episode: null },
    { id: 105, instance_id: 10, episode: null },
    { id: 106, instance_id: 10, episode: null },
    { id: 107, instance_id: 10, episode: null },
    { id: 108, instance_id: 10, episode: null },
  ];
  const fromManual = [
    { eventId: 101, investigationId: manualId },
    { eventId: 105, investigationId: otherId },
    { eventId: 105, investigationId: manualId },
    { eventId: '108', investigationId: manualId },
  ];
  const eventMembers = [{ eventId: 102, alertId: 75 }, { eventId: 106, alertId: 76 }, { eventId: 107, alertId: 77 }];
  const alertOwners = [
    { alertId: 75, lane: 'investigation', trigger: 'auto', investigationId: automaticId },
    { alertId: 76, lane: 'legacy', trigger: 'auto', investigationId: manualId },
    { alertId: 77, lane: 'investigation', trigger: 'manual', investigationId: manualId },
  ];
  // The storage double supplies database facts. Membership, content, and
  // evidence authorization use the production implementation on this executor.
  const execute = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith('SET TRANSACTION')) return [[]];
    if (sql.includes('FROM alert_events e LEFT JOIN')) return [events.filter(event => args.includes(event.id))];
    if (sql.startsWith('WITH visible AS')) {
      const candidateIds = args.slice(4, (args.length + 4) / 2);
      expect(sql).toContain("e.id MEMBER OF (JSON_EXTRACT(k.command_snapshot, '$.context.entry.sourceEventIds'))");
      expect(sql).toContain('o.alert_id = m.alert_id');
      expect(sql).toContain("o.lane = 'investigation'");
      expect(sql).toContain("JSON_UNQUOTE(JSON_EXTRACT(o.command_snapshot, '$.trigger')) = 'auto'");
      const automatic = eventMembers.flatMap(link => alertOwners
        .filter(owner => owner.alertId === link.alertId && owner.lane === 'investigation' && owner.trigger === 'auto')
        .map(owner => ({ eventId: link.eventId, investigationId: owner.investigationId })));
      return [[...fromManual, ...automatic].filter(link => candidateIds.includes(link.eventId))
        .map(link => ({ event_id: link.eventId, investigation_id: link.investigationId }))];
    }
    if (sql.startsWith('SELECT * FROM investigations WHERE id = ? FOR SHARE')) {
      const [id] = args;
      return [[{ id, session_id: `session:${id}`, profile_id: 'ops', profile_version: 1, scope_version: 'frozen',
        version: 5, lifecycle: 'open', owner_kind: id === automaticId ? 'service' : 'user', owner_id: id === manualId ? 7 : 8 }]];
    }
    if (sql.includes('FROM investigation_resources')) return [[args[0] === automaticId
      ? { resource_type: 'server', resource_id: 20, role: 'primary' }
      : { resource_type: 'instance', resource_id: 10, role: 'primary' }]];
    if (sql.includes('SELECT role FROM investigation_members')) return [member && args[0] === automaticId ? [{ role: 'viewer' }] : []];
    if (sql.startsWith('SELECT i.id FROM investigations i')) return [args.slice(0, -4)
      .filter(id => id === manualId || id === automaticId && member).map(id => ({ id }))];
    if (/SELECT id FROM (database_instances|servers)/.test(sql)) return [[{ id: args[0] }]];
    if (sql.startsWith('SELECT i.title')) return [[args[0] === manualId
      ? { title: 'Manual event investigation', updated_at: time, request_id: null, job_id: null, run_state: null }
      : { title: 'Automatic alert investigation', updated_at: time, request_id: requestId, job_id: 'fixture-job', run_state: runState }]];
    if (sql === 'SELECT state FROM workflow_jobs WHERE id = ?') {
      expect(args).toEqual(['fixture-job']);
      return [[{state:jobState}]];
    }
    if (sql.includes('FROM investigation_results WHERE')) {
      expect(args).toEqual([automaticId, requestId]);
      afterResult?.();
      return [[{ version: 3, run_id: runId, result_json: {
        schemaVersion: 2, subject: { kind: 'resource', resource: { type: 'server', id: 20 } },
        summary: rejection === 'legacy' ? '模型最终输出未通过格式或证据引用校验；未发布判断与假设。' : 'Stored conclusion',
        facts: includeEvidence ? [{ statement: 'Read-only evidence', evidenceIds: [evidenceId] }] : [],
        claims: [], hypotheses: [], rootCauseVerification: { status: 'unverified' }, unresolvedQuestions: [],
        recommendations: [{ action: 'Stored recommendation', priority: 'high' }], problemStatus: 'unconfirmed',
        provenance: { modelVersion: 'recorded', promptVersion: 'recorded', toolVersions: {}, usageStatus: 'available' }, createdAt: time,
        ...(rejection === 'marked' ? {execution:{state:'completed',stopReason:'completed',source:'runtime',reasonCode:'INVESTIGATION_ANALYSIS_REJECTED'}} : {}),
      } }]];
    }
    if (sql.includes('FROM investigation_evidence WHERE')) {
      expect(args).toEqual([evidenceId, automaticId, requestId, runId]);
      return [evidencePresent ? [{ metadata_json: { resources: [{ type: 'instance', id: 10 }] } }] : []];
    }
    throw new Error(`Unexpected SQL in event investigation fixture: ${sql}`);
  });
  const connection = { execute, beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}), release: vi.fn() };
  const getConnection = vi.fn(async () => connection);
  vi.spyOn(dbConnection, 'getPool').mockReturnValue({ getConnection } as never);
  vi.spyOn(actorContextService, 'revalidateActorOn').mockImplementation(async executor => {
    expect(executor).toBe(connection);
    return live;
  });
  vi.spyOn(actorContextService, 'loadInvestigationActorFrom').mockImplementation(async executor => {
    expect(executor).toBe(connection);
    return live;
  });
  const app = Fastify();
  return {
    app, register: () => registerEventReadRoutes(app, async request => Object.assign(request, { user: caller })),
    execute, connection, getConnection,
    setCaller: (value: ActorContext) => { caller = value; live = value; },
    setMember: (value: boolean) => { member = value; },
    setEvidencePresent: (value: boolean) => { evidencePresent = value; },
    setRun: (run: string | null, job: string, evidence = true) => { runState = run; jobState = job; includeEvidence = evidence; },
    setRejection: (value: typeof rejection) => { rejection = value; },
    onResult: (callback: () => void) => { afterResult = callback; },
    setLive: (value: ActorContext) => { live = value; },
  };
}

const manual = { id: manualId, title: 'Manual event investigation', state: 'not_started',
  conclusion: null, recommendation: null, updatedAt: time, version: null };
const automatic = { id: automaticId, title: 'Automatic alert investigation', state: 'completed',
  conclusion: 'Stored conclusion', recommendation: 'Stored recommendation', updatedAt: time, version: 3 };

describe('event investigation projections', () => {
  let fixture: ReturnType<typeof setup>;
  beforeEach(async () => { fixture = setup(); await fixture.register(); });
  afterEach(async () => { await fixture.app.close(); vi.restoreAllMocks(); });
  const get = (path: string) => fixture.app.inject({ method: 'GET', url: `${base}/${path}` });

  it('reads exact manual and automatic links and filters a newer unreadable investigation', async () => {
    expect((await get('101/investigation')).json()).toEqual({ investigation: manual });
    expect((await get('102/investigation')).json()).toEqual({ investigation: automatic });
    expect((await get('105/investigation')).json()).toEqual({ investigation: manual });
  });

  it('returns the same projections in batch order and omits inaccessible and missing events on one connection', async () => {
    const response = await get('investigations?ids=104,102,999,103,101');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toEqual({ items: [
      { eventId: 102, investigation: automatic }, { eventId: 103, investigation: null }, { eventId: 101, investigation: manual },
    ] });
    expect(fixture.getConnection).toHaveBeenCalledOnce();
    expect(fixture.connection.commit).toHaveBeenCalledOnce();
    expect(fixture.connection.release).toHaveBeenCalledOnce();
  });

  it.each([103, 106, 107, 108])('returns null for event %i without an exact eligible link', async eventId => {
    expect((await get(`${eventId}/investigation`)).json()).toEqual({ investigation: null });
  });

  it.each([104, 999])('conceals inaccessible or absent event %i on the single route', async eventId => {
    expect((await get(`${eventId}/investigation`)).statusCode).toBe(404);
  });

  it.each(['', '1,1', '0', '01', '1e2', '1,%202', '9007199254740992', Array.from({ length: 21 }, (_, i) => i + 1).join(',')])(
    'rejects invalid batch IDs %s before acquiring a connection', async ids => {
      expect((await get(`investigations?ids=${ids}`)).statusCode).toBe(400);
      expect(fixture.getConnection).not.toHaveBeenCalled();
    });

  it('requires alert view and does not disclose links to a caller without chat view', async () => {
    fixture.setCaller({ ...viewer, permissions: ['instance:view', 'chat:view'] });
    expect((await get('101/investigation')).statusCode).toBe(403);
    fixture.setCaller({ ...viewer, permissions: ['instance:view', 'alert:view'] });
    expect((await get('101/investigation')).json()).toEqual({ investigation: null });
    expect(fixture.execute.mock.calls.some(([sql]) => sql.startsWith('WITH visible AS'))).toBe(false);
  });

  it('withholds a linked investigation when membership or bound evidence is unavailable', async () => {
    fixture.setMember(false);
    expect((await get('102/investigation')).json()).toEqual({ investigation: null });
    fixture.setMember(true);
    fixture.setEvidencePresent(false);
    expect((await get('102/investigation')).json()).toEqual({ investigation: null });
  });

  it('does not return text if evidence resource scope is withdrawn during the read', async () => {
    fixture.onResult(() => fixture.setLive({ ...viewer, instanceScopes: {} }));
    const response = await get('investigations?ids=101,102');
    expect(response.json()).toEqual({ items: [{ eventId: 102, investigation: null }] });
  });

  it('omits an investigation whose membership expires after its evidence read', async () => {
    vi.mocked(actorContextService.revalidateActorOn).mockImplementation(async (_executor, _actor, _requestId, locking) => {
      if (locking) fixture.setMember(false);
      return viewer;
    });
    const response = await get('investigations?ids=101,102');
    expect(response.json()).toEqual({ items: [{ eventId: 101, investigation: manual }, { eventId: 102, investigation: null }] });
  });

  it.each(['alert:view', 'chat:view'])('rejects the response when %s disappears at the final authority check', async permission => {
    vi.mocked(actorContextService.revalidateActorOn).mockImplementation(async (_executor, _actor, _requestId, locking) =>
      locking ? { ...viewer, permissions: viewer.permissions.filter(value => value !== permission) } : viewer);
    const response = await get('investigations?ids=101,102');
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'FORBIDDEN' });
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
    expect(fixture.connection.release).toHaveBeenCalledOnce();
  });

  it.each([
    [null, 'queued', true, 'running'], ['running', 'running', true, 'running'],
    ['partial', 'completed', true, 'insufficient'], ['completed', 'completed', false, 'insufficient'],
    ['timed_out', 'completed', true, 'failed'], [null, 'dead_letter', false, 'failed'],
  ] as const)('projects run %s and job %s as %s evidence → %s', async (run, job, evidence, state) => {
    fixture.setRun(run, job, evidence);
    expect((await get('102/investigation')).json().investigation.state).toBe(state);
  });
  it.each(['legacy','marked'] as const)('keeps a rejected %s model answer outside the completed queue even with tool evidence', async style => {
    fixture.setRejection(style);
    const response = await get('102/investigation');
    expect(response.json().investigation.state).toBe('insufficient');
  });
});
