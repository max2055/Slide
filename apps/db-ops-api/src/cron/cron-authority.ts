import { randomUUID } from 'node:crypto';
import { actorContextService, type ActorContext } from '../auth/actor-context.js';
import { hasInstanceAccess, hasUnrestrictedInstanceAccess } from '../auth/require-instance-access.js';
import { hasPermission } from '../auth/require-permission.js';
import { dbConnection } from '../db-connection.js';
import type { CronJobConfig } from './types.js';
import type { CronToolAuthority } from '../adapter/get-agent-engine.js';

export const CRON_MAINTENANCE_HANDLERS = new Set([
  'capacity.collect', 'baseline.cleanup', 'report.schedule', 'alert.evaluate',
  'notification.dispatch', 'fault.diagnose-unhealthy',
]);

export function validateCronScope(job: CronJobConfig): NonNullable<CronJobConfig['resource_scope']> {
  const scope = job.resource_scope;
  if (!scope || scope.version !== 1 || ![scope.instanceIds, scope.serverIds, scope.networkDeviceIds].every(ids =>
    Array.isArray(ids) && ids.every(id => Number.isSafeInteger(id) && id > 0))) throw new Error('CRON_RESOURCE_SCOPE_REQUIRED');
  // Current user Cron API delegates only database resources.
  if (scope.targetInstanceId !== job.target_instance_id) throw new Error('CRON_TARGET_CHANGED');
  if (scope.serverIds.length || scope.networkDeviceIds.length) throw new Error('CRON_RESOURCE_SCOPE_DENIED');
  if (job.target_instance_id !== null && !scope.instanceIds.includes(job.target_instance_id)) throw new Error('CRON_TARGET_CHANGED');
  return scope;
}

export async function assertCronActorAccess(actor: ActorContext, job: CronJobConfig): Promise<void> {
  if (!hasPermission(new Set(actor.permissions), 'cron:manage')) throw new Error('CRON_OWNER_PERMISSION_REVOKED');
  if (job.target_instance_id !== null && !hasInstanceAccess(actor, job.target_instance_id,
    job.task_type === 'script' ? 'read-write' : 'read-only')) throw new Error('CRON_TARGET_ACCESS_REVOKED');
  if (job.task_type === 'script' && job.target_instance_id === null && !hasUnrestrictedInstanceAccess(actor)) throw new Error('CRON_CONTROL_ACCESS_REVOKED');
}

export interface CronRunAuthority extends CronToolAuthority {
  readonly audit: Record<string, unknown>;
}

export class CronAuthorityService {
  async authorize(job: CronJobConfig, trigger?: ActorContext): Promise<CronRunAuthority> {
    if (job.principal_type !== 'user' || job.identity_status !== 'bound' || !Number.isSafeInteger(job.owner_user_id)
      || Number(job.owner_user_id) <= 0) throw new Error('CRON_OWNER_REQUIRED');
    const scope = validateCronScope(job);
    // Copy the ceiling: neither a caller nor another job can mutate this run.
    const boundary = Object.freeze({ instanceIds: Object.freeze([...scope.instanceIds]),
      serverIds: Object.freeze([...scope.serverIds]), networkDeviceIds: Object.freeze([...scope.networkDeviceIds]) });
    const requestId = `cron:${job.id}:${randomUUID()}`;
    const load = async () => {
      const owner = await actorContextService.loadActiveActor(Number(job.owner_user_id), undefined, requestId)
        .catch(error => { throw new Error('CRON_OWNER_UNAVAILABLE', { cause: error }); });
      await assertCronActorAccess(owner, job);
      const pool = dbConnection.getPool();
      if (!pool) throw new Error('CRON_AUTHORITY_UNAVAILABLE');
      const [rows] = await pool.execute('SELECT id FROM database_instances WHERE id IN (' +
        (boundary.instanceIds.length ? boundary.instanceIds.map(() => '?').join(',') : 'NULL') + " ) AND lifecycle_state = 'available'", [...boundary.instanceIds]);
      const existingIds = new Set((rows as Array<{ id: number }>).map(row => Number(row.id)));
      if (boundary.instanceIds.some(id => !existingIds.has(id)) || (job.target_instance_id !== null && !existingIds.has(job.target_instance_id))) throw new Error('CRON_TARGET_DELETED');
      const instanceScopes: Record<number, 'read-only'> = {};
      for (const id of boundary.instanceIds) if (existingIds.has(id) && hasInstanceAccess(owner, id)) instanceScopes[id] = 'read-only';
      // The original identity/permissions are retained for audit; resourceBoundary
      // overrides even admin's global access in policy and collection filtering.
      return Object.freeze({ ...owner, instanceScopes: Object.freeze(instanceScopes), resourceBoundary: Object.freeze({ ...boundary, instanceIds: Object.freeze(Object.keys(instanceScopes).map(Number)) }) });
    };
    if (trigger) {
      const current = await actorContextService.revalidateActor(trigger, requestId);
      await assertCronActorAccess(current, job);
      if (boundary.instanceIds.some(id => !hasInstanceAccess(current, id))) throw new Error('CRON_TRIGGER_SCOPE_DENIED');
    }
    const actor = await load();
    return {
      actor,
      refreshActor: async () => {
        // Re-read the persisted task to catch deletion, rebinding, suspension or
        // target changes between calls without enlarging this run's ceiling.
        const { cronJobService } = await import('./cron-job-service.js');
        const current = await cronJobService.getJobById(job.id);
        if (!current || current.owner_user_id !== job.owner_user_id || current.principal_type !== 'user'
          || current.identity_status !== 'bound' || current.enabled !== job.enabled || current.target_instance_id !== job.target_instance_id
          || JSON.stringify(current.resource_scope) !== JSON.stringify(scope)) throw new Error('CRON_AUTHORITY_CHANGED');
        return load();
      },
      audit: { request_id: requestId, principal_type: 'user', owner_user_id: actor.userId,
        triggered_by: trigger?.userId ?? null, resource_scope: scope, actor_session_version: actor.sessionVersion },
    };
  }
}

export const cronAuthorityService = new CronAuthorityService();
