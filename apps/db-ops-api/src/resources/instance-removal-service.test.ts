import { describe, expect, it, vi } from 'vitest';
import { databaseService } from '../database-service.js';
import { InstanceAccessLifecycle, instanceAccessLifecycle } from './instance-access-lifecycle.js';
import { InstanceRemovalService, type RemovalStore } from './instance-removal-service.js';
import mysql from 'mysql2/promise';
import dmdb from 'dmdb';
import * as targetPolicy from '../security/database-target-policy.js';
import { CronManager } from '../cron/cron-manager.js';
import { cronAuthorityService } from '../cron/cron-authority.js';

describe('instance connection cleanup', () => {
  it('attempts every driver even when the first close fails and retains only failed handles', async () => {
    const service = new (databaseService.constructor as any)();
    const pool = { end: vi.fn().mockRejectedValue(new Error('injected failure')) };
    const pgClient = { end: vi.fn().mockResolvedValue(undefined) };
    const oracleConnection = { close: vi.fn().mockResolvedValue(undefined) };
    const oraclePool = { close: vi.fn().mockResolvedValue(undefined) };
    const dmConnection = { close: vi.fn().mockResolvedValue(undefined) };
    (service as any).connections.set(9, { id: 9, pool, pgClient, oracleConnection, oraclePool, dmConnection, connected: true });
    await expect(service.removeConnection(9)).rejects.toThrow();
    expect(pgClient.end).toHaveBeenCalledOnce();
    expect(oracleConnection.close).toHaveBeenCalledOnce();
    expect(oraclePool.close).toHaveBeenCalledOnce();
    expect(dmConnection.close).toHaveBeenCalledOnce();
    pool.end.mockResolvedValue(undefined);
    await service.removeConnection(9);
    expect(pgClient.end).toHaveBeenCalledOnce();
    expect(service.getConnection(9)).toBeNull();
  });
});

function fixture() {
  let state: 'available' | 'deleting' | 'deleted' = 'available';
  const access = new InstanceAccessLifecycle(async () => state === 'available');
  const store: RemovalStore = {
    begin: vi.fn(async () => { state = state === 'deleted' ? state : 'deleting'; return state; }),
    detach: vi.fn(async () => {}),
    record: vi.fn(async () => {}),
    complete: vi.fn(async () => { state = 'deleted'; }),
  };
  const runtime = { stopTasks: vi.fn(async () => {}), stopCollection: vi.fn(async () => {}), closeConnections: vi.fn(async () => {}) };
  return { access, store, runtime, service: new InstanceRemovalService(store, access, runtime, 20) };
}

