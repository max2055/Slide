import type { ActorContext } from '../auth/actor-context.js';
import { canReadResource } from '../resources/resource-service.js';
import type { ResourceRef } from '../resources/types.js';

type AnalysisSubject = {
  target_type: string;
  instance_id: number | null;
  server_id: number | null;
  network_device_id: number | null;
};

const subjects = [
  ['instance', 'instance_id'],
  ['server', 'server_id'],
  ['network_device', 'network_device_id'],
] as const;

/** Schema and createAnalysis support exactly one resource, never a global row.
 * NULL/unknown targets and conflicting IDs are not a global authorization grant.
 */
export function canReadAnalysis(actor: ActorContext, row: AnalysisSubject): boolean {
  const subject = subjects.find(([type]) => row.target_type === type);
  if (!subject) return false;
  const [type, column] = subject;
  const id = row[column];
  return Number.isSafeInteger(id) && Number(id) > 0
    && subjects.every(([, other]) => other === column || row[other] === null)
    && canReadResource(actor, { type, id: id! });
}

/** Apply BEFORE ORDER BY/LIMIT/OFFSET or aggregation, using the same grants
 * as canReadResource. Values are bound; only fixed column names enter the SQL.
 */
export function analysisAccessSql(actor: ActorContext): { sql: string; params: number[] } {
  const params: number[] = [];
  const clauses = subjects.flatMap(([type, column]) => {
    const validSubject = [
      `BINARY target_type = '${type}'`, `${column} > 0`, `${column} <= ${Number.MAX_SAFE_INTEGER}`,
      ...subjects.filter(([, other]) => other !== column).map(([, other]) => `${other} IS NULL`),
    ];
    let ids: readonly number[] | undefined;
    if (type === 'instance') {
      if (!actor.permissions.includes('*') && !actor.permissions.includes('instance:*')) {
        ids = Object.keys(actor.instanceScopes).map(Number)
          .filter(id => Number.isSafeInteger(id) && id > 0 && canReadResource(actor, { type, id }));
      } else if (actor.resourceBoundary) ids = actor.resourceBoundary.instanceIds;
    } else {
      // Check module permission independently of the delegation ceiling.
      if (!canReadResource({ ...actor, resourceBoundary: undefined }, { type, id: 1 } as ResourceRef)) return [];
      if (actor.resourceBoundary) ids = type === 'server' ? actor.resourceBoundary.serverIds : actor.resourceBoundary.networkDeviceIds;
    }
    if (ids) {
      const allowed = ids.filter(id => Number.isSafeInteger(id) && id > 0);
      if (allowed.length === 0) return [];
      validSubject.push(`${column} IN (${allowed.map(() => '?').join(', ')})`);
      params.push(...allowed);
    }
    return [`(${validSubject.join(' AND ')})`];
  });
  return { sql: clauses.length ? `(${clauses.join(' OR ')})` : '1 = 0', params };
}
