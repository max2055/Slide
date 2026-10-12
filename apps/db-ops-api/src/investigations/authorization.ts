import { ActorAuthenticationError, ActorContextService, type ActorContext } from '../auth/actor-context.js';
import { hasPermission } from '../auth/require-permission.js';
import { getToolSecurityDefinition } from '../tools/security-catalog.js';
import type { TransactionConnection } from '../workflows/outbox-service.js';
import { investigationProfileHash, resolveInvestigationProfile } from './profiles.js';
import { InvestigationStoreError, type AdmissionAuthorizer, type AdmissionInvestigation,
  type InvestigationActor, type InvestigationOperation, type InvestigationResource } from './store.js';

export type AuthorityExecutor = Pick<TransactionConnection, 'execute'>;
export type InvestigationAction = InvestigationOperation | 'continue' | 'cancel' | 'watch' | 'content';
export interface InvestigationAuthoritySnapshot {
  schemaVersion: 1;
  investigationId: string;
  sessionId: string;
  actor: InvestigationActor;
  sessionVersion: number;
  permissions: readonly string[];
  instanceScopes: ActorContext['instanceScopes'];
  globalInstanceAccess: boolean;
  resourceBoundary: NonNullable<ActorContext['resourceBoundary']>;
  profileId: string;
  profileVersion: number;
  profileHash: string;
  scopeVersion: string;
  toolAllowlist: readonly string[];
}
export interface InvestigationAuthority {
  actor: ActorContext;
  investigation: Readonly<AdmissionInvestigation>;
  tools: readonly string[];
  globalInstanceAccess: boolean;
}
export type LiveInvestigationToolPolicy = (name: string) => boolean;

const invisible = () => new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
const forbidden = () => new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
async function rows(connection: AuthorityExecutor, sql: string, values: unknown[]): Promise<any[]> {
  const [result] = await connection.execute(sql, values) as [any[], unknown];
  return result;
}
const resourcePermission = (type: InvestigationResource['type']) => type === 'instance' ? 'instance:view'
  : type === 'server' ? 'servers:view' : 'network_devices:view';
const boundaryKey = (type: InvestigationResource['type']) => type === 'instance' ? 'instanceIds'
  : type === 'server' ? 'serverIds' : 'networkDeviceIds';
export function freezeInvestigationCaller(actor: ActorContext): ActorContext {
  return Object.freeze({ ...actor, roles: Object.freeze([...actor.roles]), permissions: Object.freeze([...actor.permissions]),
    instanceScopes: Object.freeze({ ...actor.instanceScopes }), resourceBoundary: actor.resourceBoundary ? Object.freeze({
      instanceIds: Object.freeze([...actor.resourceBoundary.instanceIds]),
      serverIds: Object.freeze([...actor.resourceBoundary.serverIds]),
      networkDeviceIds: Object.freeze([...actor.resourceBoundary.networkDeviceIds]),
    }) : undefined });
}
function permission(actor: ActorContext, required: string): boolean {
  return hasPermission(new Set(actor.permissions), required);
}
function canRead(actor: ActorContext, resource: Pick<InvestigationResource, 'type' | 'id'>): boolean {
  if (actor.resourceBoundary && !actor.resourceBoundary[boundaryKey(resource.type)].includes(resource.id)) return false;
  if (!permission(actor, resourcePermission(resource.type))) return false;
  // Bounded actors need an explicit live instance grant even after promotion.
  return resource.type !== 'instance' || !!actor.instanceScopes[resource.id]
    || !actor.resourceBoundary && (actor.permissions.includes('*') || actor.permissions.includes('instance:*'));
}

/** Each caller is server-bound. Actor/model commands cannot choose another
 * identity, expand the caller ceiling, or replace this port with cached ACLs. */
export class InvestigationAuthorization {
  constructor(private readonly contexts = new ActorContextService(),
    private readonly toolPolicy: LiveInvestigationToolPolicy = () => true) {}

  forActor(caller: ActorContext): AdmissionAuthorizer {
    const ceiling = freezeInvestigationCaller(caller);
    return async (connection, actor, investigation, operation) => {
      if (actor.id !== ceiling.userId || actor.kind !== (ceiling.principalKind ?? 'user')) throw forbidden();
      await this.authorize(connection, ceiling, investigation, operation);
    };
  }

