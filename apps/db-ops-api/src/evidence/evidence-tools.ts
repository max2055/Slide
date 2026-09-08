import type { AnyAgentTool } from '../tools/types.js';
import type { ActorContext } from '../auth/actor-context.js';
import type { ResourceRef } from '../resources/types.js';
import { evidenceEvaluationService } from './evidence-evaluation.js';
interface EvaluationTools {
  evaluate(actor: ActorContext, ref: ResourceRef): Promise<unknown>;
  recordDecision(actor: ActorContext, ref: ResourceRef, input: unknown): Promise<unknown>;
  recovery(actor: ActorContext, ref: ResourceRef, operationId: string): Promise<unknown>;
}
export function createEvidenceEvaluationTools(service: EvaluationTools = evidenceEvaluationService): AnyAgentTool[] {
  return (['evaluate_evidence', 'record_evidence_decision', 'verify_operation_recovery'] as const).map(name => ({
    name, description: name === 'evaluate_evidence' ? 'Evaluate configured invariants and statistical expectations using authorized observations; unknown remains explicit.' : name === 'record_evidence_decision' ? 'Persist an inference or hypothesis linked to owned resource evidence. Does not execute operational changes.' : 'Check an owned operation for independently verifiable recovery. Success alone never proves recovery.',
    group: 'slide_self_mgmt', readOnly: name !== 'record_evidence_decision', requiresApproval: false,
    parameters: { type: 'object', properties: { resourceType: { type: 'string', enum: ['instance', 'server', 'network_device'] }, resourceId: { type: 'number' }, ...(name === 'record_evidence_decision' ? { statement: { type: 'string' as const }, status: { type: 'string' as const, enum: ['inference', 'hypothesis'] }, evidenceRefs: { type: 'array' as const, items: { type: 'string' as const } }, from: { type: 'string' as const }, to: { type: 'string' as const } } : name === 'verify_operation_recovery' ? { operationId: { type: 'string' as const } } : {}) }, required: ['resourceType', 'resourceId', ...(name === 'record_evidence_decision' ? ['statement', 'status', 'evidenceRefs', 'from', 'to'] : name === 'verify_operation_recovery' ? ['operationId'] : [])] },
    handler: async (args, context) => {
      if (!context?.actor) return { success: false, errorCode: 'MISSING_ACTOR', error: 'Authenticated actor required' };
      if (!['instance', 'server', 'network_device'].includes(String(args.resourceType)) || !Number.isSafeInteger(args.resourceId) || Number(args.resourceId) < 1) return { success: false, errorCode: 'RESOURCE_REF_INVALID', error: 'Invalid resource' };
      const ref = { type: args.resourceType, id: args.resourceId } as ResourceRef;
      try {
        const data = name === 'evaluate_evidence' ? await service.evaluate(context.actor, ref)
          : name === 'record_evidence_decision' ? await service.recordDecision(context.actor, ref, { statement: args.statement, status: args.status, evidenceRefs: args.evidenceRefs, from: args.from, to: args.to })
            : await service.recovery(context.actor, ref, typeof args.operationId === 'string' ? args.operationId : '');
        return { success: true, data };
      } catch { return { success: false, errorCode: 'EVIDENCE_UNAVAILABLE', error: 'Evidence operation unavailable or unauthorized' }; }
    },
  }));
}
