import { dbConnection } from '../db-connection.js';
import { chatDatabaseService } from '../chat-database-service.js';
import type { TransactionConnection } from '../workflows/outbox-service.js';
import { InvestigationAuthorization, type InvestigationAuthoritySnapshot } from '../investigations/authorization.js';
import type { ActorContext } from '../auth/actor-context.js';
import { memoryHash, readMessageParts, type MemoryInput, type SessionEntry, type MessagePart } from '@slide/agent-core';
import { persistedMessageParts, recordMessageParts } from './message-parts.js';

interface Executor { query<T = any>(sql: string, values?: unknown[]): Promise<[T, unknown?]>; }
interface Connection extends Executor { beginTransaction(): Promise<void>; commit(): Promise<void>; rollback(): Promise<void>; release(): void; }
interface Pool extends Executor { getConnection(): Promise<Connection>; }
export interface InvestigationExecutionBinding {
  investigationId: string; requestId: string; jobId: string; runId: string;
  workerId: string; fencingToken: number;
}
export type InvestigationConnection = TransactionConnection & Executor;
export interface InvestigationExecutionAccess {
  sessionId: string; messageId: string; authority: InvestigationAuthoritySnapshot;
  request: any; run: any; checkpoint: Record<string, unknown> | null;
}
const decode = (value: any) => typeof value === 'string' ? JSON.parse(value) : value;
const MAX_FACTS = 100_000;
const MAX_FACT_BYTES = 4 * 1024 * 1024;
function stable(value: unknown): string {
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value));
}
const FINAL_ORDINAL = 9_000_000_000;

/** A durable fact's entire JSON payload is immutable, except its explicit
 * acknowledgement/tool lifecycle. Compare the proposed successor against a
 * copy of the prior fact with only those permitted fields advanced. Unknown
 * fields, metadata, legacy projection, IDs and part order remain significant.
 */
function successor(prior: SessionEntry, next: SessionEntry): boolean {
  const expected = structuredClone(prior);
  const before = expected.messageParts, after = next.messageParts;
  if (!before || !after || before.parts.length !== after.parts.length) return false;
  const advanceStatus = (old: string, proposed: string) => old === proposed || old === 'partial' && proposed === 'completed';
  if (!advanceStatus(before.status, after.status)) return false;
  before.status = after.status;
  for (let i = 0; i < before.parts.length; i++) {
    const old = before.parts[i], proposed = after.parts[i];
    if (!advanceStatus(old.status, proposed.status)) return false;
    old.status = proposed.status;
    if (old.generation === 'open' && proposed.generation === 'ended') old.generation = 'ended';
    if (!advanceTool(old, proposed)) return false;
  }
  return stable(expected) === stable(next);
}

function advanceTool(old: MessagePart, next: MessagePart): boolean {
  if (stable(old.tool) === stable(next.tool)) return true;
  if (old.type !== 'tool_call' || next.type !== 'tool_call' || !old.tool || !next.tool) return false;
  const phases = ['planned', 'queued', 'running', 'settled', 'persisted'];
  const a = old.tool, b = next.tool;
  const rank = phases.indexOf(a.phase), nextRank = phases.indexOf(b.phase);
  if (rank < 0 || nextRank < rank || !Number.isFinite(b.occurredAt) || b.occurredAt < a.occurredAt) return false;
  if (rank >= phases.indexOf('settled') && rank === nextRank && a.occurredAt !== b.occurredAt) return false;
  if (a.outcome !== undefined && a.outcome !== b.outcome) return false;
  // Once settled, outcome/preview/progress and settlement time are facts.
  // Persistence may only acknowledge them and add its own timestamp.
  const expected = structuredClone(a);
  expected.phase = b.phase; expected.occurredAt = b.occurredAt;
  if (rank < phases.indexOf('settled')) {
    for (const key of ['outcome', 'preview', 'progress', 'settledAt'] as const) {
      if (b[key] !== undefined) Object.assign(expected, { [key]: structuredClone(b[key]) });
    }
    if (a.startedAt === undefined && b.startedAt !== undefined) expected.startedAt = b.startedAt;
  }
  if (a.persistedAt === undefined && b.phase === 'persisted' && b.persistedAt !== undefined) expected.persistedAt = b.persistedAt;
  if (stable(expected) !== stable(b)) return false;
  old.tool = expected;
  return true;
}

