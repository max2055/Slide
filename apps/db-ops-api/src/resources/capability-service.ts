import type { ActorContext } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import type { ResourceRef } from './types.js';
import { canManageResource, canReadResource } from './resource-service.js';

export type CapabilityState = 'declared' | 'configured' | 'verified' | 'degraded' | 'unsupported';
export interface ResourceCapability {
  resource: ResourceRef;
  key: string;
  state: CapabilityState;
  evidence?: Record<string, unknown> | null;
  reason?: string;
  checkedAt: Date;
  validUntil?: Date | null;
}

export interface CapabilityStore {
  get(resource: ResourceRef, key: string): Promise<ResourceCapability | null>;
  put(capability: ResourceCapability): Promise<void>;
}

const capabilityStates = new Set<CapabilityState>(['declared', 'configured', 'verified', 'degraded', 'unsupported']);

export class CapabilityService {
  constructor(private readonly store: CapabilityStore) {}

  async get(actor: ActorContext, resource: ResourceRef, key: string, now = new Date()): Promise<ResourceCapability | null> {
    if (!canReadResource(actor, resource)) throw new Error('RESOURCE_FORBIDDEN');
    const value = await this.store.get(resource, key);
    if (!value) return null;
    if (value.state === 'verified' && value.validUntil && value.validUntil <= now) {
      return { ...value, state: 'configured', reason: 'capability_verification_expired' };
    }
    return value;
  }

  async put(actor: ActorContext, capability: ResourceCapability): Promise<void> {
    if (!canManageResource(actor, capability.resource)) throw new Error('RESOURCE_FORBIDDEN');
    if (!capability.key.trim() || capability.key.length > 128) throw new Error('CAPABILITY_KEY_INVALID');
    if (!capabilityStates.has(capability.state)) throw new Error('CAPABILITY_STATE_INVALID');
    if (capability.state === 'verified' && capability.evidence?.probe !== 'collector') {
      throw new Error('CAPABILITY_VERIFICATION_EVIDENCE_REQUIRED');
    }
    if (Number.isNaN(capability.checkedAt.getTime())) throw new Error('CAPABILITY_TIME_INVALID');
    await this.store.put(capability);
  }
}

interface SqlPool {
  execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>;
}

export class MysqlCapabilityStore implements CapabilityStore {
  constructor(private readonly poolProvider: () => SqlPool | null = () => dbConnection.getPool() as unknown as SqlPool | null) {}

  async get(resource: ResourceRef, key: string): Promise<ResourceCapability | null> {
    const [rows] = await this.pool().execute<Array<any>>(
      `SELECT resource_type, resource_id, capability_key, state, evidence, reason, checked_at, valid_until
       FROM resource_capabilities WHERE resource_type = ? AND resource_id = ? AND capability_key = ?`,
      [resource.type, resource.id, key],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      resource: { type: row.resource_type, id: Number(row.resource_id) }, key: row.capability_key, state: row.state,
      evidence: typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence, reason: row.reason,
      checkedAt: new Date(row.checked_at), validUntil: row.valid_until ? new Date(row.valid_until) : null,
    };
  }

  async put(capability: ResourceCapability): Promise<void> {
    await this.pool().execute(
      `INSERT INTO resource_capabilities
       (resource_type, resource_id, capability_key, state, evidence, reason, checked_at, valid_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE state = VALUES(state), evidence = VALUES(evidence), reason = VALUES(reason),
         checked_at = VALUES(checked_at), valid_until = VALUES(valid_until)`,
      [capability.resource.type, capability.resource.id, capability.key, capability.state,
        capability.evidence ? JSON.stringify(capability.evidence) : null, capability.reason ?? null,
        capability.checkedAt, capability.validUntil ?? null],
    );
  }

  private pool(): SqlPool {
    const pool = this.poolProvider();
    if (!pool) throw new Error('RESOURCE_STORE_UNAVAILABLE');
    return pool;
  }
}

export const capabilityService = new CapabilityService(new MysqlCapabilityStore());
