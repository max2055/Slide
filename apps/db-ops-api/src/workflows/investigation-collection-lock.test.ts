import { expect, it, vi } from 'vitest';
import { BoundedWorkflowRuntime } from './bounded-worker.js';
import { MysqlWorkflowStore, type ClaimedJob } from './worker-runtime.js';
import { INVESTIGATION_PROFILES, investigationProfileHash } from '../investigations/profiles.js';

const job = (type: string, payload: Record<string, unknown>): ClaimedJob => ({ id: type, type, payload, attempts: 1, maxAttempts: 3, fencingToken: 1 });
const snapshot = { id: 'inv', profileId: 'ops', profileVersion: 1, resources: [{ type: 'instance', id: 1 }],
  authority: { profileHash: investigationProfileHash(INVESTIGATION_PROFILES.ops) } };
function fixture() {
  const execute = vi.fn(async (sql: string) => [sql.includes('investigation_requests')
    ? [{ snapshot, investigationId: 'inv', requestId: 'req', profileId: 'ops', profileVersion: 1 }]
    : [{ resourceKey: 'server:3', revision: 2 }]] as any);
  const store = new MysqlWorkflowStore(() => ({ execute }));
  return { execute, store: { resourcesFor: (j: ClaimedJob) => store.resourcesFor(j, { workerId: 'test' }) } };
}
it('uses durable read-only investigation and collection identities, preserving type plus id', async () => {
  const { store, execute } = fixture();
  expect(await store.resourcesFor(job('investigation.execute', { investigationId: 'inv', requestId: 'req', resourceId: 99 })))
    .toEqual(['investigation:inv', 'read:instance:1']);
  expect(await store.resourcesFor(job('metrics.collect', { resource: { type: 'server', id: 3 }, revision: 2 })))
    .toEqual(['collection:server:3', 'read:server:3']);
  expect(execute.mock.calls.every(([sql]) => sql.includes('fencing_token') && sql.includes('lease_expires_at'))).toBe(true);
});
it('retains the global exclusion for unknown, forged, stale or unrecognized work', async () => {
  const { store, execute } = fixture();
  expect(await store.resourcesFor(job('action.execute', { resource: { type: 'server', id: 3 } }))).toEqual(['*']);
  execute.mockResolvedValue([[]] as any);
  expect(await store.resourcesFor(job('investigation.execute', { investigationId: 'inv', requestId: 'req' }))).toEqual(['*']);
  expect(await store.resourcesFor(job('metrics.collect', { resource: { type: 'instance', id: 99 }, revision: 2 }))).toEqual(['*']);
  execute.mockResolvedValue([[{ resourceKey: 'server:3', revision: 2 }]] as any);
  expect(await store.resourcesFor(job('metrics.collect', { resource: { type: 'instance', id: 3 }, revision: 2 }))).toEqual(['*']);
});
it.each([
  { profileId: 'unknown' }, { profileVersion: 99 }, { id: 'other' },
  { authority: { profileHash: 'forged' } }, { resources: [{ type: 'server', id: -1 }] },
  { resources: [{ type: '*', id: 3 }] },
])('rejects a durable snapshot outside the recognized readonly contract: %j', async mutation => {
  const { store, execute } = fixture();
  execute.mockResolvedValue([[{ snapshot: { ...snapshot, ...mutation }, investigationId: 'inv', requestId: 'req', profileId: 'ops', profileVersion: 1 }]] as any);
  expect(await store.resourcesFor(job('investigation.execute', { investigationId: 'inv', requestId: 'req' }))).toEqual(['*']);
});
it('allows collection during a read wait but blocks an exclusive writer until that read settles', async () => {
  const pending = [job('investigation.execute', {}), job('metrics.collect', {})];
  const keys: Record<string, string[]> = { 'investigation.execute': ['read:instance:1'], 'metrics.collect': ['collection:instance:1', 'read:instance:1'], 'notification.deliver': ['instance:1'] };
  const store = { claim: async (_id: string, _lease: number, filter?: any) => {
    const i = pending.findIndex(j => !filter || (filter.exclude ? !filter.types.includes(j.type) : filter.types.includes(j.type)));
    return i < 0 ? null : pending.splice(i, 1)[0];
  }, heartbeat: async () => true, complete: async () => true, fail: async () => true };
  const runtime = new BoundedWorkflowRuntime(store, 'test', 3, async j => keys[j.type]);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const started: string[] = [];
  const run = runtime.runOnce(async j => { started.push(j.type); if (j.type === 'investigation.execute') await gate; });
  try {
    await vi.waitFor(() => expect(started).toContain('metrics.collect'), { timeout: 300 });
    pending.push(job('notification.deliver', {}));
    const next = runtime.runOnce(async j => { started.push(j.type); });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(started).not.toContain('notification.deliver');
    release(); await next;
  } finally { release(); await run; await runtime.shutdown(); }
  expect(started).toContain('notification.deliver');
});
