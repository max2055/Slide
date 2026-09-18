import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { createDatabaseRegistry, databaseReads, databaseReleases } from './catalog.js';
import { bindDatabaseDriver } from './collector.js';
import { runPackage, type PackageExecution } from '../packages/runner.js';
import { MySQLProvider } from '../../collectors/mysql.provider.js';
import { PostgreSQLProvider } from '../../collectors/postgresql.provider.js';
import { OracleProvider } from '../../collectors/oracle.provider.js';
import { DamengProvider } from '../../collectors/dameng.provider.js';
import { sealRelease } from '../packages/model.js';
import { MYSQL_STATUS_SQL, classifyError } from '../packages/adapters.js';
import { validateObservationBatch } from '../../contracts/metrics-v2/index.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../../docs/slide/metrics-v2/database/fixtures.json', import.meta.url), 'utf8'));
const registry = createDatabaseRegistry();
const release = (engine: string) => databaseReleases().find(r => r.package.id === `${engine}-representative`)!;
const selection = (engine: string) => ({ package: (({ id, version, digest }) => ({ id, version, digest }))(release(engine).package), credential_ref: 'credential:fixture', overrides: {} });
function setup(f: typeof fixture.engines[0], mutate?: (name: string, rows: any) => any) {
  const execute = vi.fn(async (sql: string, _timeout: number) => {
    const name = sql === MYSQL_STATUS_SQL ? 'status' : databaseReads.find(r => r.engine === f.engine && r.sql === sql)?.name;
    if (!name) throw new Error('UNEXPECTED_SQL');
    const rows = structuredClone(f.rows[name]);
    return { rows: mutate ? mutate(name, rows) : rows };
  });
  const e: PackageExecution = { resource: { id: 'db-1', type: 'instance', attributes: {
    'db.engine': { value: f.engine, source: 'driver', observed_at: fixture.observed_at }, 'db.version': { value: f.version, source: 'driver', observed_at: fixture.observed_at },
  } }, binding_id: 'binding-1', attempt_id: 'attempt-1', config_revision: 1, observed_at: fixture.observed_at, clock: () => e.observed_at,
  evidence: { counter: { bits: '64', start_at: fixture.start_at } }, resolve: async () => bindDatabaseDriver(execute) };
  return { e, execute };
}
const point = (r: Awaited<ReturnType<typeof runPackage>>, id: string) => r.observations.find(o => o.observation.metric.id === id)!.observation;

