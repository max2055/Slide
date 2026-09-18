import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'ssh2';
import type { NormalizedObservation } from '../../contracts/metrics-v2/index.js';
import { SemanticQueryService } from '../query.js';
import { builtinReleases, canonicalDefinitions, createBuiltinRegistry } from './builtins.js';
import { runPackage, type PackageExecution } from './runner.js';
import type { DriverEvidence, Transport } from './adapters.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../../docs/slide/metrics-v2/host/fixtures.json', import.meta.url), 'utf8'));
const hostRelease = () => builtinReleases().find(release => release.package.id === 'linux-host')!;
const selection = () => {
  const release = hostRelease();
  return { package: { id: release.package.id, version: release.package.version, digest: release.package.digest }, credential_ref: 'credential:host-fixture', overrides: {} };
};
const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, signal: null, truncated: false });

function transport(sample: typeof fixture.samples[number], deny = ''): { value: Transport; execCommands: ReturnType<typeof vi.fn> } {
  const execCommands = vi.fn(async (_client: Client, commands: string[]) => commands.map(command => {
    if (deny && command.includes(deny)) return { ...ok(), exitCode: 1, stderr: 'Permission denied: fixture-private-path' };
    if (command.includes('top -bn1')) return ok(sample.gauges.cpu_usage);
    if (command.includes('free |')) return ok(sample.gauges.memory_usage);
    if (command.includes('df -P -B1')) return ok(sample.filesystem.bytes);
    if (command.includes('df -Pi')) return ok(sample.filesystem.inodes);
    if (command.includes('findmnt')) return ok(sample.filesystem.mounts);
    if (command.includes('/proc/net/dev')) return ok(sample.network);
    if (command.includes('/proc/diskstats')) return ok(sample.disk);
    throw new Error('unexpected fixed command');
  }));
  return { value: { method: 'ssh', client: {} as Client, pool: { execCommands } }, execCommands };
}

async function collect(sampleIndex: number, evidence: DriverEvidence['host_counter_epochs'], deny = '') {
  const sample = fixture.samples[sampleIndex];
  const ssh = transport(sample, deny);
  const execution: PackageExecution = {
    resource: { id: 'host-1', type: 'server', attributes: { 'os.family': { value: 'linux', observed_at: sample.at, source: 'inventory' } } },
    binding_id: 'binding-host-1', attempt_id: `attempt-${sampleIndex}`, config_revision: 7, observed_at: sample.at,
    evidence: { host_counter_epochs: evidence }, resolve: async () => ssh.value, clock: () => sample.at,
  };
  return { result: await runPackage(createBuiltinRegistry(), selection(), execution), execCommands: ssh.execCommands };
}

const metric = (rows: NormalizedObservation[], id: string, dimensions: Record<string, string> = {}) => rows.find(row =>
  row.metric.id === id && JSON.stringify(row.dimensions) === JSON.stringify(dimensions))!;

