import { describe, expect, it, vi } from 'vitest';
import { databaseService } from '../database-service.js';
import { InstanceAccessLifecycle, instanceAccessLifecycle } from './instance-access-lifecycle.js';
import { InstanceRemovalService, MysqlInstanceRemovalStore, RemovalIntentUncommittedError, RemovalIntentUnknownError, type RemovalStore } from './instance-removal-service.js';
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
    observe: vi.fn(async () => state),
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
  it('an uncommitted intent failure restores access without a restart, including while work is in flight', async () => {
    const f = fixture();
    const signal = f.access.signal(8);
    let release!: () => void;
    const operation = f.access.track(8, () => new Promise<void>(resolve => { release = resolve; }));
    vi.mocked(f.store.begin).mockImplementation(async () => { throw new RemovalIntentUncommittedError(new Error('rolled back')); });
    expect(await f.service.remove(8)).toMatchObject({ success: false, statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
    expect(f.access.isRevoked(8)).toBe(false);
    expect(signal.aborted).toBe(false);
    await expect(f.access.assertAvailable(8)).resolves.toBeUndefined();
    expect(f.runtime.stopTasks).not.toHaveBeenCalled();
    release();
    await operation;
    vi.mocked(f.store.begin).mockImplementation(async () => 'deleting');
    expect(await f.service.remove(8)).toEqual({ success: true, state: 'deleted' });
    expect(f.access.isRevoked(8)).toBe(true);
    expect(signal.aborted).toBe(true);
  });
  it('a lost commit receipt stays fenced until the durable state is read', async () => {
    const f = fixture();
    vi.mocked(f.store.begin).mockImplementation(async () => { throw new RemovalIntentUnknownError(new Error('receipt lost')); });
    vi.mocked(f.store.observe).mockResolvedValueOnce('available');
    expect(await f.service.remove(8)).toMatchObject({ statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
    expect(f.access.isRevoked(8)).toBe(false);
    expect(f.runtime.stopTasks).not.toHaveBeenCalled();

    vi.mocked(f.store.observe).mockRejectedValueOnce(new Error('verify failed'));
    expect(await f.service.remove(8)).toMatchObject({ statusCode: 503 });
    expect(f.access.isRevoked(8)).toBe(true);
    await expect(f.access.assertAvailable(8)).rejects.toThrow('INSTANCE_REMOVED');

    vi.mocked(f.store.observe).mockResolvedValueOnce('deleting');
    expect(await f.service.remove(8)).toEqual({ success: true, state: 'deleted' });
    expect(f.store.complete).toHaveBeenCalledOnce();
  });
  it('a failed verification followed by a refused connection keeps every unresolved fence', async () => {
    const access = new InstanceAccessLifecycle(async () => true);
    const runtime = { stopTasks: vi.fn(async () => {}), stopCollection: vi.fn(async () => {}), closeConnections: vi.fn(async () => {}) };
    const store: RemovalStore = {
      begin: vi.fn(async () => { throw new RemovalIntentUnknownError(new Error('receipt lost')); }),
      observe: vi.fn(async () => { throw new Error('verify down'); }),
      detach: vi.fn(async () => {}), record: vi.fn(async () => {}), complete: vi.fn(async () => {}),
    };
    const service = new InstanceRemovalService(store, access, runtime, 20);
    expect(await service.remove(8)).toMatchObject({ statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
    expect(store.observe).toHaveBeenCalledOnce();
    expect(access.isRevoked(8)).toBe(true);

    vi.mocked(store.begin).mockRejectedValueOnce(new RemovalIntentUncommittedError(new Error('connection refused')));
    expect(await service.remove(8)).toMatchObject({ statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
    expect(store.observe).toHaveBeenCalledTimes(2);
    expect(access.isRevoked(8)).toBe(true);
    await expect(access.assertAvailable(8)).rejects.toThrow('INSTANCE_REMOVED');
    expect(runtime.stopTasks).not.toHaveBeenCalled();

    vi.mocked(store.begin).mockRejectedValueOnce(new RemovalIntentUncommittedError(new Error('rolled back')));
    vi.mocked(store.observe).mockResolvedValueOnce('available');
    expect(await service.remove(8)).toMatchObject({ statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
    expect(access.isRevoked(8)).toBe(false);
    await expect(access.assertAvailable(8)).resolves.toBeUndefined();
    expect(runtime.stopTasks).not.toHaveBeenCalled();

    vi.mocked(store.begin).mockResolvedValueOnce('deleting');
    expect(await service.remove(8)).toEqual({ success: true, state: 'deleted' });
    expect(access.isRevoked(8)).toBe(true);
  });
  it('an older verified token cannot clear a newer fence, and a newer uncommitted token cannot clear an older unknown', async () => {
    const access = new InstanceAccessLifecycle(async () => true);
    const runtime = { stopTasks: vi.fn(async () => {}), stopCollection: vi.fn(async () => {}), closeConnections: vi.fn(async () => {}) };
    let releaseObserve!: (state: 'available') => void;
    const older: RemovalStore = {
      begin: vi.fn(async () => { throw new RemovalIntentUnknownError(new Error('receipt lost')); }),
      observe: vi.fn(() => new Promise<'available'>(resolve => { releaseObserve = resolve; })),
      detach: vi.fn(async () => {}), record: vi.fn(async () => {}), complete: vi.fn(async () => {}),
    };
    const pending = new InstanceRemovalService(older, access, runtime, 20).remove(8);
    await vi.waitFor(() => expect(releaseObserve).toBeTypeOf('function'));
    access.hold(8);
    releaseObserve('available');
    expect(await pending).toMatchObject({ statusCode: 503 });
    expect(access.isRevoked(8)).toBe(true);

    const newer: RemovalStore = {
      begin: vi.fn(async () => { throw new RemovalIntentUncommittedError(new Error('connection refused')); }),
      observe: vi.fn(async () => { throw new Error('verify down'); }),
      detach: vi.fn(async () => {}), record: vi.fn(async () => {}), complete: vi.fn(async () => {}),
    };
    access.retainUnresolved(8, access.hold(8));
    expect(await new InstanceRemovalService(newer, access, runtime, 20).remove(8)).toMatchObject({ statusCode: 503 });
    expect(newer.observe).toHaveBeenCalledOnce();
    expect(access.isRevoked(8)).toBe(true);
    await expect(access.assertAvailable(8)).rejects.toThrow('INSTANCE_REMOVED');
    expect(runtime.stopTasks).not.toHaveBeenCalled();
  });
  it('an unclassified begin failure does not release the fence or skip verification', async () => {
    const f = fixture();
    vi.mocked(f.store.begin).mockRejectedValueOnce(new Error('unclassified'));
    vi.mocked(f.store.observe).mockRejectedValueOnce(new Error('verify failed'));
    expect(await f.service.remove(8)).toMatchObject({ statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
    expect(f.store.observe).toHaveBeenCalledOnce();
    expect(f.access.isRevoked(8)).toBe(true);
    await expect(f.access.assertAvailable(8)).rejects.toThrow('INSTANCE_REMOVED');
  });
  it('a later known failure cannot clear an unclassified intent until verification succeeds', async () => {
    const access = new InstanceAccessLifecycle(async () => true);
    const runtime = { stopTasks: vi.fn(async () => {}), stopCollection: vi.fn(async () => {}), closeConnections: vi.fn(async () => {}) };
    const store: RemovalStore = {
      begin: vi.fn(async () => 'deleting' as const),
      observe: vi.fn(async () => 'available' as const),
      detach: vi.fn(async () => {}), record: vi.fn(async () => {}), complete: vi.fn(async () => {}),
    };
    const service = new InstanceRemovalService(store, access, runtime, 20);

    vi.mocked(store.begin).mockRejectedValueOnce(new Error('unclassified'));
    vi.mocked(store.observe).mockRejectedValueOnce(new Error('verify failed'));
    expect(await service.remove(8)).toMatchObject({ statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
    expect(store.observe).toHaveBeenCalledOnce();
    expect(access.isRevoked(8)).toBe(true);

    vi.mocked(store.begin).mockRejectedValueOnce(new RemovalIntentUncommittedError(new Error('connection refused')));
    vi.mocked(store.observe).mockRejectedValueOnce(new Error('verify failed'));
    expect(await service.remove(8)).toMatchObject({ statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
    expect(store.observe).toHaveBeenCalledTimes(2);
    expect(access.isRevoked(8)).toBe(true);
    await expect(access.assertAvailable(8)).rejects.toThrow('INSTANCE_REMOVED');

    vi.mocked(store.begin).mockRejectedValueOnce(new RemovalIntentUncommittedError(new Error('rolled back')));
    vi.mocked(store.observe).mockRejectedValueOnce(new Error('verify failed'));
    expect(await service.remove(8)).toMatchObject({ statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
    expect(store.observe).toHaveBeenCalledTimes(3);
    expect(access.isRevoked(8)).toBe(true);

    vi.mocked(store.begin).mockResolvedValueOnce(null);
    vi.mocked(store.observe).mockRejectedValueOnce(new Error('verify failed'));
    expect(await service.remove(8)).toMatchObject({ success: false, statusCode: 404, error: 'INSTANCE_NOT_FOUND' });
    expect(store.observe).toHaveBeenCalledTimes(4);
    expect(access.isRevoked(8)).toBe(true);
    await expect(access.assertAvailable(8)).rejects.toThrow('INSTANCE_REMOVED');
    expect(runtime.stopTasks).not.toHaveBeenCalled();

    vi.mocked(store.begin).mockImplementationOnce(async () => {
      access.retainUnresolved(8, access.hold(8));
      return null;
    });
    vi.mocked(store.observe).mockResolvedValueOnce(null);
    expect(await service.remove(8)).toMatchObject({ statusCode: 404, error: 'INSTANCE_NOT_FOUND' });
    expect(access.isRevoked(8)).toBe(true);
    expect(access.unresolvedSnapshot(8).length).toBeGreaterThan(0);

    vi.mocked(store.begin).mockRejectedValueOnce(new RemovalIntentUncommittedError(new Error('rolled back')));
    vi.mocked(store.observe).mockResolvedValueOnce('available');
    expect(await service.remove(8)).toMatchObject({ statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
    expect(access.isRevoked(8)).toBe(false);
    expect(access.unresolvedSnapshot(8)).toEqual([]);
    await expect(access.assertAvailable(8)).resolves.toBeUndefined();
    expect(runtime.stopTasks).not.toHaveBeenCalled();

    vi.mocked(store.begin).mockRejectedValueOnce(new Error('unclassified'));
    vi.mocked(store.observe).mockResolvedValueOnce(null);
    expect(await service.remove(9)).toMatchObject({ statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
    expect(access.isRevoked(9)).toBe(false);
    await expect(access.assertAvailable(9)).resolves.toBeUndefined();

    vi.mocked(store.begin).mockRejectedValueOnce(new Error('unclassified'));
    vi.mocked(store.observe).mockRejectedValueOnce(new Error('verify failed'));
    expect(await service.remove(11)).toMatchObject({ statusCode: 503, error: 'INSTANCE_REMOVAL_INTENT_FAILED' });
    expect(access.isRevoked(11)).toBe(true);
    vi.mocked(store.begin).mockResolvedValueOnce(null);
    vi.mocked(store.observe).mockResolvedValueOnce(null);
    expect(await service.remove(11)).toMatchObject({ success: false, statusCode: 404, error: 'INSTANCE_NOT_FOUND' });
    expect(access.isRevoked(11)).toBe(false);
    await expect(access.assertAvailable(11)).resolves.toBeUndefined();
    expect(runtime.stopTasks).not.toHaveBeenCalled();

    vi.mocked(store.begin).mockRejectedValueOnce(new Error('unclassified'));
    vi.mocked(store.observe).mockResolvedValueOnce('deleting');
    expect(await service.remove(10)).toEqual({ success: true, state: 'deleted' });
    expect(access.isRevoked(10)).toBe(true);
    expect(store.complete).toHaveBeenCalledOnce();
    expect(runtime.stopTasks).toHaveBeenCalledOnce();
  });
  it('an older attempt cannot clear a newer deletion fence', async () => {
    const f = fixture();
    vi.mocked(f.store.begin).mockImplementation(async () => {
      f.access.revoke(8);
      throw new RemovalIntentUncommittedError(new Error('old attempt'));
    });
    expect(await f.service.remove(8)).toMatchObject({ statusCode: 503 });
    expect(f.access.isRevoked(8)).toBe(true);
    expect(f.access.signal(8).aborted).toBe(true);

    const later = fixture();
    vi.mocked(later.store.begin).mockImplementation(async () => { throw new RemovalIntentUnknownError(); });
    vi.mocked(later.store.observe).mockImplementation(async () => {
      later.access.revoke(8);
      return 'available';
    });
    expect(await later.service.remove(8)).toMatchObject({ statusCode: 503 });
    expect(later.access.isRevoked(8)).toBe(true);
  });
  it('concurrent removal shares one attempt and a missing id does not clear a newer fence', async () => {
    const f = fixture();
    let releaseBegin!: (state: 'deleting') => void;
    vi.mocked(f.store.begin).mockImplementation(() => new Promise(resolve => { releaseBegin = resolve; }));
    const first = f.service.remove(8);
    expect(f.service.remove(8)).toBe(first);
    expect(f.store.begin).toHaveBeenCalledOnce();
    releaseBegin('deleting');
    expect(await first).toEqual({ success: true, state: 'deleted' });

    vi.mocked(f.store.begin).mockImplementation(async () => {
      f.access.revoke(800);
      return null;
    });
    expect(await f.service.remove(800)).toMatchObject({ success: false, statusCode: 404 });
    expect(f.access.isRevoked(800)).toBe(true);
  });
  it('a missing id keeps the provisional fence while its own in-flight work is still tracked', async () => {
    const f = fixture();
    let release!: () => void;
    const operation = f.access.track(800, () => new Promise<void>(resolve => { release = resolve; }));
    vi.mocked(f.store.begin).mockResolvedValue(null);
    expect(await f.service.remove(800)).toMatchObject({ statusCode: 404 });
    expect(f.access.isRevoked(800)).toBe(true);
    release();
    await operation;
  });
  it('a completed tombstone stays deleted when a later cleanup dependency fails', async () => {
    const f = fixture();
    vi.mocked(f.store.begin).mockResolvedValue('deleted');
    f.runtime.stopTasks.mockRejectedValue(new Error('cleanup down'));
    expect(await f.service.remove(8)).toEqual({ success: true, state: 'deleted' });
    expect(f.runtime.stopTasks).not.toHaveBeenCalled();
    expect(f.store.detach).not.toHaveBeenCalled();
    expect(f.store.record).not.toHaveBeenCalled();
    expect(f.store.complete).not.toHaveBeenCalled();
    expect(f.access.isRevoked(8)).toBe(true);
    await expect(f.access.assertAvailable(8)).rejects.toThrow('INSTANCE_REMOVED');
  });
  it('cleanup failure after the row is already deleted does not record a deleting reason', async () => {
    const f = fixture();
    f.runtime.stopTasks.mockRejectedValue(new Error('cleanup down'));
    vi.mocked(f.store.observe).mockResolvedValue('deleted');
    expect(await f.service.remove(8)).toEqual({ success: true, state: 'deleted' });
    expect(f.store.record).not.toHaveBeenCalled();
    expect(f.store.complete).not.toHaveBeenCalled();
    expect(f.access.isRevoked(8)).toBe(true);
  });
  it('a committed deleting fence stays closed while in-flight work is still draining', async () => {
    const f = fixture();
    let release!: () => void;
    const operation = f.access.track(8, () => new Promise<void>(resolve => { release = resolve; }));
    expect(await f.service.remove(8)).toMatchObject({ success: false, state: 'deleting', reasons: ['INFLIGHT_CLEANUP_PENDING'] });
    expect(f.access.isRevoked(8)).toBe(true);
    await expect(f.access.assertAvailable(8)).rejects.toThrow('INSTANCE_REMOVED');
    release();
    await operation;
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

function fakeStore(behavior: {
  connect?: 'throw';
  begin?: 'throw';
  execute?: 'throw';
  commit?: 'throw';
  rollback?: 'throw';
  rows?: Array<{ lifecycle_state: string }>;
}) {
  const executed: string[] = [];
  const connection = {
    beginTransaction: vi.fn(async () => { if (behavior.begin === 'throw') throw new Error('begin failed'); }),
    execute: vi.fn(async (sql: string) => {
      executed.push(sql);
      if (behavior.execute === 'throw' && sql.includes('UPDATE')) throw new Error('update failed');
      if (sql.includes('SELECT')) return [behavior.rows ?? [{ lifecycle_state: 'available' }]];
      return [{ affectedRows: 1 }];
    }),
    commit: vi.fn(async () => { if (behavior.commit === 'throw') throw new Error('commit receipt lost'); }),
    rollback: vi.fn(async () => { if (behavior.rollback === 'throw') throw new Error('rollback failed'); }),
    query: vi.fn(async (sql: string) => {
      if (String(sql).includes('tx_state')) return [[{ innodb_pending: 0, tx_state: 'COMMITTED' }]];
      return connection.execute(sql);
    }),
    release: vi.fn(),
    destroy: vi.fn(),
  };
  const pool = {
    getConnection: vi.fn(async () => {
      if (behavior.connect === 'throw') throw new Error('connection failed');
      return connection;
    }),
    execute: connection.execute,
  };
  return { store: new MysqlInstanceRemovalStore(() => pool as any), connection, executed, pool };
}

describe('removal intent classification', () => {
  it('classifies connection, rollback and lost commit receipt separately', async () => {
    const connect = fakeStore({ connect: 'throw' });
    await expect(connect.store.begin(4)).rejects.toBeInstanceOf(RemovalIntentUncommittedError);
    expect(connect.pool.getConnection).toHaveBeenCalledOnce();

    const rolled = fakeStore({ execute: 'throw' });
    await expect(rolled.store.begin(4)).rejects.toBeInstanceOf(RemovalIntentUncommittedError);
    expect(rolled.connection.commit).not.toHaveBeenCalled();
    expect(rolled.connection.rollback).toHaveBeenCalled();
    expect(rolled.connection.release).toHaveBeenCalled();
    expect(rolled.connection.destroy).not.toHaveBeenCalled();

    const rollbackFailed = fakeStore({ execute: 'throw', rollback: 'throw' });
    await expect(rollbackFailed.store.begin(4)).rejects.toBeInstanceOf(RemovalIntentUnknownError);
    expect(rollbackFailed.connection.commit).not.toHaveBeenCalled();
    expect(rollbackFailed.connection.release).not.toHaveBeenCalled();
    expect(rollbackFailed.connection.destroy).toHaveBeenCalledOnce();

    const lost = fakeStore({ commit: 'throw' });
    await expect(lost.store.begin(4)).rejects.toBeInstanceOf(RemovalIntentUnknownError);
    expect(lost.connection.rollback).not.toHaveBeenCalled();
    expect(lost.connection.release).not.toHaveBeenCalled();
    expect(lost.connection.destroy).toHaveBeenCalledOnce();
  });
  it('reads a clean connection and destroys one that still has a transaction', async () => {
    const dirty = {
      query: vi.fn(async () => [[{ innodb_pending: 1, tx_state: 'ACTIVE' }]]),
      execute: vi.fn(async () => [[{ lifecycle_state: 'deleting' }]]),
      release: vi.fn(),
      destroy: vi.fn(),
    };
    const clean = {
      query: vi.fn(async (sql: string) => String(sql).includes('tx_state') ? [[{ innodb_pending: 0, tx_state: 'COMMITTED' }]] : [[{ lifecycle_state: 'available' }]]),
      execute: vi.fn(async () => [[{ lifecycle_state: 'available' }]]),
      release: vi.fn(),
      destroy: vi.fn(),
    };
    const queued = [dirty, clean];
    const pool = { getConnection: vi.fn(async () => queued.shift()), execute: vi.fn() };
    const store = new MysqlInstanceRemovalStore(() => pool as any);
    await expect(store.observe(4)).resolves.toBe('available');
    expect(dirty.execute).not.toHaveBeenCalled();
    expect(dirty.release).not.toHaveBeenCalled();
    expect(dirty.destroy).toHaveBeenCalledOnce();
    expect(clean.execute).toHaveBeenCalledOnce();
    expect(clean.release).toHaveBeenCalledOnce();
    expect(pool.execute).not.toHaveBeenCalled();
  });
  it('returns deleted without rewriting a tombstone and records reasons only while deleting', async () => {
    const deleted = fakeStore({ rows: [{ lifecycle_state: 'deleted' }] });
    await expect(deleted.store.begin(4)).resolves.toBe('deleted');
    expect(deleted.executed.some(sql => sql.includes("lifecycle_state <> 'deleted'"))).toBe(true);
    expect(deleted.connection.commit).toHaveBeenCalledOnce();

    const missing = fakeStore({ rows: [] });
    await expect(missing.store.begin(4)).resolves.toBeNull();
    expect(missing.connection.commit).not.toHaveBeenCalled();

    const reasons = fakeStore({});
    await reasons.store.record(4, ['TASK_CLEANUP_PENDING']);
    expect(reasons.executed.at(-1)).toContain("lifecycle_state = 'deleting'");

    await expect(reasons.store.observe(4)).resolves.toBe('available');
    const unknown = fakeStore({ rows: [{ lifecycle_state: 'other' }] });
    await expect(unknown.store.observe(4)).rejects.toThrow('INSTANCE_REMOVAL_STATE_UNKNOWN');
  });
});
