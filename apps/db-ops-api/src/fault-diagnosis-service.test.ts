import { afterEach, describe, expect, it, vi } from 'vitest';
import { FaultDiagnosisService, type FaultDiagnosisDependencies } from './fault-diagnosis-service.js';
import type { ActorContext } from './auth/actor-context.js';
const actor: ActorContext = { userId: 7, username: 'operator', roles: [], permissions: ['ai:manage', 'instance:view'], sessionVersion: 1, instanceScopes: { 42: 'read-only' }, requestId: 'test' };
const evidence = { schemaVersion: 1, subject: { type: 'instance', id: 42 }, database: { instance: { name: 'orders' } } };
function fixture() {
  const deps = { listActiveInstances: vi.fn(async () => [{ id: 42 }]), checkHealth: vi.fn(async () => ({ status: 'critical' })), randomUUID: () => 'test',
    contextCollector: { collect: vi.fn(async () => evidence) }, analysisStore: { getAnalysisList: vi.fn(), getAnalysisStats: vi.fn() },
    dispatch: vi.fn(async (_params: unknown) => ({ analysisId: 73, cached: false, success: true, status: 'pending' })),
  };
  return { deps, service: new FaultDiagnosisService(deps as unknown as FaultDiagnosisDependencies) };
}
afterEach(() => vi.restoreAllMocks());
describe('fault diagnosis durable admission', () => {
  it('collects under the actor before atomically admitting evidence and dispatch', async () => {
    const { deps, service } = fixture();
    expect(await service.diagnoseInstance(actor, 42)).toEqual({ success: true, analysisId: 73, status: 'queued' });
    expect(deps.contextCollector.collect).toHaveBeenCalledWith(actor, 42);
    expect(deps.dispatch).toHaveBeenCalledWith(expect.objectContaining({ actor, diagnosticContext: evidence, instanceId: 42, triggerType: 'manual' }));
    expect(deps.contextCollector.collect.mock.invocationCallOrder[0]).toBeLessThan(deps.dispatch.mock.invocationCallOrder[0]);
    expect(deps.dispatch.mock.calls[0][0]).not.toHaveProperty('existingAnalysisId');
  });
  it('rejects permission/evidence failures before creating a durable intent', async () => {
    const { deps, service } = fixture(); deps.contextCollector.collect.mockRejectedValue(new Error('RESOURCE_FORBIDDEN'));
    await expect(service.diagnoseInstance(actor, 42)).rejects.toThrow('RESOURCE_FORBIDDEN'); expect(deps.dispatch).not.toHaveBeenCalled();
  });
  it('does not retain an in-memory active lock across calls or failed observations', async () => {
    const { deps, service } = fixture();
    deps.dispatch.mockResolvedValueOnce({ analysisId: 73, cached: false, success: false, status: 'unknown' });
    expect(await service.diagnoseInstance(actor, 42)).toMatchObject({ analysisId: 73, status: 'unknown', success: false });
    expect(await service.diagnoseInstance(actor, 42, 73)).toMatchObject({ success: true, analysisId: 73 });
    expect(deps.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ retryOf: 73 }));
    expect(deps.contextCollector.collect).toHaveBeenCalledTimes(2);
  });
  it('routes unhealthy maintenance through system-scoped durable admission and skips healthy instances', async () => {
    const { deps, service } = fixture(); expect(await service.diagnoseUnhealthyInstances()).toEqual([73]);
    expect(deps.dispatch).toHaveBeenCalledWith(expect.objectContaining({ triggerType: 'auto', actor: expect.objectContaining({ userId: 0, instanceScopes: { 42: 'read-only' } }) }));
    deps.checkHealth.mockResolvedValue({ status: 'healthy' }); expect(await service.diagnoseUnhealthyInstances()).toEqual([]);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
  });
  it('does not create a new paid job for unknown automatic analyses', async () => {
    const { deps, service } = fixture(); deps.dispatch.mockResolvedValue({ analysisId: 73, cached: false, success: false, status: 'unknown' });
    await expect(service.diagnoseUnhealthyInstances()).rejects.toThrow('FAULT_DIAGNOSIS_BATCH_FAILED:42');
  });
  it('does not start another step after cancellation', async () => {
    const { workflowExecution } = await import('./workflows/execution-context.js'); const { deps, service } = fixture();
    const controller = new AbortController(); deps.listActiveInstances.mockImplementation(async () => { controller.abort(new Error('WORKFLOW_LEASE_LOST')); return [{ id: 42 }]; });
    await expect(workflowExecution.run({ signal: controller.signal, workerId: 'a', fencingToken: 1 }, () => service.diagnoseUnhealthyInstances())).rejects.toThrow('WORKFLOW_LEASE_LOST');
    expect(deps.checkHealth).not.toHaveBeenCalled(); expect(deps.dispatch).not.toHaveBeenCalled();
  });
});
