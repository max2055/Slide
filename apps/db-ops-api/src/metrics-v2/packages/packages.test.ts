import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'ssh2';
import { definitions as frozenDefinitions, profile } from '../../contracts/metrics-v2/fixtures.js';
import { observationIdentity, validateObservation } from '../../contracts/metrics-v2/index.js';
import { createOptionalSshHostVerifier } from '../../security/ssh-host-key.js';
import { canonicalDefinitions, builtinReleases, createBuiltinRegistry } from './builtins.js';
import { sealRelease, type PackageRelease, type Selection } from './model.js';
import { runPackage, type PackageExecution } from './runner.js';
import { bindSnmp, MYSQL_STATUS_SQL, type Transport } from './adapters.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../../docs/slide/metrics-v2/packages/fixtures.json', import.meta.url), 'utf8'));
const at: string = fixture.at;
const pin = (r: PackageRelease) => ({ id: r.package.id, version: r.package.version, digest: r.package.digest });
const select = (i = 0): Selection => ({ package: pin(builtinReleases()[i]), credential_ref: 'credential:fixture', overrides: {} });
const sqlTransport = (rows = fixture.mysql.first): Transport => ({ method: 'sql', pool: { query: vi.fn(async (): Promise<[unknown, unknown]> => [rows, []]) } });
function context(transport: Transport = sqlTransport()): PackageExecution {
  return { resource: { id: 'resource-1', type: 'instance', attributes: {
    'db.engine': { value: 'mysql', observed_at: at, source: 'driver' }, 'db.version': { value: '8.0.40', observed_at: at, source: 'driver' },
  } }, binding_id: 'binding-1', attempt_id: 'attempt-1', config_revision: 1, observed_at: at,
  evidence: { counter: { bits: '64', start_at: fixture.counter_start } }, resolve: vi.fn(async () => transport), clock: () => at };
}
function snmpContext(): PackageExecution {
  const e = context({ method: 'snmp', table: vi.fn(async () => structuredClone(fixture.snmp.rows)) });
  e.resource = { id: 'switch-1', type: 'network_device', attributes: { 'snmp.version': { value: 3, observed_at: at, source: 'config' } } };
  e.evidence = { interface_epochs: fixture.snmp.epochs }; return e;
}
function mutate(fn: (r: PackageRelease) => void, i = 0): PackageRelease {
  const r = builtinReleases()[i]; fn(r); return sealRelease(r);
}

