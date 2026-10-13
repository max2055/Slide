import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createMessageProjection } from '../../../../../packages/agent-core/src/message-projection.ts';
import { applyInvestigationEvent, investigationMessages, InvestigationsController } from './investigations.ts';
import { InvestigationApiError, investigationApi, type InvestigationSnapshot } from './investigation-api.ts';
vi.mock('./investigation-api.ts', async importOriginal => ({ ...await importOriginal<object>(), investigationApi: vi.fn() }));
const api = vi.mocked(investigationApi);
const snapshot = (): InvestigationSnapshot => ({ investigationId: 'one', watermark: 0, documents: [], metadata: { version: 1, lifecycle: 'open', problemStatus: 'unconfirmed' },
  runs: [{ requestId: 'req', runId: 'run', state: 'running', resolution: 'known' }], projection: { runs: { run: createMessageProjection('run') }, documents: [] }, evidenceIds: [], truncated: false, nextBefore: null });
const event = (sequence: number, state = 'cancelled') => ({ schemaVersion: 1, investigationId: 'one', sequence, runId: 'run', type: 'run.terminal', occurredAt: new Date().toISOString(), payload: { state } }) as any;
beforeEach(() => { api.mockReset(); });
describe('investigation observation and authority', () => {
  it('deduplicates durable events, rejects gaps and never changes terminal outcome', () => {
    const initial = snapshot(), terminal = applyInvestigationEvent(initial, event(1));
    expect(initial.runs[0].state).toBe('running');
    expect(applyInvestigationEvent(terminal, event(1))).toBe(terminal);
    expect(() => applyInvestigationEvent(terminal, event(3))).toThrow('REPLAY_REQUIRED');
    expect(applyInvestigationEvent(terminal, event(2, 'completed')).runs[0].state).toBe('cancelled');
  });
  it('late Parts after terminal cannot replace visible text', () => {
    let value = snapshot();
    value.projection.runs.run.parts = [{ messageId: 'm', part: { id: 'p', type: 'text', text: 'before', source: 'fact', status: 'partial' } }];
    value = applyInvestigationEvent(value, event(1));
    const late = { schemaVersion: 1, investigationId: 'one', sequence: 2, runId: 'run', type: 'parts.operation', payload: {
      version: 1, runId: 'run', sequence: 1, attempt: 1, operations: [{ type: 'text.append', messageId: 'm', partId: 'p', text: 'late' }] } } as any;
    expect(applyInvestigationEvent(value, late).projection.runs.run.parts[0].part).toMatchObject({ text: 'before' });
  });
  it('revocation invalidates in-flight detail/list responses and drops sensitive caches', async () => {
    let release!: (v: unknown) => void;
    api.mockImplementation(() => new Promise(resolve => release = resolve));
    const c = new InvestigationsController(() => {}, null);
    c.snapshot = snapshot(); c.history = [{ id: 'sensitive' }];
    const pending = c.loadList(); c.clearSensitive();
    release({ items: [{ title: 'secret' }], authorizedCounts: { total: 1 }, nextCursor: null }); await pending;
    expect(c.list.items).toEqual([]); expect(c.snapshot).toBeNull(); expect(c.history).toEqual([]);
  });
  it('a late old investigation read cannot replace the newly selected investigation', async () => {
    const releases: Array<(v: any) => void> = [];
    api.mockImplementation(() => new Promise(resolve => releases.push(resolve)));
    const c = new InvestigationsController(() => {}, null);
    const one = c.select('one'), two = c.select('two');
    releases[3]({ id: 'two' }); releases[4]({ documents: [], nextBefore: null }); releases[5]({ items: [], nextBefore: null }); await two;
    releases[0]({ id: 'one' }); releases[1]({ documents: [], nextBefore: null }); releases[2]({ items: [], nextBefore: null }); await one;
    expect(c.detail?.id).toBe('two');
  });
  it('ambiguous acceptance reuses the key and forbids a different request', async () => {
    api.mockRejectedValue(new InvestigationApiError(503, 'INVESTIGATION_QUEUE_UNAVAILABLE'));
    const c = new InvestigationsController(() => {}, null);
    const body = { title: 'one', goal: 'goal', profileId: 'ops', subject: { kind: 'resource', resource: { type: 'instance', id: 1 } }, resourceRefs: [{ type: 'instance', id: 1, role: 'primary' }] } as any;
    await c.create(body); await c.create(body); await c.create({ ...body, goal: 'different' });
    expect(api).toHaveBeenCalledTimes(2);
    expect(api.mock.calls[0][1]?.headers).toEqual(api.mock.calls[1][1]?.headers);
    expect(c.error).toContain('上一请求');
  });
  it('HTTP revocation clears content instead of retaining a stale result', async () => {
    api.mockRejectedValue(new InvestigationApiError(404, 'INVESTIGATION_NOT_FOUND'));
    const c = new InvestigationsController(() => {}, null);
    c.history = [{ id: 'sensitive' }]; await c.select('one');
    expect(c.forbidden).toBe(true); expect(c.history).toEqual([]);
  });
});

