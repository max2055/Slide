import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ effective: vi.fn(), query: vi.fn(), source: vi.fn(), connected: vi.fn(),
  getAlertRules: vi.fn(), getServers: vi.fn(), findActive: vi.fn(), findActiveAlerts: vi.fn(), createAlert: vi.fn(),
  touchAlert: vi.fn(), resolveAlert: vi.fn() }));
vi.mock('../db-connection.js', () => ({ dbConnection: { isConnected: mocks.connected } }));
vi.mock('../metrics/policy/service.js', () => ({ policyService: { effective: mocks.effective } }));
vi.mock('../metrics/consumers/runtime.js', () => ({
  metricConsumerService: { query: mocks.query }, operationalSource: mocks.source,
}));
vi.mock('../server-database-service.js', () => ({ serverDatabaseService: { getCollectionEnabledServers: mocks.getServers } }));
vi.mock('../alert-database-service.js', () => ({ alertDatabaseService: {
  getAlertRules: mocks.getAlertRules, findActiveServerAlert: mocks.findActive,
  findActiveServerAlerts: mocks.findActiveAlerts,
  createAlert: mocks.createAlert, touchAlert: mocks.touchAlert, resolveAlert: mocks.resolveAlert,
} }));
vi.mock('../workflows/execution-context.js', () => ({ assertWorkflowActive: () => {} }));
// Delegates to the real consumer; the wrapper only records calls so a no-write
// assertion can prove a completed evaluation rather than a caught exception.
vi.mock('../metrics/consumers/operational.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../metrics/consumers/operational.js')>();
  return { ...actual, evaluateOperationalRule: vi.fn(actual.evaluateOperationalRule) };
});

import { definitions, derived, identify, sample } from '../contracts/metrics/fixtures.js';
import { executeDerived } from '../metrics/derived.js';
import type { Computation, Observation } from '../metrics/observation.js';
import { evaluateOperationalRule } from '../metrics/consumers/operational.js';
import { serverAlertEvaluator } from '../server-alert-evaluator.js';
import { compileAlertRule, evaluateCompiledRule } from './compiled-rule.js';
import { validateAlertThresholdUnits } from './threshold-units.js';

