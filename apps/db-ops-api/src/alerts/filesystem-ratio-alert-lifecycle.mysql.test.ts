import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// Only the metric evidence boundary (collector query, policy binding, workflow
// guard) is controlled. The derived ratio, the consumer evaluation, the
// evaluator state machine and every alert-row read/write are production code
// running against a disposable, fully migrated MySQL.
const mocks = vi.hoisted(() => ({ effective: vi.fn(), query: vi.fn(), source: vi.fn() }));
vi.mock('../metrics/policy/service.js', () => ({ policyService: { effective: mocks.effective } }));
vi.mock('../metrics/consumers/runtime.js', () => ({
  metricConsumerService: { query: mocks.query }, operationalSource: mocks.source,
}));
vi.mock('../workflows/execution-context.js', () => ({ assertWorkflowActive: () => {} }));

import { bridgeTestFixture } from '../investigations/bridge-test-fixture.js';
import { dbConnection } from '../db-connection.js';
import { serverAlertEvaluator } from '../server-alert-evaluator.js';
import { definitions, derived, identify, sample } from '../contracts/metrics/fixtures.js';
import { executeDerived } from '../metrics/derived.js';
import type { Computation, Observation } from '../metrics/observation.js';

/**
 * Real used/size pairs captured from server:3 on 2026-10-25T13:24:52Z
 * (`outputs/legacy-template-migration-243/verify-final.json`, not committed).
 * The captured maximum is `/` = 0.371783; 0.79/0.81 keep the real denominator
 * and move the numerator, so they are labeled boundary replays, not production
 * high-water observations.
 */
interface Mount { mount: string; device: string; fs_type: string; used_bytes: number; size_bytes: number; ratio: number }
const MOUNTS: Mount[] = [
  { mount: '/boot/efi', device: '/dev/nvme0n1p1', fs_type: 'vfat', used_bytes: 7_421_952, size_bytes: 627_900_416, ratio: 0.011_820_269_282_955_85 },
  { mount: '/run/user/991', device: 'tmpfs', fs_type: 'tmpfs', used_bytes: 12_288, size_bytes: 285_470_720, ratio: 0.000_043_044_694_741_373_124 },
  { mount: '/', device: '/dev/mapper/klas-root', fs_type: 'xfs', used_bytes: 7_962_157_056, size_bytes: 21_416_116_224, ratio: 0.371_783_425_749_118_66 },
  { mount: '/sys/firmware/efi/efivars', device: 'efivarfs', fs_type: 'efivarfs', used_bytes: 33_730, size_bytes: 262_128, ratio: 0.128_677_592_626_503_08 },
  { mount: '/dev', device: 'devtmpfs', fs_type: 'devtmpfs', used_bytes: 0, size_bytes: 4_194_304, ratio: 0 },
  { mount: '/run/user/0', device: 'tmpfs', fs_type: 'tmpfs', used_bytes: 4_096, size_bytes: 285_470_720, ratio: 0.000_014_348_231_580_457_709 },
  { mount: '/dev/shm', device: 'tmpfs', fs_type: 'tmpfs', used_bytes: 0, size_bytes: 1_427_353_600, ratio: 0 },
  { mount: '/sys/fs/cgroup', device: 'tmpfs', fs_type: 'tmpfs', used_bytes: 0, size_bytes: 4_194_304, ratio: 0 },
  { mount: '/boot', device: '/dev/nvme0n1p2', fs_type: 'xfs', used_bytes: 372_379_648, size_bytes: 1_006_632_960, ratio: 0.369_925_944_010_416_7 },
  { mount: '/tmp', device: 'tmpfs', fs_type: 'tmpfs', used_bytes: 16_384, size_bytes: 1_427_353_600, ratio: 0.000_011_478_585_264_366_167 },
  { mount: '/run', device: 'tmpfs', fs_type: 'tmpfs', used_bytes: 34_816_000, size_bytes: 570_941_440, ratio: 0.060_979_984_216_945_26 },
];

const context = { now: '2026-09-01T01:00:00Z', stale_after_ms: 120_000 };
const mountNamed = (name: string) => MOUNTS.find(mount => mount.mount === name)!;
const below = (mount: Mount) => String(Math.floor(mount.size_bytes * 0.79));
const above = (mount: Mount, fraction = 0.81) => String(Math.ceil(mount.size_bytes * fraction));

