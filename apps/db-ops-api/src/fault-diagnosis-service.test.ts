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
    listActiveInstances: vi.fn(async () => [] as Array<{ id: number }>),
    checkHealth: vi.fn(async (_instanceId: number) => null as { status: string } | null),
    randomUUID: vi.fn(() => 'fault-diagnosis-uuid'),
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
      waitForCompletion: vi.fn(async (_analysisId: number, _timeoutMs?: number) => ({ status: 'completed' } as any)),
      getAnalysisList: vi.fn(async (_options?: unknown) => []),
      getAnalysisStats: vi.fn(async (_analysisType?: string) => ({})),
    },
    dispatch: vi.fn(async (_params: DispatchOrReuseParams) => {
      events.push('dispatch');
      return { analysisId: 71, cached: false };
    }),
  };
}

function diagnosticContextFor(instanceId: number): InstanceDiagnosticContext {
  return {
    ...diagnosticContext,
    subject: { type: 'instance', id: instanceId },
    database: {
      ...diagnosticContext.database,
      instance: { ...diagnosticContext.database.instance, id: instanceId, name: `instance-${instanceId}` },
    },
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
      cache_key: expect.stringMatching(/^fault:7:.*:manual:user:3:session:1$/),
    }));
    const cacheKey = deps.analysisStore.createAnalysis.mock.calls[0]![0] as { cache_key: string };
    expect(cacheKey.cache_key.length).toBeLessThan(128);
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

  it('rejects a mismatched diagnostic subject before cache or persistence', async () => {
    const deps = dependencies();
    deps.contextCollector.collect.mockResolvedValue({
      ...diagnosticContext,
      subject: { type: 'instance', id: 8 },
    });
    const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

    await expect(service.diagnoseInstance(actor, 7)).rejects.toThrow('DIAGNOSTIC_CONTEXT_SUBJECT_MISMATCH');

    expect(deps.analysisStore.findByCacheKey).not.toHaveBeenCalled();
    expect(deps.analysisStore.createAnalysis).not.toHaveBeenCalled();
    expect(deps.analysisStore.updateStatus).not.toHaveBeenCalled();
    expect(deps.analysisStore.failAnalysis).not.toHaveBeenCalled();
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

    expect(deps.analysisStore.failAnalysis).toHaveBeenCalledWith(71, 'RUNNING_FAILED');
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('returns the running error even when terminal persistence rejects', async () => {
    const deps = dependencies();
    deps.analysisStore.updateStatus.mockResolvedValue({ success: false, error: 'RUNNING_FAILED' });
    deps.analysisStore.failAnalysis.mockRejectedValue(new Error('FAIL_ANALYSIS_UNAVAILABLE'));
    const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

    await expect(service.diagnoseInstance(actor, 7)).resolves.toEqual({ success: false, error: 'RUNNING_FAILED' });

    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('waits for terminal persistence before returning a running status error', async () => {
    let resolveFailure!: (value: { success: boolean }) => void;
    const deps = dependencies();
    deps.analysisStore.updateStatus.mockResolvedValue({ success: false, error: 'RUNNING_FAILED' });
    deps.analysisStore.failAnalysis.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFailure = resolve;
    }));
    const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);
    let settled = false;

    const diagnosis = service.diagnoseInstance(actor, 7).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(deps.analysisStore.failAnalysis).toHaveBeenCalledWith(71, 'RUNNING_FAILED'));

    expect(settled).toBe(false);
    resolveFailure({ success: true });
    await expect(diagnosis).resolves.toEqual({ success: false, error: 'RUNNING_FAILED' });
  });

  it.each([
    ['running status', 'rejects', 41],
    ['running status', 'returns unsuccessful', 42],
    ['dispatch', 'rejects', 43],
    ['dispatch', 'returns unsuccessful', 44],
  ] as const)(
    'retains the pending lock when %s failure persistence %s',
    async (failureStage, persistenceMode, userId) => {
      const failureActor = Object.freeze({ ...actor, userId, requestId: `terminal-${userId}` });
      const deps = dependencies();
      const expectedError = failureStage === 'running status' ? 'RUNNING_FAILED' : 'DISPATCH_FAILED';
      if (failureStage === 'running status') {
        deps.analysisStore.updateStatus.mockResolvedValue({ success: false, error: expectedError });
      } else {
        deps.dispatch.mockRejectedValue(new Error(expectedError));
      }

      let settlePersistence!: () => void;
      const persistence = new Promise<{ success: boolean; error?: string }>((resolve, reject) => {
        settlePersistence = persistenceMode === 'rejects'
          ? () => reject(new Error('FAIL_ANALYSIS_UNAVAILABLE'))
          : () => resolve({ success: false, error: 'FAIL_ANALYSIS_UNAVAILABLE' });
      });
      deps.analysisStore.failAnalysis.mockReturnValueOnce(persistence);

      let resolveTerminal!: (value: unknown) => void;
      deps.analysisStore.waitForCompletion.mockImplementationOnce(() => new Promise((resolve) => {
        resolveTerminal = resolve;
      }));
      const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);
      let settled = false;
      const diagnosis = service.diagnoseInstance(failureActor, 7).then((result) => {
        settled = true;
        return result;
      });

      await vi.waitFor(() => expect(deps.analysisStore.failAnalysis).toHaveBeenCalledWith(71, expectedError));
      expect(settled).toBe(false);
      settlePersistence();
      await expect(diagnosis).resolves.toEqual({ success: false, error: expectedError });
      await vi.waitFor(() => expect(deps.analysisStore.waitForCompletion).toHaveBeenCalledWith(71, 120_000));

      await expect(service.diagnoseInstance(failureActor, 7)).resolves.toEqual({
        success: false,
        error: '诊断正在创建中，请稍后重试',
        status: 'in_progress',
      });
      expect(deps.contextCollector.collect).toHaveBeenCalledTimes(1);

      if (failureStage === 'running status') {
        deps.analysisStore.updateStatus.mockResolvedValue({ success: true });
      } else {
        deps.dispatch.mockResolvedValue({ analysisId: 71, cached: false });
      }
      resolveTerminal({ status: 'failed' });
      await vi.waitFor(async () => {
        await expect(service.diagnoseInstance(failureActor, 7)).resolves.toMatchObject({ success: true });
      });
    },
  );

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
      status: 'in_progress',
    });

    releaseCollection(diagnosticContext);
    await expect(first).resolves.toMatchObject({ success: true, analysisId: 71 });
  });

  it('keeps the pending lock after queued dispatch until analysis reaches a terminal state', async () => {
    let resolveTerminal!: (value: unknown) => void;
    const deps = dependencies();
    deps.analysisStore.waitForCompletion.mockImplementationOnce(() => new Promise((resolve) => {
      resolveTerminal = resolve;
    }));
    const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

    await expect(service.diagnoseInstance(actor, 7)).resolves.toMatchObject({
      success: true,
      analysisId: 71,
      status: 'queued',
    });
    await expect(service.diagnoseInstance(actor, 7)).resolves.toEqual({
      success: false,
      error: '诊断正在创建中，请稍后重试',
      status: 'in_progress',
    });
    expect(deps.contextCollector.collect).toHaveBeenCalledTimes(1);
    expect(deps.analysisStore.createAnalysis).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.analysisStore.waitForCompletion).toHaveBeenCalledWith(71, 120_000);

    resolveTerminal({ status: 'completed' });
    await vi.waitFor(async () => {
      await expect(service.diagnoseInstance(actor, 7)).resolves.toMatchObject({ success: true, status: 'queued' });
    });
    expect(deps.contextCollector.collect).toHaveBeenCalledTimes(2);
    expect(deps.analysisStore.createAnalysis).toHaveBeenCalledTimes(2);
    expect(deps.dispatch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['no record', null, 31],
    ['a running record', { status: 'running' }, 35],
  ])('keeps the pending lock when completion returns %s', async (_case, result, userId) => {
    vi.useFakeTimers();
    const uncertainActor = Object.freeze({ ...actor, userId, requestId: 'uncertain-completion' });
    const deps = dependencies();
    deps.analysisStore.waitForCompletion
      .mockResolvedValueOnce(result as any)
      .mockResolvedValueOnce({ status: 'completed' } as any);
    const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

    await expect(service.diagnoseInstance(uncertainActor, 7)).resolves.toMatchObject({
      success: true,
      status: 'queued',
    });
    await vi.waitFor(() => expect(deps.analysisStore.waitForCompletion).toHaveBeenCalledTimes(1));

    await expect(service.diagnoseInstance(uncertainActor, 7)).resolves.toEqual({
      success: false,
      error: '诊断正在创建中，请稍后重试',
      status: 'in_progress',
    });
    expect(deps.contextCollector.collect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(deps.analysisStore.waitForCompletion).toHaveBeenCalledTimes(2);
    await expect(service.diagnoseInstance(uncertainActor, 7)).resolves.toMatchObject({ success: true });
  });

  it('keeps the pending lock when completion polling rejects', async () => {
    vi.useFakeTimers();
    const uncertainActor = Object.freeze({ ...actor, userId: 32, requestId: 'rejected-completion' });
    const deps = dependencies();
    deps.analysisStore.waitForCompletion
      .mockRejectedValueOnce(new Error('STATUS_READ_UNAVAILABLE'))
      .mockResolvedValueOnce({ status: 'completed' } as any);
    const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

    await expect(service.diagnoseInstance(uncertainActor, 7)).resolves.toMatchObject({
      success: true,
      status: 'queued',
    });
    await vi.waitFor(() => expect(deps.analysisStore.waitForCompletion).toHaveBeenCalledTimes(1));

    await expect(service.diagnoseInstance(uncertainActor, 7)).resolves.toEqual({
      success: false,
      error: '诊断正在创建中，请稍后重试',
      status: 'in_progress',
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(deps.analysisStore.waitForCompletion).toHaveBeenCalledTimes(2);
    await expect(service.diagnoseInstance(uncertainActor, 7)).resolves.toMatchObject({ success: true });
  });

  it('keeps the actor-bound pending lock across an hourly cache rollover', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T14:59:59Z'));
    const rolloverActor = Object.freeze({ ...actor, userId: 33, requestId: 'hour-rollover' });
    const deps = dependencies();
    let resolveTerminal!: (value: unknown) => void;
    deps.analysisStore.waitForCompletion.mockImplementationOnce(() => new Promise((resolve) => {
      resolveTerminal = resolve;
    }));
    const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

    await expect(service.diagnoseInstance(rolloverActor, 7)).resolves.toMatchObject({
      success: true,
      status: 'queued',
    });
    vi.setSystemTime(new Date('2026-04-25T15:00:00Z'));

    await expect(service.diagnoseInstance(rolloverActor, 7)).resolves.toEqual({
      success: false,
      error: '诊断正在创建中，请稍后重试',
      status: 'in_progress',
    });
    expect(deps.contextCollector.collect).toHaveBeenCalledTimes(1);

    resolveTerminal({ status: 'completed' });
    await vi.advanceTimersByTimeAsync(0);
    await expect(service.diagnoseInstance(rolloverActor, 7)).resolves.toMatchObject({ success: true });
  });

  it('releases the pending lock when analysis explicitly fails', async () => {
    let resolveTerminal!: (value: unknown) => void;
    const failedActor = Object.freeze({ ...actor, userId: 34, requestId: 'failed-completion' });
    const deps = dependencies();
    deps.analysisStore.waitForCompletion.mockImplementationOnce(() => new Promise((resolve) => {
      resolveTerminal = resolve;
    }));
    const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

    await expect(service.diagnoseInstance(failedActor, 7)).resolves.toMatchObject({ success: true });
    resolveTerminal({ status: 'failed' });

    await vi.waitFor(async () => {
      await expect(service.diagnoseInstance(failedActor, 7)).resolves.toMatchObject({ success: true });
    });
    expect(deps.contextCollector.collect).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a completed manual diagnosis across users', async () => {
    const deps = dependencies();
    let completedKey: string | null = null;
    deps.analysisStore.findByCacheKey.mockImplementation(async (cacheKey) => (
      cacheKey === completedKey ? { id: 44, result: { conclusions: ['privileged evidence'] } } as any : null
    ));
    const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

    await expect(service.diagnoseInstance(actor, 7)).resolves.toMatchObject({
      success: true,
      analysisId: 71,
      status: 'queued',
    });
    completedKey = deps.analysisStore.findByCacheKey.mock.calls[0]![0];
    const secondActor = Object.freeze({ ...actor, userId: 4, requestId: 'second-actor' });

    await expect(service.diagnoseInstance(secondActor, 7)).resolves.toMatchObject({
      success: true,
      analysisId: 71,
      status: 'queued',
    });

    const secondKey = deps.analysisStore.findByCacheKey.mock.calls[1]![0];
    expect(secondKey).not.toBe(completedKey);
    expect(deps.analysisStore.createAnalysis).toHaveBeenCalledTimes(2);
    expect(deps.contextCollector.collect).toHaveBeenCalledWith(secondActor, 7);
  });

  describe('typed automatic diagnosis', () => {
    it('diagnoses only unhealthy active instances with a fresh exact least-privilege actor and auto trigger', async () => {
      const deps = dependencies();
      deps.listActiveInstances.mockResolvedValue([{ id: 107 }, { id: 108 }, { id: 109 }, { id: 110 }]);
      deps.checkHealth.mockImplementation(async (instanceId) => {
        if (instanceId === 107) return { status: 'healthy' };
        if (instanceId === 108) return null;
        if (instanceId === 109) return { status: 'warning' };
        return { status: 'critical' };
      });
      deps.randomUUID
        .mockReturnValueOnce('uuid-for-109')
        .mockReturnValueOnce('uuid-for-110');
      deps.contextCollector.collect.mockImplementation(async (_actor, instanceId) => diagnosticContextFor(instanceId));
      deps.analysisStore.createAnalysis
        .mockResolvedValueOnce({ success: true, analysisId: 1091 })
        .mockResolvedValueOnce({ success: true, analysisId: 1101 });
      const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

      await expect(service.diagnoseUnhealthyInstances()).resolves.toEqual([1091, 1101]);

      expect(deps.checkHealth.mock.calls.map(([instanceId]) => instanceId)).toEqual([107, 108, 109, 110]);
      expect(deps.contextCollector.collect).toHaveBeenCalledTimes(2);
      const firstActor = deps.contextCollector.collect.mock.calls[0]![0];
      const secondActor = deps.contextCollector.collect.mock.calls[1]![0];
      expect(firstActor).toEqual({
        userId: 0,
        username: 'slide-fault-diagnosis',
        roles: ['system'],
        permissions: ['instance:view', 'metric:view', 'alert:view', 'log:view', 'servers:view'],
        sessionVersion: 0,
        instanceScopes: { 109: 'read-only' },
        requestId: 'fault-diagnosis:109:uuid-for-109',
      });
      expect(secondActor).toEqual({
        userId: 0,
        username: 'slide-fault-diagnosis',
        roles: ['system'],
        permissions: ['instance:view', 'metric:view', 'alert:view', 'log:view', 'servers:view'],
        sessionVersion: 0,
        instanceScopes: { 110: 'read-only' },
        requestId: 'fault-diagnosis:110:uuid-for-110',
      });
      expect(firstActor).not.toBe(secondActor);
      expect(firstActor.instanceScopes).not.toBe(secondActor.instanceScopes);
      expect(Object.isFrozen(firstActor)).toBe(true);
      expect(Object.isFrozen(firstActor.roles)).toBe(true);
      expect(Object.isFrozen(firstActor.permissions)).toBe(true);
      expect(Object.isFrozen(firstActor.instanceScopes)).toBe(true);
      expect(Object.keys(firstActor).sort()).toEqual([
        'instanceScopes', 'permissions', 'requestId', 'roles', 'sessionVersion', 'userId', 'username',
      ]);
      expect(firstActor.permissions).not.toEqual(expect.arrayContaining([
        '*', 'instance:manage', 'instance:query', 'servers:manage', 'secret:view', 'credential:view',
      ]));

      expect(deps.analysisStore.createAnalysis.mock.calls.map(([data]) => data)).toEqual([
        expect.objectContaining({
          instance_id: 109,
          trigger_type: 'auto',
          cache_key: expect.stringMatching(/^fault:109:.*:auto:user:0:session:0$/),
        }),
        expect.objectContaining({
          instance_id: 110,
          trigger_type: 'auto',
          cache_key: expect.stringMatching(/^fault:110:.*:auto:user:0:session:0$/),
        }),
      ]);
      expect(deps.dispatch.mock.calls.map(([params]) => params)).toEqual([
        expect.objectContaining({ instanceId: 109, triggerType: 'auto' }),
        expect.objectContaining({ instanceId: 110, triggerType: 'auto' }),
      ]);
      for (const [params] of deps.dispatch.mock.calls) {
        expect(params.userMessage).toMatch(/diagnosticContext/);
        expect(params.userMessage).not.toMatch(/query_metrics|get_instance_summary|采集指标|调用其他工具/i);
      }
    });

    it('processes later instances after health, diagnosis, and unsuccessful results then rejects with failed ids', async () => {
      const deps = dependencies();
      deps.listActiveInstances.mockResolvedValue([{ id: 207 }, { id: 208 }, { id: 209 }, { id: 210 }]);
      deps.checkHealth.mockImplementation(async (instanceId) => {
        if (instanceId === 207) throw new Error('HEALTH_FAILED');
        return { status: 'critical' };
      });
      deps.contextCollector.collect.mockImplementation(async (_actor, instanceId) => {
        if (instanceId === 208) throw new Error('COLLECTION_FAILED');
        return diagnosticContextFor(instanceId);
      });
      deps.analysisStore.createAnalysis.mockImplementation(async (data: any) => {
        if (data.instance_id === 209) return { success: false, error: 'CREATE_FAILED' };
        return { success: true, analysisId: 2101 };
      });
      const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

      await expect(service.diagnoseUnhealthyInstances())
        .rejects.toThrow('FAULT_DIAGNOSIS_BATCH_FAILED:207,208,209');

      expect(deps.checkHealth.mock.calls.map(([instanceId]) => instanceId)).toEqual([207, 208, 209, 210]);
      expect(deps.contextCollector.collect.mock.calls.map(([, instanceId]) => instanceId)).toEqual([208, 209, 210]);
      expect(deps.dispatch).toHaveBeenCalledTimes(1);
      expect(deps.dispatch).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 210 }));
    });

    it('skips a pending success when retrying a partially failed batch', async () => {
      const deps = dependencies();
      deps.listActiveInstances.mockResolvedValue([{ id: 307 }, { id: 308 }]);
      deps.checkHealth.mockResolvedValue({ status: 'critical' });
      deps.contextCollector.collect.mockImplementation(async (_actor, instanceId) => diagnosticContextFor(instanceId));
      let instance308CreateCount = 0;
      deps.analysisStore.createAnalysis.mockImplementation(async (data: any) => {
        if (data.instance_id === 307) return { success: true, analysisId: 3071 };
        instance308CreateCount++;
        return { success: true, analysisId: 3080 + instance308CreateCount };
      });
      let instance308DispatchCount = 0;
      deps.dispatch.mockImplementation(async (params: DispatchOrReuseParams) => {
        if (params.instanceId === 308 && instance308DispatchCount++ === 0) {
          throw new Error('INSTANCE_308_DISPATCH_FAILED');
        }
        return { analysisId: params.existingAnalysisId!, cached: false };
      });
      const terminalResolvers = new Map<number, (value: unknown) => void>();
      deps.analysisStore.waitForCompletion.mockImplementation((analysisId: number) => new Promise((resolve) => {
        terminalResolvers.set(analysisId, resolve);
      }));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

      await expect(service.diagnoseUnhealthyInstances())
        .rejects.toThrow('FAULT_DIAGNOSIS_BATCH_FAILED:308');
      await vi.waitFor(() => expect(terminalResolvers.has(3071)).toBe(true));

      const retryOutcome = await service.diagnoseUnhealthyInstances().then(
        (analysisIds) => ({ analysisIds }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      );
      await vi.waitFor(() => expect(terminalResolvers.has(3082)).toBe(true));
      for (const resolve of terminalResolvers.values()) resolve({ status: 'completed' });

      expect(retryOutcome).toEqual({ analysisIds: [3082] });
      expect(deps.contextCollector.collect.mock.calls.filter(([, instanceId]) => instanceId === 307)).toHaveLength(1);
      expect(deps.analysisStore.createAnalysis.mock.calls.filter(([data]) => (
        data as { instance_id?: number }
      ).instance_id === 307)).toHaveLength(1);
      expect(deps.dispatch.mock.calls.filter(([params]) => params.instanceId === 307)).toHaveLength(1);
    });

    it('does not fail a new cron occurrence while its prior diagnosis is pending', async () => {
      const deps = dependencies();
      deps.listActiveInstances.mockResolvedValue([{ id: 407 }]);
      deps.checkHealth.mockResolvedValue({ status: 'critical' });
      deps.contextCollector.collect.mockImplementation(async (_actor, instanceId) => diagnosticContextFor(instanceId));
      deps.analysisStore.createAnalysis.mockResolvedValue({ success: true, analysisId: 4071 });
      let resolveTerminal!: (value: unknown) => void;
      deps.analysisStore.waitForCompletion.mockImplementation(() => new Promise((resolve) => {
        resolveTerminal = resolve;
      }));
      const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

      await expect(service.diagnoseUnhealthyInstances()).resolves.toEqual([4071]);
      await vi.waitFor(() => expect(deps.analysisStore.waitForCompletion).toHaveBeenCalledWith(4071, 120_000));

      const nextOccurrence = await service.diagnoseUnhealthyInstances().then(
        (analysisIds) => ({ analysisIds }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      );
      resolveTerminal({ status: 'completed' });

      expect(nextOccurrence).toEqual({ analysisIds: [] });
      expect(deps.contextCollector.collect).toHaveBeenCalledTimes(1);
      expect(deps.analysisStore.createAnalysis).toHaveBeenCalledTimes(1);
      expect(deps.dispatch).toHaveBeenCalledTimes(1);
    });

    it('returns an empty result without health checks when no active instances exist', async () => {
      const deps = dependencies();
      const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

      await expect(service.diagnoseUnhealthyInstances()).resolves.toEqual([]);

      expect(deps.checkHealth).not.toHaveBeenCalled();
      expect(deps.contextCollector.collect).not.toHaveBeenCalled();
    });

    it('propagates active-instance enumeration failures without checking health', async () => {
      const deps = dependencies();
      deps.listActiveInstances.mockRejectedValue(new Error('ENUMERATION_FAILED'));
      const service = new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies);

      await expect(service.diagnoseUnhealthyInstances()).rejects.toThrow('ENUMERATION_FAILED');

      expect(deps.checkHealth).not.toHaveBeenCalled();
      expect(deps.contextCollector.collect).not.toHaveBeenCalled();
    });
  });

  describe('manual cache key', () => {
    it('is stable for the same actor and security session within one hour', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-25T14:00:00Z'));
      const service = new FaultDiagnosisService(dependencies() as unknown as FaultDiagnosisDependencies);
      const key1 = service['buildCacheKey'](actor, 10, 'manual');
      vi.setSystemTime(new Date('2026-04-25T14:59:59Z'));
      const key2 = service['buildCacheKey'](actor, 10, 'manual');

      expect(key1).toBe('fault:10:2026-04-25T14:manual:user:3:session:1');
      expect(key2).toBe(key1);
    });

    it('changes when the user changes', () => {
      const service = new FaultDiagnosisService(dependencies() as unknown as FaultDiagnosisDependencies);
      const otherUser = Object.freeze({ ...actor, userId: 4 });

      expect(service['buildCacheKey'](actor, 10, 'manual')).not.toBe(service['buildCacheKey'](otherUser, 10, 'manual'));
    });

    it('changes when the actor security session changes', () => {
      const service = new FaultDiagnosisService(dependencies() as unknown as FaultDiagnosisDependencies);
      const nextSession = Object.freeze({ ...actor, sessionVersion: actor.sessionVersion + 1 });

      expect(service['buildCacheKey'](actor, 10, 'manual')).not.toBe(service['buildCacheKey'](nextSession, 10, 'manual'));
    });

    it('separates manual and automatic cache and pending namespaces', () => {
      const service = new FaultDiagnosisService(dependencies() as unknown as FaultDiagnosisDependencies);

      expect(service['buildCacheKey'](actor, 10, 'manual')).toContain(':manual:user:3:session:1');
      expect(service['buildCacheKey'](actor, 10, 'auto')).toContain(':auto:user:3:session:1');
      expect(service['buildPendingKey'](actor, 10, 'manual')).toBe('fault:10:pending:manual:user:3:session:1');
      expect(service['buildPendingKey'](actor, 10, 'auto')).toBe('fault:10:pending:auto:user:3:session:1');
    });
  });
});
