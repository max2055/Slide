import { randomUUID } from 'node:crypto';
import { dbConnection } from '../db-connection.js';

export type AgentRunState = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'timed_out';
export interface AgentRun { id: string; actorId: number; sessionId: string; messageId: string; idempotencyKey: string; state: AgentRunState; result?: unknown; error?: unknown; }

interface Pool { query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>; }

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
      'SELECT * FROM agent_runs WHERE actor_id = ? AND session_id = ? AND idempotency_key = ?',
      [actorId, sessionId, idempotencyKey],
    );
    const row = rows[0];
    if (!row) throw new Error('Agent run claim failed');
    return { created: row.id === id, run: this.map(row) };
  }

  async finish(id: string, state: Exclude<AgentRunState, 'running'>, result?: unknown, error?: unknown): Promise<boolean> {
    const [outcome] = await this.requirePool().query<{ affectedRows: number }>(
      `UPDATE agent_runs SET state = ?, result_json = ?, error_json = ?, finished_at = NOW()
       WHERE id = ? AND state = 'running'`,
      [state, result ? JSON.stringify(result) : null, error ? JSON.stringify(error) : null, id],
    );
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
