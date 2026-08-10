import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from './auth/actor-context.js';
import type { DispatchOrReuseParams } from './ai-agent-bridge.js';
import { FaultDiagnosisService, type FaultDiagnosisDependencies } from './fault-diagnosis-service.js';
import type { InstanceDiagnosticContext } from './instance-diagnostic-context-service.js';

const actor: ActorContext = Object.freeze({
  userId: 3,
  username: 'dba',
  roles: Object.freeze(['dba']),
  permissions: Object.freeze(['instance:view', 'metric:view', 'alert:view', 'log:view']),
  sessionVersion: 1,
  instanceScopes: Object.freeze({ 7: 'read-only', 8: 'read-only' }),
  requestId: 'fault-diagnosis-test',
});

const diagnosticContext: InstanceDiagnosticContext = {
  schemaVersion: 1,
  subject: { type: 'instance', id: 7 },
  collectedAt: '2026-08-10T00:00:00.000Z',
  database: {
    instance: { id: 7, name: 'orders', db_type: 'mysql', environment: 'production' },
    realtimeMetrics: { qps: 120 },
    metricHistory: [],
    alerts: [],
    logs: [],
    slowQueries: [],
  },
  storage: [],
  hosts: [],
  gaps: [],
};

function dependencies(events: string[] = []) {
  return {
    contextCollector: {
      collect: vi.fn(async (_actor: ActorContext, _instanceId: number) => {
        events.push('collect');
        return diagnosticContext;
      }),
    },
    analysisStore: {
      findByCacheKey: vi.fn(async (_cacheKey: string) => {
        events.push('cache');
        return null;
      }),
      createAnalysis: vi.fn(async (_data: unknown): Promise<{ success: boolean; analysisId?: number; error?: string }> => {
        events.push('create');
        return { success: true, analysisId: 71 };
      }),
      updateStatus: vi.fn(async (
        _analysisId: number,
        _status: 'pending' | 'running' | 'completed' | 'failed',
      ): Promise<{ success: boolean; error?: string }> => {
        events.push('running');
        return { success: true };
      }),
      failAnalysis: vi.fn(async (_analysisId: number, _message: string) => ({ success: true })),
      getAnalysisList: vi.fn(async (_options?: unknown) => []),
      getAnalysisStats: vi.fn(async (_analysisType?: string) => ({})),
    },
    dispatch: vi.fn(async (_params: DispatchOrReuseParams) => {
      events.push('dispatch');
      return { analysisId: 71, cached: false };
    }),
  };
}

describe('FaultDiagnosisService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the original actor to collection and orders collection before persistence and dispatch', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

    const result = await service.diagnoseInstance(actor, 7);

    expect(result).toEqual({ success: true, analysisId: 71, status: 'queued' });
    expect(deps.contextCollector.collect.mock.calls[0]![0]).toBe(actor);
    expect(deps.contextCollector.collect).toHaveBeenCalledWith(actor, 7);
    expect(events).toEqual(['collect', 'cache', 'create', 'running', 'dispatch']);
    expect(deps.analysisStore.createAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      analysis_type: 'fault_diagnosis',
      instance_id: 7,
      trigger_type: 'manual',
      cache_key: expect.stringMatching(/^fault:7:.*:manual$/),
    }));
    expect(deps.analysisStore.updateStatus).toHaveBeenCalledWith(71, 'running');
    expect(deps.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'fault_diagnosis',
      instanceId: 7,
      triggerType: 'manual',
      existingAnalysisId: 71,
      diagnosticContext,
    }));
    const [dispatchParams] = deps.dispatch.mock.calls[0]!;
    expect(dispatchParams.userMessage).not.toMatch(/query_metrics|get_instance_summary|采集指标|调用其他工具/i);
  });

  it('collects before checking the hourly manual cache', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.analysisStore.findByCacheKey.mockImplementation(async () => {
      events.push('cache');
      return { id: 44, result: { conclusions: [] } } as any;
    });
    const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

    await expect(service.diagnoseInstance(actor, 7)).resolves.toEqual({ success: true, analysisId: 44 });

    expect(events).toEqual(['collect', 'cache']);
    expect(deps.analysisStore.createAnalysis).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('does not create, update, or dispatch when context collection fails', async () => {
    const deps = dependencies();
    deps.contextCollector.collect.mockRejectedValue(new Error('INSTANCE_METADATA_UNAVAILABLE'));
    const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

    await expect(service.diagnoseInstance(actor, 7)).rejects.toThrow('INSTANCE_METADATA_UNAVAILABLE');

    expect(deps.analysisStore.findByCacheKey).not.toHaveBeenCalled();
    expect(deps.analysisStore.createAnalysis).not.toHaveBeenCalled();
    expect(deps.analysisStore.updateStatus).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('does not update or dispatch when analysis creation fails', async () => {
    const deps = dependencies();
    deps.analysisStore.createAnalysis.mockResolvedValue({ success: false, error: 'CREATE_FAILED' });
    const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

    await expect(service.diagnoseInstance(actor, 7)).resolves.toEqual({ success: false, error: 'CREATE_FAILED' });

    expect(deps.analysisStore.updateStatus).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('does not dispatch when the running status update fails', async () => {
    const deps = dependencies();
    deps.analysisStore.updateStatus.mockResolvedValue({ success: false, error: 'RUNNING_FAILED' });
    const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

    await expect(service.diagnoseInstance(actor, 7)).resolves.toEqual({ success: false, error: 'RUNNING_FAILED' });

    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('keeps the pending lock while context collection is in flight', async () => {
    let releaseCollection!: (value: InstanceDiagnosticContext) => void;
    const deps = dependencies();
    deps.contextCollector.collect.mockImplementation(() => new Promise((resolve) => {
      releaseCollection = resolve;
    }));
    const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

    const first = service.diagnoseInstance(actor, 7);
    await vi.waitFor(() => expect(deps.contextCollector.collect).toHaveBeenCalledTimes(1));
    await expect(service.diagnoseInstance(actor, 7)).resolves.toMatchObject({
      success: false,
      error: '诊断正在创建中，请稍后重试',
    });

    releaseCollection(diagnosticContext);
    await expect(first).resolves.toMatchObject({ success: true, analysisId: 71 });
  });

  describe('manual cache key', () => {
    it('uses hour-level granularity and a fixed manual identity', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-25T14:00:00Z'));
      const service = new FaultDiagnosisService(dependencies() as unknown as FaultDiagnosisDependencies);
      const key1 = service['buildCacheKey'](10);
      vi.setSystemTime(new Date('2026-04-25T14:59:59Z'));
      const key2 = service['buildCacheKey'](10);

      expect(key1).toBe('fault:10:2026-04-25T14:manual');
      expect(key2).toBe(key1);
    });
  });
});