describe('Linux host unified package', () => {
  it('normalizes Canonical and Extension observations through one versioned path without spatial sums', async () => {
    const { result, execCommands } = await collect(0, fixture.epochs.first);
    const rows = result.observations.map(output => output.observation);

    expect(result.attempts).toHaveLength(4);
    expect(result.attempts.every(attempt => attempt.status === 'succeeded')).toBe(true);
    expect(metric(rows, 'linux.cpu.user_system_percent').value).toEqual({ encoding: 'float64', value: 12.5 });
    expect(metric(rows, 'linux.memory.used_percent').value).toEqual({ encoding: 'float64', value: 40 });
    expect(metric(rows, 'host.filesystem.used_bytes', { mount: '/data', device: '/dev/mapper/vg-data', fs_type: 'xfs' }).value).toEqual({ encoding: 'uint64', value: '400000' });
    expect(metric(rows, 'linux.filesystem.used_ratio', { mount: '/data', device: '/dev/mapper/vg-data', fs_type: 'xfs' }).value).toEqual({ encoding: 'float64', value: 0.4 });
    const network = metric(rows, 'host.network.bytes_total', { interface: 'eth0', direction: 'in' });
    expect(network.value).toEqual({ encoding: 'uint64', value: '9007199254740993' });
    expect(network.counter?.discontinuity?.epoch).toBe('boot-a:if-eth0-a');
    expect(network.versions).toMatchObject({ contract: '1.0.0', package_id: 'linux-host', transform_version: '1.0.0', config_revision: 7 });
    expect(network.source).toMatchObject({ binding_id: 'binding-host-1', collector_id: 'linux-network' });

    const blockDefinitions = hostRelease().extensions.filter(definition => definition.id.startsWith('linux.block.'));
    expect(blockDefinitions.every(definition => definition.kind === 'counter' && definition.aggregation.space.join() === 'none')).toBe(true);
    expect(canonicalDefinitions.find(definition => definition.id === 'host.network.bytes_total')?.aggregation.space).toEqual(['none']);
    expect(rows.filter(row => row.metric.id.startsWith('linux.block.')).map(row => row.dimensions.device)).toEqual(expect.arrayContaining(['sda', 'dm-0']));
    expect(rows.some(row => ['sda1', 'loop0'].includes(row.dimensions.device))).toBe(false);
    expect(rows.some(row => row.dimensions.interface === 'lo')).toBe(false);

    expect(execCommands).toHaveBeenCalledTimes(4);
    expect(execCommands.mock.calls.flatMap(call => call[1])).toHaveLength(7);
  });

  it('uses exact per-interface counters and resets rates on reboot or same-name reappearance', async () => {
    const first = (await collect(0, fixture.epochs.first)).result.observations.map(output => output.observation);
    const second = (await collect(1, fixture.epochs.first)).result.observations.map(output => output.observation);
    const restarted = (await collect(2, fixture.epochs.restarted)).result.observations.map(output => output.observation);
    const reappeared = (await collect(2, fixture.epochs.reappeared)).result.observations.map(output => output.observation);
    const definition = canonicalDefinitions.find(candidate => candidate.id === 'host.network.bytes_total')!;
    const series = { resource_type: 'server' as const, resource_id: 'host-1', metric: { id: definition.id, semantic_version: definition.semantic_version }, dimensions: { interface: 'eth0', direction: 'in' } };
    const query = async (observations: NormalizedObservation[], from: string, to: string) => new SemanticQueryService({
      queryWindow: async () => observations,
      inventory: async () => null,
    }, async () => true).query({ definition, series: [series], from, to, now: to, interval_ms: 60_000,
      max_gap_ms: 300_000, stale_after_ms: 300_000, mode: 'rate', space: 'none' });

    const a = metric(first, definition.id, series.dimensions);
    const b = metric(second, definition.id, series.dimensions);
    expect((await query([a, b], a.observed_at, b.observed_at))[0]).toMatchObject({
      value: { encoding: 'float64', value: 100 }, quality: { status: 'good' }, coverage: 1,
    });
    for (const changed of [metric(restarted, definition.id, series.dimensions), metric(reappeared, definition.id, series.dimensions)]) {
      expect((await query([b, changed], b.observed_at, changed.observed_at))[0]).toMatchObject({
        value: null, quality: { status: 'unknown', reason: 'missing_input' }, coverage: 0,
      });
    }

    expect(second.some(row => row.dimensions.interface === 'eth1')).toBe(true);
    expect(first.some(row => row.dimensions.interface === 'eth1')).toBe(false);
    expect(restarted.some(row => row.dimensions.interface === 'eth1')).toBe(false);
  });

  it('isolates a permission failure as missing observations instead of zero', async () => {
    const { result } = await collect(0, fixture.epochs.first, '/proc/diskstats');
    const rows = result.observations.map(output => output.observation);
    expect(result.attempts.find(attempt => attempt.collector_id === 'linux-block')).toMatchObject({ status: 'failed', error: 'permission_denied' });
    expect(result.attempts.filter(attempt => attempt.status === 'succeeded')).toHaveLength(3);
    expect(rows.some(row => row.metric.id.startsWith('linux.block.'))).toBe(false);
    expect(rows.some(row => row.metric.id === 'host.network.bytes_total')).toBe(true);
    expect(result.capabilities.filter(capability => capability.metric.id.startsWith('linux.block.')).every(capability => capability.status === 'unknown')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('fixture-private-path');
  });

  it('rejects cumulative host rows without explicit lifecycle evidence', async () => {
    const { result } = await collect(0, undefined);
    expect(result.attempts.find(attempt => attempt.collector_id === 'linux-network')).toMatchObject({ status: 'failed', error: 'parse_error' });
    expect(result.attempts.find(attempt => attempt.collector_id === 'linux-block')).toMatchObject({ status: 'failed', error: 'parse_error' });
    expect(result.observations.some(output => output.observation.metric.id === 'host.network.bytes_total')).toBe(false);
  });
});