/** MySQL is authoritative for actor-owned chats. JSONL is a disposable cache.
 * Existing DB message IDs are already durable: no replacement IDs or double writes.
 */
export class CanonicalStore {
  constructor(private readonly poolProvider: () => Pool | null = () => dbConnection.getPool() as unknown as Pool,
    private readonly authorization = new InvestigationAuthorization()) {}
  private pool(): Pool { const pool = this.poolProvider(); if (!pool) throw new Error('Canonical database unavailable'); return pool; }

  async saveCheckpoint(actor: ActorContext, sessionId: string, checkpoint: Record<string, unknown> | null): Promise<void> {
    const [result] = await this.pool().query<{ affectedRows: number }>(
      `UPDATE chat_sessions SET metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.canonicalRuntimeCheckpoint', CAST(? AS JSON))
       WHERE session_id = ? AND user_id = ?`, [JSON.stringify(checkpoint), sessionId, actor.userId]);
    if (result.affectedRows !== 1) throw new Error('Chat session not found');
  }

  async appendToolFacts(actor: ActorContext, sessionId: string, userId: string, entries: SessionEntry[], iteration: number, checkpoint?: Record<string, unknown>): Promise<void> {
    if (!entries.length) return;
    if (!Number.isSafeInteger(iteration) || iteration < 0 || iteration > 100_000) throw new Error('INVALID_CANONICAL_ORDINAL');
    await chatDatabaseService.authorizeSession(actor, sessionId, 'append');
    const connection = await this.pool().getConnection();
    try {
      await connection.beginTransaction();
      // Serialize fact writes and verify ownership again inside the transaction.
      const [owners] = await connection.query<any[]>('SELECT session_id FROM chat_sessions WHERE session_id = ? AND user_id = ? FOR UPDATE', [sessionId, actor.userId]);
      if (!owners.length) throw new Error('Chat session not found');
      await this.writeToolFacts(connection, sessionId, userId, entries, iteration);
      if (checkpoint) await this.writeCheckpoint(connection, sessionId, checkpoint);
      await connection.commit();
    } catch (error) { try { await connection.rollback(); } catch { /* retain original */ } throw error; }
    finally { connection.release(); }
  }

  private async writeCheckpoint(connection: Executor, sessionId: string, checkpoint: Record<string, unknown> | null): Promise<void> {
    await connection.query("UPDATE chat_sessions SET metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.canonicalRuntimeCheckpoint', CAST(? AS JSON)) WHERE session_id = ?",
      [JSON.stringify(checkpoint), sessionId]);
  }

