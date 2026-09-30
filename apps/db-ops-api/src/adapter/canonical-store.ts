import { dbConnection } from '../db-connection.js';
import { chatDatabaseService } from '../chat-database-service.js';
import type { ActorContext } from '../auth/actor-context.js';
import type { SessionEntry } from '@slide/agent-core';

interface Executor { query<T = any>(sql: string, values?: unknown[]): Promise<[T, unknown?]>; }
interface Connection extends Executor { beginTransaction(): Promise<void>; commit(): Promise<void>; rollback(): Promise<void>; release(): void; }
interface Pool extends Executor { getConnection(): Promise<Connection>; }
const MAX_FACTS = 100_000;
const MAX_FACT_BYTES = 4 * 1024 * 1024;
function stable(value: unknown): string {
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value));
}
const FINAL_ORDINAL = 9_000_000_000;

/** MySQL is authoritative for actor-owned chats. JSONL is a disposable cache.
 * Existing DB message IDs are already durable: no replacement IDs or double writes.
 */
export class CanonicalStore {
  constructor(private readonly poolProvider: () => Pool | null = () => dbConnection.getPool() as unknown as Pool) {}
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
      const [turns] = await connection.query<any[]>("SELECT id FROM chat_messages WHERE session_id = ? AND message_id = ? AND role = 'user'", [sessionId, userId]);
      if (!turns.length) throw new Error('CANONICAL_TURN_NOT_FOUND');
      const [counts] = await connection.query<any[]>('SELECT COUNT(*) AS total FROM agent_canonical_facts WHERE session_id = ?', [sessionId]);
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry.id || (entry.source && entry.source !== 'fact') || !(entry.role === 'tool' || (entry.role === 'assistant' && entry.tool_calls?.length))) throw new Error('INVALID_CANONICAL_FACT');
        const json = JSON.stringify(entry);
        if (Buffer.byteLength(json) > MAX_FACT_BYTES) throw new Error('CANONICAL_CAPACITY_EXCEEDED');
        const [existing] = await connection.query<any[]>('SELECT entry_json FROM agent_canonical_facts WHERE session_id = ? AND message_id = ?', [sessionId, entry.id]);
        if (existing.length) {
          const prior = typeof existing[0].entry_json === 'string' ? JSON.parse(existing[0].entry_json) : existing[0].entry_json;
          // JSON object member order is not preserved by MySQL.
          const payload = (m: SessionEntry) => stable([m.role, m.content, m.tool_calls, m.tool_call_id, m.runId, m.turnId]);
          if (payload(prior) !== payload(entry)) throw new Error('CANONICAL_ID_CONFLICT');
          continue;
        }
        if (++counts[0].total > MAX_FACTS) throw new Error('CANONICAL_CAPACITY_EXCEEDED');
        // Tool ordinal follows the assistant's call list, independent of completion order.
        const ordinal = iteration * 10_000 + index + 1;
        await connection.query('INSERT INTO agent_canonical_facts (session_id, message_id, turn_sequence, ordinal, entry_json) VALUES (?, ?, ?, ?, ?)',
          [sessionId, entry.id, turns[0].id, ordinal, json]);
      }
      if (checkpoint) await connection.query(
        "UPDATE chat_sessions SET metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.canonicalRuntimeCheckpoint', CAST(? AS JSON)) WHERE session_id = ? AND user_id = ?",
        [JSON.stringify(checkpoint), sessionId, actor.userId]);
      await connection.commit();
    } catch (error) { try { await connection.rollback(); } catch { /* retain original */ } throw error; }
    finally { connection.release(); }
  }

  /** Descending cursor pages returned in chronological order, with stable IDs. */
  async getPage(actor: ActorContext, sessionId: string, limit = 200, before?: string): Promise<{ messages: SessionEntry[]; nextBefore: string | null }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('INVALID_CANONICAL_PAGE');
    if (before && !/^\d+:\d+:\d+$/.test(before)) throw new Error('INVALID_CANONICAL_CURSOR');
    await chatDatabaseService.authorizeSession(actor, sessionId, 'history');
    const cursor = before?.split(':').map(Number);
    if (cursor?.some(n => !Number.isSafeInteger(n))) throw new Error('INVALID_CANONICAL_CURSOR');
    const [rows] = await this.pool().query<any[]>(
      `SELECT history.* FROM (
         SELECT cm.id AS tie, cm.message_id, cm.role, cm.content, cm.created_at, cm.metadata, NULL AS entry_json,
           COALESCE((SELECT u.id FROM chat_messages u WHERE u.session_id = cm.session_id AND u.message_id = cm.parent_id AND u.role = 'user'), (SELECT MAX(u.id) FROM chat_messages u WHERE u.session_id = cm.session_id AND u.role = 'user' AND u.id <= cm.id), cm.id) AS turn_sequence,
           CASE WHEN cm.role = 'user' THEN 0 ELSE ${FINAL_ORDINAL} + cm.id END AS ordinal
         FROM chat_messages cm JOIN chat_sessions cs ON cs.session_id = cm.session_id
         WHERE cm.session_id = ? AND (cs.user_id = ? OR EXISTS (SELECT 1 FROM chat_session_shares sh WHERE sh.session_id = cs.session_id AND sh.recipient_user_id = ? AND sh.permission = 'read'))
         UNION ALL
         SELECT f.id, f.message_id, NULL, NULL, NULL, NULL, f.entry_json, f.turn_sequence, f.ordinal
         FROM agent_canonical_facts f JOIN chat_sessions cs ON cs.session_id = f.session_id
         WHERE f.session_id = ? AND (cs.user_id = ? OR EXISTS (SELECT 1 FROM chat_session_shares sh WHERE sh.session_id = cs.session_id AND sh.recipient_user_id = ? AND sh.permission = 'read'))
       ) history ${cursor ? 'WHERE (turn_sequence, ordinal, tie) < (?, ?, ?)' : ''}
       ORDER BY turn_sequence DESC, ordinal DESC, tie DESC LIMIT ?`,
      [sessionId, actor.userId, actor.userId, sessionId, actor.userId, actor.userId, ...(cursor ?? []), limit + 1]);
    const page = rows.slice(0, limit);
    return { nextBefore: rows.length > limit ? `${page.at(-1).turn_sequence}:${page.at(-1).ordinal}:${page.at(-1).tie}` : null,
      messages: page.reverse().map(row => {
        if (row.entry_json) return structuredClone(typeof row.entry_json === 'string' ? JSON.parse(row.entry_json) : row.entry_json);
        const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
        return { id: row.message_id, role: row.role, content: row.content, source: 'fact',
          timestamp: new Date(row.created_at).toISOString(), runId: metadata?.canonicalRunId ?? `legacy_run_${sessionId}_${row.turn_sequence}`,
          turnId: metadata?.canonicalTurnId ?? `legacy_turn_${sessionId}_${row.turn_sequence}` };
      }) };
  }
}

export const canonicalStore = new CanonicalStore();
