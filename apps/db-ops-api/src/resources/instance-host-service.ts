import type { ActorContext } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import { canManageResource, canReadResource } from './resource-service.js';

export type InstanceHostRole = 'standalone' | 'primary' | 'replica' | 'shard' | 'arbiter' | 'unknown';

export interface InstanceHostMapping {
  serverId: number;
  role: InstanceHostRole;
  notes?: string | null;
}

export interface InstanceHostDetail extends InstanceHostMapping {
  host: string;
  port: number;
  label: string | null;
  osType: string;
  status: string;
  collectionEnabled: boolean;
  validFrom: Date;
}

export interface HostedInstanceDetail extends InstanceHostMapping {
  instanceId: number;
  name: string;
  dbType: string;
  environment: string;
  status: string;
  healthStatus: string;
  validFrom: Date;
}

export interface InstanceHostStore {
  instanceExists(id: number): Promise<boolean>;
  serversExist(ids: number[]): Promise<number[]>;
  replaceInstanceHosts(instanceId: number, mappings: InstanceHostMapping[], now?: Date): Promise<InstanceHostDetail[]>;
  expireInstanceHost(instanceId: number, serverId: number, now?: Date): Promise<boolean>;
  listInstanceHosts(instanceId: number): Promise<InstanceHostDetail[]>;
  listServerInstances(serverId: number): Promise<HostedInstanceDetail[]>;
  countActiveForServer(serverId: number): Promise<number>;
}

const roles = new Set<InstanceHostRole>(['standalone', 'primary', 'replica', 'shard', 'arbiter', 'unknown']);

function hasPermission(actor: ActorContext, permission: string): boolean {
  const [resource] = permission.split(':');
  return actor.permissions.includes('*')
    || actor.permissions.includes(permission)
    || actor.permissions.includes(`${resource}:*`);
}

function parseMetadata(value: unknown): { role?: unknown; notes?: unknown } {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as { role?: unknown; notes?: unknown }; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value as { role?: unknown; notes?: unknown } : {};
}

function normalizeRowMapping(row: any): InstanceHostMapping {
  const metadata = parseMetadata(row.metadata);
  return {
    serverId: Number(row.server_id ?? row.target_id),
    role: roles.has(metadata.role as InstanceHostRole) ? metadata.role as InstanceHostRole : 'unknown',
    notes: typeof metadata.notes === 'string' ? metadata.notes : null,
  };
}

export class InstanceHostService {
  constructor(private readonly store: InstanceHostStore) {}

  async listHosts(actor: ActorContext, instanceId: number): Promise<InstanceHostDetail[]> {
    this.assertId(instanceId);
    if (!canReadResource(actor, { type: 'instance', id: instanceId }) || !hasPermission(actor, 'servers:view')) {
      throw new Error('RESOURCE_FORBIDDEN');
    }
    if (!await this.store.instanceExists(instanceId)) throw new Error('INSTANCE_NOT_FOUND');
    return this.store.listInstanceHosts(instanceId);
  }

  async replaceHosts(actor: ActorContext, instanceId: number, rawMappings: InstanceHostMapping[]): Promise<InstanceHostDetail[]> {
    this.assertId(instanceId);
    if (!canManageResource(actor, { type: 'instance', id: instanceId }) || !hasPermission(actor, 'servers:manage')) {
      throw new Error('RESOURCE_FORBIDDEN');
    }
    const mappings = this.normalizeMappings(rawMappings);
    if (!await this.store.instanceExists(instanceId)) throw new Error('INSTANCE_NOT_FOUND');
    const existingIds = new Set(await this.store.serversExist(mappings.map((mapping) => mapping.serverId)));
    if (mappings.some((mapping) => !existingIds.has(mapping.serverId))) throw new Error('SERVER_NOT_FOUND');
    return this.store.replaceInstanceHosts(instanceId, mappings);
  }

  async unlinkHost(actor: ActorContext, instanceId: number, serverId: number): Promise<boolean> {
    this.assertId(instanceId);
    this.assertId(serverId);
    if (!canManageResource(actor, { type: 'instance', id: instanceId }) || !hasPermission(actor, 'servers:manage')) {
      throw new Error('RESOURCE_FORBIDDEN');
    }
    return this.store.expireInstanceHost(instanceId, serverId);
  }

  async listInstances(actor: ActorContext, serverId: number): Promise<HostedInstanceDetail[]> {
    this.assertId(serverId);
    if (!hasPermission(actor, 'servers:view')) throw new Error('RESOURCE_FORBIDDEN');
    const rows = await this.store.listServerInstances(serverId);
    return rows.filter((row) => canReadResource(actor, { type: 'instance', id: row.instanceId }));
  }