  private async writeToolFacts(connection: Executor, sessionId: string, userId: string, entries: SessionEntry[], iteration: number): Promise<void> {
    if (!Number.isSafeInteger(iteration) || iteration < 0 || iteration > 100_000 || entries.length > 10_000) throw new Error('INVALID_CANONICAL_ORDINAL');
      const [turns] = await connection.query<any[]>("SELECT id FROM chat_messages WHERE session_id = ? AND message_id = ? AND role = 'user'", [sessionId, userId]);
      if (!turns.length) throw new Error('CANONICAL_TURN_NOT_FOUND');
      const [counts] = await connection.query<any[]>('SELECT COUNT(*) AS total FROM agent_canonical_facts WHERE session_id = ?', [sessionId]);
      for (let index = 0; index < entries.length; index++) {
        // Do not let acknowledgement normalization erase a terminal conflict.
        const supplied = entries[index].messageParts;
        const invalidBoundary = (boundary: { status: string; durable?: { kind: string; reference: string } }) =>
          boundary.status === 'failed' || boundary.status === 'discarded'
          || boundary.durable && (boundary.durable.kind !== 'checkpoint' || boundary.durable.reference !== entries[index].id);
        if (supplied && (invalidBoundary(supplied) || supplied.runTerminal !== undefined || supplied.parts?.some(invalidBoundary)))
          throw new Error('CANONICAL_ID_CONFLICT');
        const pending = entries[index].tool_calls?.some(call => !entries.some(result => result.role === 'tool' && result.tool_call_id === call.id));
        const entry = persistedMessageParts(entries[index], 'checkpoint', pending ? 'partial' : 'completed');
        if (!entry.id || (entry.source && entry.source !== 'fact') || !(entry.role === 'tool' || (entry.role === 'assistant' && entry.tool_calls?.length))) throw new Error('INVALID_CANONICAL_FACT');
        const json = JSON.stringify(entry);
        if (Buffer.byteLength(json) > MAX_FACT_BYTES) throw new Error('CANONICAL_CAPACITY_EXCEEDED');
        const persisted: SessionEntry = JSON.parse(json);
        readMessageParts(persisted.messageParts);
        const [existing] = await connection.query<any[]>('SELECT entry_json, turn_sequence FROM agent_canonical_facts WHERE session_id = ? AND message_id = ?', [sessionId, entry.id]);
        if (existing.length) {
          const prior = typeof existing[0].entry_json === 'string' ? JSON.parse(existing[0].entry_json) : existing[0].entry_json;
          if (String(existing[0].turn_sequence) !== String(turns[0].id)) throw new Error('CANONICAL_ID_CONFLICT');
          // A crash anchor precedes the post-COMMIT tool_persisted event. The
          // storage-owned receipt time may be absent from that replay; it cannot
          // revoke an acknowledgement already in SQL. Explicit timestamps and
          // every other field are still compared, so content conflicts reject.
          for (const part of persisted.messageParts!.parts) {
            const receipt = prior.messageParts?.parts.find((p: MessagePart) => p.id === part.id)?.tool;
            if (part.type === 'tool_call' && part.tool?.phase === 'persisted' && part.tool.persistedAt === undefined
              && receipt?.phase === 'persisted' && receipt.persistedAt !== undefined) part.tool.persistedAt = receipt.persistedAt;
          }
          // MySQL reorders object keys; compare the complete JSON value, not a
          // subset of fields or serializer order. Exact replay performs no UPDATE.
          if (stable(prior) === stable(persisted)) continue;
          // Pre-upgrade tool facts use the same deterministic legacy defaults
          // as getPage. Equivalent replay remains read-only; never backfill or
          // overwrite their committed JSON just to enrich display identities.
          const compatible = persistedMessageParts(prior, 'checkpoint', prior.messageParts?.status);
          if (stable(compatible) === stable(persisted)) continue;
          if (!successor(prior, persisted)) throw new Error('CANONICAL_ID_CONFLICT');
          const advancedJson = JSON.stringify(persisted);
          if (Buffer.byteLength(advancedJson) > MAX_FACT_BYTES) throw new Error('CANONICAL_CAPACITY_EXCEEDED');
          await connection.query(
            'UPDATE agent_canonical_facts SET entry_json = ? WHERE session_id = ? AND message_id = ?', [advancedJson, sessionId, entry.id]);
          continue;
        }
        if (++counts[0].total > MAX_FACTS) throw new Error('CANONICAL_CAPACITY_EXCEEDED');
        // Tool ordinal follows the assistant's call list, independent of completion order.
        const ordinal = iteration * 10_000 + index + 1;
        await connection.query('INSERT INTO agent_canonical_facts (session_id, message_id, turn_sequence, ordinal, entry_json) VALUES (?, ?, ?, ?, ?)',
          [sessionId, entry.id, turns[0].id, ordinal, json]);
      }
  }

  /** Trusted internal port, on the caller's checked-out transaction. No boolean
   * authorization receipt is accepted. Locks compose with admission/cancellation;
   * the Run is locked last and ordinary Chat cannot append to linked Sessions. */
  async assertInvestigationLease(connection: InvestigationConnection, binding: Omit<InvestigationExecutionBinding, 'runId'>): Promise<void> {
    const [rows] = await connection.query<any[]>(`SELECT id FROM workflow_jobs WHERE id = ? AND state = 'running'
      AND lease_owner = ? AND fencing_token = ? AND lease_expires_at > NOW(3) FOR UPDATE`, [binding.jobId,binding.workerId,binding.fencingToken]);
    if (!rows[0]) throw new Error('INVESTIGATION_FENCE_LOST');
  }