  async load(connection: AuthorityExecutor, id: string): Promise<Readonly<AdmissionInvestigation>> {
    const [record] = await rows(connection, 'SELECT * FROM investigations WHERE id = ? FOR SHARE', [id]);
    if (!record) throw invisible();
    const resources = await rows(connection, `SELECT resource_type, resource_id, role FROM investigation_resources
      WHERE investigation_id = ? ORDER BY resource_type, resource_id FOR SHARE`, [id]);
    return Object.freeze({ id: record.id, sessionId: record.session_id, profileId: record.profile_id,
      profileVersion: Number(record.profile_version), scopeVersion: record.scope_version, version: Number(record.version),
      lifecycle: record.lifecycle, owner: Object.freeze({ kind: record.owner_kind, id: Number(record.owner_id) }),
      resources: Object.freeze(resources.map(ref => Object.freeze({ type: ref.resource_type, id: Number(ref.resource_id), role: ref.role }))),
    });
  }

  async authorize(connection: AuthorityExecutor, caller: ActorContext, investigation: Readonly<AdmissionInvestigation>,
    action: InvestigationAction, contentResources: readonly Pick<InvestigationResource, 'type' | 'id'>[] = [],
    frozen?: InvestigationAuthoritySnapshot): Promise<InvestigationAuthority> {
    const ceiling = freezeInvestigationCaller(caller);
    const kind = ceiling.principalKind ?? 'user';
    if (kind === 'service' && !ceiling.resourceBoundary) throw invisible();
    let current: ActorContext;
    try {
      current = await this.contexts.loadInvestigationActorFrom(connection, ceiling.userId, kind, ceiling.sessionVersion, ceiling.requestId);
    } catch (error) {
      if (error instanceof ActorAuthenticationError) throw invisible();
      throw error; // SQL failures are infrastructure failures, never hidden counts.
    }
    let role: 'operator' | 'viewer' | undefined;
    if (investigation.owner.id === current.userId && investigation.owner.kind === kind) role = 'operator';
    else if (action !== 'create' && kind === 'user') {
      const [member] = await rows(connection, `SELECT role FROM investigation_members
        WHERE investigation_id = ? AND user_id = ? AND (expires_at IS NULL OR expires_at > NOW()) FOR SHARE`, [investigation.id, current.userId]);
      role = member?.role;
    }
    if (!role) throw invisible();
    const profile = resolveInvestigationProfile(investigation.profileId, investigation.profileVersion);
    if (frozen && (frozen.schemaVersion !== 1 || frozen.investigationId !== investigation.id || frozen.sessionId !== investigation.sessionId
      || frozen.actor.id !== current.userId || frozen.actor.kind !== kind
      || frozen.sessionVersion !== current.sessionVersion || frozen.profileId !== profile.id
      || frozen.profileVersion !== profile.version || frozen.profileHash !== investigationProfileHash(profile)
      || frozen.scopeVersion !== investigation.scopeVersion)) throw invisible();
    const frozenActor = frozen ? { ...ceiling, permissions: frozen.permissions, instanceScopes: frozen.instanceScopes,
      resourceBoundary: frozen.resourceBoundary } : undefined;
    const permitted = (required: string) => permission(current, required) && permission(ceiling, required)
      && (!frozenActor || permission(frozenActor, required));
    // Preserve the ORIGINAL grant source. Later admin promotion must not let an
    // explicit-grant request survive deletion of that live instance grant.
    const globalInstanceAccess = !ceiling.resourceBoundary && permission(current, 'instance:*')
      && permission(ceiling, 'instance:*') && (!frozen || frozen.globalInstanceAccess === true);
    if (!permitted('chat:view') || profile.id === 'system' && !permitted('config:view')) throw invisible();
    for (const ref of [...investigation.resources, ...contentResources]) {
      if (!['instance', 'server', 'network_device'].includes(ref.type) || !Number.isSafeInteger(ref.id) || ref.id <= 0
        || !canRead(current, ref) || !canRead(ceiling, ref) || frozenActor && !canRead(frozenActor, ref)) throw invisible();
      if (ref.type === 'instance' && !current.instanceScopes[ref.id] && !globalInstanceAccess) throw invisible();
      const table = ref.type === 'instance' ? 'database_instances' : ref.type === 'server' ? 'servers' : 'network_devices';
      const found = await rows(connection, `SELECT id FROM ${table} WHERE id = ?${ref.type === 'instance' ? " AND lifecycle_state = 'available'" : ''} FOR SHARE`, [ref.id]);
      if (!found.length) throw invisible();
    }
    if (!['read', 'watch', 'content'].includes(action) && role !== 'operator') throw forbidden();
    const tools = profile.toolAllowlist.filter(name => {
      const security = getToolSecurityDefinition(name);
      return !!security && security.audience === 'actor' && security.effect === 'read'
        && security.credentials !== 'read' && security.approval === 'never' && this.toolPolicy(name)
        && (!frozen || frozen.toolAllowlist.includes(name)) && security.permissions.every(permitted);
    });
    // Downstream tools see a bounded actor with exact effective permissions,
    // never a role/username-based admin shortcut, and read-only scope levels.
    const permissions = new Set(['chat:view', ...(profile.id === 'system' ? ['config:view'] : []),
      ...investigation.resources.map(ref => resourcePermission(ref.type)),
      ...tools.flatMap(name => [...getToolSecurityDefinition(name)!.permissions])]);
    const boundary = Object.freeze({
      instanceIds: Object.freeze(investigation.resources.filter(ref => ref.type === 'instance').map(ref => ref.id)),
      serverIds: Object.freeze(investigation.resources.filter(ref => ref.type === 'server').map(ref => ref.id)),
      networkDeviceIds: Object.freeze(investigation.resources.filter(ref => ref.type === 'network_device').map(ref => ref.id)),
    });
    return { investigation, globalInstanceAccess, tools: Object.freeze(tools), actor: Object.freeze({ ...current,
      username: `investigation-actor-${current.userId}`, roles: Object.freeze([]), permissions: Object.freeze([...permissions]),
      resourceBoundary: boundary, instanceScopes: Object.freeze(Object.fromEntries(boundary.instanceIds.map(id => [id, 'read-only' as const]))),
    }) };
  }

