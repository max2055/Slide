import type { DatabaseConnection } from '../database-service.js';

export async function collectDamengMemoryUsage(
  connection: NonNullable<DatabaseConnection['dmConnection']>,
): Promise<number | null> {
  // DM8 pool data bytes / current pool bytes, not host physical memory usage.
  const result = await connection.execute(`
    SELECT SUM(TOTAL_SIZE), SUM(DATA_SIZE) FROM V$MEM_POOL
  `);
  const row = result.rows?.[0];
  if (!Array.isArray(row) || row[0] == null || row[1] == null) return null;
  const total = Number(row[0]);
  const used = Number(row[1]);
  if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0 || used < 0) return null;
  return Math.min(100, Math.round((used / total) * 10_000) / 100);
}
