import type { ToolSchema } from '@slide/agent-core';
import { getToolSecurityDefinition } from '../tools/security-catalog.js';
import { MODEL_ANALYSIS_POLICY } from './model-analysis.js';

const opsDescriptions: Record<string, string> = {
  get_instance_summary: 'Read scoped database metadata and health summary.',
  get_resource_observations: 'Read latest observations with time, source, quality, dimensions and gap reasons. Omit metricIds for the default batch; use only IDs returned by tools.',
  get_resource_relations: 'Read current resource relations.',
  get_server_alerts: 'Read server alerts; activeOnly defaults true.',
  get_server_metrics: 'Read latest or bounded historical server metrics with freshness and gaps.',
  list_active_alerts: 'Read active database alerts; optional severity and since (ISO time).',
  query_metrics: 'Realtime without metric_ids returns canonical core metrics. Discover lists extension definitions; inventory returns attributes only. Select IDs from returned definitions. Narrow large results with one metric_ids entry + series_index + paired UTC from/to (to exclusive), one bucket.',
};

/** Shared model policy belongs once in the request, not in every schema.
 * Correlated resource enums stay in each schema; execution rechecks live ACLs.
 */
export function investigationToolPolicy(
  resources: readonly { type: string; id: number }[],
  budget: { maxWindowMs: number; maxRows: number },
): string {
  return '\nAll tools (runtime enforced): ' + JSON.stringify({
    resources: resources.map(({ type, id }) => ({ type, id })),
    maxWindowMs: budget.maxWindowMs, maxRows: budget.maxRows,
  }) + '. Missing/unknown is not healthy. evidenceOmitted: no observation; never infer health or cause from it. Use schema parameters only. Canonical references never authorize replay.' + MODEL_ANALYSIS_POLICY;
}

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
  if (opsDescriptions[tool.name]) {
    // Scope/limits are now executable schema constraints plus shared policy.
    // Legacy property prose can even contradict these constraints ("all instances").
    for (const property of Object.values(p)) delete property.description;
  }
  return { name: tool.name, parameters, description: opsDescriptions[tool.name] ?? tool.description };
}
