import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db-connection', () => ({
  dbConnection: { getPool: () => mockPool, isConnected: () => true },
}));

const mockPool = { execute: vi.fn().mockResolvedValue([[]]) };

describe('alert-silence-service.ts', () => {
  beforeEach(() => { vi.resetModules(); vi.mocked(mockPool.execute).mockReset(); });

  it('isSilenced returns false when no matching silence record', async () => {
    const { alertSilenceService } = await import('../src/alert-silence-service');
    const result = await alertSilenceService.isSilenced(1, 'cpu_usage');
    expect(result).toBe(false);
  });

  it('isSilenced returns true when active silence record exists', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([[{ id: 1 }]]);
    const { alertSilenceService } = await import('../src/alert-silence-service');
    const result = await alertSilenceService.isSilenced(1, 'cpu_usage');
    expect(result).toBe(true);
  });

  it('silence inserts a new record', async () => {
    const { alertSilenceService } = await import('../src/alert-silence-service');
    const result = await alertSilenceService.silence(1, 'cpu_usage', 5, 42);
    expect(result.success).toBe(true);
  });

  it('getActiveSilences returns empty array when no records', async () => {
    const { alertSilenceService } = await import('../src/alert-silence-service');
    const result = await alertSilenceService.getActiveSilences();
    expect(result).toEqual([]);
  });

  it('getActiveSilences with instanceId filters by instance', async () => {
    const { alertSilenceService } = await import('../src/alert-silence-service');
    await alertSilenceService.getActiveSilences(5);
    const callArgs = vi.mocked(mockPool.execute).mock.calls[0][1];
    expect(callArgs[0]).toBe(5);
  });

  it('clearSilence deletes by ID', async () => {
    const { alertSilenceService } = await import('../src/alert-silence-service');
    const result = await alertSilenceService.clearSilence(1);
    expect(result.success).toBe(true);
  });

  it('cleanupExpiredSilences returns count of deleted records', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([{ affectedRows: 3 }]);
    const { alertSilenceService } = await import('../src/alert-silence-service');
    const count = await alertSilenceService.cleanupExpiredSilences();
    expect(count).toBe(3);
  });
});
