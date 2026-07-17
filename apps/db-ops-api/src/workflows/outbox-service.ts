import { randomUUID } from 'node:crypto';

export interface TransactionConnection { execute(sql: string, values?: unknown[]): Promise<unknown>; beginTransaction(): Promise<void>; commit(): Promise<void>; rollback(): Promise<void>; release(): void; }
export interface TransactionPool { getConnection(): Promise<TransactionConnection>; }
export type OutboxInput = { eventType: string; schemaVersion: number; aggregateType: string; aggregateId: string; aggregateVersion: number; payload: Record<string, unknown>; idempotencyKey: string; availableAt?: Date };

export class OutboxService {
  constructor(private readonly pool: TransactionPool) {}
  async transaction<T>(work: (connection: TransactionConnection, append: (event: OutboxInput) => Promise<string>) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    await connection.beginTransaction();
    try {
      const result = await work(connection, (event) => this.append(connection, event));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }
  async append(connection: Pick<TransactionConnection, 'execute'>, event: OutboxInput): Promise<string> {
    if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(event.eventType) || !event.idempotencyKey || JSON.stringify(event.payload).length > 64_000) throw new Error('OUTBOX_EVENT_INVALID');
    const id = randomUUID();
    await connection.execute(
      `INSERT INTO outbox_events (id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, payload, idempotency_key, available_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [id, event.eventType, event.schemaVersion, event.aggregateType, event.aggregateId, event.aggregateVersion, JSON.stringify(event.payload), event.idempotencyKey, event.availableAt ?? new Date()],
    );
    return id;
  }
}
