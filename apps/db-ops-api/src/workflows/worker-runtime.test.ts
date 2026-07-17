import { describe, expect, it } from 'vitest';
import { OutboxService } from './outbox-service.js';
import { MysqlWorkflowStore, WorkerRuntime, type ClaimedJob, type WorkflowStore } from './worker-runtime.js';
import { JobRegistry } from './job-registry.js';

describe('outbox transaction and dedupe', () => {
  it('rolls back an event with its business transaction and commits only once', async () => {
    const calls: string[] = []; const connection = { execute: async () => { calls.push('event'); }, beginTransaction: async () => { calls.push('begin'); }, commit: async () => { calls.push('commit'); }, rollback: async () => { calls.push('rollback'); }, release: () => { calls.push('release'); } };
    const service = new OutboxService({ getConnection: async () => connection });
    await expect(service.transaction(async (_connection, append) => { await append({ eventType: 'report.ready', schemaVersion: 1, aggregateType: 'report', aggregateId: '1', aggregateVersion: 1, payload: {}, idempotencyKey: 'report:1' }); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect(calls).toEqual(['begin', 'event', 'rollback', 'release']);
  });
});

describe('typed handler registry', () => {
  it('executes a registered deterministic handler and rejects a free-text fallback', async () => {
    const registry = new JobRegistry(); let invoked = 0;
    registry.register('capacity.collect', async () => { invoked++; });
    await registry.execute({ id: 'job', type: 'capacity.collect', payload: {}, attempts: 1, maxAttempts: 3, fencingToken: 1 });
    expect(invoked).toBe(1);
    await expect(registry.execute({ id: 'job', type: 'prompt.do-anything', payload: {}, attempts: 1, maxAttempts: 3, fencingToken: 1 })).rejects.toThrow('WORKFLOW_HANDLER_UNSUPPORTED');
  });
});

describe('mysql workflow store', () => {
  it('uses unique idempotency keys and fencing predicates in persistent transitions', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const store = new MysqlWorkflowStore(() => ({ execute: async (sql, values) => { statements.push({ sql, values }); return [{ affectedRows: 0 } as any]; } }));
    await store.enqueue({ id: 'job-1', type: 'report.generate', schemaVersion: 1, payload: {}, idempotencyKey: 'occurrence:1' });
    expect(statements[0].sql).toContain('ON DUPLICATE KEY UPDATE');
    await expect(store.complete('job-1', 'worker-a', 2)).resolves.toBe(false);
    expect(statements[1].sql).toContain('fencing_token = ?');
    expect(statements[1].sql).toContain('lease_expires_at > NOW()');
  });
});

describe('lease, fencing and dead letter', () => {
  it('does not let an old fencing owner commit and dead-letters bounded failures', async () => {
    const job: ClaimedJob = { id: 'j1', type: 'report.generate', payload: {}, attempts: 3, maxAttempts: 3, fencingToken: 2 };
    const store: WorkflowStore = { claim: async () => job, heartbeat: async (_id, _owner, token) => token === 2, complete: async (_id, _owner, token) => token === 2, fail: async (_job, _owner, _error, retryAt) => retryAt === null };
    const worker = new WorkerRuntime(store, 'second-worker');
    await expect(worker.runOnce(async () => { throw new Error('poison'); })).resolves.toBe('dead_letter');
    expect(await worker.heartbeat({ ...job, fencingToken: 1 })).toBe(false);
  });
});
