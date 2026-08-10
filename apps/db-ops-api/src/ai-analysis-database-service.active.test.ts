import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execute, getPool } = vi.hoisted(() => ({
  execute: vi.fn(),
  getPool: vi.fn(),
}));

vi.mock('./db-connection.js', () => ({
  dbConnection: {
    getPool,
    isConnected: vi.fn(() => true),
  },
}));

import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';

describe('AI analysis durable dispatch state', () => {
  beforeEach(() => {
    execute.mockReset();
    getPool.mockReset();
    getPool.mockReturnValue({ execute });
  });

  it('returns the latest active analysis and durable session marker for a cache key', async () => {
    const findActive = (aiAnalysisDatabaseService as any).findActiveByCacheKey;
    expect(findActive).toBeTypeOf('function');
    execute.mockResolvedValueOnce([[
      { id: '91', status: 'running', sessionKey: 'diagnosis-91' },
    ]]);

    await expect(findActive.call(aiAnalysisDatabaseService, 'fault:91:key')).resolves.toEqual({
      id: 91,
      status: 'running',
      sessionKey: 'diagnosis-91',
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('pending', 'running')"),
      ['fault:91:key'],
    );
  });

  it('rejects active lookup when the analysis store is unavailable', async () => {
    const findActive = (aiAnalysisDatabaseService as any).findActiveByCacheKey;
    expect(findActive).toBeTypeOf('function');
    getPool.mockReturnValue(null);

    await expect(findActive.call(aiAnalysisDatabaseService, 'fault:91:key'))
      .rejects.toThrow('ANALYSIS_ACTIVE_LOOKUP_UNAVAILABLE');
    expect(execute).not.toHaveBeenCalled();
  });

  it('logs active lookup query failures internally and rejects with a stable error', async () => {
    const findActive = (aiAnalysisDatabaseService as any).findActiveByCacheKey;
    expect(findActive).toBeTypeOf('function');
    const rawError = new Error('connect ECONNREFUSED mysql://root:secret@db.internal');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    execute.mockRejectedValueOnce(rawError);

    await expect(findActive.call(aiAnalysisDatabaseService, 'fault:91:key'))
      .rejects.toThrow('ANALYSIS_ACTIVE_LOOKUP_UNAVAILABLE');
    expect(consoleError).toHaveBeenCalledWith(expect.any(String), rawError);
    consoleError.mockRestore();
  });

  it('marks a dispatched analysis only when the CAS updates one row', async () => {
    const markDispatched = (aiAnalysisDatabaseService as any).markDispatched;
    expect(markDispatched).toBeTypeOf('function');
    execute.mockResolvedValueOnce([{ affectedRows: 1 }]);

    await expect(markDispatched.call(aiAnalysisDatabaseService, 91, 'diagnosis-91')).resolves.toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('session_key IS NULL'),
      ['diagnosis-91', 91],
    );
    expect(execute.mock.calls[0]![0]).toContain("status IN ('pending', 'running')");
  });

  it('reports an unconfirmed marker when the CAS updates no row', async () => {
    const markDispatched = (aiAnalysisDatabaseService as any).markDispatched;
    expect(markDispatched).toBeTypeOf('function');
    execute.mockResolvedValueOnce([{ affectedRows: 0 }]);

    await expect(markDispatched.call(aiAnalysisDatabaseService, 91, 'diagnosis-91')).resolves.toBe(false);
  });

  it('propagates dispatch marker write failures', async () => {
    const markDispatched = (aiAnalysisDatabaseService as any).markDispatched;
    expect(markDispatched).toBeTypeOf('function');
    execute.mockRejectedValueOnce(new Error('MARKER_WRITE_FAILED'));

    await expect(markDispatched.call(aiAnalysisDatabaseService, 91, 'diagnosis-91'))
      .rejects.toThrow('MARKER_WRITE_FAILED');
  });
});