  async assertServerDeletable(serverId: number): Promise<void> {
    this.assertId(serverId);
    if (await this.store.countActiveForServer(serverId) > 0) throw new Error('SERVER_HAS_INSTANCE_RELATIONS');
  }

  private normalizeMappings(rawMappings: InstanceHostMapping[]): InstanceHostMapping[] {
    if (!Array.isArray(rawMappings)) throw new Error('INSTANCE_HOST_PAYLOAD_INVALID');
    if (rawMappings.length > 32) throw new Error('INSTANCE_HOST_LIMIT');
    const seen = new Set<number>();
    return rawMappings.map((raw) => {
      this.assertId(raw?.serverId);
      if (seen.has(raw.serverId)) throw new Error('INSTANCE_HOST_DUPLICATE');
      seen.add(raw.serverId);
      if (!roles.has(raw.role)) throw new Error('INSTANCE_HOST_ROLE_INVALID');
      const notes = raw.notes == null ? null : String(raw.notes).trim();
      if (notes && notes.length > 500) throw new Error('INSTANCE_HOST_NOTES_INVALID');
      return { serverId: raw.serverId, role: raw.role, notes: notes || null };
    });
  }

  private assertId(id: number): void {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('RESOURCE_REF_INVALID');
  }
}

interface SqlExecutor {
  execute<T = any>(sql: string, values?: unknown[]): Promise<[T, unknown?]>;
}

interface TransactionExecutor extends SqlExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

interface SqlPool extends SqlExecutor {
  getConnection(): Promise<TransactionExecutor>;
}

export class MysqlInstanceHostStore implements InstanceHostStore {
  constructor(private readonly poolProvider: () => SqlPool | null = () => dbConnection.getPool() as unknown as SqlPool | null) {}

  async instanceExists(id: number): Promise<boolean> {
    const [rows] = await this.pool().execute<any[]>('SELECT id FROM database_instances WHERE id = ? LIMIT 1', [id]);
    return rows.length > 0;
  }

  async serversExist(ids: number[]): Promise<number[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const [rows] = await this.pool().execute<any[]>(`SELECT id FROM servers WHERE id IN (${placeholders})`, ids);
    return rows.map((row) => Number(row.id));
  }

