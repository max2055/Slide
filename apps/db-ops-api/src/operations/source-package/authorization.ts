import type { Pool, RowDataPacket } from 'mysql2/promise';
import { ActorContextService } from '../../auth/actor-context.js';
import { InvestigationAuthorization, type InvestigationAuthoritySnapshot } from '../../investigations/authorization.js';
import { AgentSecurityPolicyService, DEFAULT_AGENT_ID } from '../../security/agent-security-policy-service.js';
import { assertSourceDeadline, sourceFailure, type SourcePackage } from './config.js';

export const sourceReadTools = Object.freeze(['get_server_metrics', 'get_server_alerts', 'get_resource_observations', 'get_resource_relations']);

/** Same JWT and live investigation authorizer as HTTP, before acquiring a
 * worker lease or consuming a technical receipt. No admission, model, tool,
 * audit, budget or role mutation. HTTP still reauthorizes in its transaction. */
export async function authorizeSourceContinuation(pool: Pool, config: SourcePackage, token: string, secret: string) {
  assertSourceDeadline(config);
  const connection = await pool.getConnection();
  try {
    await connection.query('START TRANSACTION READ ONLY');
    const contexts = new ActorContextService(() => connection as never);
    const caller = await contexts.authenticateAccessToken(token, secret);
    if ((caller.principalKind ?? 'user') !== 'user' || caller.userId !== config.actorId || caller.sessionVersion !== config.sessionVersion)
      sourceFailure('AUTHORIZATION_REJECTED');
    const policies = new AgentSecurityPolicyService(() => connection as never);
    await policies.initialize();
    if (policies.get(DEFAULT_AGENT_ID).version < 1) sourceFailure('AUTHORIZATION_REJECTED');
    const authorization = new InvestigationAuthorization(contexts, name =>
      policies.evaluateTool(DEFAULT_AGENT_ID, name, 'read', { type: 'server', serverId: config.serverId }).allowed);
    const investigation = await authorization.load(connection as never, config.investigationId!);
    const operator = await authorization.authorize(connection as never, caller, investigation, 'continue');
    // This source lane retains the original automatic service identity and
    // exact one-server investigation; an interactive admin grants no ceiling.
    if (investigation.profileId !== 'ops' || investigation.profileVersion !== 1
      || investigation.owner.kind !== 'service' || investigation.owner.id !== config.serviceActorId
      || investigation.resources.length !== 1 || investigation.resources[0].type !== 'server'
      || investigation.resources[0].id !== config.serverId) sourceFailure('AUTHORIZATION_REJECTED');
    const [requests] = await connection.execute<RowDataPacket[]>(`SELECT actor_kind,actor_id,request_snapshot
      FROM investigation_requests WHERE id=? AND investigation_id=? FOR SHARE`, [config.requestId, config.investigationId]);
    const request = requests[0], prior = typeof request?.request_snapshot === 'string' ? JSON.parse(request.request_snapshot) : request?.request_snapshot;
    const frozen: InvestigationAuthoritySnapshot | undefined = prior?.authority;
    if (requests.length !== 1 || request.actor_kind !== 'service' || Number(request.actor_id) !== config.serviceActorId
      || !frozen || frozen.actor.kind !== 'service' || frozen.actor.id !== config.serviceActorId)
      sourceFailure('AUTHORIZATION_REJECTED');
    const live = await contexts.loadInvestigationActorFrom(connection as never, frozen.actor.id, 'service', frozen.sessionVersion);
    const execution = await authorization.authorize(connection as never, { ...live, permissions: frozen.permissions,
      instanceScopes: frozen.instanceScopes, resourceBoundary: frozen.resourceBoundary }, investigation, 'continue', [], frozen);
    if (execution.tools.length !== sourceReadTools.length || sourceReadTools.some(name => !execution.tools.includes(name)))
      sourceFailure('AUTHORIZATION_REJECTED');
    assertSourceDeadline(config);
    // Roll back even successful reads. The returned summary is evidence only,
    // never reusable authorization; no token/claims/headers enter an audit.
    return { investigationId: investigation.id, version: investigation.version,
      operatorTools: [...operator.tools], execution: authorization.freeze(execution) };
  } catch {
    sourceFailure('AUTHORIZATION_REJECTED');
  } finally {
    try { await connection.rollback(); } finally { connection.release(); }
  }
}
