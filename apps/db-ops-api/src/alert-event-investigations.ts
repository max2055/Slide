import { Value } from '@sinclair/typebox/value';
import { rejectedAnalysisCode, rejectedAnalysisPrefix } from './investigations/execution-summary.js';
import type { PoolConnection } from 'mysql2/promise';
import { actorContextService, type ActorContext } from './auth/actor-context.js';
import { hasPermission } from './auth/require-permission.js';
import type { EventInvestigationItem, LinkedEventInvestigation } from './contracts/event-investigation.js';
import { dbConnection } from './db-connection.js';
import { freezeInvestigationCaller, InvestigationAuthorization, type AuthorityExecutor } from './investigations/authorization.js';
import { InvestigationResultSchema, validateInvestigationResult } from './investigations/contracts.js';
import { decode, observationRows } from './investigations/observation-db.js';
import { InvestigationResultStore, resultEvidenceIds } from './investigations/result-schema.js';
import { InvestigationStoreError } from './investigations/store.js';

const authorization = new InvestigationAuthorization(actorContextService);
const results = new InvestigationResultStore(undefined, authorization);

interface EventIdentity { id: number; instance_id: number | null; episode: unknown; }
type EventAccess = (actor: ActorContext, event: EventIdentity) => boolean;
type EventConnection = PoolConnection & AuthorityExecutor;

export class EventInvestigationAccessError extends Error {}

function has(actor: ActorContext, permission: string) {
  return hasPermission(new Set(actor.permissions), permission);
}

async function eventIdentities(c: PoolConnection, ids: readonly number[]): Promise<EventIdentity[]> {
  const rows = await observationRows(c, `SELECT e.id, e.instance_id, p.payload AS episode
    FROM alert_events e LEFT JOIN metric_trigger_episodes p ON p.event_id = e.id
    WHERE e.id IN (${ids.map(() => '?').join(',')})`, [...ids]);
  return rows.map(row => ({ id: Number(row.id), instance_id: row.instance_id, episode: row.episode }));
}

async function linkedCandidates(c: PoolConnection, caller: ActorContext, ids: readonly number[]) {
  const placeholders = ids.map(() => '?').join(',');
  const kind = caller.principalKind ?? 'user';
  // The owner/member predicate limits discovery. Content authorization below is
  // the authority for visibility, including additional and historical resources.
  return observationRows(c, `WITH visible AS (
      SELECT id FROM investigations WHERE owner_kind = ? AND owner_id = ?
      UNION DISTINCT
      SELECT investigation_id FROM investigation_members WHERE ? = 'user' AND user_id = ?
        AND (expires_at IS NULL OR expires_at > NOW())
    )
    SELECT links.event_id, i.id AS investigation_id
    FROM investigations i
    JOIN (
      SELECT e.id AS event_id, k.investigation_id
      FROM visible v JOIN investigation_create_keys k ON k.investigation_id = v.id
      JOIN alert_events e ON e.id IN (${placeholders})
        AND e.id MEMBER OF (JSON_EXTRACT(k.command_snapshot, '$.context.entry.sourceEventIds'))
      UNION DISTINCT
      SELECT m.event_id, o.investigation_id
      FROM alert_event_members m JOIN investigation_alert_owners o ON o.alert_id = m.alert_id
      JOIN visible v ON v.id = o.investigation_id
      WHERE m.event_id IN (${placeholders}) AND o.lane = 'investigation'
        AND JSON_UNQUOTE(JSON_EXTRACT(o.command_snapshot, '$.trigger')) = 'auto'
    ) links ON links.investigation_id = i.id
    ORDER BY links.event_id, i.updated_at DESC, i.id DESC`, [kind, caller.userId, kind, caller.userId, ...ids, ...ids]);
}

async function readableAtCompletion(c: PoolConnection, caller: ActorContext, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const kind = caller.principalKind ?? 'user';
  // A shared lock prevents membership changes, but its expiry can still pass
  // while the remaining items in a batch are being read.
  const rows = await observationRows(c, `SELECT i.id FROM investigations i
    WHERE i.id IN (${ids.map(() => '?').join(',')}) AND (
      (i.owner_kind = ? AND i.owner_id = ?) OR (? = 'user' AND EXISTS (
        SELECT 1 FROM investigation_members im WHERE im.investigation_id = i.id AND im.user_id = ?
          AND (im.expires_at IS NULL OR im.expires_at > NOW())
      ))
    )`, [...ids, kind, caller.userId, kind, caller.userId]);
  return new Set(rows.map(row => String(row.id)));
}

type ProjectionState = NonNullable<LinkedEventInvestigation>['state'];
function projectionState(requestId: string | null, run: string | null, job: string | null, hasResultEvidence: boolean): ProjectionState {
  if (!requestId) return 'not_started';
  if (run === 'running' || !run && job && ['queued', 'running', 'retry'].includes(job)) return 'running';
  if (run && ['failed', 'cancelled', 'timed_out'].includes(run) || !run && job && ['dead_letter', 'cancelled'].includes(job)) return 'failed';
  return (!run || run === 'completed') && hasResultEvidence ? 'completed' : 'insufficient';
}

