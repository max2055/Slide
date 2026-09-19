import mysql, { type Pool } from 'mysql2/promise';
import { writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'ssh2';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import serverMetricProvider, { parseProcDiskstatsExact, parseProcNetDevExact } from '../../server-metric-provider.js';
import sshSessionPool from '../../ssh-session-pool.js';
import { SemanticQueryService } from '../query.js';
import { MysqlMetricStorage } from '../storage.js';
import { isHostBlockDevice, type Transport } from './adapters.js';
import { builtinReleases, createBuiltinRegistry } from './builtins.js';
import { runPackage } from './runner.js';

const mysqlPort = Number(process.env.METRICS_V2_TEST_MYSQL_PORT);
const sshPort = Number(process.env.METRICS_V2_TEST_SSH_PORT);
const sshPassword = process.env.METRICS_V2_TEST_SSH_PASSWORD;

describe.skipIf(!mysqlPort || !sshPort || !sshPassword)('Linux host SSH to V2 MySQL qualification', () => {
  const database = `max72_${process.pid}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = mysql.createPool({ host: '127.0.0.1', port: mysqlPort, user: 'root', password: '' });
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port: mysqlPort, user: 'root', password: '', database, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
    sshSessionPool.closeAll();
  });

  it('collects a real isolated Linux host, stores Normalized Observations and queries them', async () => {
    // This opt-in fixture targets only a loopback-mapped container. Production
    // SshSessionPool deliberately denies loopback destinations.
    const client = new Client();
    await new Promise<void>((resolve, reject) => client.once('ready', resolve).once('error', reject)
      .connect({ host: '127.0.0.1', port: sshPort, username: 'fixture', password: sshPassword!, readyTimeout: 5000 }));
    const observedAt = new Date().toISOString();
    const inventory = await sshSessionPool.execCommands(client, [
      'LC_ALL=C LANG=C cat /proc/sys/kernel/random/boot_id',
      'LC_ALL=C LANG=C cat /proc/net/dev',
      'LC_ALL=C LANG=C cat /proc/diskstats',
    ], { timeoutMs: 5000, maxOutputBytes: 65536 });
    expect(inventory.every(result => result.exitCode === 0 && !result.truncated)).toBe(true);
    const interfaces = Object.fromEntries([...new Set(parseProcNetDevExact(inventory[1].stdout).map(row => row.dimensions?.interface).filter(Boolean))]
      .map(name => [name!, { epoch: `if-${name}`, observed_at: observedAt }]));
    const devices = Object.fromEntries([...new Set(parseProcDiskstatsExact(inventory[2].stdout).map(row => row.dimensions?.device).filter((name): name is string => !!name && isHostBlockDevice(name)))]
      .map(name => [name, { epoch: `device-${name}`, observed_at: observedAt }]));
    const calls: Array<{ commands: string[]; stdout: string[] }> = [];
    const transport: Transport = { method: 'ssh', client: client as Client, pool: { execCommands: async (actual, commands, options) => {
      const results = await sshSessionPool.execCommands(actual, commands, options);
      calls.push({ commands: [...commands], stdout: results.map(result => result.stdout) });
      return results;
    } } };
    const registry = createBuiltinRegistry();
    const release = builtinReleases().find(candidate => candidate.package.id === 'linux-host')!;
    const firstStarted = performance.now();
    const result = await runPackage(registry, {
      package: { id: release.package.id, version: release.package.version, digest: release.package.digest },
      credential_ref: 'credential:qualification-host', overrides: {},
    }, {
      resource: { id: 'host-qualification', type: 'server', attributes: { 'os.family': { value: 'linux', observed_at: observedAt, source: 'qualification' } } },
      binding_id: 'binding-host-qualification', attempt_id: 'attempt-host-qualification', config_revision: 1, observed_at: observedAt,
      evidence: { host_counter_epochs: { boot: { epoch: inventory[0].stdout.trim(), observed_at: observedAt }, interfaces, devices } },
      resolve: async () => transport,
    });
    const firstWallMs = performance.now() - firstStarted;
    expect(result.attempts.every(attempt => attempt.status === 'succeeded')).toBe(true);
    const definitions = registry.catalog({ id: release.package.id, version: release.package.version, digest: release.package.digest });
    const storage = new MysqlMetricStorage(pool);
    for (const output of result.observations) {
      await storage.write(output.observation, definitions.find(definition => definition.id === output.observation.metric.id)!);
    }
    const cpu = result.observations.find(output => output.observation.metric.id === 'linux.cpu.user_system_percent')!.observation;
    const rawCpu = calls.find(call => call.commands.some(command => command.includes('top -bn1')))!.stdout[0];
    expect(cpu.value).toEqual({ encoding: 'float64', value: serverMetricProvider.parseMetric('cpu_usage', rawCpu) });
    for (const metricId of ['linux.cpu.user_system_percent', 'linux.memory.used_percent', 'host.filesystem.used_bytes',
      'linux.filesystem.used_ratio']) {
      const observation = result.observations.find(output => output.observation.metric.id === metricId)?.observation;
      expect(observation, `${metricId} must be collected from Linux`).toBeDefined();
      const definition = definitions.find(candidate => candidate.id === metricId)!;
      const queried = await new SemanticQueryService(storage, async () => true).query({
        definition, series: [{ resource_type: observation!.resource_type, resource_id: observation!.resource_id,
          metric: observation!.metric, dimensions: observation!.dimensions }],
        from: new Date(Date.parse(observedAt) - 1000).toISOString(), to: new Date(Date.parse(observedAt) + 1000).toISOString(),
        now: new Date(Date.parse(observedAt) + 1000).toISOString(), interval_ms: 60_000, max_gap_ms: 300_000,
        stale_after_ms: 120_000, mode: 'last', space: 'none',
      });
      expect(queried[0]).toMatchObject({ quality: { status: observation!.quality.status }, sample_count: 1 });
      if (observation!.value?.encoding === 'float64') {
        expect(queried[0].value?.encoding).toBe('float64');
        expect((queried[0].value as { value: number }).value).toBeCloseTo(observation!.value.value, 12);
      } else {
        expect(queried[0].value).toEqual(observation!.value);
      }
    }
    const secondAt = new Date().toISOString();
    const secondStarted = performance.now();
    const second = await runPackage(registry, {
      package: { id: release.package.id, version: release.package.version, digest: release.package.digest },
      credential_ref: 'credential:qualification-host', overrides: {},
    }, {
      resource: { id: 'host-qualification', type: 'server', attributes: { 'os.family': { value: 'linux', observed_at: secondAt, source: 'qualification' } } },
      binding_id: 'binding-host-qualification', attempt_id: 'attempt-host-qualification-2', config_revision: 1, observed_at: secondAt,
      evidence: { host_counter_epochs: { boot: { epoch: inventory[0].stdout.trim(), observed_at: observedAt }, interfaces, devices } },
      resolve: async () => transport,
    });
    const secondWallMs = performance.now() - secondStarted;
    expect(second.attempts.every(attempt => attempt.status === 'succeeded')).toBe(true);
    for (const output of second.observations) {
      await storage.write(output.observation, definitions.find(definition => definition.id === output.observation.metric.id)!);
    }
    for (const metricId of ['host.network.bytes_total', 'linux.block.read_bytes_total']) {
      const observation = result.observations.find(output => output.observation.metric.id === metricId)?.observation;
      expect(observation, `${metricId} must be collected from Linux`).toBeDefined();
      const definition = definitions.find(candidate => candidate.id === metricId)!;
      const series = { resource_type: observation!.resource_type, resource_id: observation!.resource_id,
        metric: observation!.metric, dimensions: observation!.dimensions };
      const stored = await storage.queryWindow(series, observedAt, secondAt);
      expect(stored[0].value).toEqual(observation!.value);
      const [rate] = await new SemanticQueryService(storage, async () => true).query({
        definition, series: [series], from: observedAt, to: secondAt, now: secondAt,
        interval_ms: 60_000, max_gap_ms: 300_000, stale_after_ms: 120_000, mode: 'rate', space: 'none',
      });
      expect(rate).toMatchObject({ quality: { status: 'good' } });
      expect(rate.value?.encoding).toBe('float64');
      expect((rate.value as { value: number }).value).toBeGreaterThanOrEqual(0);
    }
    client.end();
    expect(result.observations.every(output => output.observation.resource_type === 'server')).toBe(true);
    if (process.env.MAX76_HOST_REPORT) await writeFile(process.env.MAX76_HOST_REPORT, JSON.stringify({
      evidence: 'real isolated Alpine Linux SSH target + MySQL; not a production host', raw_calls: calls, package_wall_ms: [firstWallMs, secondWallMs],
      legacy_cpu_same_input: serverMetricProvider.parseMetric('cpu_usage', rawCpu), v2_cpu: cpu,
      observations: [...result.observations, ...second.observations],
    }, null, 2) + '\n');
  }, 120_000);
});
