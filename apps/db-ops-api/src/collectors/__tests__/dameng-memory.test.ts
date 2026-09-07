import { describe, expect, it, vi } from 'vitest';
import type { DatabaseConnection } from '../../database-service.js';
import type { MetricDefinition } from '../../metric-registry.js';
import { DamengProvider } from '../dameng.provider.js';

describe('Dameng memory collection', () => {
  it.each([
    { rows: [[1000, 375]], expected: 37.5 },
    { rows: [['300', '100']], expected: 33.33 },
    { rows: [[100, 0]], expected: 0 },
    { rows: [[100, 110]], expected: 100 },
    { rows: [], expected: null },
    { rows: [[null, null]], expected: null },
    { rows: [[100, null]], expected: null },
    { rows: [[0, 0]], expected: null },
    { rows: [[100, -1]], expected: null },
    { rows: [['invalid', 10]], expected: null },
    { rows: [[100, Infinity]], expected: null },
  ])('returns $expected for $rows', async ({ rows, expected }) => {
    const execute = vi.fn().mockResolvedValue({ rows });
    const instance = { dmConnection: { execute } } as unknown as DatabaseConnection;
    const result = await new DamengProvider().collect(instance, { id: 'memory_usage' } as MetricDefinition);
    expect(result).toBe(expected);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toMatch(/SUM\(TOTAL_SIZE\), SUM\(DATA_SIZE\) FROM V\$MEM_POOL/);
  });
});