describe('immutable CollectorPackage releases', () => {
  it('matches product Canonical definitions and leaves CoreProfile unchanged', () => {
    const before = structuredClone(profile);
    for (const definition of canonicalDefinitions) expect(definition).toEqual(frozenDefinitions.find(d => d.id === definition.id));
    createBuiltinRegistry(); expect(profile).toEqual(before);
  });
  it('rejects tampering anywhere in the release, including recommendations', () => {
    const r = builtinReleases()[0]; r.recommendations.interval_ms = 30000;
    expect(() => createBuiltinRegistry().install(r)).toThrow('PACKAGE_DIGEST');
  });
  it('rejects same-version rewrites but allows identical idempotent installation', () => {
    const registry = createBuiltinRegistry(); expect(registry.install(builtinReleases()[0])).toEqual(builtinReleases()[0]);
    expect(() => registry.install(mutate(r => { r.recommendations.max_rows = 50; }))).toThrow('IMMUTABLE_PACKAGE');
  });
  it('isolates callers from registry state and never selects latest implicitly', () => {
    const registry = createBuiltinRegistry(); const r = registry.get(select().package); r.package.version = '9.0.0';
    expect(registry.get(select().package).package.version).toBe('1.0.0');
    expect(() => registry.get({ ...select().package, version: 'latest' })).toThrow('PACKAGE_PIN');
    expect(() => registry.get({ ...select().package, digest: `sha256:${'f'.repeat(64)}` })).toThrow('PACKAGE_PIN');
  });
  it('keeps credentials and user overrides through upgrade and downgrade without mutating inputs', () => {
    const registry = createBuiltinRegistry(), old = select(); old.overrides = { enabled: false, interval_ms: 30000, max_rows: 10 };
    const original = structuredClone(old);
    const next = registry.install(mutate(r => { r.package.version = '1.1.0'; r.recommendations.interval_ms = 90000; }));
    const upgraded = registry.switchVersion(old, pin(next));
    expect(upgraded.overrides).toEqual(old.overrides); expect(upgraded.credential_ref).toBe(old.credential_ref);
    expect(registry.select(upgraded).settings.interval_ms).toBe(30000);
    expect(registry.switchVersion(upgraded, old.package)).toEqual(old); expect(old).toEqual(original);
  });
  it('does not silently delete overrides that become invalid on upgrade', () => {
    const registry = createBuiltinRegistry(), old = select(); old.overrides = { stale_after_ms: 60000 };
    const next = registry.install(mutate(r => { r.package.version = '1.1.0'; r.recommendations.interval_ms = 90000; }));
    expect(() => registry.switchVersion(old, pin(next))).toThrow('POLICY_TIMING');
    expect(old.package.version).toBe('1.0.0');
  });
  it('rejects changing a package resource kind across versions', () => {
    const registry = createBuiltinRegistry(), r = builtinReleases()[1]; r.package.id = 'mysql-basic'; r.package.version = '1.1.0';
    expect(() => registry.install(sealRelease(r))).toThrow('PACKAGE_RESOURCE_TYPE');
  });
  it.each(['password', 'token', 'private_key', 'shell', 'sql', 'oids'])('rejects %s in selection rather than persisting secrets or commands', field => {
    expect(() => createBuiltinRegistry().select({ ...select(), [field]: 'sensitive' })).toThrow();
  });
  it('rejects inline credentials and arbitrary override parameters', () => {
    expect(() => createBuiltinRegistry().select({ ...select(), credential_ref: 'mysql://user:password@host' })).toThrow();
    expect(() => createBuiltinRegistry().select({ ...select(), overrides: { command: 'id' } })).toThrow();
  });
  const invalid: Array<[string, (r: PackageRelease) => void, string]> = [
    ['implementation', r => { r.package.collectors[0].implementation_ref = 'shell:arbitrary'; }, 'IMPLEMENTATION_DEPENDENCY'],
    ['transform', r => { r.transforms = []; }, 'schema'],
    ['transform version', r => { r.transforms[0].version = '2.0.0'; }, 'TRANSFORM_DEPENDENCY'],
    ['dependency', r => { r.package.collectors[0].mappings.pop(); }, 'MISSING_DEPENDENCY'],
    ['duplicate output', r => { r.package.collectors.push({ ...r.package.collectors[0], id: 'duplicate' }); r.documentation.push({ ...r.documentation[0], collector_id: 'duplicate' }); }, 'DUPLICATE_SOURCE'],
    ['input unit', r => { r.package.collectors[0].mappings[0].input_unit = 'By'; }, 'UNIT_CONVERSION'],
    ['extension unit', r => { r.extensions[0].unit = 'By'; }, 'MAPPING_UNIT'],
    ['extension namespace', r => { r.extensions[0].namespace = 'db'; }, 'EXTENSION_NAMESPACE'],
    ['extension dimensions', r => { r.extensions[0].dimensions.keys.push({ name: 'wrong', meaning: 'wrong', required: true }); }, 'DERIVED_JOIN'],
    ['extension encoding', r => { r.extensions[0].value_type = 'float64'; }, 'IDENTITY_SEMANTIC_CONFLICT'],
    ['extension masquerading as Canonical', r => { r.package.collectors[0].mappings[1].metric = r.package.collectors[0].mappings[0].metric; }, 'DUPLICATE_SOURCE'],
    ['applicability bypass', r => { r.package.applicability[1].values = ['1.0']; }, 'IMPLEMENTATION_APPLICABILITY'],
    ['semantic remapping', r => { r.package.collectors[0].mappings[0].raw_field = 'Queries'; }, 'MAPPING_SEMANTICS'],
  ];
  it.each(invalid)('rejects invalid %s', (_name, change, expected) => {
    const r = builtinReleases()[0]; r.package.version = '1.1.0'; change(r);
    if (expected === 'schema') expect(() => sealRelease(r)).toThrow();
    else expect(() => createBuiltinRegistry().install(sealRelease(r))).toThrow(expected === 'MAPPING_UNIT' || expected === 'DERIVED_JOIN' ? /IDENTITY_SEMANTIC_CONFLICT|MAPPING_UNIT|DERIVED_JOIN/ : expected);
  });
  it('does not allow templates to inject Canonical definitions or CoreProfile', () => {
    expect(() => createBuiltinRegistry().install({ ...builtinReleases()[0], core_profile: profile })).toThrow();
    const r = builtinReleases()[0]; (r.extensions as unknown[]).push(canonicalDefinitions[0]); expect(() => sealRelease(r)).toThrow();
  });
});