  async lockInvestigationRequest(connection: InvestigationConnection, caller: ActorContext,
    binding: Omit<InvestigationExecutionBinding, 'runId'>): Promise<Omit<InvestigationExecutionAccess, 'run'>> {
    const [locations] = await connection.query<any[]>('SELECT session_id FROM investigations WHERE id = ?', [binding.investigationId]);
    if (!locations[0]) throw new Error('INVESTIGATION_EXECUTION_INVALID');
    const sessionId = locations[0].session_id;
    const [sessions] = await connection.query<any[]>('SELECT * FROM chat_sessions WHERE session_id = ? FOR UPDATE', [sessionId]);
    const [investigations] = await connection.query<any[]>('SELECT * FROM investigations WHERE id = ? FOR UPDATE', [binding.investigationId]);
    const investigation = investigations[0];
    const [requests] = await connection.query<any[]>('SELECT * FROM investigation_requests WHERE id = ? FOR UPDATE', [binding.requestId]);
    const request = requests[0];
    if (!sessions[0] || !investigation || investigation.session_id !== sessionId || investigation.active_request_id !== binding.requestId
      || !request || request.investigation_id !== binding.investigationId || request.job_id !== binding.jobId
      || request.actor_kind !== (caller.principalKind ?? 'user') || Number(request.actor_id) !== caller.userId
      || Number(sessions[0].user_id) !== Number(investigation.owner_id) || !request.message_id)
      throw new Error('INVESTIGATION_EXECUTION_INVALID');
    const [jobs] = await connection.query<any[]>("SELECT *, lease_expires_at > NOW(3) AS live FROM workflow_jobs WHERE id = ? FOR UPDATE", [binding.jobId]);
    const job = jobs[0], payload = job && decode(job.payload);
    if (!job || job.state !== 'running' || !job.live || job.lease_owner !== binding.workerId
      || Number(job.fencing_token) !== binding.fencingToken || job.job_type !== 'investigation.execute'
      || payload?.investigationId !== binding.investigationId || payload?.requestId !== binding.requestId)
      throw new Error('INVESTIGATION_FENCE_LOST');
    if (request.cancel_requested_at) throw new Error('INVESTIGATION_CANCELLED');
    const [turns] = await connection.query<any[]>("SELECT id, content FROM chat_messages WHERE session_id = ? AND message_id = ? AND role = 'user'", [sessionId, request.message_id]);
    const snapshot = decode(request.request_snapshot);
    if (!turns[0] || turns[0].content !== snapshot.message || snapshot.actor?.kind !== request.actor_kind
      || snapshot.actor?.id !== Number(request.actor_id) || snapshot.sessionId !== sessionId || !snapshot.authority)
      throw new Error('INVESTIGATION_EXECUTION_INVALID');
    const record = await this.authorization.load(connection, binding.investigationId);
    await this.authorization.authorize(connection, caller, record, 'continue', [], snapshot.authority);
    await this.assertInvestigationLease(connection,binding);
    return { sessionId, messageId: request.message_id, authority: snapshot.authority, request,
      checkpoint: decode(sessions[0].metadata)?.canonicalRuntimeCheckpoint ?? null };
  }
  async lockInvestigationExecution(connection: InvestigationConnection, caller: ActorContext,
    binding: InvestigationExecutionBinding): Promise<InvestigationExecutionAccess> {
    const access = await this.lockInvestigationRequest(connection, caller, binding);
    const { sessionId, request } = access;
    const [runs] = await connection.query<any[]>('SELECT * FROM agent_runs WHERE id = ? FOR UPDATE', [binding.runId]);
    const run = runs[0];
    if (!run || run.state !== 'running' || Number(run.actor_id) !== caller.userId || run.session_id !== sessionId
      || run.message_id !== request.message_id || run.idempotency_key !== `investigation:${request.id}`)
      throw new Error('INVESTIGATION_RUN_INVALID');
    await this.assertInvestigationLease(connection,binding);
    return { ...access, run };
  }


