import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { RefSchema, type Ref } from '../policy/model.js';

export type LegacyMetricWriteResult<T> = { written: true; value: T } | { written: false };

/** Best-effort early gate; the final write fence remains authoritative for in-flight work. */
export async function legacyMetricSourceActive(pool: Pick<Pool, 'getConnection'>, ref: Ref): Promise<boolean> {
  return (await withLegacyMetricWrite(pool, ref, async () => undefined)).written;
}

/**
 * Serialize legacy metric writes with policy publication and rollout changes.
 * Unregistered resources retain legacy behavior; once any registered series is
 * pending, mixed, or V2, the old store is no longer a formal publisher.
 */
export async function withLegacyMetricWrite<T>(
  pool: Pick<Pool, 'getConnection'>,
  input: Ref,
  write: (connection: PoolConnection) => Promise<T>,
): Promise<LegacyMetricWriteResult<T>> {
  const ref = RefSchema.parse(input);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [lock] = await connection.execute<RowDataPacket[]>('SELECT id FROM metric_v2_policy_lock WHERE id = 1 FOR UPDATE');
    if (lock.length !== 1) throw new Error('LEGACY_METRIC_WRITE_FENCE_UNAVAILABLE');
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT source, read_mode, published_revision, applied_revision
      FROM metric_v2_rollout WHERE resource_type = ? AND resource_id = ? ORDER BY series_hash FOR UPDATE`,
    [ref.type, String(ref.id)]);
    const allowed = rows.length === 0 || rows.every(row => row.source === 'legacy' && row.read_mode === 'legacy'
      && Number(row.applied_revision) === Number(row.published_revision));
    if (!allowed) {
      await connection.commit();
      return { written: false };
    }
    const value = await write(connection);
    await connection.commit();
    return { written: true, value };
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}