describe('fixed package execution and common processor integration', () => {
  it('batches SQL, preserves >2^53 integers and produces a public counter rate with lineage', async () => {
    const registry = createBuiltinRegistry(), transport = sqlTransport(), e = context(transport);
    const first = await runPackage(registry, select(), e);
    expect(transport.method === 'sql' && transport.pool.query).toHaveBeenCalledWith({ sql: MYSQL_STATUS_SQL, timeout: 5000 });
    expect(e.resolve).toHaveBeenCalledWith('credential:fixture', e.resource, 'sql');
    expect(first.observations.find(o => o.observation.metric.id === 'mysql.queries.total')!.observation.value).toEqual({ encoding: 'uint64', value: '9007199254740993' });
    expect(first.observations.at(-1)!.observation.quality.reason).toBe('counter_baseline');
    const second = context(sqlTransport(fixture.mysql.second)); second.observed_at = '2026-09-01T00:01:02.000Z'; second.clock = () => second.observed_at; second.states = first.states; second.attempt_id = 'attempt-2';
    const output = (await runPackage(registry, select(), second)).observations.at(-1)!;
    expect(output.observation.value).toEqual({ encoding: 'float64', value: 5 });
    expect(output.observation.production).toBe('derived'); expect(output.observation.accuracy).toBe('exact');
    expect(output.window).toEqual({ from: at, to: second.observed_at }); expect(output.input_provenance.length).toBeGreaterThanOrEqual(2);
  });
  it('passes restart evidence into public processor and does not invent a zero rate', async () => {
    const registry = createBuiltinRegistry(); const first = await runPackage(registry, select(), context());
    const e = context(); e.states = first.states; e.observed_at = '2026-09-01T00:01:02.000Z'; e.clock = () => e.observed_at;
    e.evidence.counter!.start_at = '2026-09-01T00:01:01.000Z';
    const output = (await runPackage(registry, select(), e)).observations.at(-1)!.observation;
    expect(output.value).toBeNull(); expect(output.quality.reason).toBe('counter_reset');
  });
  it('invalidates the public counter baseline on package upgrade and rollback', async () => {
    const registry = createBuiltinRegistry(), newer = registry.install(mutate(r => { r.package.version = '1.1.0'; }));
    const first = await runPackage(registry, select(), context());
    const e = context(); e.states = first.states; e.observed_at = '2026-09-01T00:01:02.000Z'; e.clock = () => e.observed_at;
    const upgraded = registry.switchVersion(select(), pin(newer));
    const second = await runPackage(registry, upgraded, e);
    expect(second.observations.at(-1)!.observation.quality.reason).toBe('counter_reset');
    e.states = second.states; e.observed_at = '2026-09-01T00:01:04.000Z';
    expect((await runPackage(registry, registry.switchVersion(upgraded, select().package), e)).observations.at(-1)!.observation.quality.reason).toBe('counter_reset');
  });
  it.each(fixture.mysql.versions)('checks engine/version $engine $version', async ({ engine, version, decision }: { engine: string; version: string; decision: string }) => {
    const e = context(); e.resource.attributes['db.engine'].value = engine; e.resource.attributes['db.version'].value = version;
    const result = await runPackage(createBuiltinRegistry(), select(), e);
    expect(result.decision).toBe(decision);
    if (decision === 'unsupported') { expect(e.resolve).not.toHaveBeenCalled(); expect(result.capabilities[0].status).toBe('unsupported'); expect(result.attempts).toEqual([]); }
  });
  it('missing version stays unknown; disabled selection performs no I/O', async () => {
    const e = context(); delete e.resource.attributes['db.version'];
    expect((await runPackage(createBuiltinRegistry(), select(), e)).decision).toBe('capability_unknown');
    expect((await runPackage(createBuiltinRegistry(), { ...select(), overrides: { enabled: false } }, e)).decision).toBe('disabled');
    expect(e.resolve).not.toHaveBeenCalled();
  });
  it.each([['ER_ACCESS_DENIED_ERROR', 'permission_denied'], ['SNMP_AUTH_FAILED', 'permission_denied'], ['ETIMEDOUT', 'timeout'], ['ECONNREFUSED', 'connection_error']])('classifies %s without leaking remote text', async (code, error) => {
    const e = context(); e.resolve = async () => { throw Object.assign(new Error('secret=never-expose'), { code }); };
    const result = await runPackage(createBuiltinRegistry(), select(), e);
    expect(result.attempts[0].error).toBe(error); expect(result.capabilities[0].status).toBe('unknown');
    expect(result.observations).toEqual([]); expect(JSON.stringify(result)).not.toContain('never-expose');
    expect(result.capabilities[0].basis.at(-1)!.evidence).toBe(error);
  });
  it('timeout retains valid supported capability, but permission denial updates basis', async () => {
    const registry = createBuiltinRegistry(), e = context(); const first = await runPackage(registry, select(), e);
    e.previous_capabilities = first.capabilities; e.resolve = async () => { throw Object.assign(new Error('private'), { code: 'ETIMEDOUT' }); };
    const timeout = await runPackage(registry, select(), e); expect(timeout.capabilities[0]).toEqual(first.capabilities[0]);
    e.resolve = async () => { throw Object.assign(new Error('private'), { code: 'EACCES' }); };
    const denied = await runPackage(registry, select(), e); expect(denied.capabilities[0].status).toBe('unknown');
    expect(denied.capabilities[0].basis.at(-1)).toEqual({ kind: 'permission', evidence: 'permission_denied' });
  });
  it('does not reuse expired capability after timeout', async () => {
    const registry = createBuiltinRegistry(), e = context();
    e.previous_capabilities = (await runPackage(registry, select(), e)).capabilities;
    e.observed_at = '2026-09-01T00:10:00.000Z'; e.clock = () => e.observed_at;
    e.resolve = async () => { throw Object.assign(new Error('private'), { code: 'ETIMEDOUT' }); };
    expect((await runPackage(registry, select(), e)).capabilities[0].status).toBe('unknown');
  });
  it('classifies transport I/O separately from payload parsing, preserving state on failure', async () => {
    const registry = createBuiltinRegistry(), e = context(); const first = await runPackage(registry, select(), e);
    e.states = first.states; e.resolve = async () => ({ method: 'sql', pool: { query: async () => { throw new Error('connection lost'); } } });
    const result = await runPackage(registry, select(), e);
    expect(result.attempts[0].error).toBe('connection_error'); expect(result.states).toEqual(first.states); expect(result.observations).toEqual([]);
  });
  it.each([undefined, { bits: '64' }])('rejects missing counter epoch evidence %j', async counter => {
    const e = context(); e.evidence.counter = counter as PackageExecution['evidence']['counter'];
    const result = await runPackage(createBuiltinRegistry(), select(), e); expect(result.attempts[0].error).toBe('parse_error'); expect(result.states.size).toBe(0);
  });
  it.each([9007199254740992, '-1', '18446744073709551616', 'NaN'])('rejects invalid/lossy SQL counter %s', async value => {
    const rows = structuredClone(fixture.mysql.first); rows[0].Value = value;
    const result = await runPackage(createBuiltinRegistry(), select(), context(sqlTransport(rows)));
    expect(result.attempts[0].error).toBe('parse_error'); expect(result.observations).toEqual([]);
  });
  it('reuses fixed SSH commands/parsers and optional fingerprint policy', async () => {
    const execCommands = vi.fn(async () => [fixture.ssh.uptime, fixture.ssh.load_1min].map(stdout => ({ stdout, stderr: '', exitCode: 0, signal: null, truncated: false })));
    const e = context({ method: 'ssh', client: {} as Client, pool: { execCommands } });
    e.resource = { id: 'host-1', type: 'server', attributes: { 'os.family': { value: 'linux', observed_at: at, source: 'probe' } } };
    const result = await runPackage(createBuiltinRegistry(), select(1), e);
    expect(result.attempts[0].status).toBe('succeeded'); expect(result.observations.map(o => o.observation.value)).toEqual([{ encoding: 'float64', value: 3600.25 }, { encoding: 'float64', value: 0.5 }]);
    expect(execCommands.mock.calls[0]).toEqual([{}, ["LC_ALL=C LANG=C cat /proc/uptime | awk '{print $1}'", "LC_ALL=C LANG=C cat /proc/loadavg | awk '{print $1}'"], { timeoutMs: 5000, maxOutputBytes: 65536 }]);
    expect(createOptionalSshHostVerifier(undefined)).toBeUndefined(); expect(() => createOptionalSshHostVerifier('bad')).toThrow();
  });
  it.each(['permission', 'timeout', 'truncated', 'malformed', 'authentication'])('classifies SSH %s', async failure => {
    const execCommands = vi.fn(async () => {
      if (failure === 'timeout') throw new Error('SSH_COMMAND_TIMEOUT');
      return [{ stdout: failure === 'malformed' ? 'nan' : '1', stderr: failure === 'permission' ? 'Permission denied: private-file' : '', exitCode: failure === 'permission' ? 1 : 0, signal: null, truncated: failure === 'truncated' }, { stdout: '1', stderr: '', exitCode: 0, signal: null, truncated: false }];
    });
    const e = context({ method: 'ssh', client: {} as Client, pool: { execCommands } });
    e.resource = { id: 'host-1', type: 'server', attributes: { 'os.family': { value: 'linux', observed_at: at, source: 'driver' } } };
    if (failure === 'authentication') e.resolve = async () => { throw Object.assign(new Error('private credentials'), { level: 'client-authentication' }); };
    const result = await runPackage(createBuiltinRegistry(), select(1), e);
    expect(result.attempts[0].error).toBe(['permission', 'authentication'].includes(failure) ? 'permission_denied' : failure === 'timeout' ? 'timeout' : 'parse_error');
    expect(JSON.stringify(result)).not.toContain('private'); expect(result.observations).toEqual([]);
  });
  it.each(fixture.snmp.vendors)('discovers standard IF-MIB for %s without private OIDs', async vendor => {
    const e = snmpContext(); e.resource.attributes['device.vendor'] = { value: vendor, source: 'inventory', observed_at: at };
    const table = vi.fn(async () => fixture.snmp.rows); e.resolve = async () => ({ method: 'snmp', table });
    const result = await runPackage(createBuiltinRegistry(), select(2), e);
    expect(table).toHaveBeenCalledExactlyOnceWith('1.3.6.1.2.1.2.2', 5000);
    expect(result.observations.map(o => o.observation.value)).toEqual([{ encoding: 'float64', value: 1 }, { encoding: 'float64', value: 0 }, null]);
    expect(result.observations[2].observation.quality.status).toBe('unknown'); expect(result.observations[0].observation.dimensions.interface_epoch).toBe('boot1-port7');
  });
  it('uses existing SNMP client and forwards bounded timeout', async () => {
    const table = vi.fn(async () => fixture.snmp.rows);
    const transport = bindSnmp({ table }, { version: 2, host: '127.0.0.1', port: 161, community: 'fixture-secret' });
    if (transport.method !== 'snmp') throw new Error('test transport');
    await transport.table('1.3.6.1.2.1.2.2', 1000);
    expect(table.mock.calls[0]).toEqual([{ version: 2, host: '127.0.0.1', port: 161, community: 'fixture-secret', timeoutMs: 1000 }, '1.3.6.1.2.1.2.2']);
  });
  it.each(['missing_epoch', 'duplicate', 'overflow', 'bad_status'])('rejects SNMP %s without committing a partial batch', async failure => {
    const e = snmpContext(), rows = structuredClone(fixture.snmp.rows);
    if (failure === 'missing_epoch') e.evidence = {};
    if (failure === 'duplicate') rows.push(rows[0]);
    if (failure === 'overflow') rows.push(...Array(100).fill(rows[0]));
    if (failure === 'bad_status') rows[0].values['8'] = 99;
    e.resolve = async () => ({ method: 'snmp', table: async () => rows });
    const result = await runPackage(createBuiltinRegistry(), select(2), e); expect(result.attempts[0].error).toBe('parse_error'); expect(result.observations).toEqual([]);
  });
  it('applies identical schema/quality/dimension checks to Extension observations', async () => {
    const registry = createBuiltinRegistry(); const output = (await runPackage(registry, select(), context())).observations.find(o => o.observation.metric.id === 'mysql.queries.total')!.observation;
    const definition = registry.catalog(select().package).find(d => d.id === output.metric.id)!;
    for (const change of [{ unit: 'ms' }, { dimensions: { unknown: 'value' } }, { quality: { status: 'perfect', reason: 'none' } }, { value: { encoding: 'float64', value: 1 } }]) {
      const invalid = { ...output, ...change }; invalid.id = observationIdentity(invalid as typeof output);
      expect(() => validateObservation(invalid, definition)).toThrow();
    }
  });
});
