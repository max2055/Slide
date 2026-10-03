import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../auth/actor-context.js';
import type { ResourceDiagnosticPack } from './resource-diagnostic-service.js';
import { ResourceAgentDiagnosisService } from './resource-agent-diagnosis-service.js';

const actor: ActorContext = Object.freeze({
  userId: 1, username: 'operator', roles: Object.freeze(['admin']), permissions: Object.freeze(['*']),
  sessionVersion: 1, instanceScopes: Object.freeze({}), requestId: 'resource-agent-test',
});

const evidence: ResourceDiagnosticPack = {
  schemaVersion: 1,
  subject: { type: 'network_device', id: 17 },
  collectedAt: '2026-08-26T00:00:00.000Z',
  resource: { resource: { type: 'network_device', id: 17 }, label: 'edge-17', status: 'online', attributes: {} },
  observations: [], relations: [], alerts: [], relatedEvidence: [], gaps: [], truncated: false,
};

describe('ResourceAgentDiagnosisService', () => {
  it('collects permission-filtered evidence before durable admission without precreating a row', async () => {
    const dispatch = vi.fn(async (_params: unknown) => ({ analysisId: 91, cached: false }));
    const collect = vi.fn(async () => evidence);
    const service = new ResourceAgentDiagnosisService({ evidence: { diagnose: collect }, dispatch, now: () => new Date('2026-08-26T00:01:00.000Z') });
    expect(await service.diagnose(actor, { type: 'network_device', id: 17 })).toEqual({ success: true, analysisId: 91, status: 'queued' });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ actor, type: 'resource_diagnosis', resourceType: 'network_device', networkDeviceId: 17, diagnosticContext: evidence }));
    expect(dispatch.mock.calls[0][0]).not.toHaveProperty('existingAnalysisId');
    expect(collect.mock.invocationCallOrder[0]).toBeLessThan(dispatch.mock.invocationCallOrder[0]);
  });
  it.each(['instance', 'server', 'network_device'] as const)('reads true status for %s and rejects mismatched subjects and permission snapshots', async type => {
    let record: any;
    const dispatch = vi.fn(async (params: any) => { record = { id: 91, cache_key: params.cacheKey, instance_id: params.instanceId, server_id: params.serverId, network_device_id: params.networkDeviceId, status: 'unknown', result: null }; return { analysisId: 91, cached: false, success: false, status: 'unknown' }; });
    const service = new ResourceAgentDiagnosisService({ evidence: { diagnose: vi.fn(async () => evidence) }, dispatch, now: () => new Date(), readAnalysis: async () => record });
    expect(await service.diagnose(actor, { type, id: 17 })).toMatchObject({ success: false, status: 'unknown' });
    expect(await service.result(actor, { type, id: 17 }, 91)).toMatchObject({ analysisId: 91, status: 'unknown', error: expect.stringContaining('再次计费') });
    await expect(service.result(actor, { type, id: 18 }, 91)).rejects.toThrow('RESOURCE_NOT_FOUND');
    await expect(service.result({ ...actor, userId: 2 }, { type, id: 17 }, 91)).rejects.toThrow('RESOURCE_NOT_FOUND');
    await expect(service.result({ ...actor, permissions: [], instanceScopes: {} }, { type, id: 17 }, 91)).rejects.toThrow('RESOURCE_FORBIDDEN');
    await service.diagnose(actor, { type, id: 17 }, 91); expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ retryOf: 91 }));
  });
});
