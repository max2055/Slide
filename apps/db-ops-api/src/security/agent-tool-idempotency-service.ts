import { createHash } from 'node:crypto';
import { dbConnection } from '../db-connection.js';

type Pool = { query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]> };
export type ToolIdempotencyClaim =
  | { kind: 'claimed'; argumentsHash: string }
  | { kind: 'completed'; argumentsHash: string; result: unknown }
  | { kind: 'in_progress'; argumentsHash: string }
  | { kind: 'conflict'; argumentsHash: string };

export function stableArgumentsHash(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
    }
    return input;
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

export class AgentToolIdempotencyService {
  constructor(private readonly poolProvider: () => Pool | null = () => dbConnection.getPool() as unknown as Pool | null) {}

  async claim(actorId: number, sessionId: string, toolName: string, key: string, args: unknown): Promise<ToolIdempotencyClaim> {
    const pool = this.requirePool();
    const argumentsHash = stableArgumentsHash(args);
    const sessionHash = stableArgumentsHash(sessionId);
    const [insertOutcome] = await pool.query<{ affectedRows?: number }>(
      `INSERT INTO agent_tool_idempotency
        (actor_id, session_id, session_hash, tool_name, idempotency_key, arguments_hash, state)
       VALUES (?, ?, ?, ?, ?, ?, 'running')
       ON DUPLICATE KEY UPDATE idempotency_key = idempotency_key`,
      [actorId, sessionId, sessionHash, toolName, key, argumentsHash],
    );
    const [rows] = await pool.query<any[]>(
      `SELECT arguments_hash, state, result_json
       FROM agent_tool_idempotency
       WHERE actor_id = ? AND session_hash = ? AND tool_name = ? AND idempotency_key = ?`,
      [actorId, sessionHash, toolName, key],
    );
    const row = rows[0];
    if (!row) throw new Error('IDEMPOTENCY_CLAIM_FAILED');
    if (row.arguments_hash !== argumentsHash) return { kind: 'conflict', argumentsHash };
    if (row.state === 'completed') {
      return { kind: 'completed', argumentsHash, result: typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json };
    }
    if (row.state === 'running') {
      if (Number(insertOutcome?.affectedRows) === 1) return { kind: 'claimed', argumentsHash };
      return { kind: 'in_progress', argumentsHash };
    }
    return { kind: 'in_progress', argumentsHash };
  }

  async finish(actorId: number, sessionId: string, toolName: string, key: string, argumentsHash: string, state: 'completed' | 'failed', result: unknown): Promise<void> {
    await this.requirePool().query(
      `UPDATE agent_tool_idempotency SET state = ?, result_json = ?
       WHERE actor_id = ? AND session_hash = ? AND tool_name = ? AND idempotency_key = ? AND arguments_hash = ? AND state = 'running'`,
      [state, JSON.stringify(result), actorId, stableArgumentsHash(sessionId), toolName, key, argumentsHash],
    );
  }

  private requirePool(): Pool {
    const pool = this.poolProvider();
    if (!pool) throw new Error('IDEMPOTENCY_STORAGE_UNAVAILABLE');
    return pool;
  }
}

export const agentToolIdempotencyService = new AgentToolIdempotencyService();
