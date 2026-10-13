import { randomUUID } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import type { ActorContext } from '../auth/actor-context.js';
import { evidenceHash, redactEvidence } from '../analysis/analysis-evidence.js';
import { InvestigationStoreError, type AdmissionInvestigation, type InvestigationResource } from './store.js';
import { InvestigationObservationDatabase, appendObservation, observationRows, decode, instant,
  invalidObservation, absentObservation, isId, type ResultBinding } from './observation-db.js';

export interface EvidenceInput {
  source: string; summary: string;
  resources: Array<Pick<InvestigationResource, 'type' | 'id'>>;
  observedFrom: string | null; observedTo: string | null; collectedAt: string; raw: unknown;
}
export interface InvestigationEvidence extends Omit<EvidenceInput, 'raw'>, ResultBinding {
  id: string; contentHash: string; expiresAt: string; status: 'available' | 'expired';
  expiryReason?: 'RETENTION_EXPIRED'; raw?: unknown;
}
const maxRawBytes = 256 * 1024;
export function prepareEvidence(input: EvidenceInput): EvidenceInput & { raw: any; contentHash: string } {
  if (!input || ![input.source, input.summary].every(v => typeof v === 'string' && !!v.trim())
    || input.source.length > 128 || input.summary.length > 2_000
    || !instant(input.collectedAt) || (input.observedFrom === null) !== (input.observedTo === null)
    || input.observedFrom !== null && (!instant(input.observedFrom) || !instant(input.observedTo!)
      || Date.parse(input.observedFrom) > Date.parse(input.observedTo!) || Date.parse(input.observedTo!) > Date.parse(input.collectedAt))
    || !Array.isArray(input.resources) || input.resources.length > 20 || input.resources.some(r => !r
      || !['instance', 'server', 'network_device'].includes(r.type) || !Number.isSafeInteger(r.id) || r.id < 1)
    || new Set(input.resources.map(r => `${r.type}:${r.id}`)).size !== input.resources.length) throw invalidObservation();
  let raw: unknown;
  try {
    if (Buffer.byteLength(JSON.stringify(input.raw)) > maxRawBytes) throw invalidObservation();
    raw = JSON.parse(JSON.stringify(redactEvidence(input.raw)));
  } catch { throw invalidObservation(); }
  return { source: input.source, summary: redactEvidence(input.summary) as string,
    resources: input.resources.map(r => ({ type: r.type, id: r.id })).sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id),
    observedFrom: input.observedFrom, observedTo: input.observedTo, collectedAt: input.collectedAt,
    raw, contentHash: evidenceHash(raw) };
}

/** Trusted execution port; no public append endpoint. A read share/viewer can
 * read an authorized snapshot but cannot create evidence or result facts. */
