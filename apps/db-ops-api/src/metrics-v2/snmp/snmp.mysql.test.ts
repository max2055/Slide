import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { once } from 'node:events';
import * as snmp from 'net-snmp';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SnmpClient } from '../../network-devices/snmp-client.js';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../../workflows/worker-runtime.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import type { NormalizedObservation, Resource } from '../../contracts/metrics-v2/index.js';
import { bindSnmp } from '../packages/adapters.js';
import { MysqlMetricStorage } from '../storage.js';
import { SemanticQueryService } from '../query.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin } from '../policy/test-support.js';
import { MysqlScheduleStore } from '../scheduler/store.js';
import { MetricScheduler } from '../scheduler/service.js';
import { SnmpDiscovery, OIDS } from './collector.js';
import { createSnmpPackage } from './package.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../../docs/slide/metrics-v2/snmp/fixtures.json', import.meta.url), 'utf8'));
const port = Number(process.env.METRICS_V2_TEST_MYSQL_PORT);
const binary = (value: string) => Buffer.from(BigInt(value).toString(16).padStart(16, '0'), 'hex');
describe.skipIf(!port)('SNMP UDP → Worker → isolated MySQL → semantic query', () => {
  const database = `max73_${process.pid}`, ref = { type: 'network_device' as const, id: 1 };
  const { registry: packages, pin } = createSnmpPackage();
  let root: Pool, pool: Pool, agent: ReturnType<typeof snmp.createAgent>, endpoint: number, packets = 0;
  let now = Date.now() - 20000;
  const community = randomUUID();
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, timezone: 'Z', connectionLimit: 12 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    const probe = createSocket('udp4'); probe.bind(0, '127.0.0.1'); await once(probe, 'listening'); endpoint = probe.address().port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    agent = snmp.createAgent({ port: endpoint, address: '127.0.0.1' }, () => { packets++; });
    agent.getAuthorizer().addCommunity(community);
    await Promise.all(Object.values(agent.listener.sockets).map(socket => once(socket as Socket, 'listening')));
    const mib = agent.getMib(), ro = snmp.MaxAccess['read-only'];
    mib.registerProvider({ name: 'uptime', type: snmp.MibProviderType.Scalar, oid: OIDS.uptime.slice(0, -2), scalarType: snmp.ObjectType.TimeTicks, maxAccess: ro });
    mib.setScalarValue('uptime', fixture.uptime_ticks);
    const baseColumns = [1, 2, 5, 6, 7, 8, 10, 13, 14, 16, 19, 20];
    mib.registerProvider({ name: 'base', type: snmp.MibProviderType.Table, oid: `${OIDS.table}.1`, maxAccess: 0,
      tableColumns: baseColumns.map(n => ({ number: n, name: `base${n}`, maxAccess: ro,
        type: [2, 6].includes(n) ? snmp.ObjectType.OctetString : [5, 10, 13, 14, 16, 19, 20].includes(n) ? snmp.ObjectType.Counter : snmp.ObjectType.Integer })),
      tableIndex: [{ columnName: 'base1' }] });
    mib.addTableRow('base', baseColumns.map(n => fixture.ifTable[0].values[n]));
    const extendedColumns = [1, 6, 10, 15, 19];
    mib.registerProvider({ name: 'extended', type: snmp.MibProviderType.Table, oid: `${OIDS.xTable}.1`, maxAccess: 0,
      tableColumns: extendedColumns.map(n => ({ number: n, name: `extended${n}`, maxAccess: ro,
        type: n === 1 ? snmp.ObjectType.OctetString : [6, 10].includes(n) ? snmp.ObjectType.Counter64 : snmp.ObjectType.Gauge })),
      tableIndex: [{ columnName: 'base1', foreign: 'base' }] });
    mib.addTableRow('extended', [1, ...extendedColumns.map(n => [6, 10].includes(n) ? binary(fixture.ifXTable[0].values[n]) : fixture.ifXTable[0].values[n])]);
  }, 120000);
  afterAll(async () => {
    if (agent) await new Promise<void>(resolve => agent.close(() => resolve()));
    await pool?.end(); if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
  });
  it('applies cadence/revision, persists exact Counter64, separates directions and quarantines reboot', async () => {
    const resource: Resource = { type: ref.type, id: '1', attributes: { 'snmp.version': { value: 2, observed_at: new Date(now).toISOString(), source: 'isolated-simulator' } } };
    const policy = new PolicyService(new MysqlPolicyStore(() => pool), packages, { exists: async () => true, inventory: async () => resource }, () => new Date(now).toISOString());
    await policy.changeBinding(admin, ref, { expected_revision: 0, package: pin }, true);
    const client = new SnmpClient(), discovery = new SnmpDiscovery(() => now);
    const transport = bindSnmp(client, { version: 2, host: '127.0.0.1', port: endpoint, community, retries: 0 });
    const scheduler = new MetricScheduler(new MysqlScheduleStore(pool, packages), packages, { resolve: async () => ({
      resource, credential_ref: 'credential:isolated-snmp', evidence: { snmp: discovery }, resolve: async () => transport,
    }) }, () => now);
    const jobs = new JobRegistry(); scheduler.register(jobs);
    const queue = new MysqlWorkflowStore(() => pool as never);
    const run = async (id: string) => {
      // Queue readiness is explicit; no short lease or sleep race.
      await pool.query("UPDATE workflow_jobs SET available_at = DATE_SUB(NOW(), INTERVAL 5 SECOND) WHERE state = 'queued'");
      const worker = new WorkerRuntime(queue, id, 30);
      try { return await worker.runOnce((j, context) => jobs.execute(j, context), now); }
      finally { await worker.shutdown(); }
    };
    const observations = async (): Promise<NormalizedObservation[]> => {
      const [rows] = await pool.query<any[]>('SELECT payload FROM metric_v2_observations ORDER BY observed_at');
      return rows.map(r => typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload);
    };
    await scheduler.tick(); now += 10000; expect(await scheduler.tick()).toBe(1);
    expect(await run('snmp-one')).toBe('completed');
    const first = await observations(); expect(first).toHaveLength(16);
    const counter = first.find(o => o.metric.id === 'snmp.interface.rx_octets_total')!;
    expect(counter.value).toEqual({ encoding: 'uint64', value: fixture.ifXTable[0].values['6'] });
    const firstPackets = packets; expect(firstPackets).toBeGreaterThan(0);
    now += 59999; expect(await scheduler.tick()).toBe(0); expect(packets).toBe(firstPackets);
    now++; agent.getMib().setScalarValue('uptime', fixture.uptime_ticks + 6000);
    agent.getMib().setTableSingleCell('extended', 6, [1], binary(String(BigInt(fixture.ifXTable[0].values['6']) + BigInt(fixture.second_delta.rx))));
    agent.getMib().setTableSingleCell('extended', 10, [1], binary(String(BigInt(fixture.ifXTable[0].values['10']) + BigInt(fixture.second_delta.tx))));
    expect(await scheduler.tick()).toBe(1); expect(await run('snmp-restarted-worker')).toBe('completed');
    const rows = await observations(); expect(rows).toHaveLength(32);
    const service = new SemanticQueryService(new MysqlMetricStorage(pool), async () => true);
    for (const direction of ['rx', 'tx']) {
      const id = `snmp.interface.${direction}_bits_per_second`, definition = packages.catalog(pin).find(d => d.id === id)!;
      const latest = rows.filter(o => o.metric.id === id).at(-1)!;
      const result = await service.query({ definition, series: [{ resource_type: ref.type, resource_id: '1', metric: latest.metric, dimensions: latest.dimensions }],
        from: latest.observed_at, to: new Date(now + 1000).toISOString(), now: new Date(now + 1000).toISOString(),
        interval_ms: 60000, max_gap_ms: 300000, stale_after_ms: 120000, mode: 'last', space: 'none' });
      expect(result[0]).toMatchObject({ unit: 'bit/s', value: { value: fixture.expected_bits_per_second[direction] }, quality: { status: 'good' } });
      expect(result[0].sources[0].versions).toMatchObject({ config_revision: 1, package_id: pin.id, package_version: '1.0.0', transform_version: '1.0.0' });
    }
    expect((await policy.binding(admin, ref)).application).toMatchObject({ status: 'applied', applied_revision: 1 });
    now += 60000; agent.getMib().setScalarValue('uptime', 100);
    expect(await scheduler.tick()).toBe(1); expect(await run('snmp-reboot')).toBe('completed');
    const afterReboot = (await observations()).filter(o => o.metric.id === 'snmp.interface.rx_bits_per_second').at(-1)!;
    expect(afterReboot.value).toBeNull(); expect(afterReboot.quality.reason).toBe('counter_baseline');
    expect(afterReboot.dimensions.interface_epoch).not.toBe(counter.dimensions.interface_epoch);
    expect(JSON.stringify(await observations())).not.toContain(community);
  }, 30000);
});
