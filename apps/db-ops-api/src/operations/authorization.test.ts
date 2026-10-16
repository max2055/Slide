import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../auth/actor-context.js';
import { ActorAuthenticationError } from '../auth/actor-context.js';
import { OperationsAuthorization, OPERATIONS_PERMISSIONS } from './authorization.js';

const actor = (changes: Partial<ActorContext> = {}): ActorContext => ({ userId: 2, username: 'operator',
  roles: [], permissions: ['*'], sessionVersion: 1, instanceScopes: {}, requestId: 'test', ...changes });
const connection = { execute: vi.fn(async () => [[{ id: 1 }], []]) };
describe('operations live authority', () => {
  it('checks both relation ends, intersects the caller ceiling and rechecks on each outbound read', async () => {
    let current = actor();
    const contexts = { loadInvestigationActorFrom: vi.fn(async () => current) };
    const auth = new OperationsAuthorization(contexts);
    const caller = actor({ resourceBoundary: { instanceIds: [1], serverIds: [1], networkDeviceIds: [] }, instanceScopes: { 1: 'read-only' } });
    const refs = [{ type: 'instance' as const, id: 1 }, { type: 'server' as const, id: 1 }];
    const bounded = await auth.authorize(connection, caller, refs, 'context:read');
    expect(bounded).toMatchObject({ userId: 2, roles: [], resourceBoundary: caller.resourceBoundary, instanceScopes: { 1: 'read-only' } });
    expect(bounded.permissions).not.toContain('*');
    current = actor({ permissions: ['instance:view', OPERATIONS_PERMISSIONS['context:read']], instanceScopes: { 1: 'read-only' } });
    await expect(auth.authorize(connection, caller, refs, 'context:read')).rejects.toMatchObject({ statusCode: 404 });
    current = actor();
    await expect(auth.authorize(connection, caller, [{ type: 'server', id: 2 }], 'context:read')).rejects.toMatchObject({ statusCode: 404 });
    await expect(auth.authorize(connection, caller, refs, 'context:manage')).rejects.toMatchObject({ statusCode: 403 });
    expect(contexts.loadInvestigationActorFrom).toHaveBeenCalledTimes(4);
  });
  it('never allows admin, requester, or service identities to self approve', async () => {
    const contexts = { loadInvestigationActorFrom: vi.fn(async () => actor({ roles: ['admin'] })) };
    const auth = new OperationsAuthorization(contexts);
    const refs = [{ type: 'server' as const, id: 1 }];
    for (const identities of [undefined, { author: { kind: 'user' as const, id: 2 }, requester: { kind: 'user' as const, id: 3 } },
      { author: { kind: 'user' as const, id: 3 }, requester: { kind: 'user' as const, id: 2 } }]) {
      await expect(auth.authorize(connection, actor(), refs, 'actions:approve', identities)).rejects.toMatchObject({ statusCode: 403 });
    }
    await expect(auth.authorize(connection, actor(), refs, 'actions:approve',
      { author: { kind: 'user', id: 3 }, requester: { kind: 'user', id: 3 } })).resolves.toMatchObject({ userId: 2 });
    contexts.loadInvestigationActorFrom.mockResolvedValue(actor({ principalKind: 'service' }));
    await expect(auth.authorize(connection, actor({ principalKind: 'service' }), refs, 'cases:review',
      { author: { kind: 'user', id: 3 } })).rejects.toMatchObject({ statusCode: 403 });
  });
  it('does not turn SQL failures into empty results and invalidates deleted users/resources', async () => {
    const contexts = { loadInvestigationActorFrom: vi.fn(async () => actor()) };
    const auth = new OperationsAuthorization(contexts);
    const refs = [{ type: 'server' as const, id: 1 }];
    await expect(auth.authorize({ execute: async () => [[], []] }, actor(), refs, 'actions:read')).rejects.toMatchObject({ statusCode: 404 });
    contexts.loadInvestigationActorFrom.mockRejectedValueOnce(new Error('SQL_UNAVAILABLE'));
    await expect(auth.authorize(connection, actor(), refs, 'actions:read')).rejects.toThrow('SQL_UNAVAILABLE');
    contexts.loadInvestigationActorFrom.mockRejectedValueOnce(new ActorAuthenticationError());
    await expect(auth.authorize(connection, actor(), refs, 'actions:read')).rejects.toMatchObject({ statusCode: 404 });
    await expect(auth.authorize(connection, actor(), [], 'actions:execute')).rejects.toThrow('OPERATIONS_INPUT_INVALID');
    await expect(auth.authorize(connection, actor(), [{ type: 'server', id: -1 }], 'actions:read')).rejects.toThrow('OPERATIONS_INPUT_INVALID');
  });
});
