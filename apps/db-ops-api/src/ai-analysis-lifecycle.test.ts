import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { aiAnalysisDatabaseService as service } from './ai-analysis-database-service.js';
const envelope = { schemaVersion: 1, analysisType: 'alert_rca', subject: { type: 'instance', id: 42 }, conclusions: ['finding'], hypotheses: [], evidenceRefs: [], confidence: 0.5, recommendations: [], displayMarkdown: 'finding', provenance: { modelVersion: 'configured-provider', promptVersion: 'managed', toolVersions: {} }, createdAt: '2026-09-13T00:00:00Z' };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('analysis terminal writes', () => {
  it.each(['completed', 'failed'])('does not overwrite %s when completion and timeout compete', async initial => {
    let status = initial;
    const execute = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT')) return [[{ status, analysis_envelope: envelope }]];
      const active = ['pending', 'running'].includes(status);
      const guarded = sql.includes("status IN ('pending', 'running')");
      if (!guarded || active) status = sql.includes("status = 'failed'") ? 'failed' : 'completed';
      return [{ affectedRows: active || !guarded ? 1 : 0 }];
    });
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    await service.failAnalysis(42, 'late failure'); expect(status).toBe(initial);
    const completion = await service.completeAnalysisEnvelope(42, envelope); expect(status).toBe(initial);
    expect(completion.success).toBe(initial === 'completed');
  });
  it('does not retry a completion without its required execution trace column', async () => {
    const execute = vi.fn().mockRejectedValue(new Error("Unknown column 'execution_trace'"));
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
    expect((await service.completeAnalysis(42, { result: 'result' })).success).toBe(false); expect(execute).toHaveBeenCalledTimes(1);
  });
  it('poll timeout only observes, including completion during the last wait', async () => {
    vi.useFakeTimers(); let status = 'running';
    vi.spyOn(service, 'getAnalysisById').mockImplementation(async () => ({ status } as any));
    const fail = vi.spyOn(service, 'failAnalysis');
    const pending = service.waitForCompletion(42, 1000);
    status = 'completed'; await vi.advanceTimersByTimeAsync(2001);
    expect((await pending)?.status).toBe('completed'); expect(fail).not.toHaveBeenCalled();
  });
});
