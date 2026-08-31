import { instanceDatabaseService } from '../instance-database-service.js';
import { getToolSecurityDefinition } from './security-catalog.js';
import type { ToolPolicyResource } from './types.js';

export interface ToolResourceLookup {
  findInstanceIdByName(name: string): Promise<number | null>;
}

const defaultLookup: ToolResourceLookup = {
  async findInstanceIdByName(name: string): Promise<number | null> {
    return instanceDatabaseService.findInstanceIdByName(name);
  },
};

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
  if (['list_resources', 'get_resource_observations', 'get_resource_relations', 'diagnose_resource'].includes(toolName)
    && hasOwn(args, 'resourceType')) {
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
): Promise<ToolPolicyResource> {
  const resource = resolveToolResourceFromArgs(toolName, args);
  if (resource.error || resource.instanceId !== undefined) return resource;

  if (hasOwn(args, 'instance_name')) {
    if (typeof args.instance_name !== 'string' || !args.instance_name.trim()) {
      return { ...resource, error: 'RESOURCE_INVALID' };
    }
    const instanceId = await lookup.findInstanceIdByName(args.instance_name.trim());
    return instanceId
      ? { ...resource, instanceId }
      : { ...resource, error: 'RESOURCE_NOT_FOUND' };
  }

  return resource;
}