export class InvestigationEvidenceStore extends InvestigationObservationDatabase {
  /** Called only by the canonical checkpoint owner on its fenced transaction.
   * Unknown observation windows stay null; collection time is the first SQL
   * receipt, reused across recovery rather than invented on each replay. */
  async captureToolResult(c: PoolConnection, actor: ActorContext, investigation: Readonly<AdmissionInvestigation>,
    binding: ResultBinding, entry: { id: string; content: unknown; tool_call_id?: string; timestamp?: string }): Promise<void> {
    const key = `canonical-tool:${entry.id}`;
    const [existing] = await observationRows(c, 'SELECT metadata_json FROM investigation_evidence WHERE investigation_id = ? AND source_key = ?', [investigation.id, Buffer.from(key)]);
    const [clock] = await observationRows(c, 'SELECT NOW(3) AS collected_at');
    const collectedAt = existing ? decode(existing.metadata_json).collectedAt : new Date(clock.collected_at).toISOString();
    let raw = entry.content;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { /* bounded plain tool output */ } }
    const window = raw as { observedFrom?: unknown; observedTo?: unknown } | null;
    const observedFrom = typeof window?.observedFrom === 'string' && instant(window.observedFrom) ? window.observedFrom : null;
    const observedTo = typeof window?.observedTo === 'string' && instant(window.observedTo) ? window.observedTo : null;
    const prepared = prepareEvidence({ source: `tool:${entry.tool_call_id ?? entry.id}`.slice(0, 128),
      summary: '只读工具返回的原始观察；引用关联不代表根因已验证。', resources: investigation.resources.map(r => ({ type: r.type, id: r.id })),
      observedFrom: observedFrom && observedTo ? observedFrom : null, observedTo: observedFrom && observedTo ? observedTo : null, collectedAt, raw });
    await this.putOnConnection(c, actor, investigation, { investigationId: binding.investigationId, requestId: binding.requestId, runId: binding.runId }, key, prepared);
  }
  async put(caller: ActorContext, binding: ResultBinding, key: string, input: EvidenceInput): Promise<InvestigationEvidence> {
    const prepared = prepareEvidence(structuredClone(input));
    binding = { ...binding };
    if (typeof key !== 'string' || !key.trim() || Buffer.byteLength(key) > 255) throw invalidObservation();
    return this.transaction(caller, binding.investigationId, async (c, investigation, actor) => {
      await this.assertBinding(c, actor, investigation, binding);
      return this.putOnConnection(c, actor, investigation, binding, key, prepared);
    });
  }

  /** Caller must already have checked the original request/Run binding. This
   * server-only port composes capture and content under one transaction. */
  async putOnConnection(c: PoolConnection, actor: ActorContext, investigation: Readonly<AdmissionInvestigation>,
    binding: ResultBinding, key: string, prepared: ReturnType<typeof prepareEvidence>): Promise<InvestigationEvidence> {
    for (const r of prepared.resources) if (!investigation.resources.some(x => r.type === x.type && r.id === x.id)) throw absentObservation();
    await this.authorization.authorize(c as never, actor, investigation, 'content', prepared.resources);
    const payloadHash = evidenceHash({ binding, prepared });
    const [existing] = await observationRows(c, 'SELECT * FROM investigation_evidence WHERE investigation_id = ? AND source_key = ? FOR UPDATE', [investigation.id, Buffer.from(key)]);
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new InvestigationStoreError('IDEMPOTENCY_PAYLOAD_MISMATCH');
      return this.view(existing);
    }
    const id = randomUUID(), expiresAt = new Date(Date.parse(prepared.collectedAt) + 7 * 86_400_000);
    const { raw, contentHash, ...metadata } = prepared;
    await c.execute(`INSERT INTO investigation_evidence
      (id, investigation_id, request_id, run_id, source_key, payload_hash, content_hash, metadata_json, raw_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, investigation.id, binding.requestId, binding.runId, Buffer.from(key), payloadHash,
      contentHash, JSON.stringify(metadata), JSON.stringify(raw), expiresAt]);
    await appendObservation(c, investigation.id, `evidence:${id}`, { type: 'evidence.added', requestId: binding.requestId, runId: binding.runId,
      occurredAt: prepared.collectedAt, payload: { evidenceId: id } });
    return { ...metadata, ...binding, id, contentHash, expiresAt: expiresAt.toISOString(), status: expiresAt.getTime() <= Date.now() ? 'expired' : 'available' };
  }
  private view(row: any): InvestigationEvidence {
    const expired = row.expired_at !== null || new Date(row.expires_at).getTime() <= Date.now();
    return { ...decode(row.metadata_json), id: row.id, investigationId: row.investigation_id, requestId: row.request_id,
      runId: row.run_id, contentHash: row.content_hash, expiresAt: new Date(row.expires_at).toISOString(),
      status: expired ? 'expired' : 'available', ...(expired ? { expiryReason: 'RETENTION_EXPIRED' as const } : {}) };
  }
  async get(caller: ActorContext, id: string, evidenceId: string, raw = false): Promise<InvestigationEvidence> {
    if (!isId(evidenceId)) throw invalidObservation();
    return this.transaction(caller, id, async (c, investigation, actor) => {
      const [row] = await observationRows(c, 'SELECT * FROM investigation_evidence WHERE id = ? AND investigation_id = ? FOR UPDATE', [evidenceId, id]);
      if (!row) throw absentObservation();
      const view = this.view(row);
      await this.authorization.authorize(c as never, actor, investigation, 'content', view.resources);
      if (view.status === 'expired') {
        await c.execute('UPDATE investigation_evidence SET raw_json = NULL, expired_at = COALESCE(expired_at, NOW(3)) WHERE id = ?', [evidenceId]);
        // Commit purge first; the outer HTTP/WS boundary maps the returned
        // tombstone to 410 only for an explicitly requested raw snapshot.
        return view;
      }
      if (raw) return { ...view, raw: decode(row.raw_json) };
      return view;
    });
  }
  /** Explicit bounded maintenance; no timer or paid/external work. */
  async expire(caller: ActorContext, id: string, limit = 200): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw invalidObservation();
    return this.transaction(caller, id, async (c, investigation, actor) => {
      await this.authorization.authorize(c as never, actor, investigation, 'continue');
      const rows = await observationRows(c, 'SELECT id FROM investigation_evidence WHERE investigation_id = ? AND expires_at <= NOW(3) AND raw_json IS NOT NULL ORDER BY expires_at, id LIMIT ? FOR UPDATE', [id, limit]);
      for (const row of rows) await c.execute('UPDATE investigation_evidence SET raw_json = NULL, expired_at = COALESCE(expired_at, NOW(3)) WHERE id = ?', [row.id]);
      return rows.length;
    });
  }
  /** Trusted server maintenance deletes expired sensitive bodies only. It
   * cannot expose content, create facts, change authorization or remove hashes.
   * No model/tool/public route receives this maintenance capability. */
  async purgeExpired(limit = 200): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw invalidObservation();
    const pool = this.poolProvider();
    if (!pool) throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const rows = await observationRows(c, `SELECT id FROM investigation_evidence WHERE expires_at <= NOW(3) AND raw_json IS NOT NULL
        ORDER BY expires_at, id LIMIT ? FOR UPDATE SKIP LOCKED`, [limit]);
      for (const row of rows) await c.execute('UPDATE investigation_evidence SET raw_json = NULL, expired_at = COALESCE(expired_at, NOW(3)) WHERE id = ?', [row.id]);
      await c.commit(); return rows.length;
    } catch (error) { await c.rollback(); throw error; } finally { c.release(); }
  }
}
