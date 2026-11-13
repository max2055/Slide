import { describe, expect, it, vi } from 'vitest';
import { AnalysisDispatchStore } from './analysis-dispatch-store.js';

describe('analysis ID number boundary (#302)', () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects retry ID %s before acquiring a connection', async retryOf => {
    const pool = vi.fn();
    const store = new AnalysisDispatchStore(pool);
    await expect(store.enqueue({ retryOf } as any)).rejects.toThrow('ANALYSIS_ID_OUT_OF_SAFE_RANGE');
    expect(pool).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects claim ID %s before executing SQL', async analysisId => {
    const execute = vi.fn();
    const connection = { beginTransaction: vi.fn(), rollback: vi.fn(), release: vi.fn(), execute };
    const store = new AnalysisDispatchStore(() => ({ getConnection: async () => connection }) as any);
    await expect(store.claim(analysisId, {} as any, { signal: new AbortController().signal } as any)).rejects.toThrow('ANALYSIS_ID_OUT_OF_SAFE_RANGE');
    expect(execute).not.toHaveBeenCalled();
  });
});