/**
 * Real used/size pairs captured from server:3 on 2026-10-25T13:24:52Z
 * (`outputs/legacy-template-migration-243/verify-final.json`, not committed).
 * The captured maximum is `/` = 0.371783, so the 0.79/0.81 boundary is
 * exercised by keeping the real denominator and moving the numerator. Source
 * quality is partial/estimated except for exact zero rows.
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
const RULE = compileAlertRule({ metric_name: 'linux.filesystem.used_ratio', operator: '>=', threshold: 0.8,
  threshold_template: { warning: 0.8, error: 0.9, critical: 0.95 }, severity: 'warning' }, 'server');
const LEGACY_COPY = compileAlertRule({ metric_name: 'linux.filesystem.used_ratio', operator: '>=', threshold: 80,
  threshold_template: { warning: 80, error: 90, critical: 95 }, severity: 'warning' }, 'server');

type Sample = ReturnType<typeof sample>;

function filesystemObservation(id: 'host.filesystem.used_bytes' | 'host.filesystem.size_bytes', mount: Mount,
  value: string | null, quality: Sample['quality'] = { status: 'good', reason: 'none' }): Sample {
  const base = sample(id);
  return identify({
    ...base,
    dimensions: { mount: mount.mount, device: mount.device, fs_type: mount.fs_type },
    value: value === null ? null : { encoding: 'uint64' as const, value },
    quality,
  });
}

function envelope(observation: Sample): Computation {
  return { observation, window: { from: observation.observed_at, to: observation.observed_at }, freshness: 'fresh',
    input_provenance: [{ id: observation.id, stage: observation.stage, source: observation.source,
      versions: observation.versions, metric: observation.metric }] };
}

function deriveRatio(inputs: Sample[]): Observation {
  const anchor = inputs[0];
  return executeDerived([derived], definitions, inputs.map(envelope), {
    anchor, context, counter: { max_gap_ms: 300_000 },
    targets: { [derived.id]: { source: { ...anchor.source, collector_id: `derived:${derived.id}` },
      versions: { ...anchor.versions, transform_version: derived.transform_version } } },
  }).outputs[0].observation;
}

function ratioObservation(used: string | null, mount: Mount): Observation {
  return deriveRatio([
    filesystemObservation('host.filesystem.used_bytes', mount, used,
      used === null ? { status: 'unknown', reason: 'source_error' } : undefined),
    filesystemObservation('host.filesystem.size_bytes', mount, String(mount.size_bytes)),
  ]);
}

function ratioNumber(used: string | null, mount: Mount): number | null {
  const observation = ratioObservation(used, mount);
  return observation.value && 'value' in observation.value ? Number(observation.value.value) : null;
}

function levelOf(value: number, rule = RULE) { return evaluateCompiledRule(rule, value); }

function boundaryUsed(mount: Mount, fraction: 0.79 | 0.81): number {
  return fraction < 0.8 ? Math.floor(mount.size_bytes * fraction) : Math.ceil(mount.size_bytes * fraction);
}

describe('filesystem ratio boundary on real mount denominators (MAX-232)', () => {
  it('puts 0.79/0.81 on the correct side of 0.80 for every real mount', () => {
    for (const mount of MOUNTS) {
      const below = ratioNumber(String(boundaryUsed(mount, 0.79)), mount);
      expect(below).not.toBeNull();
      expect(below!).toBeLessThan(0.8);
      expect(levelOf(below!)).toBeNull();

      const above = ratioNumber(String(boundaryUsed(mount, 0.81)), mount);
      expect(above).not.toBeNull();
      expect(above!).toBeGreaterThan(0.8);
      expect(levelOf(above!)).toBe('warning');
    }
  });

  it('raises error/critical only past their own boundaries', () => {
    const mount = MOUNTS[2];
    expect(levelOf(ratioNumber(String(Math.floor(mount.size_bytes * 0.89)), mount)!)).toBe('warning');
    expect(levelOf(ratioNumber(String(Math.ceil(mount.size_bytes * 0.9)), mount)!)).toBe('error');
    expect(levelOf(ratioNumber(String(Math.floor(mount.size_bytes * 0.94)), mount)!)).toBe('error');
    expect(levelOf(ratioNumber(String(Math.ceil(mount.size_bytes * 0.95)), mount)!)).toBe('critical');
  });

  it('never fires the legacy 80/90/95 copy on a ratio value', () => {
    for (const value of [0.371_783, 0.79, 0.81, 0.95, 0.999_999]) expect(levelOf(value, LEGACY_COPY)).toBeNull();
    expect(validateAlertThresholdUnits({ metricId: 'linux.filesystem.used_ratio', unit: '1',
      threshold_template: { warning: 80, error: 90, critical: 95 } }))
      .toMatchObject({ code: 'ALERT_THRESHOLD_RATIO_RANGE', value: 80 });
  });

  it('keeps unknown apart from a real zero for real mounts', () => {
    const mount = MOUNTS[2];
    const unknown = ratioObservation(null, mount);
    expect(unknown.value).toBeNull();
    expect(unknown.quality.status).toBe('unknown');

    const missingSize = deriveRatio([filesystemObservation('host.filesystem.used_bytes', mount, '1000')]);
    expect(missingSize.value).toBeNull();
    expect(missingSize.quality.reason).toBe('missing_input');

    const realZero = ratioObservation('0', MOUNTS[4]);
    expect((realZero.value as { value: number }).value).toBe(0);
    expect(realZero.quality.status).toBe('good');
  });

  it('derives the captured ratio from each real used/size pair and stays healthy', () => {
    for (const mount of MOUNTS) {
      const derivedRatio = ratioObservation(String(mount.used_bytes), mount);
      const value = (derivedRatio.value as { value: number }).value;
      expect(value).toBeCloseTo(mount.ratio, 14);
      // Captured quality is partial (precision_loss) except for exact zero rows.
      expect(derivedRatio.quality.status).toBe(mount.ratio === 0 ? 'good' : 'partial');
      expect(levelOf(value)).toBeNull();
    }
  });
});

describe('byte allocation thresholds stay absolute (MAX-232)', () => {
  const GIB = 1_024 ** 3;
  const rule = compileAlertRule({ metric_name: 'mysql.tables.estimated_allocated_bytes', operator: '>=', threshold: 100 * GIB,
    threshold_template: { warning: 100 * GIB, error: 500 * GIB, critical: 1_000 * GIB }, severity: 'warning' }, 'instance');

  it('is healthy at the real 1.19 GiB and fires on absolute bytes', () => {
    expect(levelOf(1_278_853_120, rule)).toBeNull();
    expect(levelOf(101 * GIB, rule)).toBe('warning');
    expect(levelOf(501 * GIB, rule)).toBe('error');
    expect(levelOf(1_001 * GIB, rule)).toBe('critical');
  });

  it('does not accept the filesystem ratio as a byte threshold', () => {
    expect(validateAlertThresholdUnits({ metricId: 'mysql.tables.estimated_allocated_bytes', unit: 'By',
      threshold_template: { warning: 0.8, error: 0.9, critical: 0.95 } }))
      .toMatchObject({ code: 'ALERT_THRESHOLD_BYTES_ABSOLUTE', value: 0.8 });
  });
});

/**
 * Isolated replay of the production consumer evaluation reached by
 * ServerAlertEvaluator (evaluateOperationalRule -> evaluateMetric). Only the
 * storage query and the policy binding are replaced here; the derived ratio,
 * threshold compilation and per-series fire/recovery decision are the real
 * implementations. The persisted alerts-row transition
 * (alertDatabaseService.findActiveServerAlert/createAlert/touchAlert/resolveAlert)
 * needs MySQL and is checkpointed for the serialized handoff, not claimed here.
 */
