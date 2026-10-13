import { describe, expect, it, vi } from 'vitest';
import { OutboxService, type OutboxInput } from './outbox-service.js';

const event: OutboxInput = { eventType: 'report.ready', schemaVersion: 1, aggregateType: 'report',
  aggregateId: '1', aggregateVersion: 1, payload: {}, idempotencyKey: 'report:1' };

function fixture() {
  const connection = {
    execute: vi.fn(async () => [[{ id: 'persisted-id' }]]),
    beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}), release: vi.fn(),
  };
  return { connection, service: new OutboxService({ getConnection: async () => connection }) };
}

describe('outbox transaction failures', () => {
  it('caller-reserved transactions retain connection ownership on commit and rollback', async () => {
    const { connection, service } = fixture();
    await expect(service.transactionOnConnection(connection, async (_connection, append) => append(event))).resolves.toBe('persisted-id');
    const error = new Error('BORROWED_WORK_FAILED');
    await expect(service.transactionOnConnection(connection, async () => { throw error; })).rejects.toBe(error);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
  });
  it('releases the connection when begin fails without running work or rollback', async () => {
    const { connection, service } = fixture();
    const error = new Error('BEGIN_FAILED');
    connection.beginTransaction.mockRejectedValueOnce(error);
    const work = vi.fn();
    await expect(service.transaction(work)).rejects.toBe(error);
    expect(connection.release).toHaveBeenCalledOnce();
    expect(work).not.toHaveBeenCalled();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.commit).not.toHaveBeenCalled();
  });

  it('preserves the work error and releases even when rollback fails', async () => {
    const { connection, service } = fixture();
    const error = new Error('WORK_FAILED');
    connection.rollback.mockRejectedValueOnce(new Error('ROLLBACK_FAILED'));
    await expect(service.transaction(async () => { throw error; })).rejects.toBe(error);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('rolls back and releases when commit fails', async () => {
    const { connection, service } = fixture();
    const error = new Error('COMMIT_FAILED');
    connection.commit.mockRejectedValueOnce(error);
    await expect(service.transaction(async () => 'result')).rejects.toBe(error);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('returns the persisted event ID on commit', async () => {
    const { connection, service } = fixture();
    await expect(service.transaction(async (_connection, append) => append(event))).resolves.toBe('persisted-id');
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it.each([
    { ...event, eventType: 'INVALID' },
    { ...event, idempotencyKey: '' },
    { ...event, payload: { data: 'x'.repeat(64_001) } },
  ])('rejects invalid events before SQL', async invalid => {
    const { connection, service } = fixture();
    await expect(service.append(connection, invalid)).rejects.toThrow('OUTBOX_EVENT_INVALID');
    expect(connection.execute).not.toHaveBeenCalled();
  });
});
