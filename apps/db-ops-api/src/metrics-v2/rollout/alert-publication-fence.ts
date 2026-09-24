import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { dbConnection } from '../../db-connection.js';

const fenceSchema = z.strictObject({
  series_hash: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.string().min(1).max(128),
  generation: z.number().int().positive().max(4_294_967_295),
  revision: z.number().int().positive().max(4_294_967_295),
});

export type RolloutAlertFence = z.infer<typeof fenceSchema>;
export type RolloutAlertPublicationResult = 'published' | 'stale';
export interface RolloutAlertPublicationGate {
  run(alertId: number, fence: RolloutAlertFence, publish: () => Promise<void>): Promise<RolloutAlertPublicationResult>;
}

const decode = (value: unknown): unknown => typeof value === 'string' ? JSON.parse(value) : value;

export function rolloutAlertLockName(seriesHash: string): string {
  const hash = z.string().regex(/^[a-f0-9]{64}$/).parse(seriesHash);
  return `mv2:alert:${hash.slice(0, 48)}`;
}

export function parseRolloutAlertFence(alert: { source?: unknown; tags?: unknown }): RolloutAlertFence | undefined {
  if (alert.source !== 'metrics-v2-rollout') return undefined;
  const tags = decode(alert.tags);
  const parsed = fenceSchema.safeParse(tags && typeof tags === 'object' ? (tags as Record<string, unknown>).rollout_fence : undefined);
  if (!parsed.success) throw new Error('ROLLOUT_ALERT_FENCE_INVALID');
  return parsed.data;
}

/** Holds the per-series lock until the receiver call settles, so cutover,
 * rollback and recovery cannot invalidate an alert between validation and send. */
export class MysqlRolloutAlertPublicationGate implements RolloutAlertPublicationGate {
  constructor(private readonly poolProvider: () => Pool | null = () => dbConnection.getPool()) {}

  async run(alertId: number, input: RolloutAlertFence, publish: () => Promise<void>): Promise<RolloutAlertPublicationResult> {
    if (!Number.isSafeInteger(alertId) || alertId < 1) throw new Error('ROLLOUT_ALERT_FENCE_INVALID');
    const fence = fenceSchema.parse(input);
    const pool = this.poolProvider();
    if (!pool) throw new Error('ROLLOUT_ALERT_FENCE_UNAVAILABLE');
    const connection = await pool.getConnection();
    const lockName = rolloutAlertLockName(fence.series_hash);
    let locked = false;
    let inTransaction = false;
    try {
      const [lock] = await connection.execute<RowDataPacket[]>('SELECT GET_LOCK(?, 10) AS acquired', [lockName]);
      if (Number(lock[0]?.acquired) !== 1) throw new Error('ROLLOUT_ALERT_FENCE_UNAVAILABLE');
      locked = true;
      await connection.beginTransaction();
      inTransaction = true;
      const [rollout] = await connection.execute<RowDataPacket[]>(`SELECT source, generation, published_revision, applied_revision
        FROM metric_v2_rollout WHERE series_hash = ? FOR UPDATE`, [fence.series_hash]);
      const [alerts] = await connection.execute<RowDataPacket[]>(
        'SELECT status, source, tags FROM alerts WHERE id = ? FOR UPDATE', [alertId],
      );
      const alertFence = alerts[0] ? parseRolloutAlertFence({ source: alerts[0].source, tags: alerts[0].tags }) : undefined;
      const current = rollout[0];
      const valid = alerts[0]?.status === 'unread'
        && alertFence?.series_hash === fence.series_hash
        && alertFence.source === fence.source
        && alertFence.generation === fence.generation
        && alertFence.revision === fence.revision
        && current?.source === fence.source
        && Number(current.generation) === fence.generation
        && Number(current.published_revision) === fence.revision
        && Number(current.applied_revision) === fence.revision;
      await connection.commit();
      inTransaction = false;
      if (!valid) return 'stale';
      await publish();
      return 'published';
    } catch (error) {
      if (inTransaction) await connection.rollback().catch(() => undefined);
      if (error instanceof Error && error.message === 'ROLLOUT_ALERT_FENCE_INVALID') return 'stale';
      throw error;
    } finally {
      let reusable = true;
      if (locked) {
        let released = false;
        try {
          const [rows] = await connection.execute<RowDataPacket[]>('SELECT RELEASE_LOCK(?) AS released', [lockName]);
          released = Number(rows[0]?.released) === 1;
        } catch { /* Destroy below so a held named lock never returns to the pool. */ }
        if (!released) { connection.destroy(); reusable = false; }
      }
      if (reusable) connection.release();
    }
  }
}

export const rolloutAlertPublicationGate = new MysqlRolloutAlertPublicationGate();
