/**
 * MAX-238 / NATIVE-COLLECT-NOW — the user action, its durable task and its
 * exact samples.
 *
 * One `collect` call binds the signed principal, the current published revision
 * and the exact fixed plan/target/credential identity to a caller key, then the
 * same transaction enqueues one `metrics.collect_now` job in the existing
 * workflow queue. Replaying that key returns the same task; reusing it for a
 * different principal, revision or intent is a conflict. The task row is the
 * only journal: the cadence's `metric_schedule` row is read for counter state
 * and never given this job's id.
 */
import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import type { ActorContextService } from '../../auth/actor-context.js';
import type { Pool } from 'mysql2/promise';
import { canManageResource, canReadResource, MysqlResourceRelationStore, type ResourceRelationStore } from '../../resources/resource-service.js';
import { PolicyError, RefSchema, type Ref } from '../policy/model.js';
import type { PackageRegistry } from '../packages/model.js';
import { MysqlScheduleStore, type CollectTask } from '../scheduler/store.js';
import type { CollectNowAuthorizer } from '../scheduler/service.js';

const Body = z.strictObject({
  caller_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  expected_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export interface CollectNowDeps {
  readonly pool: () => Pool | null;
  readonly registry: PackageRegistry;
  /** The accepted session re-read; a revoked session is not the request's actor. */
  readonly reload: (actor: ActorContext) => Promise<ActorContext>;
  readonly reloadOn?: (actor: ActorContext, executor: { execute(sql: string, values?: any[]): Promise<unknown> }) => Promise<ActorContext>;
  readonly relations?: ResourceRelationStore;
}

export interface CollectNowResponse {
  collect: true;
  resource: Ref;
  caller_key: string;
  state: CollectTask['state'] | 'absent';
  task: {
    id: string; job_id: string; state: CollectTask['state']; revision: number;
    resolution_identity: string; outcome: CollectTask['outcome']; error_code: string | null;
    created_at: string; started_at: string | null; finished_at: string | null;
  } | null;
  samples: CollectTask['samples'];
  attempts: CollectTask['attempts'];
}

export const collectTaskResponse = (resource: Ref, callerKey: string, task: CollectTask | null): CollectNowResponse => ({
  collect: true, resource, caller_key: callerKey, state: task ? task.state : 'absent',
  task: task ? {
    id: task.id, job_id: task.job_id, state: task.state, revision: task.revision,
    resolution_identity: task.resolution_identity, outcome: task.outcome, error_code: task.error_code,
    created_at: task.created_at, started_at: task.started_at, finished_at: task.finished_at,
  } : null,
  // Only this task's own committed samples; never the resource's latest observation.
  samples: task?.samples ?? [],
  attempts: task?.attempts ?? [],
});

export class CollectNowService {
  private readonly relations: ResourceRelationStore;

  constructor(private readonly deps: CollectNowDeps) {
    this.relations = deps.relations ?? new MysqlResourceRelationStore();
  }

  private pool(): Pool {
    const pool = this.deps.pool();
    if (!pool) throw new PolicyError('COLLECT_STORE_UNAVAILABLE', 503);
    return pool;
  }

  private store(): MysqlScheduleStore { return new MysqlScheduleStore(this.pool(), this.deps.registry); }

  private async assertAccess(actor: ActorContext, ref: Ref, write: boolean,
    executor?: { execute(sql: string, values?: any[]): Promise<unknown> }): Promise<void> {
    RefSchema.parse(ref);
    if (!(write ? canManageResource(actor, ref) : canReadResource(actor, ref))) {
      throw new PolicyError('COLLECT_FORBIDDEN', 403);
    }
    const exists = executor && this.relations.existsOn
      ? await this.relations.existsOn(executor as never, ref) : await this.relations.exists(ref);
    if (!exists) throw new PolicyError('COLLECT_RESOURCE_NOT_FOUND', 404);
  }

  /**
   * Admit one collection intent. The live grant is re-read on the writer's own
   * connection after the policy lock, so a revocation that landed while the
   * transaction waited refuses the intent instead of queueing work for it.
   */
  async collect(actor: ActorContext, ref: Ref, body: unknown): Promise<CollectNowResponse> {
    await this.assertAccess(actor, ref, true);
    const parsed = Body.safeParse(body);
    if (!parsed.success) throw new PolicyError('COLLECT_INPUT_INVALID', 400);
    const authorize = async (connection: { execute(sql: string, values?: any[]): Promise<unknown> }) => {
      const current = this.deps.reloadOn ? await this.deps.reloadOn(actor, connection) : await this.deps.reload(actor);
      await this.assertAccess(current, ref, true, connection);
    };
    const admitted = await this.store().admitCollectNow({
      ref, actorId: actor.userId, sessionVersion: actor.sessionVersion,
      callerKey: parsed.data.caller_key, expectedRevision: parsed.data.expected_revision,
    }, authorize);
    return collectTaskResponse(ref, parsed.data.caller_key, admitted.task);
  }

  /** The same key's task, under the same live read grant the caller currently holds. */
  async task(actor: ActorContext, ref: Ref, callerKey: string): Promise<CollectNowResponse> {
    await this.assertAccess(actor, ref, false);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callerKey)) throw new PolicyError('COLLECT_INPUT_INVALID', 400);
    const task = await this.store().collectTaskFor(ref, callerKey, actor.userId);
    // A revoke that lands while the row is read must not return its facts.
    await this.assertAccess(await this.deps.reload(actor), ref, false);
    return collectTaskResponse(ref, callerKey, task);
  }
}

/**
 * The worker-side live grant. The task carries only the actor id and session
 * version it was admitted under; this reloads that exact principal (a rotated
 * or disabled session fails) and re-checks the resource relation, on the
 * worker's connection at persistence boundaries.
 */
export function createCollectNowAuthorizer(deps: {
  loadActor: (userId: number, sessionVersion: number) => Promise<ActorContext>;
  loadActorOn?: (executor: { execute(sql: string, values?: any[]): Promise<unknown> },
    userId: number, sessionVersion: number) => Promise<ActorContext>;
  relations?: ResourceRelationStore;
}): CollectNowAuthorizer {
  const relations = deps.relations ?? new MysqlResourceRelationStore();
  const check = (actor: ActorContext, ref: Ref) => {
    if (!canManageResource(actor, ref)) throw new PolicyError('COLLECT_FORBIDDEN', 403);
  };
  return {
    async authorize(actorId, sessionVersion, ref) {
      const actor = await deps.loadActor(actorId, sessionVersion);
      check(actor, ref);
      if (!await relations.exists(ref)) throw new PolicyError('COLLECT_RESOURCE_NOT_FOUND', 404);
    },
    async authorizeOn(executor, actorId, sessionVersion, ref) {
      const actor = deps.loadActorOn
        ? await deps.loadActorOn(executor, actorId, sessionVersion) : await deps.loadActor(actorId, sessionVersion);
      check(actor, ref);
      const exists = relations.existsOn
        ? await relations.existsOn(executor as never, ref) : await relations.exists(ref);
      if (!exists) throw new PolicyError('COLLECT_RESOURCE_NOT_FOUND', 404);
    },
  };
}

/** The production authorizer, wired to the same live session service the routes use. */
export const productionCollectNowAuthorizer = (actorService: ActorContextService): CollectNowAuthorizer =>
  createCollectNowAuthorizer({
    loadActor: (userId, sessionVersion) => actorService.loadActiveActor(userId, sessionVersion),
    loadActorOn: (executor, userId, sessionVersion) =>
      actorService.loadActiveActorOn(executor, userId, sessionVersion),
  });
