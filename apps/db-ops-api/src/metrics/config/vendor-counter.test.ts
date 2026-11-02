import { describe, expect, it, vi } from 'vitest';
import { vendorCounterTransport, ORACLE_COUNTER_SQL, DAMENG_COUNTER_SQL } from './vendor-counter.js';
import { databaseReads } from '../database/catalog.js';

describe.each(['oracle', 'dameng'] as const)('%s native counter snapshot', engine => {
  const sql = databaseReads.find(r => r.engine === engine && r.name === 'transactions')!.sql;
  const row = (startup = '2026-11-02 08:00:00') => ['9007199254740993', startup, 'fixture-instance', ...(engine === 'oracle' ? ['CDB$ROOT'] : [])];
  it('retains exact values and a stable native epoch, then changes epoch on startup change', async () => {
    let startup = '2026-11-02 08:00:00', clock = '2026-11-02T08:10:00.000Z';
    const execute = vi.fn(async () => ({ rows: [row(startup)] }));
    const state = {};
    const transport = vendorCounterTransport(engine, execute, state, () => clock);
    const first = await transport.counterQuery!({ sql, timeout: 987 });
    expect(first.rows).toEqual([['9007199254740993']]);
    expect(first.counter).toMatchObject({ bits: '64', discontinuity: { reason: 'initial', observed_at: clock } });
    expect(first.counter.start_at).toBeUndefined(); // Never interpret server-local DATE as collector-local time.
    clock = '2026-11-02T08:10:05.000Z';
    const second = await vendorCounterTransport(engine, execute, state, () => clock).counterQuery!({ sql, timeout: 987 });
    expect(second.counter).toEqual(first.counter);
    expect(second.observed_at).toBe(clock);
    startup = '2026-11-02 08:10:03';
    const rebooted = await transport.counterQuery!({ sql, timeout: 987 });
    expect(rebooted.counter.discontinuity!.epoch).not.toBe(first.counter.discontinuity!.epoch);
    expect(rebooted.counter.discontinuity!.observed_at).toBe(clock);
    expect(execute).toHaveBeenCalledWith(engine === 'oracle' ? ORACLE_COUNTER_SQL : DAMENG_COUNTER_SQL, 987);
    const fresh = await vendorCounterTransport(engine, execute, {}, () => '2026-11-02T08:11:00.000Z').counterQuery!({ sql, timeout: 987 });
    expect(fresh.counter.discontinuity!.observed_at).not.toBe(rebooted.counter.discontinuity!.observed_at);
  });
  it('rejects missing/ambiguous lifecycle rows, rounded counters and arbitrary counter SQL', async () => {
    for (const rows of [[], [row(), row()], [[1]], [[9007199254740992, ...row().slice(1)]], [[null, ...row().slice(1)]], [[...row().slice(0,1), null, ...row().slice(2)]]]) {
      const transport = vendorCounterTransport(engine, async () => ({ rows }));
      await expect(transport.counterQuery!({ sql, timeout: 1000 })).rejects.toMatchObject({ code: 'parse_error' });
    }
    const execute = vi.fn();
    await expect(vendorCounterTransport(engine, execute).counterQuery!({ sql: 'SELECT 1', timeout: 1000 })).rejects.toMatchObject({ code: 'parse_error' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('propagates denial/timeout once without retrying the old value-only read', async () => {
    for (const code of ['ORA-01031', 'ORA-01013', 'ECONNRESET']) {
      const execute = vi.fn().mockRejectedValue(Object.assign(new Error('fixture failure'), { code }));
      await expect(vendorCounterTransport(engine, execute).counterQuery!({ sql, timeout: 1000 })).rejects.toMatchObject({ code });
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });
});
