import { randomUUID } from 'node:crypto';
import type { Operation, OperationEvent, OperationState } from './types.js';
import { createRecoveryBinding, recoveryPolicyKey } from './recovery-policy.js';
import type { ResourceRef } from '../resources/types.js';

interface QueryExecutor { query<T = any>(sql: string, values?: unknown[]): Promise<[T, unknown?]>; }
interface Transaction extends QueryExecutor { beginTransaction(): Promise<void>; commit(): Promise<void>; rollback(): Promise<void>; release(): void; }
interface OperationPool extends QueryExecutor { getConnection(): Promise<Transaction>; }
type OperationInput = Omit<Operation, 'id' | 'state' | 'attempt' | 'createdAt' | 'updatedAt'>;
interface ApprovalRetry {
  authorize(connection: QueryExecutor, previous: Operation): Promise<void>;
  create(connection: QueryExecutor, previous: Operation, operationId: string): Promise<number>;
}

export class OperationRetryUnavailableError extends Error {}

const TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> = {
  queued: ['waiting_approval', 'claimed', 'cancelled', 'failed'],
  waiting_approval: ['claimed', 'cancelled'],
  claimed: ['running', 'succeeded', 'queued', 'unknown', 'cancelled'],
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

  async create(input: OperationInput): Promise<Operation> {
    const pool = this.poolProvider();
    if (!pool) throw new Error('Operation database unavailable');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const operation = await this.insert(connection, input);
      await connection.commit();
      return operation;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }

  private async insert(connection: QueryExecutor, input: OperationInput, retry?: Operation): Promise<Operation> {
    const id = randomUUID();
    await connection.query(
      `INSERT INTO operations (id, actor_id, origin, resource_type, resource_id, command_type, risk, idempotency_key, approval_id, correlation_id, state, attempt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [id, input.actorId, input.origin, input.resource.type, input.resource.id, input.commandType, input.risk, input.idempotencyKey, input.approvalId ?? null, input.correlationId, retry ? retry.attempt + 1 : 1],
    );
    const [[row]] = await connection.query<any[]>(
      `SELECT * FROM operations WHERE actor_id = ? AND idempotency_key = ? FOR UPDATE`, [input.actorId, input.idempotencyKey],
    );
    if (!row || (retry && row.id !== id)) throw new Error('Operation insert failed');
    if (row.id === id) {
      let metadata: Record<string, unknown> | undefined = retry ? { previousOperationId: retry.id } : undefined;
      const ref = { type: row.resource_type, id: Number(row.resource_id) } as ResourceRef;
      if (['instance', 'server', 'network_device'].includes(ref.type) && Number.isSafeInteger(ref.id) && ref.id > 0) {
        const [policies] = await connection.query<any[]>('SELECT config_value FROM system_config WHERE config_key = ? LIMIT 1', [recoveryPolicyKey(ref)]);
        if (policies[0]) {
          try {
            const binding = createRecoveryBinding(policies[0].config_value, Number(row.actor_id), ref, row.command_type);
            if (binding) metadata = { ...metadata, recoveryBinding: binding };
          } catch { metadata = { ...metadata, recoveryBindingUnavailable: 'RECOVERY_POLICY_INVALID' }; }
        }
      }
      await this.append(connection, id, null, 'queued', 'CREATED', input.actorId, metadata);
    }
    return this.map(row);
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

  async setApproval(id: string, approvalId: number): Promise<void> {
    const pool = this.poolProvider();
    if (!pool) throw new Error('Operation database unavailable');
    await pool.query('UPDATE operations SET approval_id = ? WHERE id = ?', [approvalId, id]);
  }

  async getForActor(id: string, actorId: number): Promise<Operation | null> {
    const pool = this.poolProvider();
    if (!pool) throw new Error('Operation database unavailable');
    const [rows] = await pool.query<any[]>('SELECT * FROM operations WHERE id = ? AND actor_id = ?', [id, actorId]);
    return rows[0] ? this.map(rows[0]) : null;
  }

  async listForActor(actorId: number, limit = 50): Promise<Operation[]> {
    const pool = this.poolProvider();
    if (!pool) throw new Error('Operation database unavailable');
    const [rows] = await pool.query<any[]>('SELECT * FROM operations WHERE actor_id = ? ORDER BY created_at DESC LIMIT ?', [actorId, Math.min(Math.max(limit, 1), 200)]);
    return rows.map((row) => this.map(row));
  }

  async eventsForActor(id: string, actorId: number): Promise<OperationEvent[] | null> {
    const pool = this.poolProvider();
    if (!pool) throw new Error('Operation database unavailable');
    const [rows] = await pool.query<any[]>(
      `SELECT oe.* FROM operation_events oe JOIN operations o ON o.id = oe.operation_id
       WHERE oe.operation_id = ? AND o.actor_id = ? ORDER BY oe.created_at ASC, oe.id ASC`, [id, actorId],
    );
    const exists = await this.getForActor(id, actorId);
    if (!exists) return null;
    return rows.map((row) => ({ operationId: row.operation_id, fromState: row.from_state, toState: row.to_state, reasonCode: row.reason_code, actorId: row.actor_id ?? undefined, metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata ?? undefined, createdAt: new Date(row.created_at) }));
  }

  async recoveryBindingForActor(id: string, actorId: number): Promise<unknown> {
    const pool = this.poolProvider();
    if (!pool) throw new Error('Operation database unavailable');
    const [rows] = await pool.query<any[]>(`SELECT oe.metadata FROM operation_events oe JOIN operations o ON o.id = oe.operation_id
      WHERE o.id = ? AND o.actor_id = ? AND oe.actor_id = ? AND oe.reason_code = 'CREATED' AND oe.from_state IS NULL
      ORDER BY oe.id ASC LIMIT 1`, [id, actorId, actorId]);
    try { const metadata = typeof rows[0]?.metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0]?.metadata; return metadata?.recoveryBinding ?? null; }
    catch { return null; }
  }

  async cancelForActor(id: string, actorId: number): Promise<Operation | null> {
    const operation = await this.getForActor(id, actorId);
    if (!operation) return null;
    if (!['queued', 'waiting_approval', 'claimed'].includes(operation.state)) {
      throw new Error('Operation cannot be cancelled in its current state');
    }
    return this.transition(id, 'cancelled', 'CANCELLED_BY_ACTOR', actorId);
  }

  async retryForActor(id: string, actorId: number, approval?: ApprovalRetry): Promise<Operation | null> {
    const pool = this.poolProvider();
    if (!pool) throw new Error('Operation database unavailable');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[row]] = await connection.query<any[]>('SELECT * FROM operations WHERE id = ? AND actor_id = ? FOR UPDATE', [id, actorId]);
      if (!row) { await connection.commit(); return null; }
      const previous = this.map(row);
      if (previous.state !== 'failed' && previous.state !== 'cancelled') throw new OperationRetryUnavailableError('Operation cannot be retried in its current state');
      if (previous.origin === 'sql-approval') {
        if (!approval || previous.state !== 'failed' || !previous.approvalId) throw new OperationRetryUnavailableError('Operation cannot be retried in its current state');
        await approval.authorize(connection, previous);
      }

      // Serialize duplicates on the original row and find attempts by an internal audit link.
      const [[receipt]] = await connection.query<any[]>(`SELECT metadata FROM operation_events
        WHERE operation_id = ? AND reason_code = 'RETRY_CREATED' ORDER BY id DESC LIMIT 1 FOR SHARE`, [id]);
      if (receipt) {
        const metadata = typeof receipt.metadata === 'string' ? JSON.parse(receipt.metadata) : receipt.metadata;
        const [[existing]] = await connection.query<any[]>('SELECT * FROM operations WHERE id = ? AND actor_id = ?', [metadata?.retryOperationId, actorId]);
        if (!existing) throw new Error('Retry receipt is unavailable');
        await connection.commit();
        return this.map(existing);
      }

      if (previous.origin !== 'sql-approval') {
        // Reuse completed legacy retry requests without deriving any new key from the caller's key.
        const [[legacy]] = await connection.query<any[]>(`SELECT * FROM operations
          WHERE actor_id = ? AND BINARY idempotency_key = ? AND origin = ? AND resource_type = ? AND resource_id = ?
            AND command_type = ? AND risk = ? AND correlation_id = ? AND attempt = ? AND created_at >= ?
          FOR SHARE`, [actorId, `${previous.idempotencyKey}:retry:${previous.attempt + 1}`, previous.origin,
          previous.resource.type, previous.resource.id, previous.commandType, previous.risk, previous.correlationId, previous.attempt + 1, previous.createdAt]);
        if (legacy) { await connection.commit(); return this.map(legacy); }
      }

      const next = await this.insert(connection, { ...previous, actorId, idempotencyKey: randomUUID(), approvalId: undefined }, previous);
      if (previous.origin === 'sql-approval' && approval) {
        const approvalId = await approval.create(connection, previous, next.id);
        await connection.query("UPDATE operations SET approval_id = ?, state = 'waiting_approval' WHERE id = ?", [approvalId, next.id]);
        await this.append(connection, next.id, 'queued', 'waiting_approval', 'NEEDS_APPROVAL', actorId, { approvalRequestId: approvalId });
        next.state = 'waiting_approval';
        next.approvalId = approvalId;
      }
      await this.append(connection, previous.id, previous.state, previous.state, 'RETRY_CREATED', actorId,
        { retryOperationId: next.id, retryApprovalId: next.approvalId, retryAttempt: next.attempt });
      await connection.commit();
      return next;
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
