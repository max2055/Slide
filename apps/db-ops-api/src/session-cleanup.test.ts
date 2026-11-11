import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDatabaseService, ChatRetentionDeniedError, ChatSessionNotFoundError, chatDatabaseService } from './chat-database-service.js';
import { runCleanup, startSessionCleanup, stopSessionCleanup } from './session-cleanup.js';

// GitHub #283 / MAX-622: invalid retention must never reach destructive SQL.
describe('session retention safety', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(chatDatabaseService, 'deleteOldSessionsForMaintenance').mockResolvedValue(0);
    vi.spyOn(chatDatabaseService, 'getSessionsForMaintenance').mockResolvedValue([]);
  });
  afterEach(() => {
    stopSessionCleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(['0', '-5', '-0', '+30', 'bogus', '30days', '1.5', '1e2', '0x10', ' ', '30\n', '３０', 'NaN', 'Infinity', '36501', '9007199254740993'])(
    'rejects configured %j before immediate or scheduled cleanup', async value => {
      vi.stubEnv('SESSION_RETENTION_DAYS', value);
      expect(() => startSessionCleanup()).toThrow(/retention/i);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(chatDatabaseService.deleteOldSessionsForMaintenance).not.toHaveBeenCalled();
      expect(chatDatabaseService.getSessionsForMaintenance).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

  it.each([undefined, '', '1', '30', '36500'])(
    'uses safe default or valid configured retention %j on startup and interval', async value => {
      vi.stubEnv('SESSION_RETENTION_DAYS', value);
      startSessionCleanup(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(chatDatabaseService.deleteOldSessionsForMaintenance).toHaveBeenCalledTimes(2);
      expect(chatDatabaseService.deleteOldSessionsForMaintenance).toHaveBeenNthCalledWith(1, value ? Number(value) : 30);
      expect(chatDatabaseService.deleteOldSessionsForMaintenance).toHaveBeenNthCalledWith(2, value ? Number(value) : 30);
    });

  it.each([0, -5, NaN, Infinity, -Infinity, 1.5, 36501, Number.MAX_SAFE_INTEGER + 1, undefined, null, '', '30'])(
    'rejects maintenance argument %j before accessing a pool', async value => {
      const poolProvider = vi.fn(() => null);
      const service = new ChatDatabaseService(poolProvider);
      await expect(service.deleteOldSessionsForMaintenance(value as number)).rejects.toThrow(/retention/i);
      expect(poolProvider).not.toHaveBeenCalled();
    });

  it.each(['0', '-1', 'bad', '1.5', '1000x', '9007199254740993'])('rejects invalid batch size %j before cleanup', value => {
    vi.stubEnv('SESSION_CLEANUP_BATCH_SIZE', value);
    expect(() => startSessionCleanup()).toThrow(/batch size/);
    expect(chatDatabaseService.deleteOldSessionsForMaintenance).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not overlap scans when an interval fires during a slow cleanup', async () => {
    let finish!: (deleted: number) => void;
    vi.mocked(chatDatabaseService.deleteOldSessionsForMaintenance).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    startSessionCleanup(1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(chatDatabaseService.deleteOldSessionsForMaintenance).toHaveBeenCalledTimes(1);
    finish(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(chatDatabaseService.deleteOldSessionsForMaintenance).toHaveBeenCalledTimes(2);
  });

  it('stopping cleanup cancels the scan before any subsequent cap', async () => {
    let finish!: (rows: Awaited<ReturnType<typeof chatDatabaseService.getSessionsForMaintenance>>) => void;
    vi.mocked(chatDatabaseService.getSessionsForMaintenance).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const cap = vi.spyOn(chatDatabaseService, 'enforceMessageCapForMaintenance');
    startSessionCleanup(1000);
    await vi.advanceTimersByTimeAsync(0);
    stopSessionCleanup();
    finish([{ id: 1, session_id: 'after-stop' }] as any);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cap).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// GitHub #381/#592: business refusals are local; infrastructure failures are fatal.
describe('maintenance traversal', () => {
  const session = (id: number) => ({ id, session_id: String(id) }) as Awaited<ReturnType<typeof chatDatabaseService.getSessionsForMaintenance>>[number];
  const store = () => ({
    deleteOldSessionsForMaintenance: vi.fn().mockResolvedValue(0),
    getSessionsForMaintenance: vi.fn().mockResolvedValue([]),
    enforceMessageCapForMaintenance: vi.fn().mockResolvedValue(2),
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    new ChatRetentionDeniedError('UNSETTLED_INTENT_RETENTION_DENIED'),
    new ChatRetentionDeniedError('RETENTION_AUDIT_CAPACITY_EXCEEDED'),
    new ChatRetentionDeniedError('INVESTIGATION_RETENTION_DENIED'),
    new ChatSessionNotFoundError(),
  ])('continues after %s and counts skipped sessions', async error => {
    const db = store();
    db.getSessionsForMaintenance.mockResolvedValueOnce([session(2), session(1)]);
    db.enforceMessageCapForMaintenance.mockRejectedValueOnce(error);
    expect(await runCleanup(30, 2, { store: db })).toEqual({ processed: 1, skipped: 1, deletedMessages: 2 });
    expect(db.enforceMessageCapForMaintenance.mock.calls).toEqual([['2', 2], ['1', 2]]);
  });

  it('visits more than 1000 sessions across pages and can run again', async () => {
    const db = store();
    const sessions = Array.from({ length: 1003 }, (_, index) => session(1003 - index));
    db.getSessionsForMaintenance.mockImplementation(async (limit, before) => sessions.filter(s => before === undefined || s.id < before).slice(0, limit));
    expect((await runCleanup(30, 2, { store: db })).processed).toBe(1003);
    expect(db.getSessionsForMaintenance.mock.calls).toEqual([[1000, undefined], [1000, 4]]);
    db.enforceMessageCapForMaintenance.mockResolvedValue(0);
    expect(await runCleanup(30, 2, { store: db })).toEqual({ processed: 1003, skipped: 0, deletedMessages: 0 });
  });

  it.each([new Error('database offline'), new DOMException('cancelled', 'AbortError'), new Error('UNSETTLED_INTENT_RETENTION_DENIED')])(
    'propagates unclassified failure %s without processing later sessions', async error => {
      const db = store();
      db.getSessionsForMaintenance.mockResolvedValueOnce([session(2), session(1)]);
      db.enforceMessageCapForMaintenance.mockRejectedValueOnce(error);
      await expect(runCleanup(30, 2, { store: db })).rejects.toBe(error);
      expect(db.enforceMessageCapForMaintenance).toHaveBeenCalledTimes(1);
    });

  it('propagates page failure and does not replay successful mutations', async () => {
    const db = store();
    const error = new Error('connection lost');
    db.getSessionsForMaintenance.mockResolvedValueOnce([session(2)]).mockRejectedValueOnce(error);
    await expect(runCleanup(30, 2, { store: db, batchSize: 1 })).rejects.toBe(error);
    expect(db.enforceMessageCapForMaintenance).toHaveBeenCalledTimes(1);
  });

  it('propagates expiration failure before reading or capping sessions', async () => {
    const db = store();
    const error = new Error('database unavailable');
    db.deleteOldSessionsForMaintenance.mockRejectedValue(error);
    await expect(runCleanup(30, 2, { store: db })).rejects.toBe(error);
    expect(db.getSessionsForMaintenance).not.toHaveBeenCalled();
  });

  it('observes cancellation before mutations and between sessions', async () => {
    const db = store();
    const controller = new AbortController();
    db.getSessionsForMaintenance.mockResolvedValueOnce([session(2), session(1)]);
    db.enforceMessageCapForMaintenance.mockImplementationOnce(async () => { controller.abort(); return 0; });
    await expect(runCleanup(30, 2, { store: db, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(db.enforceMessageCapForMaintenance).toHaveBeenCalledTimes(1);
    db.deleteOldSessionsForMaintenance.mockClear();
    await expect(runCleanup(30, 2, { store: db, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(db.deleteOldSessionsForMaintenance).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects batch size %s before deleting', async batchSize => {
    const db = store();
    await expect(runCleanup(30, 2, { store: db, batchSize })).rejects.toThrow(/batch size/);
    expect(db.deleteOldSessionsForMaintenance).not.toHaveBeenCalled();
  });
});
