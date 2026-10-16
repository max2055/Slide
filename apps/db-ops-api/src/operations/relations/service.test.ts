import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../auth/actor-context.js';
import { canManageResource } from '../../resources/resource-service.js';
import { projectResourceRelation } from '../../resources/types.js';
import { RelationService } from './service.js';
import type { RelationStore } from './store.js';

const actor: ActorContext = { userId: 1, username: 'test', roles: [], permissions: ['*'],
  instanceScopes: {}, sessionVersion: 1, requestId: 'test' };
const input = { source: { type: 'server', id: 1 }, target: { type: 'server', id: 2 }, relationType: 'depends_on', origin: 'model',
  evidence: [], observedAt: '2026-01-01T00:00:00.000Z', validFrom: '2026-01-01T00:00:00.000Z', validUntil: null };
const store: RelationStore = { transaction: vi.fn(async () => { throw new Error('SHOULD_NOT_REACH_SQL'); }) };
const service = new RelationService(store, undefined, undefined,
  () => ({ context: true, cases: false, baselines: false, attention: false, plans: false, dispatch: false }));
describe('relation input and compatibility boundaries', () => {
  it.each([
    { relationType: 'hosts' }, { target: input.source }, { source: { type: 'server', id: 0 } },
    { state: 'confirmed' }, { expectedVersion: 0 }, { confirmedBy: 1 }, { origin: 'llm-fact' },
    { observedAt: '2099-01-01T00:00:00.000Z' }, { validUntil: input.validFrom },
    { source: { type: 'server', id: 1 }, target: { type: 'instance', id: 1 }, relationType: 'runs_on' },
  ])('rejects invalid or client-owned authority fields %j', async changes => {
    await expect(service.suggest(actor, { ...input, ...changes })).rejects.toMatchObject({ code: 'OPERATIONS_INPUT_INVALID' });
  });
  it('bounds traversal requests before querying storage', async () => {
    for (const options of [{ hops: 3 }, { maxEdges: 101 }, { maxEdges: 0 }, { factsOnly: 'false' }]) {
      await expect(service.graph(actor, input.source, options as any)).rejects.toMatchObject({ code: 'OPERATIONS_INPUT_INVALID' });
    }
  });
  it('does not let wildcard managers escape a delegated ceiling', () => {
    const bounded = { ...actor, resourceBoundary: { instanceIds: [1], serverIds: [1], networkDeviceIds: [1] } };
    for (const type of ['server', 'instance', 'network_device'] as const) {
      expect(canManageResource(bounded, { type, id: 1 })).toBe(true);
      expect(canManageResource(bounded, { type, id: 2 })).toBe(false);
    }
  });
  it('projects hosts only from the server side without mutating the canonical relation', () => {
    const value = { source: { type: 'instance' as const, id: 1 }, target: { type: 'server' as const, id: 2 },
      relationType: 'runs_on' as const, provenance: 'old', validFrom: new Date(0) };
    expect(projectResourceRelation(value, value.target)).toMatchObject({ source: value.target, target: value.source, relationType: 'hosts' });
    expect(projectResourceRelation(value, value.source)).toBe(value); expect(value.relationType).toBe('runs_on');
  });
});
