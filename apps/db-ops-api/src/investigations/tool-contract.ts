import type { ToolSchema } from '@slide/agent-core';
import { getToolSecurityDefinition } from '../tools/security-catalog.js';

const opsDescriptions: Record<string, string> = {
  get_instance_summary: 'Scoped database metadata/health.',
  get_resource_observations: 'Legacy snapshots: select explicit metricIds (<=32) and limit for a complete bounded page; unselected pages readable <=4. All fields/gaps retained if it fits, otherwise whole page omitted. Returned IDs can be selected directly in query_metrics; use discover+one ID for definition and history for units/window/dimensions, not guessed aliases.',
  get_resource_relations: 'Resource relations.',
  get_server_alerts: 'Server alerts; activeOnly=true.',
  get_server_metrics: 'Legacy latest/history, readable maxRows=1. metricName is NOT a semantic ID; prefer query_metrics discover on this server, then one returned metric_ids. Never guess aliases.',
  list_active_alerts: 'Active database alerts; severity/since(ISO) optional.',
  query_metrics: 'For EACH database/server: discover (discovery_limit=8), select IDs by meaning/unit/kind; follow next_offset, restart on revision change. discover+one metric_ids: definition. Read exactly one metric_ids; select series_index for multiple dimension series. UTC from/to(exclusive) preserves the requested window. One series with up to 60 minute buckets is readable; metric_window_v1 bucketDefaults apply to every bucket (local fields override), all values/quality/time/sources remain explicit. Follow total_series and cover the full requested window. inventory: attributes.',
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
  }) + '. Missing/unknown is not healthy. evidenceOmitted/valuesProvided=false: no original values in THIS projection; never infer health or cause. An outer valuesProvided=true can carry an omitted projection: inspect its evidenceOmitted flag. Earlier original reads, current original values, summary planning memory and hash-only references are distinct; current omission does not mean the entire run never read values. Summaries cannot supply missing original values for calculations. Use schema parameters only. Canonical references never authorize replay.';
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
