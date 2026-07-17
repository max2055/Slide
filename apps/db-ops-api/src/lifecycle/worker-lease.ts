import { randomUUID } from 'node:crypto';

interface LeasePool {
  query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>;
}

export class WorkerLease {
  readonly ownerId = randomUUID();
  constructor(private readonly pool: LeasePool, private readonly name = 'slide-singleton-workers', private readonly ttlSeconds = 30) {}

  async acquire(): Promise<boolean> {
    await this.pool.query(
      `INSERT INTO worker_leases (lease_name, owner_id, fencing_token, expires_at)
       VALUES (?, ?, 1, DATE_ADD(NOW(), INTERVAL ? SECOND))
       ON DUPLICATE KEY UPDATE
         fencing_token = IF(expires_at < NOW(), fencing_token + 1, fencing_token),
         owner_id = IF(expires_at < NOW(), VALUES(owner_id), owner_id),
         expires_at = IF(expires_at < NOW(), VALUES(expires_at), expires_at)`,
      [this.name, this.ownerId, this.ttlSeconds],
    );
    const [rows] = await this.pool.query<Array<{ owner_id: string }>>('SELECT owner_id FROM worker_leases WHERE lease_name = ?', [this.name]);
    return rows[0]?.owner_id === this.ownerId;
  }

  async release(): Promise<void> {
    await this.pool.query('DELETE FROM worker_leases WHERE lease_name = ? AND owner_id = ?', [this.name, this.ownerId]);
  }

  async renew(): Promise<boolean> {
    const [result] = await this.pool.query<{ affectedRows: number }>(
      'UPDATE worker_leases SET expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE lease_name = ? AND owner_id = ?',
      [this.ttlSeconds, this.name, this.ownerId],
    );
    return Number(result.affectedRows) === 1;
  }
}
