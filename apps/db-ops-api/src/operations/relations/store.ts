import { randomBytes } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { dbConnection } from '../../db-connection.js';
import type { ResourceRef } from '../../resources/types.js';
import { OperationsError, operationsContentHash, type OperationsPrincipal, type RelationRevision } from '../contracts.js';

export interface StoredRelation extends RelationRevision {
  origin: 'manual' | 'collector' | 'model' | 'legacy';
  author: OperationsPrincipal | null;
  confirmedBy: number | null;
  confirmedAt: string | null;
  withdrawalReason: string | null;
}
export interface RelationSession {
  connection: PoolConnection;
  lockResources(refs: readonly ResourceRef[]): Promise<void>;
  lockHead(id: string): Promise<void>;
  legacyActive(value: StoredRelation, now: Date): Promise<boolean>;
  head(id: string): Promise<StoredRelation | null>;
  adjacent(ref: ResourceRef, limit: number): Promise<StoredRelation[]>;
  history(id: string, before: number, limit: number): Promise<StoredRelation[]>;
  append(value: StoredRelation): Promise<void>;
}
export interface RelationStore {
  transaction<T>(work: (session: RelationSession) => Promise<T>): Promise<T>;
}
const tables = { instance: 'database_instances', server: 'servers', network_device: 'network_devices' } as const;
const iso = (value: string | Date): string => new Date(value).toISOString();
function revision(row: any): StoredRelation {
  const provenance = typeof row.provenance === 'string' ? JSON.parse(row.provenance) : row.provenance;
  return { schemaVersion: 1, id: String(row.relation_id), relationId: String(row.relation_id), version: Number(row.version),
    contentHash: row.content_hash, source: { type: row.source_type, id: Number(row.source_id) },
    target: { type: row.target_type, id: Number(row.target_id) }, relationType: row.relation_type,
    state: row.state, evidence: provenance.evidence, origin: provenance.origin, author: provenance.author,
    observedAt: iso(row.observed_at), validFrom: iso(row.valid_from), validUntil: row.valid_until ? iso(row.valid_until) : null,
    legacyProvenance: row.legacy_provenance, confirmedBy: row.confirmed_by === null ? null : Number(row.confirmed_by),
    confirmedAt: row.confirmed_at ? iso(row.confirmed_at) : null, withdrawalReason: row.withdrawal_reason };
}
function legacy(row: any): StoredRelation {
  // Historical hosts rows are normalized on read; new writes always use runs_on.
  const reverse = row.relation_type === 'hosts';
  const value: StoredRelation = { schemaVersion: 1, id: String(row.id), relationId: String(row.id), version: 0, contentHash: '',
    source: { type: reverse ? row.target_type : row.source_type, id: Number(reverse ? row.target_id : row.source_id) },
    target: { type: reverse ? row.source_type : row.target_type, id: Number(reverse ? row.source_id : row.target_id) },
    relationType: reverse ? 'runs_on' : row.relation_type, state: 'suggested', origin: 'legacy', author: null, evidence: [],
    legacyProvenance: row.provenance, observedAt: iso(row.valid_from), validFrom: iso(row.valid_from),
    validUntil: row.valid_until ? iso(row.valid_until) : null, confirmedBy: null, confirmedAt: null, withdrawalReason: null };
  value.contentHash = relationHash(value);
  return value;
}
export function relationHash(value: StoredRelation): string {
  const { contentHash: _ignored, ...content } = value;
  return operationsContentHash(content);
}
/** New identities stay in the revision table. In particular, a suggested
 * runs_on must never become an active mapping in the legacy hosts API. */
export function newRelationId(): string { return String(2 ** 50 + randomBytes(6).readUIntBE(0, 6)); }

