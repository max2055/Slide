import { describe, expect, it, vi } from 'vitest';
import type { IAgentEngine, InvokeResult } from '../adapter/types.js';
import { JobRegistry } from '../workflows/job-registry.js';
import type { ClaimedJob } from '../workflows/worker-runtime.js';
import { registerAnalysisDispatchHandler } from './analysis-dispatch-handler.js';
import type { AnalysisDispatchStore, OwnedAnalysis } from './analysis-dispatch-store.js';

describe('analysis completion write recovery (#488)', () => {
  function setup(invoke: IAgentEngine['invoke']) {
    const job: ClaimedJob = { id: 'job', type: 'analysis.dispatch', payload: { analysisId: 1 }, attempts: 1, maxAttempts: 3, fencingToken: 1 };
    const context = { workerId: 'test', fencingToken: 1, signal: new AbortController().signal };
    const owned: OwnedAnalysis = { analysisId: 1, job, context, runtimeRunId: 'run', request: {
      purpose: 'fault_diagnosis', subject: { type: 'server', id: 1 }, message: 'test', systemPrompt: 'test',
      configVersion: 'c1', evidenceVersion: 'e1', authorizationVersion: 'a1', sessionKey: 'session',
    } };
    const store = {
      claim: vi.fn().mockResolvedValue(owned), beforeSend: vi.fn(), responded: vi.fn(),
      completeEnvelope: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
      fail: vi.fn().mockResolvedValue(true), recordExecution: vi.fn(),
    };
    const registry = new JobRegistry();
    registerAnalysisDispatchHandler(registry, { store: store as unknown as AnalysisDispatchStore,
      engine: async () => ({ invoke } as IAgentEngine), authorize: async () => {}, configurationVersion: async () => 'c1' });
    return { store, owned, execute: () => registry.execute(job, context) };
  }

  it.each(['throw', 'error-result', 'completed-result'] as const)('retains the dedicated reason on %s', async exit => {
    const fixture = setup(async (_s, _m, _p, options) => {
      await options!.beforeProviderRequest!();
      try { await options!.completeAnalysis!({}); }
      catch (error) { if (exit === 'throw') throw error; }
      return { content: null, stopReason: exit === 'error-result' ? 'error' : 'completed' };
    });
    await expect(fixture.execute()).rejects.toThrow(exit === 'throw' ? 'ECONNRESET' : 'ANALYSIS_COMPLETION_WRITE_UNCONFIRMED');
    expect(fixture.store.fail).toHaveBeenCalledExactlyOnceWith(fixture.owned, 'ANALYSIS_COMPLETION_WRITE_UNCONFIRMED', false, false);
    expect(fixture.store.responded).not.toHaveBeenCalled();
    expect(fixture.store.beforeSend).toHaveBeenCalledTimes(1);
  });

  it('blocks a further provider request after a swallowed completion error', async () => {
    const fixture = setup(async (_s, _m, _p, options) => {
      await options!.beforeProviderRequest!();
      await options!.completeAnalysis!({}).catch(() => {});
      await options!.beforeProviderRequest!();
      throw new Error('UNREACHABLE');
    });
    await expect(fixture.execute()).rejects.toThrow('ANALYSIS_COMPLETION_WRITE_UNCONFIRMED');
    expect(fixture.store.beforeSend).toHaveBeenCalledTimes(1);
    expect(fixture.store.completeEnvelope).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ content: null, stopReason: 'completed' }, 'ANALYSIS_ENVELOPE_NOT_SAVED', true],
    [{ content: null, stopReason: 'error', error: 'provider error' }, 'ANALYSIS_PROVIDER_RESULT_UNKNOWN', false],
  ] as const)('preserves ordinary result classification: %s', async (result, reason, known) => {
    const fixture = setup(async () => result as InvokeResult);
    await fixture.execute();
    expect(fixture.store.fail).toHaveBeenCalledExactlyOnceWith(fixture.owned, reason, known);
  });
});
