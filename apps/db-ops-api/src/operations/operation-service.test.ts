import { describe, expect, it } from 'vitest';
import { OperationService, PersistentOperationService } from './operation-service.js';

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

class FakeOperationPool {
  policy: unknown = null;
  policyReads = 0;
  transactionActive = false;
  rows: any[] = [];
  events: any[] = [];
  commits = 0;
  rollbacks = 0;
  async getConnection() { return this; }
  async beginTransaction() { this.transactionActive = true; }
  async commit() { this.commits++; this.transactionActive = false; }
  async rollback() { this.rollbacks++; this.transactionActive = false; }
  release() {}
  async query(sql: string, values: any[] = []): Promise<any> {
    if (sql.includes('FROM system_config')) { expect(this.transactionActive).toBe(true); this.policyReads++; return [this.policy ? [{ config_value: JSON.stringify(this.policy) }] : []]; }
    if (sql.includes('INSERT INTO operations')) {
      const [id, actorId, origin, resourceType, resourceId, commandType, risk, idempotencyKey, approvalId, correlationId] = values;
      if (!this.rows.some((row) => row.actor_id === actorId && row.idempotency_key === idempotencyKey)) {
        this.rows.push({ id, actor_id: actorId, origin, resource_type: resourceType, resource_id: resourceId, command_type: commandType, risk, idempotency_key: idempotencyKey, approval_id: approvalId, correlation_id: correlationId, state: 'queued', attempt: 1, created_at: new Date(), updated_at: new Date() });
      }
      return [{}];
    }
    if (sql.includes('FROM operations WHERE actor_id')) return [[this.rows.find((row) => row.actor_id === values[0] && row.idempotency_key === values[1])]];
    if (sql.includes('FROM operations WHERE id = ? FOR UPDATE') || sql.includes('SELECT * FROM operations WHERE id = ?')) return [[this.rows.find((row) => row.id === values[0])]];
    if (sql.includes('UPDATE operations SET state')) { const row = this.rows.find((candidate) => candidate.id === values.at(-1)); row.state = values[0]; row.updated_at = new Date(); return [{}]; }
    if (sql.includes('UPDATE operations SET attempt')) { const row = this.rows.find((candidate) => candidate.id === values[1]); row.attempt = values[0]; return [{}]; }
    if (sql.includes('INSERT INTO operation_events')) { this.events.push(values); return [{}]; }
    throw new Error(`Unexpected SQL ${sql}`);
  }
}

describe('PersistentOperationService', () => {
  it('snapshots configured recovery in the create transaction and retains it on reuse', async () => {
    const pool = new FakeOperationPool();
    pool.policy = { schemaVersion: 1, version: 1, enabled: true, commandTypes: ['write'], metricId: 'cpu', source: 'collector', max: 80, windowSeconds: 60, maxSampleGapSeconds: 30 };
    const service = new PersistentOperationService(() => pool as any);
    const input = { actorId: 7, origin: 'api', resource: { type: 'instance', id: '12' }, commandType: 'write', risk: 'low' as const, idempotencyKey: 'same', correlationId: 'corr' };
    await service.create(input);
    const snapshot = JSON.parse(pool.events[0][5]).recoveryBinding;
    expect(snapshot).toMatchObject({ actorId: 7, resource: { type: 'instance', id: 12 }, commandType: 'write', policyVersion: 1, max: 80 });
    pool.policy = { ...(pool.policy as object), version: 2, max: 100 };
    await service.create({ ...input, recoveryBinding: { max: 200 } } as any);
    expect(pool.events).toHaveLength(1); expect(pool.policyReads).toBe(1);
    expect(JSON.parse(pool.events[0][5]).recoveryBinding).toEqual(snapshot);
    expect(pool.commits).toBe(2);
  });
  it('persists idempotency and events in committed transactions', async () => {
    const pool = new FakeOperationPool();
    const service = new PersistentOperationService(() => pool as any);
    const input = { actorId: 7, origin: 'api', resource: { type: 'instance', id: '12' }, commandType: 'read', risk: 'low' as const, idempotencyKey: 'same', correlationId: 'corr' };
    const first = await service.create(input);
    const second = await service.create(input);
    expect(second.id).toBe(first.id);
    expect(pool.events).toHaveLength(1);
    expect(pool.events[0][5]).toBeNull();
    await service.transition(first.id, 'waiting_approval', 'NEEDS_APPROVAL', 7);
    expect(pool.events).toHaveLength(2);
    expect(pool.commits).toBe(3);
  });

  it('rolls back an illegal persistent transition without appending an event', async () => {
    const pool = new FakeOperationPool();
    const service = new PersistentOperationService(() => pool as any);
    const operation = await service.create({ actorId: 7, origin: 'api', resource: { type: 'instance', id: '12' }, commandType: 'read', risk: 'low', idempotencyKey: 'one', correlationId: 'corr' });
    await expect(service.transition(operation.id, 'succeeded', 'INVALID')).rejects.toThrow('Illegal operation transition');
    expect(pool.rollbacks).toBe(1);
    expect(pool.events).toHaveLength(1);
  });
  it('rolls back creation when its immutable event cannot be persisted', async () => {
    class FailingEventPool extends FakeOperationPool {
      override async query(sql: string, values: any[] = []): Promise<any> {
        if (sql.includes('INSERT INTO operation_events')) throw new Error('event unavailable');
        return super.query(sql, values);
      }
    }
    const pool = new FailingEventPool();
    const service = new PersistentOperationService(() => pool as any);
    await expect(service.create({ actorId: 7, origin: 'api', resource: { type: 'instance', id: '12' }, commandType: 'read', risk: 'low', idempotencyKey: 'one', correlationId: 'corr' })).rejects.toThrow('event unavailable');
    expect(pool.rollbacks).toBe(1); expect(pool.commits).toBe(0);
  });

  it('creates a distinct retry attempt without replaying an existing operation', async () => {
    const pool = new FakeOperationPool();
    const service = new PersistentOperationService(() => pool as any);
    const operation = await service.create({ actorId: 7, origin: 'api', resource: { type: 'instance', id: '12' }, commandType: 'write', risk: 'high', idempotencyKey: 'write', correlationId: 'corr' });
    await service.transition(operation.id, 'waiting_approval', 'NEEDS_APPROVAL');
    await service.transition(operation.id, 'claimed', 'CLAIMED');
    await service.transition(operation.id, 'running', 'STARTED');
    await service.transition(operation.id, 'failed', 'FAILED');
    const retry = await service.retryForActor(operation.id, 7);
    expect(retry).toMatchObject({ state: 'queued', attempt: 2, correlationId: 'corr' });
    expect(retry?.id).not.toBe(operation.id);
  });
});
