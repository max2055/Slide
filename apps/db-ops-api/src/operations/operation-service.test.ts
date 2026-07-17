import { describe, expect, it } from 'vitest';
import { OperationService } from './operation-service.js';

function create(service: OperationService, key = 'key') {
  return service.create({ actorId: 7, origin: 'api', resource: { type: 'instance', id: '12' }, commandType: 'read', risk: 'low', idempotencyKey: key, correlationId: 'corr' });
}

describe('OperationService', () => {
  it('deduplicates idempotency per actor and appends an immutable timeline', () => {
    const service = new OperationService();
    const first = create(service);
    expect(create(service)).toBe(first);
    service.transition(first.id, 'waiting_approval', 'NEEDS_APPROVAL', 7);
    expect(service.eventsFor(first.id).map((event) => event.toState)).toEqual(['queued', 'waiting_approval']);
  });

  it('rejects illegal transitions', () => {
    const service = new OperationService();
    const operation = create(service);
    expect(() => service.transition(operation.id, 'succeeded', 'SKIP')).toThrow('Illegal operation transition');
  });

  it('claims at most once and makes expired uncertain work manually recoverable', () => {
    const service = new OperationService();
    const operation = create(service);
    expect(service.claim(operation.id, 'worker-a', 1, 7)?.state).toBe('claimed');
    expect(service.claim(operation.id, 'worker-b', 1, 7)).toBeNull();
    expect(service.expireLease(operation.id, new Date(Date.now() + 10))).toMatchObject({ state: 'unknown' });
  });
});