async function readProjection(c: EventConnection, caller: ActorContext, id: string): Promise<LinkedEventInvestigation> {
  try {
    const record = await authorization.load(c, id);
    await authorization.authorize(c, caller, record, 'content');
    const [head] = await observationRows(c, `SELECT i.title, i.updated_at, q.id AS request_id,
      q.job_id, ar.state AS run_state
      FROM investigations i LEFT JOIN investigation_requests q ON q.id = (
        SELECT id FROM investigation_requests WHERE investigation_id = i.id ORDER BY accepted_version DESC, id DESC LIMIT 1
      )
      LEFT JOIN agent_runs ar ON ar.session_id = i.session_id AND ar.actor_id = q.actor_id
        AND ar.message_id = q.message_id
        AND CAST(ar.idempotency_key AS BINARY) = CAST(CONCAT('investigation:', q.id) AS BINARY)
      WHERE i.id = ?`, [id]);
    // Legacy workflow tables inherit the database collation. Look up the
    // exact job with a bound key to keep that primary-key read portable.
    const [job] = head.job_id && !head.run_state
      ? await observationRows(c, 'SELECT state FROM workflow_jobs WHERE id = ?', [head.job_id]) : [];
    const [row] = head.request_id ? await observationRows(c, `SELECT version, result_json, run_id
      FROM investigation_results WHERE investigation_id = ? AND request_id = ? ORDER BY version DESC LIMIT 1 FOR SHARE`,
    [id, head.request_id]) : [];
    const stored = row ? decode(row.result_json) : null;
    const refs = Value.Check(InvestigationResultSchema, stored) ? resultEvidenceIds(stored) : [];
    const valid = row ? validateInvestigationResult(stored, await results.authorizedBindings(c, caller, record,
      { investigationId: id, requestId: head.request_id, runId: row.run_id }, refs)) : null;
    const result = valid?.ok ? valid.value : null;
    const analysisRejected = result?.execution?.reasonCode === rejectedAnalysisCode || result?.summary.startsWith(rejectedAnalysisPrefix);
    return {
      id, title: head.title,
      state: projectionState(head.request_id, head.run_state ?? result?.execution?.state ?? null, job?.state ?? null,
        !!result && refs.length > 0 && !analysisRejected),
      conclusion: result?.summary ?? null,
      recommendation: result?.recommendations[0]?.action ?? null,
      updatedAt: new Date(head.updated_at).toISOString(), version: result ? Number(row.version) : null,
    };
  } catch (error) {
    if (error instanceof InvestigationStoreError && [403, 404].includes(error.statusCode)) return null;
    throw error;
  }
}

export async function readEventInvestigations(actor: ActorContext, ids: readonly number[], canRead: EventAccess): Promise<EventInvestigationItem[]> {
  const caller = freezeInvestigationCaller(actor);
  const pool = dbConnection.getPool();
  if (!pool) throw new Error('EVENT_STORE_UNAVAILABLE');
  const c = await pool.getConnection() as EventConnection;
  let begun = false;
  try {
    await c.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await c.beginTransaction();
    begun = true;
    const initial = await actorContextService.revalidateActorOn(c, caller, caller.requestId);
    if (![caller, initial].every(value => has(value, 'alert:view'))) throw new EventInvestigationAccessError();
    const events = (await eventIdentities(c, ids)).filter(event => canRead(caller, event) && canRead(initial, event));
    const projections = new Map<number, NonNullable<LinkedEventInvestigation>>();
    if (events.length && [caller, initial].every(value => has(value, 'chat:view'))) {
      const candidates = await linkedCandidates(c, caller, events.map(event => event.id));
      const byInvestigation = new Map<string, LinkedEventInvestigation>();
      for (const row of candidates) {
        const eventId = Number(row.event_id), id = String(row.investigation_id);
        if (projections.has(eventId)) continue;
        if (!byInvestigation.has(id)) byInvestigation.set(id, await readProjection(c, caller, id));
        const projection = byInvestigation.get(id);
        if (projection) projections.set(eventId, projection);
      }
    }
    // Content and evidence checks above hold shared authority locks. Re-read
    // live event grants and identities before releasing this same connection.
    const final = await actorContextService.revalidateActorOn(c, caller, caller.requestId, true);
    if (!has(final, 'alert:view') || has(initial, 'chat:view') && !has(final, 'chat:view'))
      throw new EventInvestigationAccessError();
    const visible = events.length ? new Set((await eventIdentities(c, events.map(event => event.id)))
      .filter(event => canRead(caller, event) && canRead(final, event)).map(event => event.id)) : new Set<number>();
    const retained = await readableAtCompletion(c, caller, [...new Set([...projections.values()].map(projection => projection.id))]);
    const items = ids.filter(id => visible.has(id)).map(eventId => {
      const projection = projections.get(eventId);
      return { eventId, investigation: projection && retained.has(projection.id) ? projection : null };
    });
    await c.commit();
    return items;
  } catch (error) {
    if (begun) await c.rollback().catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}
