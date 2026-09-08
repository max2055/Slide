import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../../auth/actor-context.js';
import { diagnoseResourceTool, getResourceObservationsTool, listResourcesTool, getEvidenceBundleTool } from './resource_tools.js';
import { resourceDiagnosticService } from '../../../resources/resource-diagnostic-service.js';

const actor: ActorContext = Object.freeze({
  userId: 1, username: 'operator', roles: Object.freeze(['admin']), permissions: Object.freeze(['*']),
  sessionVersion: 1, instanceScopes: Object.freeze({}), requestId: 'tool-test',
});

describe('resource agent tools', () => {
  it('requires a resource for evidence bundles', async () => {
    expect(await getEvidenceBundleTool.handler({}, { actor })).toMatchObject({ success: false, errorCode: 'RESOURCE_INVALID' });
    expect(getEvidenceBundleTool.parameters.required).toEqual(['resourceType', 'resourceId']);
  });
  it('requires an authenticated actor context', async () => {
    const result = await listResourcesTool.handler({}, {});
    expect(result).toMatchObject({ success: false, errorCode: 'MISSING_ACTOR' });
  });

  it('rejects invalid resource identifiers before service access', async () => {
    const spy = vi.spyOn(resourceDiagnosticService, 'getObservations');
    const result = await getResourceObservationsTool.handler({ resourceType: 'network_device', resourceId: 0 }, { actor });
    expect(result).toMatchObject({ success: false, errorCode: 'RESOURCE_INVALID' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('passes a bounded resource reference to the diagnosis service', async () => {
    const spy = vi.spyOn(resourceDiagnosticService, 'diagnose').mockResolvedValue({
      schemaVersion: 1, subject: { type: 'server', id: 4 }, collectedAt: new Date().toISOString(),
      resource: { resource: { type: 'server', id: 4 }, label: 'server-4', status: 'online', attributes: {} },
      observations: [], relations: [], alerts: [], relatedEvidence: [], gaps: [], truncated: false,
    });
    const result = await diagnoseResourceTool.handler({ resourceType: 'server', resourceId: 4 }, { actor });
    expect(result.success).toBe(true);
    expect(spy).toHaveBeenCalledWith(actor, { type: 'server', id: 4 });
    spy.mockRestore();
  });
});
