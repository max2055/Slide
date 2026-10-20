import type { ToolSchema } from '@slide/agent-core';
import { getToolSecurityDefinition } from '../tools/security-catalog.js';

/** A provider-only projection. Execution still resolves and authorizes every
 * argument against the live actor and the immutable request ceiling. */
export function investigationToolContract(tool: ToolSchema,
  resources: readonly { type: string; id: number }[], budget: { maxWindowMs: number; maxRows: number }): ToolSchema | null {
  const parameters = structuredClone(tool.parameters), p = parameters.properties;
  const required = new Set(parameters.required ?? []);
  const security = getToolSecurityDefinition(tool.name);
  if (tool.name === 'search_case_references') return resources.length ? { ...tool,
    description: `${tool.description} 仅搜索完整范围均包含在本调查 ${JSON.stringify(resources)} 内的案例；参考不授予任何执行权限。` } : null;
  const cross = ['query_metrics', 'get_resource_observations', 'get_resource_relations'].includes(tool.name);
  const candidates = cross && security?.resource === 'none' ? resources : resources.filter(r => r.type === security?.resource);
  if (!candidates.length) return null;
  if (cross) {
    // Correlated alternatives prevent the model from pairing another type's ID.
    delete p.instance_id;
    p.resourceType = { type: 'string', enum: [...new Set(candidates.map(r => r.type))] };
    p.resourceId = { type: 'number', enum: [...new Set(candidates.map(r => r.id))] };
    Object.assign(parameters, { anyOf: candidates.map(r => ({ properties: {
      resourceType: { const: r.type }, resourceId: { const: r.id },
    } })) });
    required.add('resourceType'); required.add('resourceId');
  } else if (tool.name !== 'list_active_alerts') {
    const key = security?.resource === 'server' ? 'serverId' : 'instance_id';
    p[key] = { ...p[key], type: 'number', enum: candidates.map(r => r.id) };
    required.add(key);
  }
  for (const key of ['range', 'period']) if (p[key]) {
    if (budget.maxWindowMs < 3600000) delete p[key];
    else p[key] = { ...p[key], enum: ['1h'] };
  }
  for (const key of ['limit', 'maxRows']) if (p[key])
    p[key] = { ...p[key], type: 'integer', minimum: 1, maximum: Math.min(100, budget.maxRows) };
  parameters.required = [...required];
  return { name: tool.name, parameters, description: `${tool.description} 本调查只允许 ${JSON.stringify(candidates)}；历史窗口最多 ${budget.maxWindowMs}ms，缺失或 unknown 不代表健康。` };
}
