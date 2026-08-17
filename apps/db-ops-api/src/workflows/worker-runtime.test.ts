import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxService } from './outbox-service.js';
import { MysqlWorkflowStore, WorkerRuntime, type ClaimedJob, type WorkflowStore } from './worker-runtime.js';
import { JobRegistry } from './job-registry.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

class SharedLeaseStore implements WorkflowStore {
  readonly heartbeatCalls: Array<{ workerId: string; fencingToken: number }> = [];
  private owner: string | null = null;
  private leaseExpiresAt = 0;
  private fencingToken = 0;
  private attempts = 0;
  private completed = false;

  async claim(workerId: string, leaseSeconds: number): Promise<ClaimedJob | null> {
    if (this.completed || (this.owner !== null && this.leaseExpiresAt > Date.now())) return null;
    this.owner = workerId;
    this.leaseExpiresAt = Date.now() + leaseSeconds * 1_000;
    this.fencingToken++;
    this.attempts++;
    return {
      id: 'shared-job',
      type: 'fault.diagnose-unhealthy',
      payload: {},
      attempts: this.attempts,
      maxAttempts: 3,
      fencingToken: this.fencingToken,
    };
  }

  async heartbeat(_jobId: string, workerId: string, fencingToken: number, leaseSeconds: number): Promise<boolean> {
    this.heartbeatCalls.push({ workerId, fencingToken });
    if (this.owner !== workerId || this.fencingToken !== fencingToken || this.leaseExpiresAt <= Date.now()) return false;
    this.leaseExpiresAt = Date.now() + leaseSeconds * 1_000;
    return true;
  }

  async complete(_jobId: string, workerId: string, fencingToken: number): Promise<boolean> {
    if (this.owner !== workerId || this.fencingToken !== fencingToken || this.leaseExpiresAt <= Date.now()) return false;
    this.completed = true;
    this.owner = null;
    return true;
  }

  async fail(job: ClaimedJob, workerId: string, _error: Error, _retryAt: Date | null): Promise<boolean> {
    if (this.owner !== workerId || this.fencingToken !== job.fencingToken || this.leaseExpiresAt <= Date.now()) return false;
    this.owner = null;
    return true;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  it('reclaims an expired running job after a worker crash', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const store = new MysqlWorkflowStore(() => ({ execute: async (sql, values) => {
      statements.push({ sql, values });
      return [sql.startsWith('SELECT') ? [] : { affectedRows: 1 }] as any;
    } }));
    await store.claim('worker-b', 30);
    expect(statements[0].sql).toContain("state IN ('queued', 'retry', 'running')");
  });

