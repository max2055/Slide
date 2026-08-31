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
  it('collects permission-filtered evidence before dispatching a network-device Agent diagnosis', async () => {
    const dispatch = vi.fn(async () => ({ analysisId: 91, cached: false }));
    const store = {
      findByCacheKey: vi.fn(async () => null),
      createAnalysis: vi.fn(async () => ({ success: true, analysisId: 91 })),
      updateStatus: vi.fn(async () => ({ success: true })),
      markDispatched: vi.fn(async () => true),
    };
    const service = new ResourceAgentDiagnosisService({
      evidence: { diagnose: vi.fn(async () => evidence) },
      analysisStore: store,
      dispatch: dispatch as any,
      now: () => new Date('2026-08-26T00:01:00.000Z'),
    });
    await expect(service.diagnose(actor, { type: 'network_device', id: 17 })).resolves.toEqual({ success: true, analysisId: 91, status: 'queued' });
    expect(store.createAnalysis).toHaveBeenCalledWith(expect.objectContaining({ analysis_type: 'fault_diagnosis', network_device_id: 17 }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource_diagnosis', resourceType: 'network_device', networkDeviceId: 17, diagnosticContext: evidence }));
    expect(store.markDispatched).toHaveBeenCalledWith(91, 'resource-diagnosis-network_device-17-91');
  });
});
