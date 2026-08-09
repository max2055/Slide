import type { ActorContext } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import type { ResourceDetail, ResourceRef, ResourceRelation, ResourceRelationType } from './types.js';

export interface ResourceRelationStore {
  exists(ref: ResourceRef): Promise<boolean>;
  insertRelation(relation: ResourceRelation): Promise<void>;
  listRelations(ref: ResourceRef): Promise<ResourceRelation[]>;
  describe?(ref: ResourceRef): Promise<ResourceDetail | null>;
}

const relationTypes = new Set<ResourceRelationType>(['runs_on', 'hosts', 'replicates_to', 'depends_on']);

function hasValidTopology(relation: ResourceRelation): boolean {
  if (relation.relationType === 'runs_on') {
    return relation.source.type === 'instance' && relation.target.type === 'server';
  }
  if (relation.relationType === 'hosts') return false;
  if (relation.relationType === 'replicates_to') {
    return relation.source.type === 'instance' && relation.target.type === 'instance';
  }
  return true;
}

function hasGlobalResourceAccess(actor: ActorContext): boolean {
  return actor.permissions.includes('*') || actor.permissions.includes('instance:*');
}

export function canReadResource(actor: ActorContext, ref: ResourceRef): boolean {
  return ref.type === 'instance'
    ? hasGlobalResourceAccess(actor) || Boolean(actor.instanceScopes[ref.id])
    : hasGlobalResourceAccess(actor) || actor.permissions.includes('servers:view');
}

export function canManageResource(actor: ActorContext, ref: ResourceRef): boolean {
  if (hasGlobalResourceAccess(actor)) return true;
  return ref.type === 'instance'
    && actor.permissions.includes('instance:manage')
    && (actor.instanceScopes[ref.id] === 'read-write' || actor.instanceScopes[ref.id] === 'admin')
    || ref.type === 'server' && actor.permissions.includes('servers:manage');
}

export class ResourceService {
  constructor(private readonly store: ResourceRelationStore) {}

  async createRelation(actor: ActorContext, relation: ResourceRelation): Promise<void> {
    if (!relationTypes.has(relation.relationType)) throw new Error('RESOURCE_RELATION_TYPE_INVALID');
    if (!hasValidTopology(relation)) throw new Error('RESOURCE_RELATION_TOPOLOGY_INVALID');
    if (!Number.isInteger(relation.source.id) || relation.source.id < 1 || !Number.isInteger(relation.target.id) || relation.target.id < 1) {
      throw new Error('RESOURCE_REF_INVALID');
    }
    if (relation.source.type === relation.target.type && relation.source.id === relation.target.id) throw new Error('RESOURCE_RELATION_SELF');
    if (!relation.provenance.trim() || relation.provenance.length > 64) throw new Error('RESOURCE_PROVENANCE_INVALID');
    if (Number.isNaN(relation.validFrom.getTime()) || (relation.validUntil && Number.isNaN(relation.validUntil.getTime()))
      || (relation.validUntil && relation.validUntil <= relation.validFrom)) throw new Error('RESOURCE_RELATION_WINDOW_INVALID');
    if (!canManageResource(actor, relation.source) || !canManageResource(actor, relation.target)) throw new Error('RESOURCE_FORBIDDEN');
    if (!await this.store.exists(relation.source) || !await this.store.exists(relation.target)) throw new Error('RESOURCE_NOT_FOUND');
    await this.store.insertRelation(relation);
  }

  async currentRelations(actor: ActorContext, ref: ResourceRef, now = new Date()): Promise<ResourceRelation[]> {
    if (!canReadResource(actor, ref)) throw new Error('RESOURCE_FORBIDDEN');
    const relations = await this.store.listRelations(ref);
    return relations.filter((relation) => relation.validFrom <= now && (!relation.validUntil || relation.validUntil > now));
  }

  async detail(actor: ActorContext, ref: ResourceRef): Promise<ResourceDetail> {
    if (!canReadResource(actor, ref)) throw new Error('RESOURCE_FORBIDDEN');
    const detail = await this.store.describe?.(ref);
    if (!detail) throw new Error('RESOURCE_NOT_FOUND');
    return detail;
  }
}

interface SqlPool {
  execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>;
}

export class MysqlResourceRelationStore implements ResourceRelationStore {
  constructor(private readonly poolProvider: () => SqlPool | null = () => dbConnection.getPool() as unknown as SqlPool | null) {}

  async exists(ref: ResourceRef): Promise<boolean> {
    const pool = this.pool();
    const table = ref.type === 'instance' ? 'database_instances' : 'servers';
    const [rows] = await pool.execute<Array<{ id: number }>>(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`, [ref.id]);
    return rows.length > 0;
  }

  async insertRelation(relation: ResourceRelation): Promise<void> {
    await this.pool().execute(
      `INSERT INTO resource_relations
       (source_type, source_id, target_type, target_id, relation_type, provenance, metadata, valid_from, valid_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [relation.source.type, relation.source.id, relation.target.type, relation.target.id,
        relation.relationType, relation.provenance, relation.metadata ? JSON.stringify(relation.metadata) : null,
        relation.validFrom, relation.validUntil ?? null],
    );
  }

  async listRelations(ref: ResourceRef): Promise<ResourceRelation[]> {
    const [rows] = await this.pool().execute<Array<any>>(
      `SELECT source_type, source_id, target_type, target_id, relation_type, provenance, metadata, valid_from, valid_until
       FROM resource_relations
       WHERE (source_type = ? AND source_id = ?) OR (target_type = ? AND target_id = ?)
       ORDER BY valid_from DESC`,
      [ref.type, ref.id, ref.type, ref.id],
    );
    return rows.map((row) => ({
      source: { type: row.source_type, id: Number(row.source_id) }, target: { type: row.target_type, id: Number(row.target_id) },
      relationType: row.relation_type, provenance: row.provenance,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      validFrom: new Date(row.valid_from), validUntil: row.valid_until ? new Date(row.valid_until) : null,
    }));
  }

  async describe(ref: ResourceRef): Promise<ResourceDetail | null> {
    const [rows] = ref.type === 'instance'
      ? await this.pool().execute<Array<any>>('SELECT id, name, db_type, environment, host, port, status, health_status FROM database_instances WHERE id = ? LIMIT 1', [ref.id])
      : await this.pool().execute<Array<any>>('SELECT id, label, host, port, os_type, status, collection_enabled FROM servers WHERE id = ? LIMIT 1', [ref.id]);
    const row = rows[0];
    if (!row) return null;
    const attributes = ref.type === 'instance'
      ? { dbType: row.db_type, environment: row.environment, host: row.host, port: Number(row.port), healthStatus: row.health_status }
      : { host: row.host, port: Number(row.port), osType: row.os_type, collectionEnabled: Boolean(row.collection_enabled) };
    return { resource: ref, label: ref.type === 'instance' ? row.name : row.label || row.host, status: row.status, attributes };
  }

  private pool(): SqlPool {
    const pool = this.poolProvider();
    if (!pool) throw new Error('RESOURCE_STORE_UNAVAILABLE');
    return pool;
  }
}

export const resourceService = new ResourceService(new MysqlResourceRelationStore());