  it('does not reselect an existing lease when the claim update affects no rows', async () => {
    const execute = vi.fn(async (sql: string) => [sql.startsWith('SELECT') ? [{
      id: 'still-leased', type: 'report.generate', payload: {}, attempts: 1, maxAttempts: 3, fencingToken: 7,
    }] : { affectedRows: 0 }] as any);
    const store = new MysqlWorkflowStore(() => ({ execute }));

    await expect(store.claim('worker-a', 30)).resolves.toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
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

  it('does not claim or execute again while the same runtime has a run in flight', async () => {
    const job: ClaimedJob = { id: 'overlap', type: 'fault.diagnose-unhealthy', payload: {}, attempts: 1, maxAttempts: 3, fencingToken: 1 };
    const claim = vi.fn(async () => job);
    const complete = vi.fn(async () => true);
    const store: WorkflowStore = {
      claim,
      heartbeat: vi.fn(async () => true),
      complete,
      fail: vi.fn(async () => true),
    };
    const gate = deferred();
    const handler = vi.fn(async () => gate.promise);
    const worker = new WorkerRuntime(store, 'worker-overlap');

    const first = worker.runOnce(handler);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const overlapping = worker.runOnce(handler);
    gate.resolve();

    await expect(overlapping).resolves.toBe('running');
    await expect(first).resolves.toBe('completed');
    expect(claim).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('heartbeats a long handler and prevents a second worker from reclaiming after the original lease duration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:00.000Z'));
    const store = new SharedLeaseStore();
    const firstGate = deferred();
    const firstHandler = vi.fn(async () => firstGate.promise);
    const secondHandler = vi.fn(async () => {});
    const firstWorker = new WorkerRuntime(store, 'worker-a', 3);
    const secondWorker = new WorkerRuntime(store, 'worker-b', 3);

    const first = firstWorker.runOnce(firstHandler);
    await vi.advanceTimersByTimeAsync(0);
    expect(firstHandler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(secondWorker.runOnce(secondHandler)).resolves.toBe('idle');
    expect(secondHandler).not.toHaveBeenCalled();
    expect(store.heartbeatCalls.length).toBeGreaterThanOrEqual(3);

    firstGate.resolve();
    await expect(first).resolves.toBe('completed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a hung heartbeat and allows the runtime to claim again', async () => {
    vi.useFakeTimers();
    const job: ClaimedJob = { id: 'hung-heartbeat', type: 'fault.diagnose-unhealthy', payload: {}, attempts: 1, maxAttempts: 3, fencingToken: 5 };
    const jobs: Array<ClaimedJob | null> = [job, null];
    const claim = vi.fn(async () => jobs.shift() ?? null);
    let rejectHeartbeat!: (reason?: unknown) => void;
    const pendingHeartbeat = new Promise<boolean>((_resolve, reject) => { rejectHeartbeat = reject; });
    const heartbeat = vi.fn(() => pendingHeartbeat);
    const complete = vi.fn(async () => true);
    const fail = vi.fn(async () => true);
    const store: WorkflowStore = { claim, heartbeat, complete, fail };
    const handlerGate = deferred();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const worker = new WorkerRuntime(store, 'worker-timeout', 3);
    let runResult: Awaited<ReturnType<WorkerRuntime['runOnce']>> | undefined;

    const run = worker.runOnce(async () => handlerGate.promise);
    void run.then((result) => { runResult = result; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    handlerGate.resolve();
    await vi.advanceTimersByTimeAsync(500);

    expect(runResult).toBe('retry');
    await expect(run).resolves.toBe('retry');
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    const secondHandler = vi.fn(async () => {});
    await expect(worker.runOnce(secondHandler)).resolves.toBe('idle');
    expect(claim).toHaveBeenCalledTimes(2);
    expect(secondHandler).not.toHaveBeenCalled();

    rejectHeartbeat(new Error('LATE_HEARTBEAT_FAILURE'));
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['returns false', false, false],
    ['rejects', true, true],
  ] as const)('does not write a terminal state when heartbeat %s', async (_label, heartbeatRejects, handlerRejects) => {
    vi.useFakeTimers();
    const job: ClaimedJob = { id: 'lost-lease', type: 'fault.diagnose-unhealthy', payload: {}, attempts: 1, maxAttempts: 3, fencingToken: 4 };
    const heartbeat = vi.fn(async () => {
      if (heartbeatRejects) throw new Error('HEARTBEAT_UNAVAILABLE');
      return false;
    });
    const complete = vi.fn(async () => true);
    const fail = vi.fn(async () => true);
    const store: WorkflowStore = { claim: vi.fn(async () => job), heartbeat, complete, fail };
    const gate = deferred();
    const handler = vi.fn(async () => {
      await gate.promise;
      if (handlerRejects) throw new Error('HANDLER_FAILED');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const worker = new WorkerRuntime(store, 'worker-lost', 3);

    const run = worker.runOnce(handler);
    await vi.advanceTimersByTimeAsync(1_000);
    gate.resolve();

    await expect(run).resolves.toBe('retry');
    expect(heartbeat).toHaveBeenCalledWith('lost-lease', 'worker-lost', 4, 3);
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[WorkerRuntime] WORKFLOW_LEASE_LOST:lost-lease');
    expect(vi.getTimerCount()).toBe(0);
  });
});