describe('production consumer evaluation per mount (MAX-232, isolated replay)', () => {
  const GIB = 1_024 ** 3;
  const WINDOW = { from: '2026-10-25T13:24:52.000Z', to: '2026-10-25T13:24:52.000Z' };
  const RULE = { metric_name: 'linux.filesystem.used_ratio', operator: '>=' as const, threshold: 0.8,
    threshold_template: { warning: 0.8, error: 0.9, critical: 0.95 }, severity: 'warning' as const, duration_seconds: 0 };
  const BYTE_RULE = { metric_name: 'mysql.tables.estimated_allocated_bytes', operator: '>=' as const, threshold: 100 * GIB,
    threshold_template: { warning: 100 * GIB, error: 500 * GIB, critical: 1_000 * GIB },
    severity: 'warning' as const, duration_seconds: 0 };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connected.mockReturnValue(true);
    mocks.source.mockResolvedValue('semantic');
    mocks.effective.mockResolvedValue({ resolved: { plan: { binding: { package: { id: 'linux-representative' } } },
      settings: { interval_ms: 60_000 } } });
  });

  function ratioSeries(mount: Mount, used: string | null) {
    const observation = ratioObservation(used, mount);
    return {
      dimensions: { mount: mount.mount, device: mount.device, fs_type: mount.fs_type },
      buckets: [{ value: observation.value, unit: '1', window: WINDOW, freshness: 'fresh', coverage: 1,
        quality: observation.quality, accuracy: 'exact', sample_count: 1 }],
    };
  }

  async function evaluate(entries: Array<[Mount, string | null]>, rule: typeof RULE = RULE) {
    mocks.query.mockResolvedValue({ metrics: [{ definition: { id: 'linux.filesystem.used_ratio',
      semantic_version: '1.0.0', unit: '1', kind: 'gauge' }, state: 'available',
      series: entries.map(([mount, used]) => ratioSeries(mount, used)) }] });
    return evaluateOperationalRule({ type: 'server', id: 3 }, rule, 0);
  }

  it('fires warning above 0.80 and stays healthy below it on every real mount', async () => {
    for (const mount of MOUNTS) {
      expect(await evaluate([[mount, String(boundaryUsed(mount, 0.79))]])).toMatchObject({
        handled: true, level: null, state: 'healthy', recovery: true,
      });
      expect(await evaluate([[mount, String(boundaryUsed(mount, 0.81))]])).toMatchObject({
        handled: true, level: 'warning', state: 'firing',
        dimensions: { mount: mount.mount, device: mount.device, fs_type: mount.fs_type },
      });
    }
  });

  it('raises error and critical past their own ratio boundaries', async () => {
    const mount = MOUNTS[2];
    expect(await evaluate([[mount, String(Math.ceil(mount.size_bytes * 0.9))]])).toMatchObject({ level: 'error' });
    expect(await evaluate([[mount, String(Math.ceil(mount.size_bytes * 0.95))]])).toMatchObject({ level: 'critical' });
  });

  it('keeps every real captured used/size pair healthy through the same evaluation', async () => {
    expect(await evaluate(MOUNTS.map(mount => [mount, String(mount.used_bytes)] as [Mount, string])))
      .toMatchObject({ handled: true, level: null, state: 'healthy', recovery: true });
  });

  it('keeps the rule firing while any mount is over 0.80, and recovers only after all recover', async () => {
    const firing = new Set(['/boot/efi', '/', '/boot']);
    const entries = (recovered?: string) => MOUNTS.map(mount => [mount,
      String(boundaryUsed(mount, firing.has(mount.mount) && mount.mount !== recovered ? 0.81 : 0.79))] as [Mount, string]);
    expect(await evaluate(entries())).toMatchObject({ level: 'warning', state: 'firing' });
    expect(await evaluate(entries('/boot/efi'))).toMatchObject({ level: 'warning', state: 'firing' });
    expect(await evaluate(MOUNTS.map(mount => [mount, String(boundaryUsed(mount, 0.79))] as [Mount, string])))
      .toMatchObject({ level: null, state: 'healthy', recovery: true });
  });

  it('never recovers or reports zero while one mount is unknown', async () => {
    const entries = MOUNTS.map(mount => [mount,
      mount.mount === '/' ? null : String(boundaryUsed(mount, 0.79))] as [Mount, string | null]);
    expect(await evaluate(entries)).toMatchObject({ level: null, state: 'unknown', recovery: false, value: null });
  });

  it('shows the legacy 80/90/95 rule never fires through the same evaluation', async () => {
    const legacy = { ...RULE, threshold: 80, threshold_template: { warning: 80, error: 90, critical: 95 } };
    expect(await evaluate(MOUNTS.map(mount => [mount, String(boundaryUsed(mount, 0.81))] as [Mount, string]), legacy))
      .toMatchObject({ level: null, state: 'healthy', recovery: true });
  });

  it('keeps byte allocation on absolute bytes through the same evaluation', async () => {
    const evaluateBytes = async (value: string) => {
      mocks.query.mockResolvedValue({ metrics: [{ definition: { id: 'mysql.tables.estimated_allocated_bytes',
        semantic_version: '1.0.0', unit: 'By', kind: 'gauge' }, state: 'available',
        series: [{ dimensions: {}, buckets: [{ value: { encoding: 'uint64', value }, unit: 'By', window: WINDOW,
          freshness: 'fresh', coverage: 1, quality: { status: 'good', reason: 'none' }, accuracy: 'estimated',
          sample_count: 1 }] }] }] });
      return evaluateOperationalRule({ type: 'instance', id: 7 }, BYTE_RULE, 0);
    };
    expect(await evaluateBytes('1278853120')).toMatchObject({ handled: true, level: null, state: 'healthy' });
    expect(await evaluateBytes(String(501 * GIB))).toMatchObject({ level: 'error' });
    expect(await evaluateBytes(String(1_001 * GIB))).toMatchObject({ level: 'critical' });
  });
});

