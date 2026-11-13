// GitHub #275: busy runs must not borrow the real execution's settlement.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { CronManager } from './cron-manager.js';
import { cronRunStore } from './cron-run-store.js';

const state = vi.hoisted(() => ({ pool: null as any }));
vi.mock('../db-connection', () => ({ dbConnection: { getPool: () => state.pool } }));
vi.mock('../sql-executor', () => ({ sqlExecutor: {} }));
vi.mock('./cron-run-store.js', () => ({ cronRunStore: {
  get: vi.fn(), start: vi.fn(), finish: vi.fn(), bindLog: vi.fn(),
} }));
vi.mock('./cron-authority.js', () => ({
  cronAuthorityService: { authorize: async () => ({ audit: {} }) }, CRON_MAINTENANCE_HANDLERS: new Set(),
}));

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

// Real MySQL is opt-in and receives explicit connection configuration from the caller.
const mysqlConfig = process.env.CRON_LOCK_MYSQL_CONFIG;
describe.each(mysqlConfig ? ['mock', 'mysql'] : ['mock'])('Cron lock ownership (%s)', mode => {
  let realPool: mysql.Pool | undefined;
  let borrowed: number;
  let acquired: number;
  let releaseError: boolean;
  let connections: Set<any>;
  let manager: CronManager;
  let blocked: ReturnType<typeof gate>;
  let executor: { execute: ReturnType<typeof vi.fn> };
  let service: any;
  let owner: Promise<void> | undefined;
  const jobId = 275_000_000 + process.pid;

  beforeEach(async () => {
    vi.clearAllMocks();
    borrowed = 0; acquired = 1; releaseError = false; connections = new Set(); owner = undefined;
    blocked = gate();
    if (mode === 'mysql') realPool = mysql.createPool({ ...JSON.parse(mysqlConfig!), connectionLimit: 3 });
    state.pool = { getConnection: async () => {
      const real = await realPool?.getConnection();
      borrowed++;
      const connection = {
        query: async (sql: string, params: unknown[]) => {
          if (sql.includes('RELEASE_LOCK') && releaseError) throw new Error('release failed');
          return real ? real.query(sql, params) : [[{ acquired }]];
        },
        release: () => { borrowed--; connections.delete(connection); real?.release(); },
      };
      connections.add(connection);
      return connection;
    } };
    vi.mocked(cronRunStore.get).mockImplementation(async id => ({ id, jobId, status: 'queued', triggeredBy: null }) as any);
    vi.mocked(cronRunStore.start).mockResolvedValue(true);
    vi.mocked(cronRunStore.finish).mockResolvedValue(undefined as any);
    const config = { id: jobId, name: 'ownership probe', task_type: 'agent', target_instance_id: null };
    service = { getJobById: vi.fn(async () => config), startLog: vi.fn(async () => 1),
      recordExecutionAuthority: vi.fn(async () => true), completeLog: vi.fn(async () => {}), updateRunResult: vi.fn(async () => {}) };
    executor = { execute: vi.fn(async () => ({ stopReason: 'timeout', cancellationPending: true, executionSettled: blocked.promise })) };
    manager = new CronManager(service, executor as any);
  });

  afterEach(async () => {
    blocked.resolve();
    await owner?.catch(() => {});
    await manager.stop();
    for (const connection of connections) connection.release();
    await realPool?.end();
    realPool = undefined;
    vi.restoreAllMocks();
  });

  async function beginOwner() {
    owner = manager.executeRun('owner');
    await vi.waitFor(() => expect(service.updateRunResult).toHaveBeenCalled());
    expect(borrowed).toBe(1);
    if (realPool) {
      const contender = await realPool.getConnection();
      try {
        const [rows] = await contender.query<any[]>('SELECT GET_LOCK(?, 0) AS acquired', [`slide:cron:${jobId}`]);
        expect(rows[0].acquired).toBe(0);
      } finally {
        await contender.query('SELECT RELEASE_LOCK(?)', [`slide:cron:${jobId}`]);
        contender.release();
      }
    }
  }

  it('returns every busy connection before the timed-out owner settles, then permits rescheduling', async () => {
    await beginOwner();
    let ownerDone = false;
    void owner!.then(() => { ownerDone = true; });
    for (let i = 0; i < 12; i++) {
      let finished = false;
      const duplicate = manager.executeRun(`busy-${i}`).then(() => { finished = true; });
      try {
        await vi.waitFor(() => expect(finished).toBe(true), { timeout: 300 });
        expect(borrowed).toBe(1);
        expect(cronRunStore.finish).toHaveBeenCalledWith(`busy-${i}`, 'cancelled', 'CRON_JOB_BUSY');
      } finally {
        // Ensure the pre-fix reproduction also cleans up deterministically.
        if (!finished) blocked.resolve();
        await duplicate;
      }
    }
    expect(ownerDone).toBe(false);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    blocked.resolve();
    await owner;
    expect(borrowed).toBe(0);
    await manager.executeRun('next');
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(borrowed).toBe(0);
  });

  it('does not wait on a direct execution when GET_LOCK succeeds but the local job is busy', async () => {
    await manager.executeJob((await service.getJobById(jobId))!);
    let finished = false;
    const duplicate = manager.executeRun('local-busy').then(() => { finished = true; });
    try {
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 300 });
      expect(borrowed).toBe(0);
      expect(executor.execute).toHaveBeenCalledTimes(1);
    } finally { blocked.resolve(); await duplicate; }
  });

  it('returns a connection on contention from another process/manager', async () => {
    const other = realPool ? spawn(process.execPath, ['--input-type=module', '-e', `
      import mysql from 'mysql2/promise';
      import { once } from 'node:events';
      const connection = await mysql.createConnection(JSON.parse(process.env.CRON_LOCK_MYSQL_CONFIG));
      try {
        const [rows] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [${JSON.stringify(`slide:cron:${jobId}`)}]);
        if (!rows[0].acquired) throw new Error('Test lock already occupied');
        process.stdout.write('ready');
        await once(process.stdin, 'data');
        await connection.query('SELECT RELEASE_LOCK(?)', [${JSON.stringify(`slide:cron:${jobId}`)}]);
      } finally { await connection.end(); }
    `], { stdio: ['pipe', 'pipe', 'pipe'] }) : undefined;
    const exited = other ? once(other, 'exit') : undefined;
    try {
      if (other) {
        await Promise.race([
          once(other.stdout, 'data').then(([data]) => expect(data.toString()).toBe('ready')),
          exited!.then(() => { throw new Error('Lock holder exited before readiness'); }),
        ]);
      } else acquired = 0;
      await manager.executeRun('foreign-busy');
      expect(borrowed).toBe(0);
      expect(executor.execute).not.toHaveBeenCalled();
      expect(cronRunStore.finish).toHaveBeenCalledWith('foreign-busy', 'cancelled', 'CRON_JOB_BUSY');
    } finally {
      if (other) { other.stdin.end('release'); expect((await exited!)[0]).toBe(0); }
    }
  });

  it('returns busy connections even if recording cancellation fails', async () => {
    await beginOwner();
    vi.mocked(cronRunStore.finish).mockRejectedValueOnce(new Error('cancel audit failed'));
    let finished = false;
    const duplicate = manager.executeRun('failed-cancel').catch(error => { expect(error.message).toBe('cancel audit failed'); finished = true; });
    try {
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 300 });
      expect(borrowed).toBe(1);
    } finally { blocked.resolve(); await duplicate; }
  });

  it('retains owner ownership when timeout reporting fails', async () => {
    service.completeLog.mockRejectedValue(new Error('log unavailable'));
    const failed = manager.executeRun('owner').catch(error => error);
    owner = failed.then(() => {});
    await vi.waitFor(() => expect(service.completeLog).toHaveBeenCalledTimes(2));
    expect(borrowed).toBe(1);
    blocked.resolve();
    expect(await failed).toMatchObject({ message: 'log unavailable' });
    expect(borrowed).toBe(0);
  });

  it('does not borrow a connection for a pre-cancelled run', async () => {
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(manager.executeRun('cancelled', { signal: controller.signal } as any)).rejects.toThrow('cancelled');
    expect(borrowed).toBe(0);
    expect(cronRunStore.get).not.toHaveBeenCalled();
  });

  it('keeps the owner lock after worker cancellation until the side effect settles', async () => {
    const controller = new AbortController();
    owner = manager.executeRun('owner', { signal: controller.signal } as any);
    await vi.waitFor(() => expect(service.updateRunResult).toHaveBeenCalled());
    controller.abort(new Error('lease cancelled'));
    expect(borrowed).toBe(1);
    await manager.executeRun('after-cancel');
    expect(borrowed).toBe(1);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    blocked.resolve();
    await owner;
    expect(borrowed).toBe(0);
  });

  it('returns the connection if lock release fails', async () => {
    releaseError = true;
    vi.mocked(cronRunStore.start).mockResolvedValueOnce(false);
    await expect(manager.executeRun('not-started')).rejects.toThrow('release failed');
    expect(borrowed).toBe(0);
  });
});