export class MysqlRelationStore implements RelationStore {
  constructor(private readonly pool: () => Pool | null = () => dbConnection.getPool()) {}
  async transaction<T>(work: (session: RelationSession) => Promise<T>): Promise<T> {
    const pool = this.pool();
    if (!pool) throw new OperationsError('OPERATIONS_DEPENDENCY_UNAVAILABLE');
    const connection = await pool.getConnection();
    try {
      // Re-read permission/resource changes rather than a repeatable-read snapshot.
      await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await connection.beginTransaction();
      const result = await work(new MysqlRelationSession(connection));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally { connection.release(); }
  }
}
class MysqlRelationSession implements RelationSession {
  constructor(readonly connection: PoolConnection) {}
  async lockHead(id: string): Promise<void> {
    await this.connection.execute('SELECT version FROM resource_relation_revisions WHERE relation_id=? ORDER BY version DESC LIMIT 1 FOR UPDATE', [id]);
  }
  async legacyActive(value: StoredRelation, now: Date): Promise<boolean> {
    if (value.legacyProvenance === null) return true;
    const [rows] = await this.connection.execute<any[]>(
      'SELECT id FROM resource_relations WHERE id=? AND valid_from<=? AND (valid_until IS NULL OR valid_until>?)', [value.relationId, now, now]);
    return rows.length === 1;
  }
  async lockResources(refs: readonly ResourceRef[]): Promise<void> {
    for (const ref of [...new Map(refs.map(ref => [`${ref.type}:${ref.id}`, ref])).values()]
      .sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id)) {
      const [rows] = await this.connection.execute<any[]>(`SELECT id FROM ${tables[ref.type]} WHERE id = ? FOR UPDATE`, [ref.id]);
      if (rows.length !== 1) throw new OperationsError('OPERATIONS_NOT_FOUND');
    }
  }
  async head(id: string): Promise<StoredRelation | null> {
    const [rows] = await this.connection.execute<any[]>(
      'SELECT * FROM resource_relation_revisions WHERE relation_id = ? ORDER BY version DESC LIMIT 1', [id]);
    if (rows[0]) return revision(rows[0]);
    const [old] = await this.connection.execute<any[]>('SELECT * FROM resource_relations WHERE id = ?', [id]);
    return old[0] ? legacy(old[0]) : null;
  }
  async adjacent(ref: ResourceRef, limit: number): Promise<StoredRelation[]> {
    // Apply the bound to the combined legacy/revision set, not to either half.
    const [ids] = await this.connection.execute<any[]>(`SELECT relation_id FROM (
      SELECT r.relation_id FROM resource_relation_revisions r
      WHERE ((r.source_type = ? AND r.source_id = ?) OR (r.target_type = ? AND r.target_id = ?))
        AND NOT EXISTS (SELECT 1 FROM resource_relation_revisions n WHERE n.relation_id=r.relation_id AND n.version>r.version)
      UNION ALL SELECT l.id FROM resource_relations l
      WHERE ((l.source_type = ? AND l.source_id = ?) OR (l.target_type = ? AND l.target_id = ?))
        AND NOT EXISTS (SELECT 1 FROM resource_relation_revisions r WHERE r.relation_id=l.id)
      ) candidates ORDER BY relation_id LIMIT ${limit}`, [ref.type, ref.id, ref.type, ref.id, ref.type, ref.id, ref.type, ref.id]);
    const result: StoredRelation[] = [];
    for (const row of ids) { const value = await this.head(String(row.relation_id)); if (value) result.push(value); }
    return result;
  }
  async history(id: string, before: number, limit: number): Promise<StoredRelation[]> {
    const [rows] = await this.connection.execute<any[]>(
      `SELECT * FROM resource_relation_revisions WHERE relation_id=? AND version<? ORDER BY version DESC LIMIT ${limit}`, [id, before]);
    return rows.map(revision);
  }
  async append(value: StoredRelation): Promise<void> {
    await this.connection.execute(`INSERT INTO resource_relation_revisions
      (relation_id,version,schema_version,source_type,source_id,target_type,target_id,relation_type,state,content_hash,
       provenance,legacy_provenance,observed_at,confirmed_by,confirmed_at,valid_from,valid_until,withdrawal_reason)
      VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [value.relationId, value.version, value.source.type, value.source.id,
      value.target.type, value.target.id, value.relationType, value.state, value.contentHash,
      JSON.stringify({ evidence: value.evidence, origin: value.origin, author: value.author }), value.legacyProvenance,
      new Date(value.observedAt), value.confirmedBy, value.confirmedAt ? new Date(value.confirmedAt) : null,
      new Date(value.validFrom), value.validUntil ? new Date(value.validUntil) : null, value.withdrawalReason]);
  }
}