describe('MAX-71 database representative packages', () => {
  it.each([
    [{ code: '42501' }, 'permission_denied'], [{ code: '57014' }, 'timeout'],
    [{ code: 'ORA-01031' }, 'permission_denied'], [{ errorNum: 1031 }, 'permission_denied'],
    [{ errorNum: 1013 }, 'timeout'], [{ code: 'DPI-1067' }, 'timeout'],
    [{ errCode: -551 }, 'permission_denied'], [{ errCode: 20010 }, 'timeout'],
  ])('classifies native driver error %j without exposing remote text', (error, expected) => {
    expect(classifyError(Object.assign(new Error('private details'), error))).toBe(expected);
  });
  it('exports immutable releases and refuses to force unlike session semantics onto Canonical uptime', () => {
    const exported = JSON.parse(readFileSync(new URL('../../../../../docs/slide/metrics-v2/database/releases.json', import.meta.url), 'utf8'));
    expect(exported).toEqual(databaseReleases());
    const incompatible = structuredClone(release('mysql'));
    incompatible.package.version = '1.1.0';
    incompatible.package.collectors.find(c => c.id === 'mysql-connections')!.mappings[0].metric = { id: 'db.uptime_seconds', semantic_version: '1.0.0' };
    expect(() => registry.install(sealRelease(incompatible))).toThrow();
    const identities = databaseReads.filter(r => r.name === 'connections').map(r => r.fields[0].definition.id);
    expect(new Set(identities).size).toBe(4);
  });
  it.each(fixture.engines)('matches the existing $engine connection gauge without changing legacy consumers', async f => {
    const providers = { mysql: new MySQLProvider(), postgresql: new PostgreSQLProvider(), oracle: new OracleProvider(), dameng: new DamengProvider() };
    const connection = {
      pool: { query: async () => [[{ count: 3 }], []] }, pgClient: { query: async () => ({ rows: [{ count: '3' }] }) },
      oracleConnection: { execute: async () => ({ rows: [[3]] }) }, dmConnection: { execute: async () => ({ rows: [[3]] }) },
    };
    const legacy = await providers[f.engine as keyof typeof providers].collect(connection as never, { id: 'connections' } as never);
    const id = databaseReads.find(r => r.engine === f.engine && r.name === 'connections')!.fields[0].definition.id;
    const next = point(await runPackage(registry, selection(f.engine), setup(f).e), id);
    expect(next.value).toEqual({ encoding: 'uint64', value: String(legacy) });
  });

  it.each(fixture.engines)('normalizes $engine $version without semantic aliases, preserving precision and lineage', async f => {
    const { e, execute } = setup(f), s = selection(f.engine);
    const result = await runPackage(registry, s, e);
    expect(result.attempts.every(a => a.status === 'succeeded')).toBe(true);
    validateObservationBatch(result.observations.map(o => o.observation), registry.catalog(s.package));
    expect(execute).toHaveBeenCalledTimes(release(f.engine).package.collectors.length);
    expect(execute.mock.calls.every(c => c[1] === 5000)).toBe(true);
    const counter = result.observations.find(o => o.observation.metric.id.endsWith('commit_total'))!.observation;
    expect(counter.value).toEqual({ encoding: 'uint64', value: '9007199254740993' });
    expect(counter.lineage[0].stage).toBe('raw');
    expect(counter.versions).toMatchObject({ package_id: `${f.engine}-representative`, package_version: '1.0.0', config_revision: 1, transform_version: '1.0.0' });
    expect(result.observations.some(o => o.observation.metric.id === 'db.version')).toBe(false);
    expect(result.observations.every(o => o.observation.resource_type === 'instance' && !o.observation.metric.id.startsWith('host.'))).toBe(true);
    expect(result.observations.filter(o => o.observation.production === 'derived').every(o => o.observation.value === null)).toBe(true);
    if (f.engine === 'postgresql') {
      expect(counter.dimensions).toEqual({ database: 'fixture_db' });
      expect(result.observations.filter(o => o.observation.production === 'derived').every(o => o.observation.dimensions.database === 'fixture_db')).toBe(true);
    }
  });
  it.each(fixture.engines)('derives $engine rates from exact deltas and resets on restart', async f => {
    const first = await runPackage(registry, selection(f.engine), setup(f).e);
    const { e } = setup(f, (name, rows) => {
      if (name === 'transactions') {
        if (f.engine === 'mysql') rows[0].Value = '9007199254741003';
        else if (f.engine === 'postgresql') rows[0].commits = '9007199254741003';
        else rows[0][0] = '9007199254741003';
      }
      return rows;
    });
    e.states = first.states; e.observed_at = '2026-09-01T00:01:02.000Z'; e.attempt_id = 'attempt-2';
    const prefix = f.engine === 'mysql' ? 'mysql.transaction_commands' : `${f.engine}.transactions`;
    const next = await runPackage(registry, selection(f.engine), e);
    expect(point(next, `${prefix}.commit_rate`).value).toEqual({ encoding: 'float64', value: 5 });
    if (['mysql', 'postgresql'].includes(f.engine)) expect(point(next, `${prefix}.completed_rate`).value).toEqual({ encoding: 'float64', value: 5 });
    e.states = next.states; e.observed_at = '2026-09-01T00:01:04.000Z'; e.evidence.counter!.start_at = '2026-09-01T00:01:03.000Z';
    const reset = point(await runPackage(registry, selection(f.engine), e), `${prefix}.commit_rate`);
    expect(reset.value).toBeNull(); expect(reset.quality.reason).toBe('counter_reset');
  });
  it.each(fixture.engines)('isolates $engine missing scalar and denied query, with no fallback defaults', async f => {
    const { e } = setup(f, (name, rows) => {
      if (name === 'connections') throw Object.assign(new Error('private secret'), { code: 'EACCES' });
      if (name === 'limit') return [];
      return rows;
    });
    const result = await runPackage(registry, selection(f.engine), e);
    expect(result.attempts.find(a => a.collector_id.endsWith('-connections'))).toMatchObject({ status: 'failed', error: 'permission_denied' });
    expect(result.attempts.find(a => a.collector_id.endsWith('-limit'))).toMatchObject({ status: 'failed', error: 'parse_error' });
    expect(result.observations.some(o => o.observation.metric.id.endsWith('commit_total'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private secret');
  });
  it('keeps a healthy mapping when its sibling status counter is missing or lossy', async () => {
    for (const bad of [undefined, 9007199254740992, '-1']) {
      const { e } = setup(fixture.engines[0], (name, rows) => { if (name === 'transactions') rows[0].Value = bad; return rows; });
      const result = await runPackage(registry, selection('mysql'), e);
      expect(result.attempts.find(a => a.collector_id === 'mysql-transactions')!.status).toBe('partial');
      expect(point(result, 'mysql.transaction_commands.rollback_total').value).toEqual({ encoding: 'uint64', value: '4' });
      expect(point(result, 'mysql.transaction_commands.completed_rate').value).toBeNull();
    }
  });
  it('marks allocation estimates and retains NULL instead of fabricating size or host metrics', async () => {
    const { e } = setup(fixture.engines[0]);
    expect(point(await runPackage(registry, selection('mysql'), e), 'mysql.tables.estimated_allocated_bytes')).toMatchObject({ accuracy: 'estimated', production: 'measured', unit: 'By' });
    const missing = setup(fixture.engines[0], (name, rows) => name === 'size' ? [{ bytes: null }] : rows);
    expect(point(await runPackage(registry, selection('mysql'), missing.e), 'mysql.tables.estimated_allocated_bytes')).toMatchObject({ value: null, accuracy: 'unknown' });
  });
  it.each(['5.7.44', '8.0.40', '8.4.6'])('keeps same Canonical uptime meaning on MySQL %s', async version => {
    const { e } = setup({ ...fixture.engines[0], version });
    expect(point(await runPackage(registry, selection('mysql'), e), 'db.uptime_seconds').value).toEqual({ encoding: 'float64', value: 60 });
  });
  it.each(fixture.engines)('rejects unqualified $engine versions and missing version before I/O', async f => {
    const { e, execute } = setup(f); e.resource.attributes['db.version'].value = '99.0';
    expect((await runPackage(registry, selection(f.engine), e)).decision).toBe('unsupported');
    delete e.resource.attributes['db.version'];
    expect((await runPackage(registry, selection(f.engine), e)).decision).toBe('capability_unknown');
    expect(execute).not.toHaveBeenCalled();
  });
  it('refuses transaction counters without trusted epoch but retains gauges', async () => {
    const { e } = setup(fixture.engines[0]); e.evidence = {};
    const result = await runPackage(registry, selection('mysql'), e);
    expect(point(result, 'mysql.connections.limit').value).toEqual({ encoding: 'uint64', value: '151' });
    expect(result.observations.some(o => o.observation.metric.id.endsWith('commit_total'))).toBe(false);
  });
  it('preserves timeout capability evidence and stops new SQL after cancellation', async () => {
    const { e } = setup(fixture.engines[0]); e.previous_capabilities = (await runPackage(registry, selection('mysql'), e)).capabilities;
    e.resolve = async () => bindDatabaseDriver(async () => { throw Object.assign(new Error('secret'), { code: 'ETIMEDOUT' }); });
    const timed = await runPackage(registry, selection('mysql'), e);
    expect(timed.attempts.every(a => a.error === 'timeout')).toBe(true);
    expect(timed.capabilities.find(c => c.metric.id === 'mysql.connections.limit')!.status).toBe('supported');
    const controller = new AbortController(); e.signal = controller.signal;
    const execute = vi.fn(async () => { controller.abort(); return { rows: [] }; }); e.resolve = async () => bindDatabaseDriver(execute);
    await expect(runPackage(registry, selection('mysql'), e)).rejects.toThrow(); expect(execute).toHaveBeenCalledTimes(1);
  });
});
