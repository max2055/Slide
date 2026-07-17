import { randomUUID } from 'node:crypto';
import type { Operation, OperationEvent, OperationState } from './types.js';

interface QueryExecutor { query<T = any>(sql: string, values?: unknown[]): Promise<[T, unknown?]>; }
interface Transaction extends QueryExecutor { beginTransaction(): Promise<void>; commit(): Promise<void>; rollback(): Promise<void>; release(): void; }
interface OperationPool extends QueryExecutor { getConnection(): Promise<Transaction>; }

const TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> = {
  queued: ['waiting_approval', 'claimed', 'cancelled', 'failed'],
  waiting_approval: ['claimed', 'cancelled'],
  claimed: ['running', 'queued', 'unknown', 'cancelled'],
  running: ['succeeded', 'failed', 'unknown'],
  succeeded: [], failed: [], cancelled: [], unknown: [],
};

function bounded(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const text = JSON.stringify(value);
  return text.length <= 16_384 ? JSON.parse(text) : { truncated: true };
}

export class OperationService {
  private readonly operations = new Map<string, Operation>();
  private readonly byIdempotency = new Map<string, string>();
  private readonly events = new Map<string, OperationEvent[]>();

  create(input: Omit<Operation, 'id' | 'state' | 'attempt' | 'createdAt' | 'updatedAt'>): Operation {
    const key = `${input.actorId}:${input.idempotencyKey}`;
    const existing = this.byIdempotency.get(key);
    if (existing) return this.require(existing);
    const now = new Date();
    const operation: Operation = { ...input, id: randomUUID(), state: 'queued', attempt: 1, createdAt: now, updatedAt: now };
    this.operations.set(operation.id, operation);
    this.byIdempotency.set(key, operation.id);
    this.append(operation, null, 'queued', 'CREATED', operation.actorId);
    return operation;
  }

  transition(id: string, toState: OperationState, reasonCode: string, actorId?: number, metadata?: Record<string, unknown>): Operation {
    const operation = this.require(id);
    if (!TRANSITIONS[operation.state].includes(toState)) throw new Error(`Illegal operation transition ${operation.state} -> ${toState}`);
    const fromState = operation.state;
    operation.state = toState;
    operation.updatedAt = new Date();
    if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(toState)) operation.finishedAt = operation.updatedAt;
    this.append(operation, fromState, toState, reasonCode, actorId, metadata);
    return operation;
  }

  claim(id: string, owner: string, leaseMs: number, actorId?: number): Operation | null {
    const operation = this.require(id);
    if (!['queued', 'waiting_approval'].includes(operation.state)) return null;
    this.transition(id, 'claimed', 'CLAIMED', actorId);
    operation.leaseOwner = owner;
    operation.leaseExpiresAt = new Date(Date.now() + leaseMs);
    return operation;
  }

  expireLease(id: string, now = new Date()): Operation | null {
    const operation = this.require(id);
    if (operation.state !== 'claimed' || !operation.leaseExpiresAt || operation.leaseExpiresAt > now) return null;
    return this.transition(id, 'unknown', 'LEASE_EXPIRED');
  }

  eventsFor(id: string): readonly OperationEvent[] { return this.events.get(id) ?? []; }
  private require(id: string): Operation { const operation = this.operations.get(id); if (!operation) throw new Error('Operation not found'); return operation; }
  private append(operation: Operation, fromState: OperationState | null, toState: OperationState, reasonCode: string, actorId?: number, metadata?: Record<string, unknown>): void {
    const list = this.events.get(operation.id) ?? [];
    list.push({ operationId: operation.id, fromState, toState, reasonCode, actorId, metadata: bounded(metadata), createdAt: new Date() });
    this.events.set(operation.id, list);
  }
}

/** Database-backed operation repository used by request paths. */
export class PersistentOperationService {
  constructor(private readonly poolProvider: () => OperationPool | null) {}

  async create(input: Omit<Operation, 'id' | 'state' | 'attempt' | 'createdAt' | 'updatedAt'>): Promise<Operation> {
    const pool = this.poolProvider();
    if (!pool) throw new Error('Operation database unavailable');
    const id = randomUUID();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        `INSERT INTO operations (id, actor_id, origin, resource_type, resource_id, command_type, risk, idempotency_key, approval_id, correlation_id, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')
         ON DUPLICATE KEY UPDATE id = id`,
        [id, input.actorId, input.origin, input.resource.type, input.resource.id, input.commandType, input.risk, input.idempotencyKey, input.approvalId ?? null, input.correlationId],
      );
      const [rows] = await connection.query<any[]>(
        `SELECT * FROM operations WHERE actor_id = ? AND idempotency_key = ? FOR UPDATE`, [input.actorId, input.idempotencyKey],
      );
      const row = rows[0];
      if (!row) throw new Error('Operation insert failed');
      if (row.id === id) await this.append(connection, id, null, 'queued', 'CREATED', input.actorId);
      await connection.commit();
      return this.map(row);
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }

  async transition(id: string, toState: OperationState, reasonCode: string, actorId?: number, metadata?: Record<string, unknown>): Promise<Operation> {
    const pool = this.poolProvider();
    if (!pool) throw new Error('Operation database unavailable');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<any[]>(`SELECT * FROM operations WHERE id = ? FOR UPDATE`, [id]);
      const row = rows[0];
      if (!row) throw new Error('Operation not found');
      const fromState = row.state as OperationState;
      if (!TRANSITIONS[fromState].includes(toState)) throw new Error(`Illegal operation transition ${fromState} -> ${toState}`);
      await connection.query(
        `UPDATE operations SET state = ?, result_json = COALESCE(?, result_json), error_json = COALESCE(?, error_json),
         finished_at = CASE WHEN ? IN ('succeeded','failed','cancelled','unknown') THEN NOW() ELSE finished_at END WHERE id = ?`,
        [toState, toState === 'succeeded' ? JSON.stringify(bounded(metadata) ?? {}) : null, toState === 'failed' || toState === 'unknown' ? JSON.stringify(bounded(metadata) ?? {}) : null, toState, id],
      );
      await this.append(connection, id, fromState, toState, reasonCode, actorId, metadata);
      const [updated] = await connection.query<any[]>(`SELECT * FROM operations WHERE id = ?`, [id]);
      await connection.commit();
      return this.map(updated[0]);
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }

  private async append(connection: QueryExecutor, id: string, fromState: OperationState | null, toState: OperationState, reasonCode: string, actorId?: number, metadata?: Record<string, unknown>): Promise<void> {
    await connection.query(
      `INSERT INTO operation_events (operation_id, from_state, to_state, reason_code, actor_id, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, fromState, toState, reasonCode, actorId ?? null, metadata ? JSON.stringify(bounded(metadata)) : null],
    );
  }

  private map(row: any): Operation {
    return { id: row.id, actorId: Number(row.actor_id), origin: row.origin, resource: { type: row.resource_type, id: row.resource_id }, commandType: row.command_type, risk: row.risk, idempotencyKey: row.idempotency_key, correlationId: row.correlation_id, state: row.state, attempt: Number(row.attempt), approvalId: row.approval_id ?? undefined, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at), finishedAt: row.finished_at ? new Date(row.finished_at) : undefined };
  }
}
