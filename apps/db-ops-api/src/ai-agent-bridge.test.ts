import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceDiagnosticContext } from './instance-diagnostic-context-service.js';
import type { ResourceDiagnosticPack } from './resources/resource-diagnostic-service.js';

const { enqueue, invoke, configurationVersion } = vi.hoisted(() => ({ enqueue: vi.fn(), invoke: vi.fn(), configurationVersion: vi.fn(async () => 'config-v1') }));
vi.mock('./analysis/analysis-runtime.js', () => ({ analysisDispatchStore: { enqueue } }));
vi.mock('./analysis/analysis-identity.js', () => ({ analysisConfigurationVersion: configurationVersion, analysisAuthorizationVersion: () => 'actor-v1' }));
vi.mock('./adapter/get-agent-engine.js', () => ({ getAgentEngine: vi.fn(async () => ({ invoke })) }));
vi.mock('./prompts/prompt-manager.js', () => ({ promptManager: { getPrompt: vi.fn(() => null) } }));
import { dispatchOrReuse } from './ai-agent-bridge.js';
const actor = { userId: 7, username: 'operator', roles: [], permissions: ['ai:manage'], sessionVersion: 1, instanceScopes: { 7: 'read-only' as const }, requestId: 'test' };

function faultContext(instanceId = 7, logMessage = 'connection pressure'): InstanceDiagnosticContext {
  return {
    schemaVersion: 1,
    subject: { type: 'instance', id: instanceId },
    collectedAt: '2026-08-10T00:00:00.000Z',
    database: {
      instance: { id: instanceId, name: 'orders', db_type: 'mysql' },
      realtimeMetrics: null,
      metricHistory: [],
      alerts: [],
      logs: [{ message: logMessage }],
      slowQueries: [],
    },
    storage: [],
    hosts: [],
    gaps: [],
  };
}

function resourceContext(): ResourceDiagnosticPack {
  return {
    schemaVersion: 1,
    subject: { type: 'network_device', id: 17 },
    collectedAt: '2026-08-10T00:00:00.000Z',
    resource: { resource: { type: 'network_device', id: 17 }, label: 'edge-17', status: 'online', attributes: {} },
    observations: [], relations: [], alerts: [], relatedEvidence: [], gaps: [], truncated: false,
  };
}

describe('dispatchOrReuse durable admission', () => {
  beforeEach(() => { vi.clearAllMocks(); enqueue.mockResolvedValue({ analysisId: 73, success: true, cached: false, status: 'pending' }); configurationVersion.mockResolvedValue('config-v1'); });
  it('atomically queues a frozen request without invoking the provider in HTTP admission', async () => {
    const result = await dispatchOrReuse({ type: 'fault_diagnosis', instanceId: 7, cacheKey: 'fault:7', sessionKey: 'fault', userMessage: 'analyze', diagnosticContext: faultContext(), actor });
    expect(result).toMatchObject({ analysisId: 73, status: 'pending' }); expect(invoke).not.toHaveBeenCalled();
    const request = enqueue.mock.calls[0][0].request;
    expect(request).toMatchObject({ actor, subject: { type: 'instance', id: 7 }, configVersion: 'config-v1', authorizationVersion: 'actor-v1' });
    expect(request.message).toContain('__ANALYSIS_ID__'); expect(request.message).toContain('connection pressure'); expect(request.message).toContain('不可信证据');
  });
  it.each([undefined, { ...faultContext(), subject: { type: 'server', id: 7 } }, faultContext(8)])('rejects invalid evidence before committing any intent', async diagnosticContext => {
    await expect(dispatchOrReuse({ type: 'fault_diagnosis', instanceId: 7, cacheKey: 'fault:7', sessionKey: 'fault', userMessage: 'analyze', diagnosticContext, actor } as any)).rejects.toThrow(/DIAGNOSTIC_CONTEXT/);
    expect(enqueue).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });
  it('rejects unavailable configuration before creating an orphan analysis', async () => {
    configurationVersion.mockRejectedValue(new Error('LLM_CONFIGURATION_UNAVAILABLE'));
    await expect(dispatchOrReuse({ type: 'fault_diagnosis', instanceId: 7, cacheKey: 'fault:7', sessionKey: 'fault', userMessage: 'analyze', diagnosticContext: faultContext(), actor })).rejects.toThrow('LLM_CONFIGURATION_UNAVAILABLE');
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('freezes network-device subject and actor with explicit unknown retry identity', async () => {
    await dispatchOrReuse({ type: 'resource_diagnosis', resourceType: 'network_device', resourceId: 17, networkDeviceId: 17, cacheKey: 'resource:17', sessionKey: 'resource', userMessage: 'analyze', diagnosticContext: resourceContext(), actor, retryOf: 70 });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ retryOf: 70, analysisType: 'fault_diagnosis', request: expect.objectContaining({ subject: { type: 'network_device', id: 17 } }) }));
  });
  it('requires an actor for manual analysis and honors the dispatch stop switch', async () => {
    const params = { type: 'topsql_analysis', instanceId: 7, cacheKey: 'sql:7', sessionKey: 'sql', userMessage: 'SELECT 1' } as const;
    await expect(dispatchOrReuse(params)).rejects.toThrow('ANALYSIS_ACTOR_REQUIRED');
    vi.stubEnv('ANALYSIS_DISPATCH_ENABLED', 'false');
    try { await expect(dispatchOrReuse({ ...params, actor })).rejects.toThrow('ANALYSIS_DISPATCH_DISABLED'); }
    finally { vi.unstubAllEnvs(); }
    expect(enqueue).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });
});
