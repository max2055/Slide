import { randomUUID } from 'node:crypto';
import { dbConnection } from '../db-connection.js';
import type { CompleteEvent } from './types.js';
import { platformLogs } from '../platform/structured-log-evidence-adapter.js';

export type AgentRunState = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'timed_out';
export interface AgentRun { id: string; actorId: number; sessionId: string; messageId: string; idempotencyKey: string; state: AgentRunState; result?: unknown; error?: unknown; }

interface Executor { query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>; }
interface Connection extends Executor { beginTransaction(): Promise<void>; commit(): Promise<void>; rollback(): Promise<void>; release(): void; }
interface Pool extends Executor { getConnection?(): Promise<Connection>; }
interface CompletionResult { completionPending?: boolean; event: CompleteEvent; stopReason: 'completed'; }

export class AgentRunService {
  constructor(private readonly poolProvider: () => Pool | null = () => dbConnection.getPool() as unknown as Pool | null) {}

  async claim(actorId: number, sessionId: string, messageId: string, idempotencyKey: string): Promise<{ run: AgentRun; created: boolean }> {
    const pool = this.requirePool();
    const id = randomUUID();
    await pool.query(
      `INSERT INTO agent_runs (id, actor_id, session_id, message_id, idempotency_key, state, expires_at)
       VALUES (?, ?, ?, ?, ?, 'running', DATE_ADD(NOW(), INTERVAL 24 HOUR))
       ON DUPLICATE KEY UPDATE id = id`,
      [id, actorId, sessionId, messageId, idempotencyKey],
    );
    const [rows] = await pool.query<any[]>(
      'SELECT * FROM agent_runs WHERE actor_id = ? AND idempotency_key = ?',
      [actorId, idempotencyKey],
    );
    const row = rows[0];
    if (!row) throw new Error('Agent run claim failed');
    platformLogs.record({ component: 'agent', eventType: row.id === id ? 'run.started' : 'run.duplicate', status: 'ok', correlationId: row.id });
    return { created: row.id === id, run: this.map(row) };
  }

  async findByIdempotencyKey(actorId: number, idempotencyKey: string): Promise<AgentRun | null> {
    const [rows] = await this.requirePool().query<any[]>(
      'SELECT * FROM agent_runs WHERE actor_id = ? AND idempotency_key = ?',
      [actorId, idempotencyKey],
    );
    return rows[0] ? this.map(rows[0]) : null;
  }

  // Persist the answer before attempting the atomic message + terminal commit.
  // A replay can finish this intent even after the originating process exits.
  async complete(run: AgentRun, event: CompleteEvent): Promise<AgentRun> {
    await this.requirePool().query(
      `UPDATE agent_runs SET result_json = ?, error_json = ?
       WHERE id = ? AND actor_id = ? AND session_id = ? AND state = 'running' AND result_json IS NULL`,
      [JSON.stringify({ completionPending: true, event, stopReason: 'completed' }),
        JSON.stringify({ code: 'COMPLETION_PENDING', retryable: true }), run.id, run.actorId, run.sessionId],
    );
    const current = await this.getForActor(run.id, run.actorId, run.sessionId);
    if (!current) throw new Error('Agent run not found');
    return this.recoverCompletion(current);
  }

  async failUnstagedCompletion(id: string): Promise<void> {
    await this.requirePool().query(
      `UPDATE agent_runs SET state = 'failed', error_json = ?, finished_at = NOW()
       WHERE id = ? AND state = 'running' AND result_json IS NULL`,
      [JSON.stringify({ code: 'COMPLETION_STORAGE_FAILED', retryable: true }), id],
    );
  }