type Sample = ReturnType<typeof sample>;
function filesystemObservation(id: 'host.filesystem.used_bytes' | 'host.filesystem.size_bytes', mount: Mount,
  value: string | null, quality: Sample['quality'] = { status: 'good', reason: 'none' }): Sample {
  return identify({ ...sample(id),
    dimensions: { mount: mount.mount, device: mount.device, fs_type: mount.fs_type },
    value: value === null ? null : { encoding: 'uint64' as const, value }, quality });
}
function envelope(observation: Sample): Computation {
  return { observation, window: { from: observation.observed_at, to: observation.observed_at }, freshness: 'fresh',
    input_provenance: [{ id: observation.id, stage: observation.stage, source: observation.source,
      versions: observation.versions, metric: observation.metric }] };
}
function ratioObservation(used: string | null, mount: Mount): Observation {
  const inputs = [
    filesystemObservation('host.filesystem.used_bytes', mount, used,
      used === null ? { status: 'unknown', reason: 'source_error' } : undefined),
    filesystemObservation('host.filesystem.size_bytes', mount, String(mount.size_bytes)),
  ];
  const anchor = inputs[0];
  return executeDerived([derived], definitions, inputs.map(envelope), {
    anchor, context, counter: { max_gap_ms: 300_000 },
    targets: { [derived.id]: { source: { ...anchor.source, collector_id: `derived:${derived.id}` },
      versions: { ...anchor.versions, transform_version: derived.transform_version } } },
  }).outputs[0].observation;
}

let current: Array<[Mount, string | null]> = [];
function state(overrides: Record<string, string | null>): Array<[Mount, string | null]> {
  return MOUNTS.map(mount => [mount, overrides[mount.mount] === undefined ? below(mount) : overrides[mount.mount]]);
}
const WINDOW = { from: '2026-10-25T13:24:52.000Z', to: '2026-10-25T13:24:52.000Z' };
const results = () => ({ metrics: [{
  definition: { id: 'linux.filesystem.used_ratio', semantic_version: '1.0.0', unit: '1', kind: 'gauge' },
  state: 'available', series: current.map(([mount, used]) => {
    const observation = ratioObservation(used, mount);
    return { dimensions: { mount: mount.mount, device: mount.device, fs_type: mount.fs_type },
      buckets: [{ value: observation.value, unit: '1', window: WINDOW, freshness: 'fresh', coverage: 1,
        quality: observation.quality, accuracy: 'exact', sample_count: 1 }] };
  }) }] });

const dimensionsOf = (mount: Mount) => ({ mount: mount.mount, device: mount.device, fs_type: mount.fs_type });

