import { ActorAuthenticationError, ActorContextService, type ActorContext } from '../auth/actor-context.js';
import { hasPermission } from '../auth/require-permission.js';
import { freezeInvestigationCaller } from '../investigations/authorization.js';
import { OperationsError, principalSchema, resourceRefSchema, type OperationsPrincipal } from './contracts.js';
import type { ResourceRef } from '../resources/types.js';

/** P10 registers/grants these explicitly; no role/username bypass here. */
export const OPERATIONS_PERMISSIONS = Object.freeze({
  'context:read': 'operations:context:view', 'context:manage': 'operations:context:manage',
  'cases:read': 'operations:cases:view', 'cases:manage': 'operations:cases:manage', 'cases:review': 'operations:cases:review',
  'actions:read': 'operations:actions:view', 'actions:propose': 'operations:actions:propose',
  'actions:approve': 'operations:actions:approve', 'actions:execute': 'operations:actions:execute',
} as const);
export type OperationsAction = keyof typeof OPERATIONS_PERMISSIONS;
type Executor = { execute(sql: string, values?: unknown[]): Promise<any> };
type ContextLoader = Pick<ActorContextService, 'loadInvestigationActorFrom'>;
const types = {
  instance: { table: 'database_instances', boundary: 'instanceIds', read: 'instance:view', manage: 'instance:manage' },
  server: { table: 'servers', boundary: 'serverIds', read: 'servers:view', manage: 'servers:manage' },
  network_device: { table: 'network_devices', boundary: 'networkDeviceIds', read: 'network_devices:view', manage: 'network_devices:manage' },
} as const;
function permission(actor: ActorContext, code: string): boolean { return hasPermission(new Set(actor.permissions), code); }
function resourceAllowed(actor: ActorContext, ref: ResourceRef, write: boolean): boolean {
  const type = types[ref.type];
  if (actor.resourceBoundary && !actor.resourceBoundary[type.boundary].includes(ref.id)) return false;
  if (!permission(actor, type.read) || write && !permission(actor, type.manage)) return false;
  if (ref.type !== 'instance') return true;
  const grant = actor.instanceScopes[ref.id];
  if (grant) return !write || grant === 'read-write' || grant === 'admin';
  return !actor.resourceBoundary && (actor.permissions.includes('*') || actor.permissions.includes('instance:*'));
}

export class OperationsAuthorization {
  constructor(private readonly contexts: ContextLoader = new ActorContextService()) {}
  /** Invoke inside the caller's transaction before every content/cache/model/WS
   * send and mutation. Resources MUST be the complete persisted object scope,
   * never client-selected subset. Domain services additionally enforce source
   * investigation membership, status, expiry and version/freshness. */
  async authorize(connection: Executor, caller: ActorContext, resources: readonly ResourceRef[], action: OperationsAction,
    independence?: { author: OperationsPrincipal; requester?: OperationsPrincipal }): Promise<ActorContext> {
    const ceiling = freezeInvestigationCaller(caller);
    const parsed = resources.map(ref => resourceRefSchema.safeParse(ref));
    if (parsed.some(result => !result.success)) throw new OperationsError('OPERATIONS_INPUT_INVALID');
    const refs = parsed.map(result => result.data!);
    const identities = independence && { author: { ...independence.author },
      requester: independence.requester && { ...independence.requester } };
    if (!refs.length || refs.length > 100 || !Object.hasOwn(OPERATIONS_PERMISSIONS, action)) throw new OperationsError('OPERATIONS_INPUT_INVALID');
    const write = !action.endsWith(':read');
    const denied = () => new OperationsError(write ? 'OPERATIONS_FORBIDDEN' : 'OPERATIONS_NOT_FOUND');
    let current: ActorContext;
    try {
      current = await this.contexts.loadInvestigationActorFrom(connection, ceiling.userId, ceiling.principalKind ?? 'user',
        ceiling.sessionVersion, ceiling.requestId);
    } catch (error) { if (error instanceof ActorAuthenticationError) throw denied(); throw error; }
    if (current.userId !== ceiling.userId || (current.principalKind ?? 'user') !== (ceiling.principalKind ?? 'user')
      || current.sessionVersion !== ceiling.sessionVersion) throw denied();
    for (const actor of [ceiling, current]) {
      if (!permission(actor, OPERATIONS_PERMISSIONS[action]) || refs.some(ref => !resourceAllowed(actor, ref, write))) throw denied();
    }
    if (action === 'cases:review' || action === 'actions:approve') {
      if (!identities || current.principalKind === 'service' || !principalSchema.safeParse(identities.author).success
        || action === 'actions:approve' && !principalSchema.safeParse(identities.requester).success
        || [identities.author, identities.requester].some(principal => principal?.id === current.userId)) throw denied();
    }
    // Resource checks are current locking reads; missing/deleted objects reveal no content.
    for (const ref of [...new Map(refs.map(ref => [`${ref.type}:${ref.id}`, ref])).values()]
      .sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id)) {
      const [rows] = await connection.execute(`SELECT id FROM ${types[ref.type].table} WHERE id = ?${ref.type === 'instance' ? " AND lifecycle_state = 'available'" : ''} FOR SHARE`, [ref.id]);
      if (!Array.isArray(rows) || rows.length !== 1) throw denied();
    }
    // Return exact permissions/resources needed for this operation, never an
    // admin wildcard or an old grant revoked since the original ceiling.
    const permissions = new Set<string>([OPERATIONS_PERMISSIONS[action]]);
    const boundary = { instanceIds: [] as number[], serverIds: [] as number[], networkDeviceIds: [] as number[] };
    for (const ref of refs) {
      permissions.add(types[ref.type].read);
      if (write) permissions.add(types[ref.type].manage);
      if (!boundary[types[ref.type].boundary].includes(ref.id)) boundary[types[ref.type].boundary].push(ref.id);
    }
    return freezeInvestigationCaller({ ...current, username: `operations-actor-${current.userId}`, roles: [],
      permissions: [...permissions], resourceBoundary: boundary,
      instanceScopes: Object.fromEntries(boundary.instanceIds.map(id => [id, write ? 'read-write' : 'read-only'])) });
  }
}
