import type { ActorContext } from '../auth/actor-context.js';
import { hasPermission } from '../auth/require-permission.js';
import { instanceDatabaseService, type AvailableInstanceIdentity } from '../instance-database-service.js';
import { getToolSecurityDefinition } from './security-catalog.js';
import type { ToolPolicyResource } from './types.js';

export interface ToolResourceLookup {
  findInstanceIdByName(name: string): Promise<number | null>;
  /** When present, name resolution uses the full active set instead of an arbitrary id. */
  listAvailableInstancesByNormalizedName?(name: string): Promise<AvailableInstanceIdentity[]>;
}

const defaultLookup: ToolResourceLookup = {
  async findInstanceIdByName(name: string): Promise<number | null> {
    return instanceDatabaseService.findInstanceIdByName(name);
  },
  listAvailableInstancesByNormalizedName(name: string) {
    return instanceDatabaseService.listAvailableInstancesByNormalizedName(name);
  },
};

/** Same write scope as tool policy. Exported so the update tool cannot drift from authorization. */
export function actorCanWriteInstance(actor: ActorContext, instanceId: number): boolean {
  if (actor.resourceBoundary && !actor.resourceBoundary.instanceIds.includes(instanceId)) return false;
  if (actor.username.toLowerCase() === 'admin' || actor.roles.includes('admin') || hasPermission(new Set(actor.permissions), 'instance:*')) {
    return true;
  }
  const level = actor.instanceScopes[instanceId];
  return level === 'read-write' || level === 'admin';
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function hasOwn(args: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(args, key);
}

function instanceReference(args: Record<string, unknown>): Pick<ToolPolicyResource, 'instanceId' | 'error'> {
  const key = hasOwn(args, 'instance_id') ? 'instance_id' : hasOwn(args, 'instanceId') ? 'instanceId' : undefined;
  if (!key) return {};
  const instanceId = positiveInteger(args[key]);
  return instanceId ? { instanceId } : { error: 'RESOURCE_INVALID' };
}

function serverReference(args: Record<string, unknown>): Pick<ToolPolicyResource, 'serverId' | 'error'> {
  const key = hasOwn(args, 'serverId') ? 'serverId' : hasOwn(args, 'server_id') ? 'server_id' : undefined;
  if (!key) return {};
  const serverId = positiveInteger(args[key]);
  return serverId ? { serverId } : { error: 'RESOURCE_INVALID' };
}

function networkDeviceReference(args: Record<string, unknown>): Pick<ToolPolicyResource, 'networkDeviceId' | 'error'> {
  const key = hasOwn(args, 'networkDeviceId') ? 'networkDeviceId' : hasOwn(args, 'network_device_id') ? 'network_device_id' : undefined;
  if (!key) return {};
  const networkDeviceId = positiveInteger(args[key]);
  return networkDeviceId ? { networkDeviceId } : { error: 'RESOURCE_INVALID' };
}

export function resolveToolResourceFromArgs(
  toolName: string,
  args: Record<string, unknown>,
): ToolPolicyResource {
  const definition = getToolSecurityDefinition(toolName);
  const type = definition?.resource ?? 'none';

  // Cross-resource read tools carry an explicit, typed reference rather than
  // pretending every target is a database instance. Resolve it before the
  // handler so Agent policy/audit records retain the concrete subject.
  const evidenceTool = ['get_evidence_bundle', 'get_evidence_item'].includes(toolName);
  if ((evidenceTool || ['list_resources', 'get_resource_observations', 'get_resource_relations', 'diagnose_resource', 'query_metrics'].includes(toolName))
    && (evidenceTool || hasOwn(args, 'resourceType'))) {
    const resourceType = args.resourceType;
    const resourceId = positiveInteger(args.resourceId);
    if (!['instance', 'server', 'network_device'].includes(String(resourceType)) || resourceId === undefined) {
      return { type: 'none', error: 'RESOURCE_INVALID' };
    }
    return resourceType === 'instance'
      ? { type: 'instance', instanceId: resourceId }
      : resourceType === 'server'
        ? { type: 'server', serverId: resourceId }
        : { type: 'network_device', networkDeviceId: resourceId };
  }

  if (type === 'instance') return { type, ...instanceReference(args) };
  if (type === 'server') return { type, ...serverReference(args) };
  if (type === 'network_device') return { type, ...networkDeviceReference(args) };
  if (type === 'network-scan') return { type };
  if (type === 'database-target') {
    const instance = instanceReference(args);
    if (instance.error) return { type, ...instance };

    const hasHost = hasOwn(args, 'host');
    const hasPort = hasOwn(args, 'port');
    if (!hasHost && !hasPort) return { type, ...instance };
    if (typeof args.host !== 'string' || !args.host.trim() || !positiveInteger(args.port)) {
      return { type, ...instance, error: 'RESOURCE_INVALID' };
    }
    return {
      type,
      ...instance,
      databaseTarget: { host: args.host.trim(), port: Number(args.port) },
    };
  }

  return { type };
}

export async function resolveToolResource(
  toolName: string,
  args: Record<string, unknown>,
  lookup: ToolResourceLookup = defaultLookup,
  actor?: ActorContext,
): Promise<ToolPolicyResource> {
  const resource = resolveToolResourceFromArgs(toolName, args);
  if (resource.error || resource.instanceId !== undefined) return resource;

  if (hasOwn(args, 'instance_name')) {
    if (typeof args.instance_name !== 'string' || !args.instance_name.trim()) {
      return { ...resource, error: 'RESOURCE_INVALID' };
    }
    const normalized = args.instance_name.trim();
    // The new environment argument is the value to store, never the row selector.
    try {
      if (lookup.listAvailableInstancesByNormalizedName) {
        const matches = await lookup.listAvailableInstancesByNormalizedName(normalized);
        if (matches.length === 1) return { ...resource, instanceId: matches[0].id };
        const visible = actor ? matches.filter((match) => actorCanWriteInstance(actor, match.id)) : [];
        if (matches.length > 1 && visible.length >= 2) return { ...resource, error: 'AMBIGUOUS_INSTANCE_NAME' };
        return { ...resource, error: 'RESOURCE_NOT_FOUND' };
      }
      const instanceId = await lookup.findInstanceIdByName(normalized);
      return instanceId
        ? { ...resource, instanceId }
        : { ...resource, error: 'RESOURCE_NOT_FOUND' };
    } catch {
      // Keep storage details (including SQL and credentials) out of policy/audit results.
      return { ...resource, error: 'RESOURCE_LOOKUP_UNAVAILABLE' };
    }
  }

  return resource;
}
