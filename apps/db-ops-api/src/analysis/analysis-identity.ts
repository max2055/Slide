import type { ActorContext } from '../auth/actor-context.js';
import { actorContextService } from '../auth/actor-context.js';
import { hasPermission } from '../auth/require-permission.js';
import { canReadResource } from '../resources/resource-service.js';
import { llmDatabaseService } from '../llm-database-service.js';
import { resolveSceneModel } from '../llm/scene-routing.js';
import { dbConnection } from '../db-connection.js';
import { analysisHash, type AnalysisRequest } from './analysis-dispatch-store.js';

export function analysisAuthorizationVersion(actor?: ActorContext): string {
  return analysisHash(actor ? [actor.userId, actor.sessionVersion, [...actor.roles].sort(), [...actor.permissions].sort(), Object.entries(actor.instanceScopes).sort(), actor.resourceBoundary ?? null] : ['system']);
}

/** Do not persist credentials, their ciphertext or an endpoint containing credentials. */
export async function analysisConfigurationVersion(purpose: string, prompt: string): Promise<string> {
  const { provider, model } = await resolveSceneModel(llmDatabaseService, purpose, { requiresFunctionCall: true });
  return analysisHash([provider.id, provider.updated_at, model, provider.enabled, provider.api_format,
    analysisHash(provider.api_base_url), provider.context_window, provider.max_tokens, provider.timeout_ms,
    provider.models_supported, prompt, process.env.AGENT_RUN_TIMEOUT_MS ?? null, process.env.AGENT_MAX_ITERATIONS ?? null]);
}

export async function authorizeAnalysisRequest(request: AnalysisRequest): Promise<void> {
  const pool = dbConnection.getPool();
  if (!pool) throw new Error('ANALYSIS_AUTHORITY_UNAVAILABLE');
  const table = request.subject.type === 'instance' ? 'database_instances' : request.subject.type === 'server' ? 'servers' : 'network_devices';
  const [resources] = await pool.execute<any[]>(`SELECT id FROM ${table} WHERE id = ?`, [request.subject.id]);
  if (!resources.length) throw new Error('ANALYSIS_SUBJECT_DELETED');
  if (request.actor && request.actor.userId > 0) {
    const current = await actorContextService.revalidateActor(request.actor).catch(() => { throw new Error('ANALYSIS_AUTHORITY_REVOKED'); });
    // Any reduction or expansion invalidates the frozen evidence permission scope.
    const bounded = { ...current, ...(request.actor.resourceBoundary ? { resourceBoundary: request.actor.resourceBoundary } : {}) };
    if (analysisAuthorizationVersion(bounded) !== request.authorizationVersion
      || !hasPermission(new Set(current.permissions), 'ai:manage') || !canReadResource(bounded, request.subject)) throw new Error('ANALYSIS_AUTHORITY_REVOKED');
  } else {
    // Server-owned maintenance is distinct from a browser actor. Recheck its live switch.
    const [configs] = await pool.execute<any[]>("SELECT config_value FROM system_config WHERE config_key = 'auto_analysis_config'");
    const value = configs[0]?.config_value;
    const config = typeof value === 'string' ? JSON.parse(value) : value;
    if (config?.enabled === false) throw new Error('ANALYSIS_AUTOMATION_DISABLED');
    if (request.actor && (request.actor.userId !== 0 || !request.actor.roles.includes('system'))) throw new Error('ANALYSIS_AUTHORITY_REVOKED');
  }
}