it('terminal Parts persisted frames cannot introduce a late fact', () => {
  const value = applyInvestigationEvent(snapshot(), event(1));
  const late = { schemaVersion: 1, investigationId: 'one', sequence: 2, runId: 'run', type: 'parts.operation', payload: {
    version: 1, runId: 'run', sequence: 2, attempt: 0, operations: [{ type: 'parts.persisted', documents: [{ id: 'late', role: 'assistant', parts: [] }] }] } } as any;
  expect(applyInvestigationEvent(value, late).documents).toEqual([]);
});
it('clearing authority also clears loading indicators and connection state', () => {
  const c = new InvestigationsController(() => {}, null);
  c.loading = c.detailLoading = c.online = true; c.clearSensitive();
  expect([c.loading, c.detailLoading, c.online]).toEqual([false, false, false]);
});
it('operator rejection preserves authorized read content and disables operations', async () => {
  api.mockRejectedValue(new InvestigationApiError(403, 'INVESTIGATION_OPERATION_FORBIDDEN'));
  const c = new InvestigationsController(() => {}, null);
  c.detail = { id: 'one', version: 1 } as any; c.history = [{ id: 'authorized' }];
  await c.continue('viewer');
  expect(c.operationForbidden).toBe(true); expect(c.history).toEqual([{ id: 'authorized' }]);
});
it('acceptance retry preserves the original body after the observed version changes', async () => {
  api.mockRejectedValue(new InvestigationApiError(503, 'INVESTIGATION_QUEUE_UNAVAILABLE'));
  const c = new InvestigationsController(() => {}, null);
  c.detail = { id: 'one', version: 1 } as any;
  await c.continue('original'); c.detail.version = 2;
  await c.retryPending();
  expect(api.mock.calls[1][1]?.body).toBe(api.mock.calls[0][1]?.body);
  expect(api.mock.calls[1][1]?.headers).toEqual(api.mock.calls[0][1]?.headers);
});
it('coalesced refresh services the newly selected investigation after an old read ends', async () => {
  const c = new InvestigationsController(() => {}, null);
  const releases: Array<(v: any) => void> = [];
  api.mockImplementation(() => new Promise(resolve => releases.push(resolve)));
  (c as any).id = 'one';
  const old = (c as any).refreshFacts();
  (c as any).generation++; (c as any).id = 'two';
  const next = (c as any).refreshFacts();
  releases[0]({ id: 'one' }); releases[1]({ items: [], nextBefore: null }); releases[2]({ documents: [], nextBefore: null });
  await vi.waitFor(() => expect(api.mock.calls.length).toBe(6));
  expect(api.mock.calls[3][0]).toBe('/two');
  releases[3]({ id: 'two' }); releases[4]({ items: [], nextBefore: null }); releases[5]({ documents: [], nextBefore: null });
  await Promise.all([old, next]); expect(c.detail?.id).toBe('two');
});
it('overlapping history and snapshots preserve canonical order and IDs', () => {
  const value = snapshot();
  value.documents = ['older', 'middle', 'latest'].map(id => ({ id, role: 'user', parts: [], legacy: { id, role: 'user', content: id } })) as any;
  expect(investigationMessages(value, [{ id: 'middle' }, { id: 'latest' }]).map(m => m.id)).toEqual(['older', 'middle', 'latest']);
  expect(investigationMessages(value, [{ id: 'before' }, { id: 'middle' }, { id: 'latest' }, { id: 'newer' }]).map(m => m.id)).toEqual(['before', 'older', 'middle', 'latest', 'newer']);
});
it('an older concurrent result page cannot duplicate versions or rewind a cursor', async () => {
  const releases: Array<(v: any) => void> = [];
  api.mockImplementation(() => new Promise(resolve => releases.push(resolve)));
  const c = new InvestigationsController(() => {}, null);
  c.results = { items: [{ id: 'latest' }], nextBefore: 'page1' } as any;
  const first = c.loadResults(), duplicate = c.loadResults();
  releases[0]({ items: [{ id: 'old' }], nextBefore: 'page2' }); await first;
  const next = c.loadResults(); releases[2]({ items: [{ id: 'oldest' }], nextBefore: null }); await next;
  releases[1]({ items: [{ id: 'old' }], nextBefore: 'page2' }); await duplicate;
  expect(c.results.items.map(r => r.id)).toEqual(['latest', 'old', 'oldest']); expect(c.results.nextBefore).toBeNull();
});
it('switching selection during a submission does not leave the new view permanently busy', async () => {
  let release!: (v: any) => void;
  api.mockImplementation((_path, options) => options?.method === 'POST' ? new Promise(resolve => release = resolve) :
    Promise.resolve(_path.endsWith('/facts') ? { documents: [], nextBefore: null } : _path.endsWith('/results') ? { items: [], nextBefore: null } : { id: 'two' }) as any);
  const c = new InvestigationsController(() => {}, null);
  const pending = c.create({ title: 'one' } as any, false);
  await c.select('two'); release({ id: 'one' }); await pending;
  expect(c.busy).toBe(false); expect(c.detail?.id).toBe('two');
});