/**
 * Isolated replay of the current ServerAlertEvaluator state machine (MAX-226
 * per-dimension isolation): every active alert is recovered against its own
 * complete dimension set, then the currently firing dimension is created or
 * touched. The derived ratio, rule compilation, consumer evaluation and
 * fire/recovery decision are real; the collector query and the MySQL-backed
 * alertDatabaseService/serverDatabaseService are replaced. Persisted rows are
 * proven separately in filesystem-ratio-alert-lifecycle.mysql.test.ts.
 */
describe('server alert state chain per mount (MAX-232, isolated replay)', () => {
  const WINDOW = { from: '2026-10-25T13:24:52.000Z', to: '2026-10-25T13:24:52.000Z' };
  const baseRule = { id: 42, name: '文件系统使用率过高', description: null, target_type: 'server',
    metric_name: 'linux.filesystem.used_ratio', operator: '>=', threshold: 0.8,
    threshold_template: { warning: 0.8, error: 0.9, critical: 0.95 }, duration_seconds: 0, recovery_seconds: 0,
    severity: 'warning', enabled: true, silence_minutes: 5, notification_channels: null, server_id: null,
    db_types: null, instance_ids: null, template_id: null };
  interface ActiveRow { id: number; tags: { dimensions: Record<string, string> } }
  let current: Array<[Mount, string | null]> = [];
  const results = (entries: Array<[Mount, string | null]>) => ({ metrics: [{
    definition: { id: 'linux.filesystem.used_ratio', semantic_version: '1.0.0', unit: '1', kind: 'gauge' },
    state: 'available', series: entries.map(([mount, used]) => {
      const observation = ratioObservation(used, mount);
      return { dimensions: { mount: mount.mount, device: mount.device, fs_type: mount.fs_type },
        buckets: [{ value: observation.value, unit: '1', window: WINDOW, freshness: 'fresh', coverage: 1,
          quality: observation.quality, accuracy: 'exact', sample_count: 1 }] };
    }) }] });
  const mountsAt = (firing: Set<string>, recovered?: string): Array<[Mount, string]> => MOUNTS.map(mount =>
    [mount, String(boundaryUsed(mount, firing.has(mount.mount) && mount.mount !== recovered ? 0.81 : 0.79))]);
  const mountNamed = (name: string) => MOUNTS.find(mount => mount.mount === name)!;
  const activeRow = (id: number, mount: Mount): ActiveRow => ({ id,
    tags: { dimensions: { mount: mount.mount, device: mount.device, fs_type: mount.fs_type } } });

  beforeEach(() => {
    vi.clearAllMocks();
    current = [];
    mocks.connected.mockReturnValue(true);
    mocks.source.mockResolvedValue('semantic');
    mocks.effective.mockResolvedValue({ resolved: { plan: { binding: { package: { id: 'linux-representative' } } },
      settings: { interval_ms: 60_000 } } });
    mocks.getServers.mockResolvedValue([{ id: 3, label: 'server-3', host: '10.0.0.3' }]);
    mocks.getAlertRules.mockResolvedValue([baseRule]);
    mocks.query.mockImplementation(async () => results(current));
    mocks.findActiveAlerts.mockResolvedValue([]);
    mocks.findActive.mockResolvedValue(null);
    mocks.createAlert.mockResolvedValue({ success: true });
  });

  it('creates one alert with the complete firing-mount dimensions when no alert is active', async () => {
    current = mountsAt(new Set(['/boot/efi', '/', '/boot']));
    await serverAlertEvaluator.evaluateServerRules();
    expect(mocks.findActiveAlerts).toHaveBeenCalledWith(3, 'linux.filesystem.used_ratio', 42);
    expect(mocks.createAlert).toHaveBeenCalledTimes(1);
    const created = mocks.createAlert.mock.calls[0][0] as { tags: { dimensions: Record<string, string> } };
    expect(created.tags.dimensions).toEqual({ mount: '/boot/efi', device: '/dev/nvme0n1p1', fs_type: 'vfat' });
    expect(mocks.touchAlert).not.toHaveBeenCalled();
    expect(mocks.resolveAlert).not.toHaveBeenCalled();
  });

  it('resolves the recovered mount independently while another mount keeps firing', async () => {
    mocks.findActiveAlerts.mockResolvedValue([activeRow(99, mountNamed('/boot/efi')), activeRow(100, mountNamed('/'))]);
    mocks.findActive.mockImplementation(async (_server, _metric, _rule, dimensions) =>
      dimensions?.mount === '/' ? { id: 100 } : null);
    current = mountsAt(new Set(['/boot/efi', '/', '/boot']), '/boot/efi');
    await serverAlertEvaluator.evaluateServerRules();
    expect(mocks.resolveAlert.mock.calls).toEqual([[99]]);
    expect(mocks.touchAlert).toHaveBeenCalledWith(100, expect.any(Number), expect.anything());
    expect(mocks.createAlert).not.toHaveBeenCalled();
  });

  it('resolves each active mount-specific alert once every mount is back under 0.80', async () => {
    mocks.findActiveAlerts.mockResolvedValue([activeRow(99, mountNamed('/boot/efi')), activeRow(100, mountNamed('/'))]);
    current = mountsAt(new Set());
    await serverAlertEvaluator.evaluateServerRules();
    expect(mocks.resolveAlert.mock.calls).toEqual([[99], [100]]);
    expect(mocks.createAlert).not.toHaveBeenCalled();
    expect(mocks.touchAlert).not.toHaveBeenCalled();
  });

  it('writes nothing while the alerted mount is unknown, after a completed evaluation', async () => {
    mocks.findActiveAlerts.mockResolvedValue([activeRow(99, mountNamed('/'))]);
    mocks.findActive.mockResolvedValue({ id: 99 });
    current = MOUNTS.map(mount => [mount, mount.mount === '/' ? null : String(boundaryUsed(mount, 0.79))]);
    const failure = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await serverAlertEvaluator.evaluateServerRules();
      const evaluations = await Promise.all((evaluateOperationalRule as unknown as
        { mock: { results: Array<{ value: unknown }> } }).mock.results.map(result => result.value));
      // One recovery evaluation for "/" plus one semantic evaluation over every mount.
      expect(evaluations.length).toBeGreaterThanOrEqual(2);
      expect(evaluations.at(-1)).toMatchObject({ handled: true, state: 'unknown', level: null, value: null, recovery: false });
      expect(mocks.query).toHaveBeenCalled();
      expect(failure).not.toHaveBeenCalled();
      expect(mocks.createAlert).not.toHaveBeenCalled();
      expect(mocks.touchAlert).not.toHaveBeenCalled();
      expect(mocks.resolveAlert).not.toHaveBeenCalled();
    } finally {
      failure.mockRestore();
    }
  });

  it('shows the legacy 80/90/95 rule would resolve instead of firing above 0.80', async () => {
    mocks.getAlertRules.mockResolvedValue([{ ...baseRule, threshold: 80,
      threshold_template: { warning: 80, error: 90, critical: 95 } }]);
    mocks.findActiveAlerts.mockResolvedValue([activeRow(99, mountNamed('/'))]);
    current = mountsAt(new Set(['/boot/efi', '/', '/boot']));
    await serverAlertEvaluator.evaluateServerRules();
    expect(mocks.createAlert).not.toHaveBeenCalled();
    expect(mocks.touchAlert).not.toHaveBeenCalled();
    expect(mocks.resolveAlert).toHaveBeenCalledWith(99);
  });
});