  async recoverCompletion(run: AgentRun): Promise<AgentRun> {
    if (run.state !== 'running' || !(run.result as CompletionResult | undefined)?.completionPending) return run;
    const pool = this.requirePool();
    if (!pool.getConnection) throw new Error('Completion requires a database transaction');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<any[]>(
        'SELECT * FROM agent_runs WHERE id = ? AND actor_id = ? AND session_id = ? FOR UPDATE',
        [run.id, run.actorId, run.sessionId],
      );
      if (!rows[0]) throw new Error('Agent run not found');
      const current = this.map(rows[0]);
      const result = current.result as CompletionResult;
      if (current.state !== 'running' || !result?.completionPending) {
        await connection.commit();
        return current;
      }
      const [sessions] = await connection.query<any[]>(
        'SELECT session_id FROM chat_sessions WHERE session_id = ? AND user_id = ? FOR UPDATE',
        [run.sessionId, run.actorId],
      );
      if (!sessions[0]) throw new Error('Chat session not found');
      const event = { ...result.event };
      if (event.finalContent || event.thinkingContent) {
        const content = event.thinkingContent
          ? `<think>${event.thinkingContent}</think>\n\n${event.finalContent || ''}` : event.finalContent;
        const messageId = `run_${run.id}_assistant`;
        await connection.query(
          `INSERT INTO chat_messages (session_id, message_id, role, content)
           VALUES (?, ?, 'assistant', ?) ON DUPLICATE KEY UPDATE message_id = message_id`,
          [run.sessionId, messageId, content],
        );
        const [messages] = await connection.query<any[]>(
          'SELECT id, content FROM chat_messages WHERE session_id = ? AND message_id = ?', [run.sessionId, messageId],
        );
        if (!messages[0] || messages[0].content !== content) throw new Error('Completion message conflict');
        event.messageSequence = Number(messages[0].id);
        await connection.query(
          `UPDATE chat_sessions SET message_count = (SELECT COUNT(*) FROM chat_messages WHERE session_id = ?),
           last_message_at = (SELECT MAX(created_at) FROM chat_messages WHERE session_id = ?) WHERE session_id = ?`,
          [run.sessionId, run.sessionId, run.sessionId],
        );
      }
      const committed = { stopReason: 'completed', event };
      const [updated] = await connection.query<{ affectedRows: number }>(
        `UPDATE agent_runs SET state = 'completed', result_json = ?, error_json = NULL, finished_at = NOW()
         WHERE id = ? AND state = 'running'`, [JSON.stringify(committed), run.id],
      );
      if (updated.affectedRows !== 1) throw new Error('Completion state conflict');
      await connection.commit();
      platformLogs.record({ component: 'agent', eventType: 'run.completed', status: 'ok', correlationId: run.id });
      return { ...current, state: 'completed', result: committed, error: null };
    } catch (error) {
      // COMMIT acknowledgement can be lost. Replaying the stable key safely
      // distinguishes an already committed result from a rolled-back attempt.
      try { await connection.rollback(); } catch { /* retain original error */ }
      throw error;
    } finally {
      connection.release();
    }
  }

  async pendingCompletions(actorId: number, sessionId: string): Promise<AgentRun[]> {
    const [rows] = await this.requirePool().query<any[]>(
      `SELECT * FROM agent_runs WHERE actor_id = ? AND session_id = ? AND state = 'running'
       AND JSON_EXTRACT(result_json, '$.completionPending') = true ORDER BY created_at LIMIT 100`,
      [actorId, sessionId],
    );
    return rows.map(row => this.map(row));
  }

  async finish(id: string, state: Exclude<AgentRunState, 'running'>, result?: unknown, error?: unknown): Promise<boolean> {
    const [outcome] = await this.requirePool().query<{ affectedRows: number }>(
      `UPDATE agent_runs SET state = ?, result_json = ?, error_json = ?, finished_at = NOW()
       WHERE id = ? AND state = 'running'`,
      [state, result ? JSON.stringify(result) : null, error ? JSON.stringify(error) : null, id],
    );
    if (Number(outcome.affectedRows) === 1) platformLogs.record({ component: 'agent', eventType: 'run.' + state, status: state === 'completed' ? 'ok' : state === 'failed' || state === 'timed_out' ? 'failed' : 'unknown', correlationId: id });
    return Number(outcome.affectedRows) === 1;
  }

  async getForActor(id: string, actorId: number, sessionId: string): Promise<AgentRun | null> {
    const [rows] = await this.requirePool().query<any[]>(
      'SELECT * FROM agent_runs WHERE id = ? AND actor_id = ? AND session_id = ?', [id, actorId, sessionId],
    );
    return rows[0] ? this.map(rows[0]) : null;
  }

  async cancelForActor(id: string, actorId: number, sessionId: string): Promise<boolean> {
    const [outcome] = await this.requirePool().query<{ affectedRows: number }>(
      `UPDATE agent_runs SET state = 'cancelled', finished_at = NOW(), error_json = ?
       WHERE id = ? AND actor_id = ? AND session_id = ? AND state = 'running'`,
      [JSON.stringify({ reasonCode: 'CANCELLED_BY_ACTOR' }), id, actorId, sessionId],
    );
    return Number(outcome.affectedRows) === 1;
  }

  private requirePool(): Pool { const pool = this.poolProvider(); if (!pool) throw new Error('Agent run database unavailable'); return pool; }
  private map(row: any): AgentRun { return { id: row.id, actorId: Number(row.actor_id), sessionId: row.session_id, messageId: row.message_id, idempotencyKey: row.idempotency_key, state: row.state, result: typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json, error: typeof row.error_json === 'string' ? JSON.parse(row.error_json) : row.error_json }; }
}

export const agentRunService = new AgentRunService();