describe('filesystem ratio alert lifecycle / real MySQL (MAX-232)', () => {
  let f: Awaited<ReturnType<typeof bridgeTestFixture>>;
  let failure: MockInstance;

  beforeAll(async () => {
    f = await bridgeTestFixture();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(f.pool);
    vi.spyOn(dbConnection, 'isConnected').mockReturnValue(true);
    await f.pool.query(`INSERT INTO servers (id, label, host, port, os_type, credential_type, credential_encrypted, collection_enabled)
      VALUES (901, 'ratio-lifecycle', 'fixture.invalid', 22, 'linux', 'password', 'unused', 1)`);
  }, 120_000);
  afterAll(async () => { vi.restoreAllMocks(); await f?.close(); }, 60_000);

  beforeEach(async () => {
    await f.pool.query('DELETE FROM alerts');
    await f.pool.query('DELETE FROM alert_rules');
    current = state({});
    mocks.source.mockResolvedValue('semantic');
    mocks.effective.mockResolvedValue({ resolved: { plan: { binding: { package: { id: 'linux-representative' } } },
      settings: { interval_ms: 60_000 } } });
    mocks.query.mockImplementation(async () => results());
    failure = vi.spyOn(console, 'error');
  });
  afterEach(() => failure.mockRestore());

  const insertRule = async (id: number, threshold: number, template: Record<string, number>, enabled = 1) => {
    await f.pool.execute(`INSERT INTO alert_rules
      (id, name, target_type, server_id, metric_name, operator, threshold, threshold_template, duration_seconds, severity, enabled)
      VALUES (?, ?, 'server', NULL, 'linux.filesystem.used_ratio', '>=', ?, ?, 0, 'warning', ?)`,
    [id, `ratio-${id}`, threshold, JSON.stringify(template), enabled]);
  };
  const insertAlert = async (ruleId: number, mount: Mount, level = 'warning') => {
    const [insert] = await f.pool.execute<any>(`INSERT INTO alerts
      (server_id, target_type, alert_type, level, title, message, metric_name, metric_value, threshold_value, tags, status)
      VALUES (901, 'server', 'performance', ?, 'snapshot', 'threshold', 'linux.filesystem.used_ratio', '0.81', '0.8', ?, 'unread')`,
    [level, JSON.stringify({ rule_id: ruleId, dimensions: dimensionsOf(mount) })]);
    return Number(insert.insertId);
  };
  const rows = async () => (await f.pool.query<any[]>('SELECT * FROM alerts ORDER BY id'))[0];
  const run = async () => { await serverAlertEvaluator.evaluateServerRules(); return rows(); };

  it('persists one alert for the firing mount with complete dimensions and the ratio snapshot', async () => {
    await insertRule(42, 0.8, { warning: 0.8, error: 0.9, critical: 0.95 });
    current = state({ '/boot/efi': above(mountNamed('/boot/efi')) });
    const persisted = await run();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ server_id: 901, target_type: 'server', status: 'unread', level: 'warning',
      metric_name: 'linux.filesystem.used_ratio', threshold_value: '0.80' });
    expect(Number(persisted[0].metric_value)).toBeGreaterThan(0.8);
    expect(Number(persisted[0].metric_value)).toBeLessThan(0.82);
    expect(persisted[0].tags).toMatchObject({ rule_id: 42, dimensions: dimensionsOf(mountNamed('/boot/efi')) });
    expect(persisted[0].resolved_at).toBeNull();
  });

  it('resolves a recovered mount in the alerts row while another mount keeps firing and is touched', async () => {
    await insertRule(42, 0.8, { warning: 0.8, error: 0.9, critical: 0.95 });
    const efi = mountNamed('/boot/efi'), root = mountNamed('/');
    current = state({ '/boot/efi': above(efi) });
    const created = await run();
    expect(created).toHaveLength(1);
    const recovered = created[0].id;
    const stillFiring = await insertAlert(42, root);

    current = state({ '/': above(root) });
    const after = await run();
    const recoveredRow = after.find((row: any) => row.id === recovered);
    const firingRow = after.find((row: any) => row.id === stillFiring);
    expect(recoveredRow.status).toBe('resolved');
    expect(recoveredRow.resolved_at).not.toBeNull();
    expect(firingRow.status).toBe('unread');
    expect(firingRow.resolved_at).toBeNull();
    expect(Number(firingRow.metric_value)).toBeGreaterThan(0.8);
    expect(firingRow.tags.dimensions).toEqual(dimensionsOf(root));
  });

  it('keeps the persisted alert open when the alerted mount is unknown, not zero', async () => {
    await insertRule(42, 0.8, { warning: 0.8, error: 0.9, critical: 0.95 });
    const root = mountNamed('/');
    current = state({ '/': above(root) });
    const created = await run();
    expect(created).toHaveLength(1);
    const metricValue = created[0].metric_value;
    const alertId = created[0].id;

    current = state({ '/': null });
    mocks.query.mockClear();
    const after = await run();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: alertId, status: 'unread', resolved_at: null, metric_value: metricValue });
    expect(mocks.query).toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  });

  it('isolates rules and their threshold snapshots for the same server, metric and mount', async () => {
    await insertRule(42, 0.8, { warning: 0.8, error: 0.9, critical: 0.95 });
    await insertRule(43, 0.9, { warning: 0.9, error: 0.95, critical: 0.99 });
    const root = mountNamed('/');
    current = state({ '/': above(root, 0.85) });
    const first = await run();
    expect(first).toHaveLength(1);
    expect(first[0].tags.rule_id).toBe(42);

    current = state({ '/': above(root, 0.95) });
    const both = await run();
    expect(both).toHaveLength(2);
    const rule42 = both.find((row: any) => row.tags.rule_id === 42);
    const rule43 = both.find((row: any) => row.tags.rule_id === 43);
    expect(rule42.threshold_value).toBe('0.80');
    expect(rule43.threshold_value).toBe('0.90');
    expect(rule42.tags.dimensions).toEqual(rule43.tags.dimensions);

    current = state({ '/': above(root, 0.85) });
    const after = await run();
    const rule42After = after.find((row: any) => row.id === rule42.id);
    const rule43After = after.find((row: any) => row.id === rule43.id);
    expect(rule42After.status).toBe('unread');
    expect(Number(rule42After.metric_value)).toBeGreaterThan(0.8);
    expect(rule42After.threshold_value).toBe('0.80');
    expect(rule43After.status).toBe('resolved');
    expect(rule43After.threshold_value).toBe('0.90');
  });

  it('shows a legacy 80/90/95 rule falsely resolving above 0.80 in the alerts row', async () => {
    await insertRule(44, 80, { warning: 80, error: 90, critical: 95 });
    const root = mountNamed('/');
    const legacy = await insertAlert(44, root);

    current = state({ '/': above(root) });
    const after = await run();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: legacy, status: 'resolved' });
    expect(after[0].resolved_at).not.toBeNull();
  });
});
