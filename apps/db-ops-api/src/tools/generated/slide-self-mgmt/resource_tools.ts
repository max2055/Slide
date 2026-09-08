import type { AnyAgentTool, ToolExecutionContext, ToolResult } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { resourceDiagnosticService } from '../../../resources/resource-diagnostic-service.js';
import type { ResourceRef, ResourceType } from '../../../resources/types.js';
import { evidenceService } from '../../../evidence/evidence-service.js';
import { createEvidenceEvaluationTools } from '../../../evidence/evidence-tools.js';

function actorOrError(context?: ToolExecutionContext): ToolResult<never> | null {
  return context?.actor ? null : { success: false, error: '缺少已认证的操作员上下文', errorCode: 'MISSING_ACTOR' };
}

function refFrom(args: Record<string, unknown>): ResourceRef | null {
  const type = args.resourceType;
  const id = args.resourceId;
  if (typeof type !== 'string' || !['instance', 'server', 'network_device'].includes(type)
    || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  return { type: type as ResourceType, id };
}

const invalidRef = (): ToolResult<never> => ({ success: false, error: 'resourceType/resourceId 参数无效', errorCode: 'RESOURCE_INVALID' });

export const listResourcesTool: AnyAgentTool = {
  name: 'list_resources',
  description: '列出当前操作员可见的数据库实例、服务器和华为网络设备资源。只返回脱敏元数据和数据质量状态。',
  parameters: { type: 'object', properties: {} },
  group: 'slide_self_mgmt', readOnly: true,
  handler: async (_args, context) => {
    const missing = actorOrError(context); if (missing) return missing;
    try { return { success: true, data: await resourceDiagnosticService.listResources(context!.actor!) }; }
    catch { return { success: false, error: '资源列表不可用', errorCode: 'RESOURCE_LIST_FAILED' }; }
  },
};

export const getResourceObservationsTool: AnyAgentTool = {
  name: 'get_resource_observations',
  description: '读取指定资源的最新观测，包含采集时间、来源、质量、维度和缺口原因。',
  parameters: {
    type: 'object', properties: {
      resourceType: { type: 'string', enum: ['instance', 'server', 'network_device'] },
      resourceId: { type: 'number' },
      metricIds: { type: 'array', items: { type: 'string' } },
      limit: { type: 'number' },
    }, required: ['resourceType', 'resourceId'],
  },
  group: 'slide_self_mgmt', readOnly: true,
  handler: async (args, context) => {
    const missing = actorOrError(context); if (missing) return missing;
    const ref = refFrom(args); if (!ref) return invalidRef();
    const metricIds = Array.isArray(args.metricIds) ? args.metricIds.filter((id): id is string => typeof id === 'string') : undefined;
    try { return { success: true, data: { resource: ref, observations: await resourceDiagnosticService.getObservations(context!.actor!, ref, { metricIds, limit: typeof args.limit === 'number' ? args.limit : undefined }) } }; }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : '观测不可用', errorCode: 'RESOURCE_OBSERVATIONS_FAILED' }; }
  },
};

export const getResourceRelationsTool: AnyAgentTool = {
  name: 'get_resource_relations',
  description: '读取指定资源与其他数据库、服务器或网络设备的当前有效关系。',
  parameters: { type: 'object', properties: { resourceType: { type: 'string', enum: ['instance', 'server', 'network_device'] }, resourceId: { type: 'number' } }, required: ['resourceType', 'resourceId'] },
  group: 'slide_self_mgmt', readOnly: true,
  handler: async (args, context) => {
    const missing = actorOrError(context); if (missing) return missing;
    const ref = refFrom(args); if (!ref) return invalidRef();
    try { return { success: true, data: { resource: ref, relations: await resourceDiagnosticService.getRelations(context!.actor!, ref) } }; }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : '关系不可用', errorCode: 'RESOURCE_RELATIONS_FAILED' }; }
  },
};