describe('instance removal lifecycle', () => {
  it('fences before persisting intent and completes only after all cleanup', async () => {
    const f = fixture();
    f.store.begin = vi.fn(async () => {
      await expect(f.access.assertAvailable(8)).rejects.toThrow('INSTANCE_REMOVED');
      expect(f.runtime.closeConnections).not.toHaveBeenCalled();
      return 'deleting' as const;
    });
    expect(await f.service.remove(8)).toEqual({ success: true, state: 'deleted' });
    expect(f.store.complete).toHaveBeenCalledOnce();
  });
  it('continues cleanup after a driver failure; retry converges without re-enabling access', async () => {
    const f = fixture();
    f.runtime.closeConnections.mockRejectedValueOnce(new Error('secret-bearing remote error'));
    expect(await f.service.remove(8)).toMatchObject({ success: false, state: 'deleting', reasons: ['CONNECTION_CLEANUP_PENDING'] });
    expect(f.store.detach).toHaveBeenCalled();
    expect(f.store.complete).not.toHaveBeenCalled();
    await expect(f.access.assertAvailable(8)).rejects.toThrow('INSTANCE_REMOVED');
    expect(await f.service.remove(8)).toEqual({ success: true, state: 'deleted' });
    expect(await f.service.remove(8)).toEqual({ success: true, state: 'deleted' });
  });
  it('never acknowledges success if tombstone write fails', async () => {
    const f = fixture();
    vi.mocked(f.store.complete).mockRejectedValueOnce(new Error('injected commit failure'));
    expect(await f.service.remove(8)).toMatchObject({ success: false, reasons: ['TOMBSTONE_COMMIT_FAILED'] });
    expect(await f.service.remove(8)).toMatchObject({ success: true });
  });
  it('coalesces concurrent requests and retains an in-flight operation until it settles', async () => {
    const f = fixture();
    let release!: () => void;
    const operation = f.access.track(8, () => new Promise<void>(resolve => { release = resolve; }));
    const first = f.service.remove(8);
    expect(f.service.remove(8)).toBe(first);
    expect(await first).toMatchObject({ success: false, reasons: ['INFLIGHT_CLEANUP_PENDING'] });
    release(); await operation;
    expect(await f.service.remove(8)).toMatchObject({ success: true });
  });
  it('retained and borrowed driver handles reject late queries before issuing IO', async () => {
    const access = new InstanceAccessLifecycle(async () => true);
    const query = vi.fn(async () => []);
    const borrowed = access.guardDriver(8, { query });
    await borrowed.query();
    access.revoke(8);
    await expect(borrowed.query()).rejects.toThrow('INSTANCE_REMOVED');
    expect(query).toHaveBeenCalledOnce();
  });
  it('a delayed validity lookup cannot override local invalidation', async () => {
    let release!: (valid: boolean) => void;
    const access = new InstanceAccessLifecycle(() => new Promise(resolve => { release = resolve; }));
    const attempt = access.assertAvailable(8);
    access.revoke(8);
    release(true);
    await expect(attempt).rejects.toThrow('INSTANCE_REMOVED');
  });
  it('retains a late borrowed session when closing it after invalidation fails', async () => {
    const access = new InstanceAccessLifecycle(async () => true);
    let release!: (handle: unknown) => void;
    const client = { close: vi.fn(async () => {}).mockRejectedValueOnce(new Error('injected close failure')) };
    const pool = access.guardDriver(8, { getConnection: () => new Promise(resolve => { release = resolve; }) });
    const pending = pool.getConnection();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    access.revoke(8); release(client);
    await expect(pending).rejects.toThrow();
    await access.closeTemporary(8);
    expect(client.close).toHaveBeenCalledTimes(2);
  });
  it('a separate access fence observes durable invalidation before issuing a query', async () => {
    let available = true;
    const first = new InstanceAccessLifecycle(async () => available);
    const second = new InstanceAccessLifecycle(async () => available);
    const query = vi.fn(async () => []);
    const handle = second.guardDriver(8, { query });
    await handle.query();
    first.revoke(8); available = false;
    await expect(handle.query()).rejects.toThrow('INSTANCE_REMOVED');
    expect(second.signal(8).aborted).toBe(true);
    expect(query).toHaveBeenCalledOnce();
  });
  it('old fallback configuration cannot reconnect after invalidation', async () => {
    instanceAccessLifecycle.revoke(900001);
    expect(await databaseService.reconnect(900001, 'old', { host: '127.0.0.1', port: 1, user: 'fake', password: 'fake', db_type: 'mysql' })).toBe(false);
    expect(await databaseService.addConnection(900001, 'old', { host: '127.0.0.1', port: 1, user: 'fake', password: 'fake', db_type: 'mysql' })).toBe(false);
  });
  it('temporary socket cleanup failures remain retryable and never acknowledge deletion', async () => {
    const f = fixture();
    const close = vi.fn(async () => {}).mockRejectedValueOnce(new Error('socket close failed'));
    f.access.ownTemporary(8, close);
    expect(await f.service.remove(8)).toMatchObject({ success: false, reasons: ['TEMPORARY_CONNECTION_CLEANUP_PENDING'] });
    expect(f.store.complete).not.toHaveBeenCalled();
    expect(await f.service.remove(8)).toMatchObject({ success: true });
    expect(close).toHaveBeenCalledTimes(2);
  });
  it('a late connector closes its handle without probing or publishing the removed target', async () => {
    const service = new (databaseService.constructor as any)();
    let ready!: () => void, release!: (handle: unknown) => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const handle = { ping: vi.fn(async () => {}), release: vi.fn() };
    const pool = { getConnection: vi.fn(() => { ready(); return new Promise(resolve => { release = resolve; }); }), end: vi.fn(async () => {}) };
    const create = vi.spyOn(mysql, 'createPool').mockReturnValue(pool as any);
    const policy = vi.spyOn(targetPolicy, 'authorizeDatabaseTarget').mockResolvedValue({ address: '127.0.0.1', port: 1 } as any);
    try {
      const opening = service.addConnection(900002, 'late', { host: '127.0.0.1', port: 1, user: 'fake', password: 'fake', db_type: 'mysql' });
      await started;
      instanceAccessLifecycle.revoke(900002);
      release(handle);
      expect(await opening).toBe(false);
      expect(pool.end).toHaveBeenCalledOnce();
      expect(handle.release).toHaveBeenCalledOnce();
      expect(handle.ping).not.toHaveBeenCalled();
      expect(service.getConnection(900002)).toBeNull();
    } finally { create.mockRestore(); policy.mockRestore(); }
  });
  it('a missing ID does not poison a future legitimate allocation', async () => {
    const f = fixture();
    vi.mocked(f.store.begin).mockResolvedValue(null);
    expect(await f.service.remove(800)).toMatchObject({ success: false, statusCode: 404 });
    expect(f.access.isRevoked(800)).toBe(false);
  });
  it('retains a late timed-out Dameng handle when its initial close fails', async () => {
    vi.useFakeTimers();
    const service = new (databaseService.constructor as any)();
    let release!: (handle: unknown) => void;
    const handle = { close: vi.fn(async () => {}).mockRejectedValueOnce(new Error('injected close failure')) };
    const create = vi.spyOn(dmdb, 'getConnection').mockImplementation(() => new Promise(resolve => { release = resolve; }) as any);
    const policy = vi.spyOn(targetPolicy, 'authorizeDatabaseTarget').mockResolvedValue({ address: '127.0.0.1', port: 1 } as any);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const opening = service.addConnection(900003, 'late-dm', { host: '127.0.0.1', port: 1, user: 'fake', password: 'fake', db_type: 'dameng' });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await opening).toBe(false);
      instanceAccessLifecycle.revoke(900003);
      release(handle);
      await instanceAccessLifecycle.drain(900003);
      expect(handle.close).toHaveBeenCalledOnce();
      await instanceAccessLifecycle.closeTemporary(900003);
      expect(handle.close).toHaveBeenCalledTimes(2);
    } finally { create.mockRestore(); policy.mockRestore(); errors.mockRestore(); vi.useRealTimers(); }
  });
  it('a skipped duplicate Cron trigger does not release cleanup ownership of the running job', async () => {
    let started!: () => void, finish!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const completion = new Promise<void>(resolve => { finish = resolve; });
    const config = { id: 900004, name: 'in-flight', enabled: true, target_instance_id: 900004, task_type: 'agent' };
    const jobs = { getJobById: async () => config, startLog: async () => 1,
      recordExecutionAuthority: async () => true, completeLog: async () => {}, updateRunResult: async () => {} };
    const executor = { execute: async () => { started(); await completion; return { stopReason: 'completed', businessStatus: 'unknown', finalContent: '' }; } };
    const authority = vi.spyOn(cronAuthorityService, 'authorize').mockResolvedValue({ audit: {}, actor: {} as any, refreshActor: async () => ({} as any) });
    const manager = new CronManager(jobs as any, executor as any);
    const execution = manager.executeJob(config as any);
    try {
      await ready;
      await manager.executeJob(config as any);
      const stopped = manager.stopInstance(900004);
      expect(await Promise.race([stopped.then(() => 'stopped'), new Promise(resolve => setTimeout(() => resolve('pending'), 20))])).toBe('pending');
      finish(); await execution; await stopped;
    } finally { finish(); await execution; authority.mockRestore(); }
  });
});
