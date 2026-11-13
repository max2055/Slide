import { createHash, randomUUID } from 'node:crypto';
import { dbConnection } from '../db-connection.js';

type Pool = { query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]> };
export type ToolExecution = { argumentsHash: string; ownerToken: string };
export type ToolIdempotencyClaim =
  | ({ kind: 'claimed' } & ToolExecution)
  | { kind: 'completed'; argumentsHash: string; result: unknown }
  | { kind: 'in_progress'; argumentsHash: string }
  | { kind: 'unknown'; argumentsHash: string; checkpoint: unknown }
  | { kind: 'identity_unverified'; argumentsHash: string }
  | { kind: 'conflict'; argumentsHash: string };

function argumentsHash(value: unknown, compare: (a: string, b: string) => number): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a], [b]) => compare(a, b)).map(([key, item]) => [key, normalize(item)]));
    }
    return input;
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

export function stableArgumentsHash(value: unknown): string {
  return argumentsHash(value, (a, b) => a < b ? -1 : a > b ? 1 : 0);
}

// Old rows contain only a digest, so compare legacy serializations without
// storing the original arguments (which may include credentials). Never rewrite
// an old digest on a read: its running owner may still need it for finish.
let legacyCollators: Intl.Collator[] | undefined;
function matchesLegacyHash(value: unknown, hash: string): boolean {
  if (!legacyCollators) {
    const tags = ['en-US', 'da-DK', 'zh-TW', 'zh-HK', 'de-AT', 'sv-FI'];
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    for (const a of letters) for (const b of letters) {
      tags.push(a + b);
      for (const c of letters) tags.push(a + b + c);
    }
    const locales = Intl.Collator.supportedLocalesOf(tags);
    legacyCollators = [new Intl.Collator(), ...locales.map(locale => new Intl.Collator(locale))];
  }
  return legacyCollators.some(collator => argumentsHash(value, collator.compare) === hash);
}
const decode = (value: unknown): unknown => typeof value === 'string' ? JSON.parse(value) : value;

export class AgentToolIdempotencyService {
  static readonly heartbeatMs = 10_000;
  constructor(private readonly poolProvider: () => Pool | null = () => dbConnection.getPool() as unknown as Pool | null) {}

  async claim(actorId: number, sessionId: string, toolName: string, key: string, args: unknown): Promise<ToolIdempotencyClaim> {
    const pool = this.requirePool();
    const hash = stableArgumentsHash(args);
    const identity = [actorId, stableArgumentsHash(sessionId), toolName, key];
    const ownerToken = randomUUID();
    try {
      // A duplicate INSERT never owns execution, independent of FOUND_ROWS.
      await pool.query(
        `INSERT INTO agent_tool_idempotency
        (actor_id, session_id, session_hash, tool_name, idempotency_key, arguments_hash, state, hash_version, owner_token, lease_until, checkpoint_json)
       VALUES (?, ?, ?, ?, ?, ?, 'running', 2, ?, TIMESTAMPADD(SECOND, 60, NOW(3)), JSON_OBJECT('items', JSON_OBJECT()))`,
        [actorId, sessionId, identity[1], toolName, key, hash, ownerToken],
      );
      return { kind: 'claimed', argumentsHash: hash, ownerToken };
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== 'ER_DUP_ENTRY') throw error;
    }
    const read = async () => {
      const [rows] = await pool.query<any[]>(
        `SELECT arguments_hash, hash_version, state, result_json, checkpoint_json
         FROM agent_tool_idempotency WHERE actor_id = ? AND session_hash = ? AND tool_name = ? AND idempotency_key = ?`, identity);
      if (!rows[0]) throw new Error('IDEMPOTENCY_CLAIM_FAILED');
      return rows[0];
    };
    let row = await read();
    if (row.arguments_hash !== hash && !(Number(row.hash_version) === 1 && matchesLegacyHash(args, row.arguments_hash))) {
      // A legacy digest alone cannot distinguish changed parameters from a
      // historical ICU ordering we cannot reconstruct. Never advise a new key.
      return { kind: Number(row.hash_version) === 1 ? 'identity_unverified' : 'conflict', argumentsHash: hash };
    }
    if (row.state === 'running') {
      // Atomic expiry and heartbeat race on the same row. No ownership transfer.
      await pool.query(
        `UPDATE agent_tool_idempotency SET state = 'unknown'
         WHERE actor_id = ? AND session_hash = ? AND tool_name = ? AND idempotency_key = ?
         AND state = 'running' AND (lease_until IS NULL OR lease_until <= NOW(3))`, identity);
      row = await read();
    }
    if (row.state === 'completed') return { kind: 'completed', argumentsHash: row.arguments_hash, result: decode(row.result_json) };
    if (row.state === 'running') return { kind: 'in_progress', argumentsHash: row.arguments_hash };
    return { kind: 'unknown', argumentsHash: row.arguments_hash, checkpoint: decode(row.checkpoint_json) };
  }

  async heartbeat(actorId: number, sessionId: string, toolName: string, key: string, execution: ToolExecution): Promise<void> {
    await this.writeOwned(`lease_until = TIMESTAMPADD(SECOND, 60, NOW(3))`, [], actorId, sessionId, toolName, key, execution);
  }

  async checkpoint(actorId: number, sessionId: string, toolName: string, key: string, execution: ToolExecution, index: number, value: unknown): Promise<void> {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('INVALID_CHECKPOINT_INDEX');
    await this.writeOwned(`checkpoint_json = JSON_SET(checkpoint_json, ?, CAST(? AS JSON))`,
      [`$.items."${index}"`, JSON.stringify(value)], actorId, sessionId, toolName, key, execution);
  }

  async finish(actorId: number, sessionId: string, toolName: string, key: string, argumentsHash: string, state: 'completed' | 'failed', result: unknown, ownerToken: string): Promise<void> {
    await this.writeOwned('state = ?, result_json = ?', [state, JSON.stringify(result)], actorId, sessionId, toolName, key, { argumentsHash, ownerToken });
  }

  private async writeOwned(set: string, values: unknown[], actorId: number, sessionId: string, toolName: string, key: string, execution: ToolExecution): Promise<void> {
    const [outcome] = await this.requirePool().query<{ affectedRows: number }>(
      `UPDATE agent_tool_idempotency SET ${set}, execution_revision = execution_revision + 1
       WHERE actor_id = ? AND session_hash = ? AND tool_name = ? AND idempotency_key = ?
       AND arguments_hash = ? AND owner_token = ? AND state = 'running' AND lease_until > NOW(3)`,
      [...values, actorId, stableArgumentsHash(sessionId), toolName, key, execution.argumentsHash, execution.ownerToken]);
    if (outcome.affectedRows !== 1) throw new Error('IDEMPOTENCY_OWNERSHIP_LOST');
  }

  private requirePool(): Pool {
    const pool = this.poolProvider();
    if (!pool) throw new Error('IDEMPOTENCY_STORAGE_UNAVAILABLE');
    return pool;
  }
}

export const agentToolIdempotencyService = new AgentToolIdempotencyService();
