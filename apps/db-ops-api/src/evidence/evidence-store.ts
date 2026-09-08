import { Value } from '@sinclair/typebox/value';
import { dbConnection } from '../db-connection.js';
import type { ActorContext } from '../auth/actor-context.js';
import { canReadResource } from '../resources/resource-service.js';
import type { ResourceRef } from '../resources/types.js';
import { EvidenceResourceSchema, validateEvidenceItem, type EvidenceItem } from './evidence-contract.js';
export interface EvidenceQuery { from: string; to: string; limit: number; correlationId?: string; }
interface Executor { execute(sql: string, values?: any[]): Promise<any>; }
export function authorizeEvidence(actor: ActorContext, ref: ResourceRef): void {
  if (!actor || !Number.isSafeInteger(actor.userId) || actor.userId < 1) throw new Error('MISSING_ACTOR');
  if (!Value.Check(EvidenceResourceSchema, ref)) throw new Error('RESOURCE_REF_INVALID');
  if (!canReadResource(actor, ref)) throw new Error('RESOURCE_FORBIDDEN');
}
export function validateEvidenceQuery(query: EvidenceQuery): void {
  const from = Date.parse(query.from), to = Date.parse(query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to - from > 7 * 86400_000
    || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100
    || (query.correlationId !== undefined && (!query.correlationId.length || query.correlationId.length > 128))) throw new Error('EVIDENCE_QUERY_INVALID');
}
export class EvidenceStore {
  constructor(private readonly pool: () => Executor | null = () => dbConnection.getPool()) {}
  private executor(): Executor { const pool = this.pool(); if (!pool) throw new Error('EVIDENCE_STORAGE_UNAVAILABLE'); return pool; }
  async put(actor: ActorContext, item: EvidenceItem): Promise<void> {
    if (!validateEvidenceItem(item)) throw new Error('EVIDENCE_INVALID');
    const ref = item.subject.resource; authorizeEvidence(actor, ref);
    await this.executor().execute(`INSERT INTO agent_evidence (owner_user_id, resource_type, resource_id, id, correlation_id, evidence_json, observed_at, valid_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id`,
    [actor.userId, ref.type, ref.id, item.id, item.correlationId, JSON.stringify(item), new Date(item.observedAt), new Date(item.validUntil)]);
  }
  private decode(rows: any[], ref: ResourceRef): EvidenceItem[] {
    return rows.map(row => { try { return typeof row.evidence_json === 'string' ? JSON.parse(row.evidence_json) : row.evidence_json; } catch { return null; } })
      .filter((item): item is EvidenceItem => validateEvidenceItem(item) && item.subject.resource.type === ref.type && item.subject.resource.id === ref.id);
  }
  async query(actor: ActorContext, ref: ResourceRef, query: EvidenceQuery): Promise<EvidenceItem[]> {
    authorizeEvidence(actor, ref); validateEvidenceQuery(query);
    const values: unknown[] = [actor.userId, ref.type, ref.id, new Date(query.from), new Date(query.to)];
    if (query.correlationId) values.push(query.correlationId);
    const [rows] = await this.executor().execute(`SELECT evidence_json FROM agent_evidence WHERE owner_user_id = ? AND resource_type = ? AND resource_id = ? AND observed_at >= ? AND observed_at <= ?${query.correlationId ? ' AND correlation_id = ?' : ''} ORDER BY observed_at DESC, id ASC LIMIT ${query.limit}`, values);
    return this.decode(rows, ref);
  }
  async getById(actor: ActorContext, ref: ResourceRef, id: string): Promise<EvidenceItem | null> {
    authorizeEvidence(actor, ref);
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('EVIDENCE_ID_INVALID');
    const [rows] = await this.executor().execute('SELECT evidence_json FROM agent_evidence WHERE owner_user_id = ? AND resource_type = ? AND resource_id = ? AND id = ? LIMIT 1', [actor.userId, ref.type, ref.id, id]);
    return this.decode(rows, ref).find(item => item.id === id) ?? null;
  }
}
export const evidenceStore = new EvidenceStore();
