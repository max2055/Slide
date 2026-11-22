import type { ActorContext } from './auth/actor-context.js';
import { getAccessibleInstanceIds } from './auth/require-instance-access.js';
import { canReadResource } from './resources/resource-service.js';

export interface ReportAccessScope {
  instanceIds: readonly number[] | null;
  serverIds: readonly number[] | null;
}

export function getReportAccessScope(actor: ActorContext): ReportAccessScope {
  const boundary = actor.resourceBoundary;
  return {
    instanceIds: getAccessibleInstanceIds(actor),
    serverIds: boundary
      ? boundary.serverIds.filter(id => canReadResource(actor, { type: 'server', id }))
      : canReadResource(actor, { type: 'server', id: 1 }) ? null : [],
  };
}

/** Filter stored targets before reading payloads or applying pagination. */
export function reportAccessSql(scope?: ReportAccessScope, alias: '' | 'r.' = '') {
  const params: number[] = [];
  if (!scope || (scope.instanceIds === null && scope.serverIds === null)) {
    return { sql: 'TRUE', params };
  }

  const columnScope = (column: string, ids: readonly number[] | null) => {
    if (ids === null) return `${column} > 0`;
    if (!ids.length) return 'FALSE';
    for (const id of ids) params.push(id);
    return `${column} IN (${ids.map(() => '?').join(', ')})`;
  };
  const instance = columnScope(`${alias}instance_id`, scope.instanceIds);
  const server = columnScope(`${alias}server_id`, scope.serverIds);
  // Restricted readers need exactly one target and a matching report type.
  // Historical aggregate, mixed, and unclassified records require full scope.
  const sql = `${alias}network_device_id IS NULL AND (
    (${alias}type IN ('health', 'performance', 'slow_query', 'capacity', 'audit', 'custom')
      AND ${alias}server_id IS NULL AND ${instance})
    OR (${alias}type = 'server_health' AND ${alias}instance_id IS NULL AND ${server})
  )`;
  return { sql, params };
}
