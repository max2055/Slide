import { describe, expect, it } from 'vitest';
import { definitions, derived, identify, sample } from '../contracts/metrics/fixtures.js';
import { executeDerived } from '../metrics/derived.js';
import type { Computation, Observation } from '../metrics/observation.js';
import { compileAlertRule, evaluateCompiledRule } from './compiled-rule.js';
import { validateAlertThresholdUnits } from './threshold-units.js';

/**
 * Mount denominators captured from server:3 on 2026-10-25T13:24:52Z
 * (`outputs/legacy-template-migration-243/verify-final.json`, not committed).
 * The real observed maximum is `/` = 0.371783, so the 0.79/0.81 boundary is
 * exercised by keeping the real denominator and moving the numerator.
 */
interface Mount { mount: string; device: string; fs_type: string; size_bytes: number; ratio: number }
const MOUNTS: Mount[] = [
  { mount: '/boot/efi', device: '/dev/nvme0n1p1', fs_type: 'vfat', size_bytes: 627_900_416, ratio: 0.011_820_269 },
  { mount: '/run/user/991', device: 'tmpfs', fs_type: 'tmpfs', size_bytes: 285_470_720, ratio: 0.000_043_045 },
  { mount: '/', device: '/dev/mapper/klas-root', fs_type: 'xfs', size_bytes: 21_416_116_224, ratio: 0.371_783_426 },
  { mount: '/sys/firmware/efi/efivars', device: 'efivarfs', fs_type: 'efivarfs', size_bytes: 262_128, ratio: 0.128_677_593 },
  { mount: '/dev', device: 'devtmpfs', fs_type: 'devtmpfs', size_bytes: 4_194_304, ratio: 0 },
  { mount: '/run/user/0', device: 'tmpfs', fs_type: 'tmpfs', size_bytes: 285_470_720, ratio: 0.000_014_348 },
  { mount: '/dev/shm', device: 'tmpfs', fs_type: 'tmpfs', size_bytes: 1_427_353_600, ratio: 0 },
  { mount: '/sys/fs/cgroup', device: 'tmpfs', fs_type: 'tmpfs', size_bytes: 4_194_304, ratio: 0 },
  { mount: '/boot', device: '/dev/nvme0n1p2', fs_type: 'xfs', size_bytes: 1_006_632_960, ratio: 0.369_925_944 },
  { mount: '/tmp', device: 'tmpfs', fs_type: 'tmpfs', size_bytes: 1_427_353_600, ratio: 0.000_011_479 },
  { mount: '/run', device: 'tmpfs', fs_type: 'tmpfs', size_bytes: 570_941_440, ratio: 0.060_979_984 },
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

  it('evaluates and recovers each mount independently', () => {
    const firing = new Set(['/boot/efi', '/', '/boot']);
    const states = new Map(MOUNTS.map(mount => [mount.mount,
      levelOf(ratioNumber(String(boundaryUsed(mount, firing.has(mount.mount) ? 0.81 : 0.79)), mount)!)]));
    expect([...states.entries()].filter(([, level]) => level === 'warning').map(([mount]) => mount).sort())
      .toEqual([...firing].sort());
    expect(states.get('/dev')).toBeNull();

    const recovered = new Map(states);
    recovered.set('/boot/efi', levelOf(ratioNumber(String(boundaryUsed(MOUNTS[0], 0.79)), MOUNTS[0])!));
    expect(recovered.get('/boot/efi')).toBeNull();
    expect(recovered.get('/')).toBe('warning');
    expect(recovered.get('/boot')).toBe('warning');
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

  it('leaves the real captured baseline healthy', () => {
    for (const mount of MOUNTS) expect(levelOf(mount.ratio)).toBeNull();
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
