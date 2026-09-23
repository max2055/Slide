import { describe, expect, it, vi } from 'vitest';
import { postgresCounterTransport, POSTGRES_COUNTER_SQL } from './postgres-counter.js';
import { collectDatabase } from '../database/collector.js';
import { databaseReads, implementationId, createDatabaseRegistry, databaseReleases } from '../database/catalog.js';
import { runPackage } from '../packages/runner.js';

const read = databaseReads.find(r => r.engine === 'postgresql' && r.name === 'transactions')!;
const snapshot = (extra: Record<string, unknown> = {}) => ({ database: 'bound', commits: '9007199254740993', rollbacks: '7',
  database_oid: '16384', startup: '2026-09-23T01:00:00.000001Z', reset: '2026-09-23T02:00:00.000001Z',
  sampled_at: '2026-09-23T03:00:00.000001Z', ...extra });
const query = { sql: read.sql, timeout: 345 };

describe('PostgreSQL authoritative counter snapshot', () => {
  it('uses one fixed read for values and lifecycle, preserving exact large counters', async () => {
    const execute = vi.fn(async () => ({ rows: [snapshot()] }));
    const t = postgresCounterTransport(execute);
    const rows = await collectDatabase(implementationId(read), t, {}, 345);
    expect(execute).toHaveBeenCalledExactlyOnceWith(POSTGRES_COUNTER_SQL, 345);
    expect(rows[0]).toMatchObject({ dimensions: { database: 'bound' }, fields: { commits: { encoding: 'uint64', value: '9007199254740993' } },
      observed_at: '2026-09-23T03:00:00.000Z', counter: { bits: '64', start_at: '2026-09-23T01:00:00.000Z', discontinuity: { observed_at: '2026-09-23T02:00:00.000Z', reason: 'reset' } } });
  });
  it('keeps epoch identity stable across samples and distinguishes microsecond resets and target identity', async () => {
    const epoch = async (extra: Record<string, unknown>) => (await postgresCounterTransport(async () => ({ rows: [snapshot(extra)] })).counterQuery!(query)).counter;
    const first = await epoch({});
    expect(await epoch({ sampled_at: '2026-09-23T03:01:00.000001Z', commits: '9999999999999999' })).toEqual(first);
    for (const extra of [{ reset: '2026-09-23T02:00:00.000002Z' }, { startup: '2026-09-23T01:00:00.000002Z' }, { database_oid: '16385' }]) {
      expect((await epoch(extra))?.discontinuity?.epoch).not.toEqual(first?.discontinuity?.epoch);
    }
  });
  it('accepts never-reset statistics without inventing a reset timestamp', async () => {
    const result = await postgresCounterTransport(async () => ({ rows: [snapshot({ reset: null })] })).counterQuery!(query);
    expect(result.counter).toMatchObject({ discontinuity: { reason: 'boot', observed_at: '2026-09-23T01:00:00.000Z' } });
  });
  it.each([{ reset: undefined }, { reset: 'bad' }, { startup: null }, { database_oid: '0' }, { database_oid: '1e2' },
    { sampled_at: '2026-09-23T00:00:00.000001Z' }, { reset: '2026-09-24T01:00:00.000001Z' }, { database: '' }])('rejects missing or contradictory lifecycle evidence %j', async extra => {
    await expect(postgresCounterTransport(async () => ({ rows: [snapshot(extra)] })).counterQuery!(query)).rejects.toThrow('parse_error');
  });
  it('does not accept an arbitrary counter query and does not hide ordinary driver behavior', async () => {
    const execute = vi.fn(async () => ({ rows: [{ connections: '3' }] }));
    const t = postgresCounterTransport(execute);
    await expect(t.counterQuery!({ sql: 'SELECT secret', timeout: 345 })).rejects.toThrow('parse_error');
    expect(execute).not.toHaveBeenCalled();
    expect((await t.pool.query({ sql: 'SELECT COUNT(*)', timeout: 345 }))[0]).toEqual([{ connections: '3' }]);
  });
  it('normalizes native errors without leaking server text', async () => {
    const t = postgresCounterTransport(async () => { throw Object.assign(new Error('private database detail'), { code: '42501' }); });
    await expect(collectDatabase(implementationId(read), t, {}, 345)).rejects.toThrow('permission_denied');
  });
  it('derives a rate only within a stable epoch and guards the atomic read with cancellation', async () => {
    const registry = createDatabaseRegistry(), release = databaseReleases().find(r => r.package.id === 'postgresql-representative')!;
    const selection = { package: (({ id, version, digest }) => ({ id, version, digest }))(release.package), credential_ref: 'credential:test', overrides: {} };
    let raw = snapshot({ commits: '100' });
    const execute = vi.fn(async () => ({ rows: [raw] }));
    const transport = postgresCounterTransport(execute), check = vi.fn(async () => undefined);
    const base = { resource: { type: 'instance' as const, id: '1', attributes: {
      'db.engine': { value: 'postgresql', source: 'driver', observed_at: raw.sampled_at },
      'db.version': { value: '16.4', source: 'driver', observed_at: raw.sampled_at } } },
      collector_ids: ['postgresql-transactions'], binding_id: 'binding:1', config_revision: 1, evidence: {},
      resolve: async () => transport, before_request: check };
    const run = async (n: number, states?: Awaited<ReturnType<typeof runPackage>>['states']) => runPackage(registry, selection,
      { ...base, attempt_id: `attempt:${n}`, observed_at: raw.sampled_at, clock: () => raw.sampled_at, states });
    const first = await run(1);
    raw = snapshot({ commits: '160', sampled_at: '2026-09-23T03:01:00.000001Z' });
    const second = await run(2, first.states);
    const rate = (r: Awaited<ReturnType<typeof runPackage>>) => r.observations.find(o => o.observation.metric.id === 'postgresql.transactions.commit_rate')!.observation;
    expect(rate(first).quality.reason).toBe('counter_baseline');
    expect(rate(second).value).toEqual({ encoding: 'float64', value: 1 });
    raw = snapshot({ commits: '200', reset: '2026-09-23T03:01:30.000001Z', sampled_at: '2026-09-23T03:02:00.000001Z' });
    expect(rate(await run(3, second.states))).toMatchObject({ value: null, quality: { reason: 'counter_reset' } });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(check).toHaveBeenCalled();
    const signal = AbortSignal.abort();
    await expect(runPackage(registry, selection, { ...base, signal, attempt_id: 'cancelled', observed_at: raw.sampled_at })).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
