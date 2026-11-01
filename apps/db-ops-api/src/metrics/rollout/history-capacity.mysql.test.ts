import { writeFile } from 'node:fs/promises';
import mysql, { type Pool } from 'mysql2/promise';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { identify, sample } from '../../contracts/metrics/fixtures.js';
import { seriesHash } from '../storage.js';
import { MysqlFormalMetricStore } from './formal-store.js';
import { MetricConsumerService } from '../consumers/service.js';
import { registerMetricConsumerRoutes } from '../consumers/routes.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin } from '../policy/test-support.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { readHistoryContext } from '../consumers/history-context.js';

const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const enabled = process.env.MAX240_CAPACITY === '1' && port && port !== 3306;
// Explicit workload, not a collector/SLO qualification: one series per resource,
// 60-second sampling, 24h, all 650 resources actually populated in isolated MySQL.
describe.skipIf(!enabled)('MAX240 650-resource persisted history measurement', () => {
  const database = `max240_capacity_${process.pid}`;
  let root: Pool, pool: Pool, app: ReturnType<typeof Fastify>, base: string;
  const to = Math.floor(Date.now() / 60000) * 60000, from = to - 86400000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const sql = (at: string) => at.slice(0, 23).replace('T', ' ');
  const inventory = [
    ...Array.from({ length: 500 }, (_, i) => ({ type: 'server' as const, id: i + 1, metric: 'host.filesystem.used_bytes' })),
    ...Array.from({ length: 100 }, (_, i) => ({ type: 'instance' as const, id: i + 1, metric: 'db.uptime_seconds' })),
    ...Array.from({ length: 50 }, (_, i) => ({ type: 'network_device' as const, id: i + 1, metric: 'network.interface.oper_up' })),
  ];
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 8 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    const formal = new MysqlFormalMetricStore(pool);
    const policy = new PolicyService(new MysqlPolicyStore(() => pool), createConfigurationRegistry(),
      { exists: async () => true, inventory: async () => null });
    const service = new MetricConsumerService(policy, createConfigurationRegistry(), {
      historyMetrics: (...a) => formal.historyMetrics(...a),
      queryWindow: (...a) => formal.queryWindow(...a), readWindow: (...a) => formal.readWindow(...a),
      readHistoryWindow: (...a) => formal.readHistoryWindow(...a), historyDimensions: (...a) => formal.historyDimensions(...a),
      readObservationPage: (...a) => formal.readObservationPage(...a), dimensions: (...a) => formal.dimensions(...a),
      inventory: async () => null, attempts: async () => [], historyContext: (...a) => readHistoryContext(pool, ...a),
    });
    app = Fastify(); await registerMetricConsumerRoutes(app, async req => { (req as any).user = admin; }, service);
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  }, 120000);
  afterAll(async () => {
    await app?.close(); await pool?.end();
    if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
  });
  it('measures complete 1440-bucket HTTP reads against 936000 actual persisted observations', async () => {
    const seedStarted = performance.now();
    for (let offset = 0; offset < inventory.length; offset += 4) {
      await Promise.all(inventory.slice(offset, offset + 4).map(async resource => {
        const fixture = sample(resource.metric);
        const rows = Array.from({ length: 1440 }, (_, minute) => {
          const at = iso(from + minute * 60000);
          return identify({ ...fixture, resource_id: String(resource.id), observed_at: at, collected_at: at, stored_at: at });
        });
        const hash = seriesHash(rows[0]);
        await pool.execute(`INSERT INTO metric_rollout(series_hash,source,generation,read_mode,package_pin,published_revision,applied_revision,resource_type,resource_id)
          VALUES(?,'retired',2,'pending',?,2,NULL,?,?)`, [hash, JSON.stringify({ id: 'fixture', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }), resource.type, String(resource.id)]);
        await pool.execute('INSERT INTO metric_source_acceptance(resource_key,revision,generation,evidence) VALUES(?,1,1,?)',
          [`${resource.type}:${resource.id}`, JSON.stringify({ validation: 'controlled_capacity_fixture' })]);
        for (let n = 0; n < rows.length; n += 720) {
          const chunk = rows.slice(n, n + 720);
          await pool.query(`INSERT INTO metric_observations(id,series_hash,stage,observed_at,stored_at,valid_value,payload,payload_hash,evidence_expires_at)
            VALUES ${chunk.map(() => '(?,?,\'normalized\',?,?,1,?,?,NULL)').join(',')}`,
          chunk.flatMap(o => [o.id, hash, sql(o.observed_at), sql(o.stored_at!), JSON.stringify(o), 'fixture']));
          await pool.query(`INSERT INTO metric_publications(observation_id,series_hash,generation,observed_at) VALUES ${chunk.map(() => '(?,?,1,?)').join(',')}`,
            chunk.flatMap(o => [o.id, hash, sql(o.observed_at)]));
        }
      }));
    }
    const seedMs = performance.now() - seedStarted;
    const [[count]] = await pool.query<any[]>('SELECT COUNT(*) AS n FROM metric_observations');
    expect(Number(count.n)).toBe(936000);
    const latencies: number[] = [], receipts: unknown[] = [];
    let errors = 0, truncated = 0;
    // Ten actual reads per class, at 4 concurrent clients; first read is not discarded.
    const selected = ['server','instance','network_device'].flatMap(type => inventory.filter(r => r.type === type).slice(0, 10));
    for (let n = 0; n < selected.length; n += 4) await Promise.all(selected.slice(n, n + 4).map(async r => {
      const started = performance.now();
      const response = await fetch(`${base}/api/metrics/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: { type: r.type, id: r.id }, metric_ids: [r.metric], history: true, from: iso(from), to: iso(to), bucket_ms: 60000 }) });
      const body = await response.json() as any;
      const ms = performance.now() - started; latencies.push(ms);
      if (response.status !== 200) errors++;
      const buckets = body.metrics?.[0]?.series?.[0]?.buckets ?? [];
      if (buckets.length !== 1440 || buckets[0]?.window.from !== iso(from) || buckets.at(-1)?.window.to !== iso(to)) truncated++;
      receipts.push({ resource: r, status: response.status, ms, buckets: buckets.length });
    }));
    const sorted = [...latencies].sort((a,b) => a-b);
    const quantile = (q: number) => sorted[Math.ceil(q * sorted.length) - 1];
    const [tables] = await pool.query<any[]>(`SELECT TABLE_NAME,DATA_LENGTH,INDEX_LENGTH,TABLE_ROWS FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=? AND TABLE_NAME IN ('metric_observations','metric_publications')`, [database]);
    const report = { workload: { servers: 500, databases: 100, network_devices: 50, series_per_resource: 1,
      sample_ms: 60000, hours: 24, persisted_rows: Number(count.n), clients: 4, http_queries: selected.length },
      boundary: 'Synthetic contract samples in real MySQL; read-side HTTP only, no target collectors, no SLO claim',
      environment: { node: process.version, platform: process.platform, mysql: (await pool.query<any[]>('SELECT VERSION() AS v'))[0][0].v },
      seed_ms: seedMs, latency_ms: { p50: quantile(.5), p95: quantile(.95), p99: quantile(.99), max: sorted.at(-1) },
      errors, truncated, truncation_rate: truncated / selected.length, tables, receipts };
    console.log('[MAX240 capacity]', JSON.stringify(report));
    if (process.env.MAX240_CAPACITY_REPORT) await writeFile(process.env.MAX240_CAPACITY_REPORT, JSON.stringify(report, null, 2));
    expect(errors).toBe(0); expect(truncated).toBe(0);
  }, 900000);
});
