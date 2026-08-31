import type { ActorContext } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import type { ResourceDetail, ResourceRef, ResourceRelation, ResourceRelationType } from './types.js';

export interface ResourceRelationStore {
  exists(ref: ResourceRef): Promise<boolean>;
  insertRelation(relation: ResourceRelation): Promise<void>;
  listRelations(ref: ResourceRef): Promise<ResourceRelation[]>;
  describe?(ref: ResourceRef): Promise<ResourceDetail | null>;
}

const relationTypes = new Set<ResourceRelationType>([
  'runs_on', 'hosts', 'replicates_to', 'depends_on', 'connected_to', 'serves',
]);

function hasValidTopology(relation: ResourceRelation): boolean {
  if (relation.relationType === 'runs_on') {
    return relation.source.type === 'instance' && relation.target.type === 'server';
  }
  if (relation.relationType === 'hosts') return false;
  if (relation.relationType === 'connected_to') {
    return (relation.source.type === 'server' && relation.target.type === 'network_device')
      || (relation.source.type === 'network_device' && relation.target.type === 'server');
  }
  if (relation.relationType === 'serves') {
    return relation.source.type === 'network_device' && relation.target.type === 'server';
  }
  if (relation.relationType === 'replicates_to') {
    return relation.source.type === 'instance' && relation.target.type === 'instance';
  }
  return true;
}

function hasPermission(actor: ActorContext, permission: string): boolean {
  const [resource] = permission.split(':');
  return actor.permissions.includes('*')
    || actor.permissions.includes(permission)
    || actor.permissions.includes(`${resource}:*`);
}

export function canReadResource(actor: ActorContext, ref: ResourceRef): boolean {
  return ref.type === 'instance'
    ? actor.permissions.includes('*') || actor.permissions.includes('instance:*') || Boolean(actor.instanceScopes[ref.id])
    : ref.type === 'server'
      ? hasPermission(actor, 'servers:view')
      : hasPermission(actor, 'network_devices:view');
}

export function canManageResource(actor: ActorContext, ref: ResourceRef): boolean {
  if (ref.type === 'server') return hasPermission(actor, 'servers:manage');
  if (ref.type === 'network_device') return hasPermission(actor, 'network_devices:manage');
  if (actor.permissions.includes('*') || actor.permissions.includes('instance:*')) return true;
  return hasPermission(actor, 'instance:manage')
    && (actor.instanceScopes[ref.id] === 'read-write' || actor.instanceScopes[ref.id] === 'admin');
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
    return relations.filter((relation) => {
      const other = relation.source.type === ref.type && relation.source.id === ref.id
        ? relation.target
        : relation.source;
      return relation.validFrom <= now && (!relation.validUntil || relation.validUntil > now)
        && canReadResource(actor, other);
    });
  }

  async detail(actor: ActorContext, ref: ResourceRef): Promise<ResourceDetail> {
    if (!canReadResource(actor, ref)) throw new Error('RESOURCE_FORBIDDEN');
    const detail = await this.store.describe?.(ref);
    if (!detail) throw new Error('RESOURCE_NOT_FOUND');
    return detail;
  }
}

interface SqlExecutor {
  execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>;
}

interface SqlPool extends SqlExecutor {
  getConnection(): Promise<TransactionExecutor>;
}

interface TransactionExecutor extends SqlExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export class MysqlResourceRelationStore implements ResourceRelationStore {
  constructor(private readonly poolProvider: () => SqlPool | null = () => dbConnection.getPool() as unknown as SqlPool | null) {}

  async exists(ref: ResourceRef): Promise<boolean> {
    const pool = this.pool();
    const table = resourceTable(ref.type);
    const [rows] = await pool.execute<Array<{ id: number }>>(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`, [ref.id]);
    return rows.length > 0;
  }

  async insertRelation(relation: ResourceRelation): Promise<void> {
    const connection = await this.pool().getConnection();
    try {
      await connection.beginTransaction();
      for (const type of ['instance', 'server', 'network_device'] as const) {
        const ids = [relation.source, relation.target]
          .filter((ref) => ref.type === type)
          .map((ref) => ref.id)
          .sort((left, right) => left - right);
        if (ids.length === 0) continue;
        const table = resourceTable(type);
        const placeholders = ids.map(() => '?').join(', ');
        const [rows] = await connection.execute<Array<{ id: number }>>(
          `SELECT id FROM ${table} WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE`, ids,
        );
        if (rows.length !== new Set(ids).size) throw new Error('RESOURCE_NOT_FOUND');
      }
      const upperBound = relation.validUntil ? 'AND valid_from < ?' : '';
      const overlapValues = [
        relation.source.type, relation.source.id, relation.target.type, relation.target.id, relation.relationType,
        ...(relation.validUntil ? [relation.validUntil] : []), relation.validFrom,
      ];
      const [overlaps] = await connection.execute<Array<{ id: number }>>(
        `SELECT id FROM resource_relations
         WHERE source_type = ? AND source_id = ? AND target_type = ? AND target_id = ? AND relation_type = ?
           ${upperBound} AND (valid_until IS NULL OR valid_until > ?)
         LIMIT 1 FOR UPDATE`,
        overlapValues,
      );
      if (overlaps.length > 0) throw new Error('RESOURCE_RELATION_OVERLAP');
      await connection.execute(
        `INSERT INTO resource_relations
         (source_type, source_id, target_type, target_id, relation_type, provenance, metadata, valid_from, valid_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [relation.source.type, relation.source.id, relation.target.type, relation.target.id,
          relation.relationType, relation.provenance, relation.metadata ? JSON.stringify(relation.metadata) : null,
          relation.validFrom, relation.validUntil ?? null],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
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
      : ref.type === 'server'
        ? await this.pool().execute<Array<any>>('SELECT id, label, host, port, os_type, status, collection_enabled FROM servers WHERE id = ? LIMIT 1', [ref.id])
        : await this.pool().execute<Array<any>>('SELECT id, name, label, host, site, vendor, model, os_version, status, collection_enabled FROM network_devices WHERE id = ? LIMIT 1', [ref.id]);
    const row = rows[0];
    if (!row) return null;
    const attributes = ref.type === 'instance'
      ? { dbType: row.db_type, environment: row.environment, host: row.host, port: Number(row.port), healthStatus: row.health_status }
      : ref.type === 'server'
        ? { host: row.host, port: Number(row.port), osType: row.os_type, collectionEnabled: Boolean(row.collection_enabled) }
        : { host: row.host, site: row.site, vendor: row.vendor, model: row.model, osVersion: row.os_version, collectionEnabled: Boolean(row.collection_enabled) };
    return { resource: ref, label: ref.type === 'instance' ? row.name : row.label || row.name || row.host, status: row.status, attributes };
  }

  private pool(): SqlPool {
    const pool = this.poolProvider();
    if (!pool) throw new Error('RESOURCE_STORE_UNAVAILABLE');
    return pool;
  }
}

function resourceTable(type: ResourceRef['type']): string {
  switch (type) {
    case 'instance': return 'database_instances';
    case 'server': return 'servers';
    case 'network_device': return 'network_devices';
  }
}

export const resourceService = new ResourceService(new MysqlResourceRelationStore());
