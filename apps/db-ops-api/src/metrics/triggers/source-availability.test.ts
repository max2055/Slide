import { describe, expect, it, vi } from 'vitest';
import type { PoolConnection } from 'mysql2/promise';
import { readTriggerSourceAvailability } from './source-availability.js';

const resource = { type: 'instance', id: 5 } as const;
const measured = (id: string) => ({ id, stage: 'raw' as const });
const normalized = (id: string, lineage: unknown[]) => ({ id, stage: 'normalized' as const, lineage });
const now = new Date('2026-11-01T00:00:00Z');

describe('template event source availability', () => {
  it('uses authorized resource and bounded IDs while following normalized lineage', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[normalized('opening', [{ id: 'derived-input', stage: 'normalized' }])], []])
      .mockResolvedValueOnce([[normalized('derived-input', [measured('raw')])], []])
      .mockResolvedValueOnce([[{ ...measured('raw'), retained: 1, expired: 0 }], []]);
    const connection = { execute } as unknown as Pick<PoolConnection, 'execute'>;
    expect(await readTriggerSourceAvailability(connection, resource, ['opening', 'opening'], now)).toBe('available');
    expect(execute.mock.calls.map(([, parameters]) => parameters.slice(2))).toEqual([
      ['opening', 'instance', '5'], ['derived-input', 'instance', '5'], ['raw', 'instance', '5'],
    ]);
  });

  it.each([
    { sources: [{ ...measured('raw'), retained: 0, expired: 1 }], status: 'expired' },
    { sources: [{ ...measured('raw'), retained: 0, expired: 0 }], status: 'unknown' },
    { sources: [], status: 'unknown' },
    { sources: [{ id: 'raw', stage: 'normalized', retained: 1 }], status: 'unknown' },
  ])('distinguishes known expiry and unknown lineage from available evidence %#', async ({ sources, status }) => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[normalized('opening', [measured('raw')])], []])
      .mockResolvedValueOnce([sources, []]);
    const connection = { execute } as unknown as Pick<PoolConnection, 'execute'>;
    expect(await readTriggerSourceAvailability(connection, resource, ['opening'], now)).toBe(status);
  });

  it('preserves unknown for old snapshots with no references and cyclic lineage', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[normalized('opening', [
        { id: 'opening', stage: 'normalized' }, measured('raw'),
      ])], []])
      .mockResolvedValueOnce([[{ ...measured('raw'), retained: 1, expired: 0 }], []]);
    const connection = { execute } as unknown as Pick<PoolConnection, 'execute'>;
    expect(await readTriggerSourceAvailability(connection, resource, undefined, now)).toBe('unknown');
    expect(execute).not.toHaveBeenCalled();
    expect(await readTriggerSourceAvailability(connection, resource, ['opening'], now)).toBe('unknown');
  });
});
