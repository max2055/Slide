import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseConnection } from '../../database-service.js';
import { trialDatabaseTransport } from '../config/database-transport.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { checkApplicability } from '../packages/applicability.js';
import { runPackage, type PackageExecution } from '../packages/runner.js';
import { RegisteredCapabilityCatalog } from '../templates/catalog.js';

const registry = createConfigurationRegistry();
const family = 'oracle-representative';
const at = '2026-11-26T02:00:00.000Z';
const later = (seconds: number) => new Date(Date.parse(at) + seconds * 1000).toISOString();
const resource = (version: string) => ({ type: 'instance' as const, id: '9112', attributes: {
  'db.engine': { value: 'oracle', observed_at: at, source: 'driver' },
  'db.version': { value: version, observed_at: at, source: 'driver' },
} });
const selection = (pin: string) => {
  const { id, version, digest } = registry.list().find(r => r.package.id === family && r.package.version === pin)!.package;
  return { package: { id, version, digest }, credential_ref: 'credential:oracle-fixture', overrides: {} };
};
const point = (r: Awaited<ReturnType<typeof runPackage>>, id: string) => r.observations.find(o => o.observation.metric.id === id)!.observation;

afterEach(() => vi.useRealTimers());

it('installs only the Oracle 11.2 family with narrowly scoped read permissions and preserves every 19c pin', async () => {
  const releases = registry.list().filter(r => r.package.id === family);
  expect(releases.slice(0, -1).map(r => [r.package.version, r.package.digest])).toEqual([
    ['1.0.0', 'sha256:6cf602995e5303fd97dd11e4a0f149764a145e4d1224e6cd05cb32dbd8714993'],
    ['1.1.0', 'sha256:c9674f2f8c27e917281042c868506d0f14fc43425b359aad74af8e792757b3c2'],
    ['1.2.0', 'sha256:ccfffa194b82b65a23a9510786e4babd42dbd7b1db86fc98e10740511553437b'],
    ['1.3.0', 'sha256:e7d3e8066bc7d67abde61653bb6975759b20ca5d32e1913da5e662510a9136e9'],
  ]);
  const release = releases.at(-1)!;
  expect(release.package.version).toBe('1.4.0');
  expect(checkApplicability(release.package, resource('11.2.0.4.0'), at).every(c => c.status === 'supported')).toBe(true);
  const resolve = vi.fn();
  for (const version of ['11.1.0.7.0', '11.20.0.0.0', '19.19.0.0.0']) {
    const result = await runPackage(registry, selection('1.4.0'), { resource: resource(version), binding_id: 'oracle-fixture',
      attempt_id: 'wrong-version', config_revision: 1, observed_at: at, evidence: {}, resolve });
    expect(result.decision).toBe('unsupported');
  }
  expect(resolve).not.toHaveBeenCalled();
  const catalog = new RegisteredCapabilityCatalog(registry);
  const pin = selection('1.4.0').package;
  const permissions = release.package.collectors.map(collector => catalog.autofill({ package: pin, metric: collector.mappings[0].metric }));
  expect(permissions.map(m => m.permissions)).toEqual([
    ['CREATE SESSION', 'SELECT V_$SESSION'],
    ['CREATE SESSION', 'SELECT V_$PARAMETER'],
    ['CREATE SESSION', 'SELECT V_$SYSSTAT', 'SELECT V_$INSTANCE'],
  ]);
  expect(permissions[2].discovery).toContain("SYS_CONTEXT('USERENV','DB_UNIQUE_NAME')");
  expect(permissions[2].discovery).not.toContain('CON_NAME');
});

it.each([
  { pin: '1.4.0', version: '11.2.0.4.0', identity: 'DB_UNIQUE_NAME' },
  { pin: '1.3.0', version: '19.19.0.0.0', identity: 'CON_NAME' },
])('collects Oracle $version through the normal pooled transport with exact counters and native restarts', async ({ pin, version, identity }) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  let commits = '9007199254740993';
  let startup = '2026-11-26 01:30:00';
  let databaseIdentity = 'fixture-db';
  let transactionDenied = false;
  const close = vi.fn(async () => {});
  const execute = vi.fn(async (sql: string) => {
    if (sql === 'SET TRANSACTION READ ONLY') return {};
    if (sql === 'SELECT COUNT(*) FROM V$SESSION') return { rows: [['7']] };
    if (sql === "SELECT VALUE FROM V$PARAMETER WHERE NAME = 'processes'") return { rows: [['64']] };
    if (sql.includes(`SYS_CONTEXT('USERENV','${identity}')`) && sql.includes('FROM V$SYSSTAT s CROSS JOIN V$INSTANCE i')) {
      if (transactionDenied) throw Object.assign(new Error('fixture private details'), { code: 'ORA-01031' });
      return { rows: [[commits, startup, 'fixture-instance', databaseIdentity]] };
    }
    throw new Error('UNEXPECTED_SQL');
  });
  const client = { close, execute };
  const connection = { id: 9112, db_type: 'oracle', oracleConnection: { oracleServerVersionString: version },
    oraclePool: { getConnection: async () => client } } as unknown as DatabaseConnection;
  const run = (seconds: number, states?: PackageExecution['states']) => {
    vi.setSystemTime(later(seconds));
    return runPackage(registry, selection(pin), { resource: resource(version), binding_id: 'oracle-fixture', attempt_id: `attempt-${seconds}`,
      config_revision: 1, observed_at: later(seconds), evidence: {}, states, resolve: async () => trialDatabaseTransport(connection) });
  };
  const first = await run(0);
  expect(first.attempts.map(a => a.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
  expect(point(first, 'oracle.sessions.count').value).toEqual({ encoding: 'uint64', value: '7' });
  expect(point(first, 'oracle.processes.limit').value).toEqual({ encoding: 'uint64', value: '64' });
  expect(point(first, 'oracle.transactions.commit_total').value).toEqual({ encoding: 'uint64', value: '9007199254740993' });
  expect(point(first, 'oracle.transactions.commit_rate')).toMatchObject({ value: null, quality: { reason: 'counter_baseline' } });

  commits = '9007199254741003';
  const second = await run(2, first.states);
  expect(point(second, 'oracle.transactions.commit_rate').value).toEqual({ encoding: 'float64', value: 5 });
  startup = '2026-11-26 02:00:03';
  const restart = await run(4, second.states);
  expect(point(restart, 'oracle.transactions.commit_rate')).toMatchObject({ value: null, quality: { reason: 'counter_reset' } });
  databaseIdentity = 'another-fixture-db';
  const changedIdentity = await run(6, restart.states);
  expect(point(changedIdentity, 'oracle.transactions.commit_rate')).toMatchObject({ value: null, quality: { reason: 'counter_reset' } });

  transactionDenied = true;
  const denied = await run(8, changedIdentity.states);
  expect(denied.attempts.map(a => [a.status, a.error])).toEqual([
    ['succeeded', null], ['succeeded', null], ['failed', 'permission_denied'],
  ]);
  expect(denied.observations.every(result => result.observation.metric.id !== 'oracle.transactions.commit_total')).toBe(true);
  expect(JSON.stringify(denied)).not.toContain('fixture private details');

  transactionDenied = false;
  commits = '9007199254741013';
  const restored = await run(10, denied.states);
  expect(restored.attempts.map(a => a.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
  expect(point(restored, 'oracle.transactions.commit_total').value).toEqual({ encoding: 'uint64', value: commits });
  expect(execute.mock.calls.filter(([sql]) => sql.includes('V$SYSSTAT'))).toHaveLength(6);
  expect(close).toHaveBeenCalledTimes(18);
});
