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

const manualLookup = {
  instanceId: 91,
  triggerType: 'manual' as const,
  userId: 3,
  sessionVersion: 1,
};

describe('AI analysis durable dispatch state', () => {
  beforeEach(() => {
    execute.mockReset();
    getPool.mockReset();
    getPool.mockReturnValue({ execute });
  });

  it('returns the latest active fault diagnosis for stable typed dimensions', async () => {
    const findActive = (aiAnalysisDatabaseService as any).findActiveFaultDiagnosis;
    expect(findActive).toBeTypeOf('function');
    execute.mockResolvedValueOnce([[
      { id: '91', status: 'running', sessionKey: 'diagnosis-91' },
    ]]);

    await expect(findActive.call(aiAnalysisDatabaseService, manualLookup)).resolves.toEqual({
      id: 91,
      status: 'running',
      sessionKey: 'diagnosis-91',
    });
    const sql = execute.mock.calls[0]![0] as string;
    expect(sql).toContain("analysis_type = 'fault_diagnosis'");
    expect(sql).toContain('instance_id = ?');
    expect(sql).toContain('trigger_type = ?');
    expect(sql).toContain('cache_key LIKE ?');
    expect(sql).toContain("status IN ('pending', 'running')");
    expect(execute).toHaveBeenCalledWith(
      expect.any(String),
      [91, 'manual', 'fault:91:%:manual:user:3:session:1'],
    );
  });

  it.each([
    [
      { instanceId: 91, triggerType: 'auto' as const, userId: 0, sessionVersion: 0 },
      [91, 'auto', 'fault:91:%:auto:user:0:session:0'],
    ],
    [
      { instanceId: 91, triggerType: 'manual' as const, userId: 4, sessionVersion: 2 },
      [91, 'manual', 'fault:91:%:manual:user:4:session:2'],
    ],
  ])('constructs the active pattern internally for trigger and actor isolation', async (lookup, expectedParams) => {
    const findActive = (aiAnalysisDatabaseService as any).findActiveFaultDiagnosis;
    expect(findActive).toBeTypeOf('function');
    execute.mockResolvedValueOnce([[]]);

    await expect(findActive.call(aiAnalysisDatabaseService, lookup)).resolves.toBeNull();
    expect(execute).toHaveBeenCalledWith(expect.any(String), expectedParams);
  });

  it('rejects active lookup when the analysis store is unavailable', async () => {
    const findActive = (aiAnalysisDatabaseService as any).findActiveFaultDiagnosis;
    expect(findActive).toBeTypeOf('function');
    getPool.mockReturnValue(null);

    await expect(findActive.call(aiAnalysisDatabaseService, manualLookup))
      .rejects.toThrow('ANALYSIS_ACTIVE_LOOKUP_UNAVAILABLE');
    expect(execute).not.toHaveBeenCalled();
  });

  it('logs active lookup query failures internally and rejects with a stable error', async () => {
    const findActive = (aiAnalysisDatabaseService as any).findActiveFaultDiagnosis;
    expect(findActive).toBeTypeOf('function');
    const rawError = new Error('connect ECONNREFUSED mysql://root:secret@db.internal');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    execute.mockRejectedValueOnce(rawError);

    await expect(findActive.call(aiAnalysisDatabaseService, manualLookup))
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