  async appendInvestigationToolFacts(connection: InvestigationConnection, caller: ActorContext,
    binding: InvestigationExecutionBinding, entries: SessionEntry[], iteration: number, checkpoint?: Record<string, unknown>): Promise<void> {
    const access = await this.lockInvestigationExecution(connection, caller, binding);
    if (entries.some(entry => entry.runId !== binding.runId || entry.turnId !== access.messageId)) throw new Error('INVESTIGATION_FACT_BINDING_INVALID');
    this.assertInvestigationCheckpoint(checkpoint,binding.runId,access.messageId);
    await this.writeToolFacts(connection, access.sessionId, access.messageId, entries, iteration);
    // Capture every committed Parts revision in the SAME transaction. A slow
    // observer cannot miss intermediate tool acknowledgements between polls.
    const { captureCanonicalDocument } = await import('../investigations/stream.js');
    const { InvestigationEvidenceStore } = await import('../investigations/evidence-store.js');
    const evidence = new InvestigationEvidenceStore(this.poolProvider as never, this.authorization);
    const investigation = await this.authorization.load(connection, binding.investigationId);
    for (const entry of entries) {
      const [facts] = await connection.query<any[]>('SELECT entry_json FROM agent_canonical_facts WHERE session_id = ? AND message_id = ?', [access.sessionId, entry.id]);
      if (facts[0]) {
        const fact = decode(facts[0].entry_json);
        await captureCanonicalDocument(connection as never, binding.investigationId, binding.requestId,
          fact.messageParts, new Date(access.request.created_at).toISOString());
        if (fact.role === 'tool') await evidence.captureToolResult(connection as never, caller, investigation, binding, fact);
      }
    }
    if (checkpoint !== undefined) await this.writeCheckpoint(connection, access.sessionId, checkpoint);
    await this.assertInvestigationLease(connection,binding);
  }

  async saveInvestigationCheckpoint(connection: InvestigationConnection, caller: ActorContext,
    binding: InvestigationExecutionBinding, checkpoint: Record<string, unknown> | null): Promise<void> {
    const access = await this.lockInvestigationExecution(connection, caller, binding);
    this.assertInvestigationCheckpoint(checkpoint,binding.runId,access.messageId);
    await this.writeCheckpoint(connection, access.sessionId, checkpoint);
    await this.assertInvestigationLease(connection,binding);
  }

  async getInvestigationPage(connection: InvestigationConnection, caller: ActorContext,
    binding: InvestigationExecutionBinding, limit = 200, before?: string): Promise<{ messages: SessionEntry[]; nextBefore: string | null }> {
    const access = await this.lockInvestigationExecution(connection, caller, binding);
    const page = await this.readPage(connection, access.sessionId, limit, before);
    await this.assertInvestigationLease(connection,binding);
    return page;
  }

  /** Observation shares the canonical history/turn algorithm but has no
   * execution lease requirement. Real current investigation authority is
   * checked on this same transaction; ordinary Chat shares are insufficient. */
  async getObservationPage(connection: InvestigationConnection, caller: ActorContext,
    investigationId: string, limit = 200, before?: string): Promise<{ messages: SessionEntry[]; nextBefore: string | null }> {
    const investigation = await this.authorization.load(connection, investigationId);
    await this.authorization.authorize(connection, caller, investigation, 'content');
    return this.readPage(connection, investigation.sessionId, limit, before);
  }

  private assertInvestigationCheckpoint(checkpoint: Record<string, unknown> | null | undefined, runId: string, turnId: string): void {
    if (checkpoint && (checkpoint.canonical_run_id !== undefined && checkpoint.canonical_run_id !== runId
      || checkpoint.canonical_turn_id !== undefined && checkpoint.canonical_turn_id !== turnId)) throw new Error('INVESTIGATION_CHECKPOINT_INVALID');
  }

