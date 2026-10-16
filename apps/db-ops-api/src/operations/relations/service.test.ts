import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../auth/actor-context.js';
import { canManageResource } from '../../resources/resource-service.js';
import { projectResourceRelation } from '../../resources/types.js';
import { RelationService } from './service.js';
import { OperationsAuthorization } from '../authorization.js';
import type { RelationSession, RelationStore, StoredRelation } from './store.js';

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

  it.each(['withdrawn', 'expired'])('removes a path whose upstream becomes %s before send', async state => {
    let now = new Date('2026-10-16T00:00:00.000Z');
    const edge = (id: string, source: number, target: number): StoredRelation => ({ id, relationId: id, version: 2, schemaVersion: 1,
      source: { type: 'server', id: source }, target: { type: 'server', id: target }, relationType: 'depends_on',
      state: 'confirmed', origin: 'manual', author: { kind: 'user', id: 1 }, contentHash: id.repeat(64), legacyProvenance: null,
      observedAt: now.toISOString(), validFrom: now.toISOString(), validUntil: '2026-10-16T00:00:01.000Z', confirmedBy: 1, confirmedAt: now.toISOString(),
      evidence: [{ id: 'source', version: 1, hash: 'a'.repeat(64), validUntil: '2026-10-17T00:00:00.000Z' }], withdrawalReason: null });
    const values = [edge('1', 1, 2), edge('2', 2, 3)];
    const session: RelationSession = {
      connection: { execute: async () => [[{ id: 1 }]] } as any,
      lockResources: async () => {}, lockHead: async () => {}, legacyValidity: async () => ({ validUntil: null }),
      head: async id => values.find(value => value.id === id) ?? null,
      adjacent: async ref => values.filter(value => value.source.id === ref.id || value.target.id === ref.id),
      history: async () => [], append: async () => {},
    };
    let upstreamReads = 0;
    const liveAuth = new OperationsAuthorization({ loadInvestigationActorFrom: async () => actor });
    const graphService = new RelationService({ transaction: work => work(session) }, liveAuth,
      { check: async (_session, _actor, relation) => {
        if (relation.id === '1' && ++upstreamReads > 1) {
          if (state === 'withdrawn') return 'withdrawn';
          now = new Date(+now + 2000);
        }
        return 'valid';
      } },
      undefined, () => now);
    expect(await graphService.graph(actor, { type: 'server', id: 1 })).toMatchObject({ edges: [], partial: true });
  });

  it('filters legacy source expiry across the asynchronous transaction commit', async () => {
    let now = new Date('2026-10-16T00:00:00.000Z');
    const value: StoredRelation = { id: '1', relationId: '1', version: 2, schemaVersion: 1,
      source: { type: 'instance', id: 1 }, target: { type: 'server', id: 1 }, relationType: 'runs_on',
      state: 'confirmed', origin: 'manual', author: { kind: 'user', id: 1 }, contentHash: 'a'.repeat(64), legacyProvenance: 'legacy',
      observedAt: now.toISOString(), validFrom: now.toISOString(), validUntil: null, confirmedBy: 1, confirmedAt: now.toISOString(),
      evidence: [{ id: 'source', version: 1, hash: 'a'.repeat(64), validUntil: '2026-10-17T00:00:00.000Z' }], withdrawalReason: null };
    const session: RelationSession = {
      connection: { execute: async () => [[{ id: 1 }]] } as any,
      lockResources: async () => {}, lockHead: async () => {},
      legacyValidity: async () => ({ validUntil: '2026-10-16T00:00:01.000Z' }),
      head: async () => value, adjacent: async () => [value], history: async () => [], append: async () => {},
    };
    const graphService = new RelationService({ transaction: async work => {
      const result = await work(session);
      // The database commit completes after the source window closes.
      await Promise.resolve(); now = new Date(+now + 2000);
      return result;
    } }, new OperationsAuthorization({ loadInvestigationActorFrom: async () => actor }),
    { check: async () => 'valid' }, undefined, () => now);
    expect(await graphService.graph(actor, value.source)).toMatchObject({ edges: [], partial: true });
  });
});
