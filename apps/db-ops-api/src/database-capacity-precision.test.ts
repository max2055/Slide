import { describe, expect, it, vi } from 'vitest';
import { databaseService } from './database-service.js';

describe('capacity total precision', () => {
  it('sums raw MySQL bytes instead of rounded per-database GB values', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[
        { db_name: 'a', size_gb: '0.00', size_bytes: 3_221_225, table_count: 1 },
        { db_name: 'b', size_gb: '0.00', size_bytes: 3_221_225, table_count: 1 },
      ]])
      .mockResolvedValueOnce([[]]);

    const result = await (databaseService as any).getMySQLCapacity({ pool: { execute } });

    expect(result.total_size_gb).toBe(0.01);
  });

  it('sums raw Dameng bytes instead of rounded per-tablespace GB values', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [
        ['A', 210_000_000, 1_073_741_824],
        ['B', 210_000_000, 1_073_741_824],
      ] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await (databaseService as any).getDamengCapacity({ dmConnection: { execute } });

    expect(result.tablespaces.map((row: { size_gb: number }) => row.size_gb)).toEqual([0.20, 0.20]);
    expect(result.total_size_gb).toBe(0.39);
  });
});