  /** One committed SQL snapshot. Only user statements from durably completed runs.
   * Internal owner identity comes from authenticated admission or a stored shared
   * record, never a model, request payload, workspace path or cached JSONL.
   */
  async getCommittedMemoryInputs(ownerId: number, sessionId: string, ids: string[]): Promise<MemoryInput[]> {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || !ids.length || ids.length > 1000
      || ids.some(id => typeof id !== 'string' || id.length > 256)) throw new Error('MEMORY_SOURCE_QUERY_INVALID');
    const [rows] = await this.pool().query<any[]>(
      `SELECT cm.message_id, cm.content FROM chat_messages cm
       JOIN chat_sessions cs ON cs.session_id = cm.session_id AND cs.user_id = ?
       JOIN agent_runs ar ON ar.session_id = cm.session_id AND ar.actor_id = cs.user_id
         AND cm.message_id = CONCAT('run_', ar.id, '_user') AND ar.state = 'completed'
       WHERE cm.session_id = ? AND cm.role = 'user' AND cm.message_id IN (${ids.map(() => '?').join(',')})
       ORDER BY cm.id`, [ownerId, sessionId, ...ids]);
    return rows.map(row => ({ id: row.message_id, content: row.content, hash: memoryHash(row.content) }));
  }

  /** Descending cursor pages returned in chronological order, with stable IDs. */
  async getPage(actor: ActorContext, sessionId: string, limit = 200, before?: string): Promise<{ messages: SessionEntry[]; nextBefore: string | null }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('INVALID_CANONICAL_PAGE');
    if (before && !/^\d+:\d+:\d+$/.test(before)) throw new Error('INVALID_CANONICAL_CURSOR');
    await chatDatabaseService.authorizeSession(actor, sessionId, 'history');
    return this.readPage(this.pool(), sessionId, limit, before, actor);
  }

  private async readPage(connection: Executor, sessionId: string, limit: number, before?: string, actor?: ActorContext): Promise<{ messages: SessionEntry[]; nextBefore: string | null }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('INVALID_CANONICAL_PAGE');
    if (before && !/^\d+:\d+:\d+$/.test(before)) throw new Error('INVALID_CANONICAL_CURSOR');
    const cursor = before?.split(':').map(Number);
    if (cursor?.some(n => !Number.isSafeInteger(n))) throw new Error('INVALID_CANONICAL_CURSOR');
    const [rows] = await connection.query<any[]>(
      `SELECT history.* FROM (
         SELECT cm.id AS tie, cm.message_id, cm.role, cm.content, cm.created_at, cm.metadata, NULL AS entry_json,
           COALESCE((SELECT u.id FROM chat_messages u WHERE u.session_id = cm.session_id AND u.message_id = cm.parent_id AND u.role = 'user'), (SELECT MAX(u.id) FROM chat_messages u WHERE u.session_id = cm.session_id AND u.role = 'user' AND u.id <= cm.id), cm.id) AS turn_sequence,
           CASE WHEN cm.role = 'user' THEN 0 ELSE ${FINAL_ORDINAL} + cm.id END AS ordinal
         FROM chat_messages cm JOIN chat_sessions cs ON cs.session_id = cm.session_id
         WHERE cm.session_id = ? ${actor ? "AND (cs.user_id = ? OR EXISTS (SELECT 1 FROM chat_session_shares sh WHERE sh.session_id = cs.session_id AND sh.recipient_user_id = ? AND sh.permission = 'read'))" : ''}
         UNION ALL
         SELECT f.id, f.message_id, NULL, NULL, NULL, NULL, f.entry_json, f.turn_sequence, f.ordinal
         FROM agent_canonical_facts f JOIN chat_sessions cs ON cs.session_id = f.session_id
         WHERE f.session_id = ? ${actor ? "AND (cs.user_id = ? OR EXISTS (SELECT 1 FROM chat_session_shares sh WHERE sh.session_id = cs.session_id AND sh.recipient_user_id = ? AND sh.permission = 'read'))" : ''}
       ) history ${cursor ? 'WHERE (turn_sequence, ordinal, tie) < (?, ?, ?)' : ''}
       ORDER BY turn_sequence DESC, ordinal DESC, tie DESC LIMIT ?`,
      [sessionId, ...(actor ? [actor.userId, actor.userId] : []), sessionId, ...(actor ? [actor.userId, actor.userId] : []), ...(cursor ?? []), limit + 1]);
    const page = rows.slice(0, limit);
    return { nextBefore: rows.length > limit ? `${page.at(-1).turn_sequence}:${page.at(-1).ordinal}:${page.at(-1).tie}` : null,
      messages: page.reverse().map(row => {
        if (row.entry_json) {
          const entry = typeof row.entry_json === 'string' ? JSON.parse(row.entry_json) : row.entry_json;
          return persistedMessageParts(entry, 'checkpoint', entry.messageParts?.status);
        }
        return recordMessageParts(row, { runId: `legacy_run_${sessionId}_${row.turn_sequence}`, turnId: `legacy_turn_${sessionId}_${row.turn_sequence}` });
      }) };
  }
}

export const canonicalStore = new CanonicalStore();