  freeze(authority: InvestigationAuthority): InvestigationAuthoritySnapshot {
    const { actor, investigation, tools, globalInstanceAccess } = authority;
    return Object.freeze({ schemaVersion: 1, investigationId: investigation.id, sessionId: investigation.sessionId,
      actor: Object.freeze({ kind: actor.principalKind ?? 'user', id: actor.userId }),
      sessionVersion: actor.sessionVersion, permissions: actor.permissions, instanceScopes: actor.instanceScopes, globalInstanceAccess,
      resourceBoundary: actor.resourceBoundary!, profileId: investigation.profileId, profileVersion: investigation.profileVersion,
      profileHash: investigationProfileHash(resolveInvestigationProfile(investigation.profileId, investigation.profileVersion)),
      scopeVersion: investigation.scopeVersion, toolAllowlist: tools });
  }

  /** Consumers must call before each model/tool/content/watch send, including
   * cache reuse. A previous successful read is never a reusable permission. */
  async authorizeTool(connection: AuthorityExecutor, caller: ActorContext, investigation: Readonly<AdmissionInvestigation>,
    frozen: InvestigationAuthoritySnapshot, tool: string,
    targets: readonly Pick<InvestigationResource, 'type' | 'id'>[]): Promise<InvestigationAuthority> {
    const authority = await this.authorize(connection, caller, investigation, 'continue', targets, frozen);
    const security = getToolSecurityDefinition(tool);
    if (!authority.tools.includes(tool) || !security || targets.some(target => !investigation.resources.some(ref => ref.type === target.type && ref.id === target.id))
      || ['instance', 'server', 'network_device'].includes(security.resource)
        && (!targets.length || targets.some(target => target.type !== security.resource))) throw forbidden();
    return authority;
  }
}

export const investigationAuthorization = new InvestigationAuthorization();

/** Explicit provisioning port: allocates only a numeric, password-disabled
 * identity. Operators grant exact roles/instances separately; no default admin,
 * production startup mutation, implicit wildcard or model-selected account. */
export async function provisionInvestigationServiceIdentity(connection: AuthorityExecutor, name: string): Promise<number> {
  const { INVESTIGATION_SERVICE_PREFIX, INVESTIGATION_SERVICE_PASSWORD } = await import('../auth/investigation-service-identity.js');
  if (!/^[a-z0-9-]{1,30}$/.test(name)) throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
  const username = `${INVESTIGATION_SERVICE_PREFIX}${name}`;
  await connection.execute('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, INVESTIGATION_SERVICE_PASSWORD]);
  const [user] = await rows(connection, 'SELECT id FROM users WHERE username = ? FOR SHARE', [username]);
  if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0) throw forbidden();
  return Number(user.id);
}
