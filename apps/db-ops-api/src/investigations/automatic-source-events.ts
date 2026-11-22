import type { RowDataPacket } from 'mysql2/promise';
import { eventResourceAccess } from '../alert-event-access.js';
import { ActorAuthenticationError, actorContextService, type ActorContext } from '../auth/actor-context.js';
import { hasPermission } from '../auth/require-permission.js';
import { dbConnection } from '../db-connection.js';
import { freezeInvestigationCaller } from './authorization.js';
import { InvestigationStoreError, type InvestigationRecord } from './store.js';

function eventAuthority(actor: ActorContext): string {
  return JSON.stringify([actor.roles, actor.permissions, actor.instanceScopes, actor.resourceBoundary]);
}

/** Manual entry keeps its original bindings. Automatic links grant no access. */
export async function automaticSourceEventIds(actor: ActorContext, record: InvestigationRecord): Promise<number[]> {
  if (record.context?.entry || !hasPermission(new Set(actor.permissions), 'alert:view')) return [];
  const caller = freezeInvestigationCaller(actor);
  const pool = dbConnection.getPool();
  if (!pool) return [];
  const [events] = await pool.execute<RowDataPacket[]>(`SELECT DISTINCT e.id, e.instance_id
    FROM investigation_alert_owners o
    JOIN alert_event_members m ON m.alert_id = o.alert_id
    JOIN alert_events e ON e.id = m.event_id
    WHERE o.investigation_id = ? AND o.lane = 'investigation'
      AND JSON_UNQUOTE(JSON_EXTRACT(o.command_snapshot, '$.trigger')) = 'auto'
    ORDER BY e.id DESC`, [record.id]);
  if (!events.length) return [];

  try {
    const live = await actorContextService.revalidateActor(caller, caller.requestId);
    if (!hasPermission(new Set(live.permissions), 'alert:view')) return [];
    const sameScope = eventAuthority(caller) === eventAuthority(live);
    const ids: number[] = [];
    for (const event of events) {
      const id = Number(event.id);
      if (Number.isSafeInteger(id) && id > 0 && await eventResourceAccess(live, event)
        && (sameScope || await eventResourceAccess(caller, event))) ids.push(id);
    }
    const final = await actorContextService.revalidateActor(caller, caller.requestId);
    return eventAuthority(final) === eventAuthority(live) ? ids : [];
  } catch (error) {
    if (error instanceof ActorAuthenticationError) throw new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
    throw error;
  }
}
