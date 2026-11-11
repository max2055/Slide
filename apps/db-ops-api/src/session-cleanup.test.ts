import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDatabaseService, chatDatabaseService } from './chat-database-service.js';
import { startSessionCleanup, stopSessionCleanup } from './session-cleanup.js';

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
});
