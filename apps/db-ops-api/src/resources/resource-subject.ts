import type { ResourceRef, ResourceType } from './types.js';

const RESOURCE_TYPES = new Set<ResourceType>(['instance', 'server', 'network_device']);

/** Parse an external resource reference without accepting ambiguous IDs. */
export function parseResourceRef(input: unknown): ResourceRef {
  if (!input || typeof input !== 'object') throw new Error('RESOURCE_REF_INVALID');
  const value = input as Record<string, unknown>;
  if (typeof value.type !== 'string' || !RESOURCE_TYPES.has(value.type as ResourceType)) {
    throw new Error('RESOURCE_TYPE_INVALID');
  }
  const id = typeof value.id === 'number' ? value.id : Number(value.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('RESOURCE_REF_INVALID');
  return { type: value.type as ResourceType, id };
}

export function resourceKey(ref: ResourceRef): string {
  return `${ref.type}:${ref.id}`;
}

export function resourceTypeLabel(type: ResourceType): string {
  switch (type) {
    case 'instance': return 'database_instance';
    case 'server': return 'server';
    case 'network_device': return 'network_device';
  }
}

export function isResourceType(value: unknown): value is ResourceType {
  return typeof value === 'string' && RESOURCE_TYPES.has(value as ResourceType);
}