  async replaceInstanceHosts(instanceId: number, mappings: InstanceHostMapping[], now = new Date()): Promise<InstanceHostDetail[]> {
    const connection = await this.pool().getConnection();
    try {
      await connection.beginTransaction();
      const [instances] = await connection.execute<any[]>('SELECT id FROM database_instances WHERE id = ? FOR UPDATE', [instanceId]);
      if (instances.length === 0) throw new Error('INSTANCE_NOT_FOUND');
      if (mappings.length > 0) {
        const serverIds = mappings.map((mapping) => mapping.serverId).sort((left, right) => left - right);
        const placeholders = serverIds.map(() => '?').join(', ');
        const [servers] = await connection.execute<any[]>(
          `SELECT id FROM servers WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE`, serverIds,
        );
        const existingIds = new Set(servers.map((row) => Number(row.id)));
        if (serverIds.some((id) => !existingIds.has(id))) throw new Error('SERVER_NOT_FOUND');
      }
      const [rows] = await connection.execute<any[]>(
        `SELECT id, target_id AS server_id, metadata, valid_from, valid_until FROM resource_relations
         WHERE source_type = 'instance' AND source_id = ? AND target_type = 'server'
           AND relation_type = 'runs_on' AND (valid_until IS NULL OR valid_until > ?)
         ORDER BY target_id, (valid_until IS NULL) DESC, valid_from, id FOR UPDATE`,
        [instanceId, now],
      );
      const desired = new Map(mappings.map((mapping) => [mapping.serverId, mapping]));
      const unchanged = new Set<number>();
      for (const row of rows) {
        const current = normalizeRowMapping(row);
        const next = desired.get(current.serverId);
        const validFrom = new Date(row.valid_from);
        if (!unchanged.has(current.serverId) && validFrom <= now
          && next && next.role === current.role && (next.notes ?? null) === (current.notes ?? null)) {
          unchanged.add(current.serverId);
        } else if (validFrom >= now) {
          await connection.execute('DELETE FROM resource_relations WHERE id = ?', [row.id]);
        } else {
          await connection.execute('UPDATE resource_relations SET valid_until = ? WHERE id = ?', [now, row.id]);
        }
      }
      for (const mapping of mappings) {
        if (unchanged.has(mapping.serverId)) continue;
        await connection.execute(
          `INSERT INTO resource_relations
           (source_type, source_id, target_type, target_id, relation_type, provenance, metadata, valid_from, valid_until)
           VALUES ('instance', ?, 'server', ?, 'runs_on', 'manual', ?, ?, NULL)`,
          [instanceId, mapping.serverId, JSON.stringify({ role: mapping.role, notes: mapping.notes ?? null }), now],
        );
      }
      const [enrichedRows] = await connection.execute<any[]>(
        `SELECT rr.target_id AS server_id, rr.metadata, rr.valid_from,
                s.host, s.port, s.label, s.os_type, s.status, s.collection_enabled
         FROM resource_relations rr JOIN servers s ON s.id = rr.target_id
         WHERE rr.source_type = 'instance' AND rr.source_id = ? AND rr.target_type = 'server'
           AND rr.relation_type = 'runs_on' AND rr.valid_from <= ?
           AND (rr.valid_until IS NULL OR rr.valid_until > ?)
         ORDER BY s.host, s.port`,
        [instanceId, now, now],
      );
      await connection.commit();
      return enrichedRows.map((row) => ({
        ...normalizeRowMapping(row), host: row.host, port: Number(row.port), label: row.label,
        osType: row.os_type, status: row.status, collectionEnabled: Boolean(row.collection_enabled),
        validFrom: new Date(row.valid_from),
      }));
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async expireInstanceHost(instanceId: number, serverId: number, now = new Date()): Promise<boolean> {
    const [result] = await this.pool().execute<any>(
      `UPDATE resource_relations SET valid_until = ?
       WHERE source_type = 'instance' AND source_id = ? AND target_type = 'server' AND target_id = ?
         AND relation_type = 'runs_on' AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)`,
      [now, instanceId, serverId, now, now],
    );
    return Number(result.affectedRows) > 0;
  }

  async listInstanceHosts(instanceId: number): Promise<InstanceHostDetail[]> {
    const [rows] = await this.pool().execute<any[]>(
      `SELECT rr.target_id AS server_id, rr.metadata, rr.valid_from,
              s.host, s.port, s.label, s.os_type, s.status, s.collection_enabled
       FROM resource_relations rr JOIN servers s ON s.id = rr.target_id
       WHERE rr.source_type = 'instance' AND rr.source_id = ? AND rr.target_type = 'server'
         AND rr.relation_type = 'runs_on' AND rr.valid_from <= NOW()
         AND (rr.valid_until IS NULL OR rr.valid_until > NOW())
       ORDER BY s.host, s.port`,
      [instanceId],
    );
    return rows.map((row) => ({
      ...normalizeRowMapping(row), host: row.host, port: Number(row.port), label: row.label,
      osType: row.os_type, status: row.status, collectionEnabled: Boolean(row.collection_enabled),
      validFrom: new Date(row.valid_from),
    }));
  }

  async listServerInstances(serverId: number): Promise<HostedInstanceDetail[]> {
    const [rows] = await this.pool().execute<any[]>(
      `SELECT rr.source_id AS instance_id, rr.target_id AS server_id, rr.metadata, rr.valid_from,
              i.name, i.db_type, i.environment, i.status, i.health_status
       FROM resource_relations rr JOIN database_instances i ON i.id = rr.source_id
       WHERE rr.source_type = 'instance' AND rr.target_type = 'server' AND rr.target_id = ?
         AND rr.relation_type = 'runs_on' AND rr.valid_from <= NOW()
         AND (rr.valid_until IS NULL OR rr.valid_until > NOW())
       ORDER BY i.name`,
      [serverId],
    );
    return rows.map((row) => ({
      ...normalizeRowMapping(row), instanceId: Number(row.instance_id), name: row.name,
      dbType: row.db_type, environment: row.environment, status: row.status,
      healthStatus: row.health_status, validFrom: new Date(row.valid_from),
    }));
  }

  async countActiveForServer(serverId: number): Promise<number> {
    const [rows] = await this.pool().execute<any[]>(
      `SELECT COUNT(*) AS count FROM resource_relations
       WHERE source_type = 'instance' AND target_type = 'server' AND target_id = ?
         AND relation_type = 'runs_on' AND valid_from <= NOW()
         AND (valid_until IS NULL OR valid_until > NOW())`,
      [serverId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  private pool(): SqlPool {
    const pool = this.poolProvider();
    if (!pool) throw new Error('RESOURCE_STORE_UNAVAILABLE');
    return pool;
  }
}

export const instanceHostService = new InstanceHostService(new MysqlInstanceHostStore());