export const diagnoseResourceTool: AnyAgentTool = {
  name: 'diagnose_resource',
  description: '基于当前资源元数据、观测、告警和关系生成有界只读证据包；缺失数据保持未知，不推断为健康。',
  parameters: { type: 'object', properties: { resourceType: { type: 'string', enum: ['instance', 'server', 'network_device'] }, resourceId: { type: 'number' } }, required: ['resourceType', 'resourceId'] },
  group: 'slide_self_mgmt', readOnly: true,
  handler: async (args, context) => {
    const missing = actorOrError(context); if (missing) return missing;
    const ref = refFrom(args); if (!ref) return invalidRef();
    try { return { success: true, data: await resourceDiagnosticService.diagnose(context!.actor!, ref) }; }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : '资源诊断不可用', errorCode: 'RESOURCE_DIAGNOSIS_FAILED' }; }
  },
};

export const getEvidenceBundleTool: AnyAgentTool = {
  name: 'get_evidence_bundle',
  description: '按资源和时间窗读取结构化证据；事实、推断、假设分栏，过期或缺失数据保持显式缺口。',
  parameters: { type: 'object', properties: { resourceType: { type: 'string', enum: ['instance', 'server', 'network_device'] }, resourceId: { type: 'number' }, correlationId: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'number', description: 'Integer from 1 to 100' } }, required: ['resourceType', 'resourceId'] },
  group: 'slide_self_mgmt', readOnly: true,
  handler: async (args, context) => {
    const missing = actorOrError(context); if (missing) return missing;
    const ref = refFrom(args); if (!ref) return invalidRef();
    if (['from', 'to', 'correlationId'].some(key => args[key] !== undefined && typeof args[key] !== 'string') || (args.limit !== undefined && typeof args.limit !== 'number')) return { success: false, error: 'EVIDENCE_QUERY_INVALID' };
    try { return { success: true, data: await evidenceService.getBundle(context!.actor!, ref, { from: args.from as string | undefined, to: args.to as string | undefined, correlationId: args.correlationId as string | undefined, limit: args.limit as number | undefined }) }; }
    catch { return { success: false, error: '证据不可用或无权访问', errorCode: 'EVIDENCE_UNAVAILABLE' }; }
  },
};

export const getEvidenceItemTool: AnyAgentTool = {
  name: 'get_evidence_item', description: '读取当前操作员拥有且当前仍可访问的资源证据。',
  parameters: { type: 'object', properties: { resourceType: { type: 'string', enum: ['instance', 'server', 'network_device'] }, resourceId: { type: 'number' }, evidenceId: { type: 'string', description: '64 lowercase hexadecimal characters' } }, required: ['resourceType', 'resourceId', 'evidenceId'] },
  group: 'slide_self_mgmt', readOnly: true,
  handler: async (args, context) => {
    const missing = actorOrError(context); if (missing) return missing;
    const ref = refFrom(args); if (!ref) return invalidRef();
    if (typeof args.evidenceId !== 'string' || !/^[a-f0-9]{64}$/.test(args.evidenceId)) return { success: false, errorCode: 'EVIDENCE_ID_INVALID', error: '证据 ID 无效' };
    try { const item = await evidenceService.getItem(context!.actor!, ref, args.evidenceId); return item ? { success: true, data: item } : { success: false, errorCode: 'EVIDENCE_NOT_FOUND', error: '证据不存在' }; }
    catch { return { success: false, errorCode: 'EVIDENCE_UNAVAILABLE', error: '证据不可用或无权访问' }; }
  },
};
export const resourceTools = [listResourcesTool, getResourceObservationsTool, getResourceRelationsTool, diagnoseResourceTool, getEvidenceBundleTool, getEvidenceItemTool, ...createEvidenceEvaluationTools()];

// Keep direct module imports equivalent to the other generated tools. The
// central index also calls registerAll(), which is idempotent by tool name.
for (const tool of resourceTools) toolCatalog.register(tool);
