import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { authorize, explain, dispatch } = vi.hoisted(() => ({ authorize: vi.fn(), explain: vi.fn(), dispatch: vi.fn() }));
vi.mock('./analysis/analysis-identity.js', () => ({ authorizeAnalysisRequest: authorize, analysisAuthorizationVersion: () => 'auth' }));
vi.mock('./database-service.js', () => ({ databaseService: { getConnection: () => ({ db_type: 'mysql' }), getExplainPlan: explain } }));
vi.mock('./ai-agent-bridge.js', () => ({ dispatchOrReuse: dispatch }));
import { dbConnection } from './db-connection.js';
import { metricsDatabaseService } from './metrics-database-service.js';
import { topsqlAnalysisService } from './topsql-analysis-service.js';

const actor = { userId: 7, username: 'op', roles: [], permissions: ['ai:manage'], sessionVersion: 1, instanceScopes: { 42: 'read-only' as const }, requestId: 'MAX-536' };
const row = { id: 101, instance_id: 42, sql_text: 'SELECT 1', sql_hash: 'rank101', avg_time_ms: '1.25', total_time_ms: '2.50', max_time_ms: null, min_time_ms: '0.00', schema_name: null };
beforeEach(() => {
  vi.clearAllMocks();
  authorize.mockResolvedValue(undefined);
  explain.mockResolvedValue('MySQL 执行计划:\n  constant');
  dispatch.mockResolvedValue({ success: true, analysisId: 900 });
});
afterEach(() => vi.restoreAllMocks());

describe.each(['analyzeSlowQuery', 'reanalyzeSlowQuery'] as const)('MAX-536 %s', method => {
  it('analyzes the exact record without reading a ranked list, keeping current authorization and evidence', async () => {
    const execute = vi.fn().mockResolvedValue([[row], []]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    const list = vi.spyOn(metricsDatabaseService, 'getSlowQueries');
    await expect(topsqlAnalysisService[method](101, 42, 'manual', actor)).resolves.toBe(900);
    expect(list).not.toHaveBeenCalled();
    expect(execute.mock.calls[0][1]).toEqual([42, 101]);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ actor, subject: { type: 'instance', id: 42 } }));
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(explain.mock.invocationCallOrder[0]);
    expect(explain.mock.invocationCallOrder[0]).toBeLessThan(dispatch.mock.invocationCallOrder[0]);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      relatedId: 101, instanceId: 42, actor, reuseCompleted: method === 'analyzeSlowQuery',
      evidenceData: expect.objectContaining({ metrics: expect.objectContaining({ avg_time_ms: 1.25, total_time_ms: 2.5, min_time_ms: 0, max_time_ms: null }) }),
    }));
  });

  it('does not collect evidence or dispatch a missing, deleted or other-instance record', async () => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: vi.fn().mockResolvedValue([[], []]) } as any);
    await expect(topsqlAnalysisService[method](101, 42, 'manual', actor)).rejects.toThrow('慢查询 #101 不存在');
    expect(authorize).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'query failure'])('distinguishes %s from not found without dispatch', async mode => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(mode === 'unavailable' ? null : { execute: vi.fn().mockRejectedValue(new Error('storage offline')) } as any);
    await expect(topsqlAnalysisService[method](101, 42, 'manual', actor)).rejects.toThrow(mode === 'unavailable' ? 'SLOW_QUERIES_UNAVAILABLE' : 'SLOW_QUERIES_QUERY_FAILED');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('stops before collection and dispatch when current authority is revoked', async () => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: vi.fn().mockResolvedValue([[row], []]) } as any);
    authorize.mockRejectedValue(new Error('ANALYSIS_AUTHORITY_REVOKED'));
    await expect(topsqlAnalysisService[method](101, 42, 'manual', actor)).rejects.toThrow('ANALYSIS_AUTHORITY_REVOKED');
    expect(explain).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

it('MAX-536 reanalysis preserves retry identity and disables completed-result reuse', async () => {
  vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: vi.fn().mockResolvedValue([[row], []]) } as any);
  await topsqlAnalysisService.reanalyzeSlowQuery(101, 42, 'manual', actor, 899);
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ retryOf: 899, reuseCompleted: false }));
});
