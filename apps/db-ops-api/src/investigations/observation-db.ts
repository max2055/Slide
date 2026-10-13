import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { ActorContext } from '../auth/actor-context.js';
import { dbConnection } from '../db-connection.js';
import { evidenceHash } from '../analysis/analysis-evidence.js';
import { InvestigationAuthorization, freezeInvestigationCaller } from './authorization.js';
import { InvestigationStoreError, type AdmissionInvestigation } from './store.js';
import { validateInvestigationStreamEvent, type InvestigationStreamEvent } from './contracts.js';

export const decode = (value: any): any => typeof value === 'string' ? JSON.parse(value) : value;
export const invalidObservation = () => new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
export const absentObservation = () => new InvestigationStoreError('INVESTIGATION_NOT_FOUND');
export const isId = (value: string) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const instant = (value: string) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export async function observationRows(c: Pick<PoolConnection, 'execute'>, sql: string, values: any[] = []): Promise<RowDataPacket[]> {
  return (await c.execute<RowDataPacket[]>(sql, values))[0];
}
export interface ResultBinding { investigationId: string; requestId: string; runId: string; }
type EventInput = InvestigationStreamEvent extends infer E ? E extends InvestigationStreamEvent ? Omit<E, 'sequence' | 'schemaVersion' | 'investigationId'> : never : never;

/** Only ordinals allocated by this store are excluded from content identity.
 * All source data, including Parts operations and timestamps, remain binding. */
function observationIdentity(event: InvestigationStreamEvent): unknown {
  return { ...event, sequence: 0, ...(event.type === 'parts.operation'
    ? { payload: { ...event.payload, sequence: 0 } } : {}) };
}

/** Caller holds Session -> Investigation locks. The head participates in the
 * same transaction as the content; rollback cannot advance a cursor. */
export async function appendObservation(c: PoolConnection, id: string, source: string, input: EventInput): Promise<number> {
  if (Buffer.byteLength(source) > 255) throw invalidObservation();
  await c.execute('INSERT INTO investigation_stream_heads (investigation_id) VALUES (?) ON DUPLICATE KEY UPDATE sequence = sequence', [id]);
  const [head] = await observationRows(c, 'SELECT sequence FROM investigation_stream_heads WHERE investigation_id = ? FOR UPDATE', [id]);
  const [existing] = await observationRows(c, 'SELECT sequence, event_json FROM investigation_stream_events WHERE investigation_id = ? AND source_key = ?', [id, Buffer.from(source)]);
  if (existing) {
    const previous = decode(existing.event_json);
    if (evidenceHash(observationIdentity(previous)) !== evidenceHash(observationIdentity({ ...input, schemaVersion: 1, investigationId: id, sequence: 0 })))
      throw new InvestigationStoreError('IDEMPOTENCY_PAYLOAD_MISMATCH');
    return Number(existing.sequence);
  }
  const sequence = Number(head.sequence) + 1;
  const event = { ...input, schemaVersion: 1, investigationId: id, sequence };
  if (event.type === 'parts.operation') event.payload = { ...event.payload, sequence };
  if (!Number.isSafeInteger(sequence) || !validateInvestigationStreamEvent(event).ok) throw invalidObservation();
  await c.execute('INSERT INTO investigation_stream_events (investigation_id, sequence, source_key, event_json, occurred_at) VALUES (?, ?, ?, ?, ?)',
    [id, sequence, Buffer.from(source), JSON.stringify(event), new Date(event.occurredAt)]);
  await c.execute('UPDATE investigation_stream_heads SET sequence = ? WHERE investigation_id = ?', [sequence, id]);
  return sequence;
}

/** Source checkpoints outlive replay retention, so pruning/restart never
 * recaptures unchanged messages or resurrects an expired event. */
export async function captureObservation(c: PoolConnection, id: string, source: string, input: EventInput): Promise<void> {
  const payloadHash = evidenceHash(input);
  const [prior] = await observationRows(c, 'SELECT payload_hash FROM investigation_observed_sources WHERE investigation_id = ? AND source_key = ? FOR UPDATE', [id, Buffer.from(source)]);
  if (prior?.payload_hash === payloadHash) return;
  await appendObservation(c, id, `${source}:${payloadHash}`, input);
  await c.execute('INSERT INTO investigation_observed_sources (investigation_id, source_key, payload_hash) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE payload_hash = VALUES(payload_hash)', [id, Buffer.from(source), payloadHash]);
}

/** This common content boundary uses real current principal/membership/Profile
 * and ALL required resource scopes, including evidence-specific scopes. */
export class InvestigationObservationDatabase {
  constructor(protected readonly poolProvider: () => Pool | null = () => dbConnection.getPool(),
    protected readonly authorization = new InvestigationAuthorization()) {}
  async transaction<T>(caller: ActorContext, id: string,
    work: (c: PoolConnection, investigation: Readonly<AdmissionInvestigation>, actor: ActorContext) => Promise<T>): Promise<T> {
    if (!isId(id)) throw invalidObservation();
    const actor = freezeInvestigationCaller(caller);
    const pool = this.poolProvider();
    if (!pool) throw new InvestigationStoreError('INVESTIGATION_QUEUE_UNAVAILABLE');
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [binding] = await observationRows(c, 'SELECT session_id FROM investigations WHERE id = ?', [id]);
      if (!binding) throw absentObservation();
      await c.execute('SELECT id FROM chat_sessions WHERE session_id = ? FOR UPDATE', [binding.session_id]);
      await c.execute('SELECT id FROM investigations WHERE id = ? FOR UPDATE', [id]);
      const investigation = await this.authorization.load(c as never, id);
      await this.authorization.authorize(c as never, actor, investigation, 'content');
      const value = await work(c, investigation, actor);
      await c.commit();
      return value;
    } catch (error) { await c.rollback(); throw error; }
    finally { c.release(); }
  }
  async assertBinding(c: PoolConnection, actor: ActorContext, investigation: Readonly<AdmissionInvestigation>, binding: ResultBinding): Promise<any> {
    if (!isId(binding.requestId) || typeof binding.runId !== 'string' || binding.runId.length > 100 || binding.investigationId !== investigation.id) throw invalidObservation();
    const [request] = await observationRows(c, 'SELECT * FROM investigation_requests WHERE id = ? AND investigation_id = ? FOR SHARE', [binding.requestId, investigation.id]);
    const [run] = await observationRows(c, 'SELECT * FROM agent_runs WHERE id = ? FOR SHARE', [binding.runId]);
    if (!request || !run || run.session_id !== investigation.sessionId || run.message_id !== request.message_id
      || run.idempotency_key !== `investigation:${request.id}` || Number(run.actor_id) !== Number(request.actor_id)
      || request.actor_kind !== (actor.principalKind ?? 'user') || Number(request.actor_id) !== actor.userId) throw absentObservation();
    const snapshot = decode(request.request_snapshot);
    if (!snapshot.authority || snapshot.sessionId !== investigation.sessionId) throw absentObservation();
    await this.authorization.authorize(c as never, actor, investigation, 'continue', [], snapshot.authority);
    return { request, run, snapshot };
  }
}
