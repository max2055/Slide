import type { AnyAgentTool } from './types.js';

export type ToolAudience = 'actor' | 'internal';
export type ToolEffect = 'read' | 'write' | 'execute' | 'secret' | 'delegate';
export type ToolResource = 'none' | 'instance' | 'server' | 'network_device' | 'database-target' | 'network-scan' | 'cron' | 'analysis';
export type ToolApproval = 'never' | 'on-risk' | 'always';
export type ToolNetwork = 'none' | 'registered-database' | 'registered-server' | 'registered-network-device' | 'configured-provider' | 'restricted' | 'internal';
export type ToolCredentialAccess = 'none' | 'use' | 'read';

export interface ToolSecurityDefinition {
  audience: ToolAudience;
  effect: ToolEffect;
  resource: ToolResource;
  permissions: readonly string[];
  approval: ToolApproval;
  network: ToolNetwork;
  credentials: ToolCredentialAccess;
}

/**
 * Operator-owned security posture for every production Agent tool. Tool
 * implementations may add restrictions, but cannot weaken these definitions.
 */
const TOOL_SECURITY_CATALOG: Readonly<Record<string, ToolSecurityDefinition>> = Object.freeze({
  slide_check_status: definition('actor', 'execute', 'none', ['config:view'], 'on-risk', 'configured-provider', 'use'),
  slide_add_database: definition('actor', 'write', 'database-target', ['instance:create'], 'always', 'registered-database', 'use'),
  slide_add_database_batch: definition('actor', 'write', 'database-target', ['instance:create'], 'always', 'registered-database', 'use'),
  slide_add_network_device: definition('actor', 'write', 'network_device', ['network_devices:manage'], 'always', 'none', 'none'),
  slide_test_connection: definition('actor', 'execute', 'database-target', ['instance:view'], 'always', 'registered-database', 'use'),
  slide_update_db_config: definition('actor', 'write', 'instance', ['instance:update'], 'always', 'registered-database', 'use'),
  slide_complete_analysis: definition('internal', 'write', 'analysis', [], 'never', 'none', 'none'),
  list_database_instances: definition('actor', 'read', 'instance', ['instance:view'], 'never', 'none', 'none'),
  get_instance_connection: definition('actor', 'secret', 'instance', ['instance:view'], 'always', 'none', 'use'),
  list_server_instances: definition('actor', 'read', 'server', ['servers:view'], 'never', 'registered-server', 'use'),
  get_server_metrics: definition('actor', 'read', 'server', ['servers:view'], 'never', 'registered-server', 'use'),
  get_server_alerts: definition('actor', 'read', 'server', ['servers:view'], 'never', 'registered-server', 'use'),
  analyze_server_health: definition('actor', 'read', 'server', ['servers:view'], 'never', 'registered-server', 'use'),
  get_server_diagnostics: definition('actor', 'read', 'server', ['servers:view'], 'never', 'registered-server', 'use'),
  list_resources: definition('actor', 'read', 'none', [], 'never', 'none', 'none'),
  get_resource_observations: definition('actor', 'read', 'none', [], 'never', 'none', 'none'),
  get_resource_relations: definition('actor', 'read', 'none', [], 'never', 'none', 'none'),
  diagnose_resource: definition('actor', 'read', 'none', [], 'never', 'none', 'none'),
  slide_oracle_ash_report: definition('actor', 'read', 'instance', ['instance:view'], 'never', 'registered-database', 'use'),
  slide_oracle_awr_report: definition('actor', 'read', 'instance', ['instance:view'], 'never', 'registered-database', 'use'),
  slide_oracle_tablespace_detail: definition('actor', 'read', 'instance', ['instance:view'], 'never', 'registered-database', 'use'),
  get_instance_summary: definition('actor', 'read', 'instance', ['instance:view'], 'never', 'none', 'none'),
  list_active_alerts: definition('actor', 'read', 'instance', ['alert:view'], 'never', 'none', 'none'),
  query_metrics: definition('actor', 'read', 'instance', ['metric:view'], 'never', 'none', 'none'),
  slide_complete_cron: definition('internal', 'write', 'cron', [], 'never', 'none', 'none'),
  spawn_subagent: definition('actor', 'delegate', 'none', ['config:manage'], 'never', 'internal', 'none'),
  access_subagent: definition('actor', 'delegate', 'none', ['config:manage'], 'never', 'internal', 'none'),
  execute_code: definition('actor', 'execute', 'none', ['ai:execute'], 'always', 'none', 'none'),
  discover_database_endpoints: definition('actor', 'execute', 'network-scan', ['network:discover'], 'always', 'restricted', 'none'),
});

function definition(
  audience: ToolAudience,
  effect: ToolEffect,
  resource: ToolResource,
  permissions: string[],
  approval: ToolApproval,
  network: ToolNetwork,
  credentials: ToolCredentialAccess,
): ToolSecurityDefinition {
  return Object.freeze({
    audience,
    effect,
    resource,
    permissions: Object.freeze([...permissions]),
    approval,
    network,
    credentials,
  });
}

export function getToolSecurityDefinition(toolName: string): ToolSecurityDefinition | undefined {
  return TOOL_SECURITY_CATALOG[toolName];
}

export function assertToolSecurityCatalogCoverage(tools: readonly AnyAgentTool[]): void {
  const missing = [...new Set(
    tools
      .map((tool) => tool.name)
      .filter((name) => !getToolSecurityDefinition(name)),
  )].sort();

  if (missing.length > 0) {
    throw new Error(`Agent tools missing operator-owned security metadata: ${missing.join(', ')}`);
  }
}

export function isActorFacingTool(toolName: string): boolean {
  return getToolSecurityDefinition(toolName)?.audience === 'actor';
}

export function isDeclarativelyReadOnlyTool(toolName: string): boolean {
  return getToolSecurityDefinition(toolName)?.effect === 'read';
}
