import type { AnyAgentTool, ToolExecutionContext, ToolResult } from '../../types.js';
import { resourceDiagnosticService } from '../../../resources/resource-diagnostic-service.js';
import type { ResourceRef, ResourceType } from '../../../resources/types.js';

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

export const resourceTools = [listResourcesTool, getResourceObservationsTool, getResourceRelationsTool, diagnoseResourceTool];
