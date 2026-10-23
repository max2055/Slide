import type { ToolSchema } from '@slide/agent-core';
import { getToolSecurityDefinition } from '../tools/security-catalog.js';

const opsDescriptions: Record<string, string> = {
  get_instance_summary: 'Scoped database metadata/health.',
  get_resource_observations: 'Legacy snapshots: select metricIds<=32 + limit for complete bounded pages (unselected<=4). query_metrics: returned ID + history; discover+ID for semantics.',
  get_resource_relations: 'Resource relations.',
  get_server_alerts: 'Server alerts; activeOnly=true.',
  get_server_metrics: 'Legacy latest/history, readable maxRows=1. metricName is NOT a semantic ID; prefer query_metrics discover on this server, then one returned metric_ids. Never guess aliases.',
  list_active_alerts: 'Active database alerts; severity/since(ISO) optional.',
  query_metrics: 'Select one returned/discovered metric_ids per resource. discover(discovery_limit=8): index, next_offset, restart on revision change; discover+ID: definition/unit/kind. history: UTC from/to(exclusive), interval:1m, <=1h/60 buckets. Inspect dimensions/total_series before selecting one series_index; cover all series/windows, pair metrics by full dimensions. metric_window_v1 bucketDefaults apply per bucket; local fields override, values/quality/time/sources stay explicit. inventory: attributes.',
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
  }) + '. Missing/unknown is not healthy. evidenceOmitted: no CURRENT values (outer valuesProvided may be true); never infer health or cause from it. Prior reads differ; summaries/hashes are not originals. Schema only; references never authorize replay.';
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
  const candidates = cross && security?.resource === 'none' ? resources : resources.filter(r =>
    security?.resourceTypes ? security.resourceTypes.some(type => type === r.type) : r.type === security?.resource);
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
  if (tool.name === 'query_metrics') p.metric_ids = { ...p.metric_ids, minItems: 1, maxItems: 1 };
  parameters.required = [...required];
  if (opsDescriptions[tool.name]) {
    // Scope/limits are now executable schema constraints plus shared policy.
    // Legacy property prose can even contradict these constraints ("all instances").
    for (const property of Object.values(p)) delete property.description;
  }
  return { name: tool.name, parameters, description: opsDescriptions[tool.name] ?? tool.description };
}
