import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { Client } from 'pg';
import Fastify from 'fastify';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from '../../../../../frontend/node_modules/vite/dist/node/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import type { NormalizedObservation, Resource } from '../../contracts/metrics-v2/index.js';
import { MysqlMetricStorage } from '../storage.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { postgresCounterTransport } from '../config/postgres-counter.js';
import { bindDatabaseDriver } from './collector.js';
import { capacityDefinition, capacityReads } from './catalog.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin } from '../policy/test-support.js';
import { MysqlScheduleStore } from '../scheduler/store.js';
import { MetricScheduler } from '../scheduler/service.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../../workflows/worker-runtime.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import { RolloutControl } from '../rollout/control.js';
import { MysqlFormalMetricStore } from '../rollout/formal-store.js';
import { MetricConsumerService } from '../consumers/service.js';
import { registerMetricConsumerRoutes } from '../consumers/routes.js';

const mysqlPort = Number(process.env.METRICS_V2_TEST_MYSQL_PORT), pgPort = Number(process.env.MAX131_TEST_PG_PORT);
describe.skipIf(!mysqlPort || !pgPort)('MAX-131 real capacity cycle → formal HTTP → database list', () => {
  const database = `max131_${process.pid}`, targetDatabase = `max131_target_${process.pid}`, user = `reader_${process.pid}`;
  const registry = createConfigurationRegistry(), resources = new Map<number, Resource>(), pins = new Map<number, { id: string; version: string; digest: string }>();
  let root: Pool, pool: Pool, target: Pool, pgRoot: Client, pg: Client, policies: PolicyService;
  let scheduler: MetricScheduler, jobs: JobRegistry, worker: WorkerRuntime, consumer: MetricConsumerService;
  let app: ReturnType<typeof Fastify>, vite: ViteDevServer, browser: Browser, api: string, web: string;
  let now = Date.now(), mysqlSizeReads = 0, pgSizeReads = 0;
  const clock = () => new Date(now).toISOString();
  const outputs = async (): Promise<NormalizedObservation[]> => (await pool.query<RowDataPacket[]>("SELECT payload FROM metric_v2_observations WHERE stage = 'normalized'"))[0]
    .map(r => typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload);
  const cycle = async () => {
    expect(await scheduler.tick()).toBe(2);
    await pool.query("UPDATE workflow_jobs SET available_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE state = 'queued'");
    expect(await worker.runOnce((job, ctx) => jobs.execute(job, ctx), now)).toBe('completed');
    expect(await worker.runOnce((job, ctx) => jobs.execute(job, ctx), now)).toBe('completed');
  };
  const query = (id: number) => app.inject({ method: 'POST', url: '/api/metrics-v2/query', payload: { resource: { type: 'instance', id }, latest_capacity: true } });
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port: mysqlPort, user: 'root', password: '', supportBigNumbers: true, bigNumberStrings: true });
    await root.query(`CREATE DATABASE ${database}`); await root.query(`CREATE DATABASE ${targetDatabase}`);
    await root.query(`CREATE TABLE ${targetDatabase}.payload (id INT PRIMARY KEY, data TEXT) ENGINE=InnoDB`);
    await root.query(`INSERT INTO ${targetDatabase}.payload VALUES (1, REPEAT('a', 4096))`);
    await root.query(`CREATE USER '${user}'@'%' IDENTIFIED BY ''`); await root.query(`GRANT SELECT ON ${targetDatabase}.* TO '${user}'@'%'`);
    target = mysql.createPool({ host: '127.0.0.1', port: mysqlPort, user, password: '', database: targetDatabase, supportBigNumbers: true, bigNumberStrings: true });
    pool = mysql.createPool({ host: '127.0.0.1', port: mysqlPort, user: 'root', password: '', database, timezone: 'Z', connectionLimit: 16 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    pgRoot = new Client({ host: '127.0.0.1', port: pgPort, user: 'postgres', database: 'postgres' }); await pgRoot.connect();
    await pgRoot.query(`CREATE DATABASE ${targetDatabase}`);
    pg = new Client({ host: '127.0.0.1', port: pgPort, user: 'postgres', database: targetDatabase }); await pg.connect();
    await pg.query('CREATE TABLE payload (id INT PRIMARY KEY, data TEXT)'); await pg.query("INSERT INTO payload VALUES (1, repeat('b', 4096))");
    const mysqlVersion = (await target.query<RowDataPacket[]>('SELECT VERSION() AS version'))[0][0].version;
    const pgVersion = (await pg.query('SHOW server_version')).rows[0].server_version;
    for (const [id, engine, version] of [[1, 'mysql', mysqlVersion], [2, 'postgresql', pgVersion]] as const) {
      const resource: Resource = { type: 'instance', id: String(id), attributes: {
        'db.engine': { value: engine, observed_at: clock(), source: 'driver' }, 'db.version': { value: version, observed_at: clock(), source: 'driver' },
      } }; resources.set(id, resource); await new MysqlMetricStorage(pool).writeInventory(resource);
      const release = registry.list().find(r => r.package.id === (id === 1 ? 'mysql-basic' : 'postgresql-representative') && r.package.version === (id === 1 ? '1.1.0' : '1.0.0'))!;
      const { id: packageId, version: packageVersion, digest } = release.package; pins.set(id, { id: packageId, version: packageVersion, digest });
    }
    policies = new PolicyService(new MysqlPolicyStore(() => pool), registry, { exists: async () => true, inventory: async ref => resources.get(ref.id)! }, clock);
    for (const id of [1, 2]) await policies.changeBinding(admin, { type: 'instance', id }, { expected_revision: 0, package: pins.get(id), overrides: { max_rows: { mode: 'set', value: 10 } } }, true);
    jobs = new JobRegistry();
    scheduler = new MetricScheduler(new MysqlScheduleStore(pool, registry, 'production'), registry, { resolve: async ref => ({
      resource: resources.get(ref.id)!, credential_ref: 'credential:isolated-capacity',
      evidence: { counter: { bits: '64', start_at: new Date(now - 60000).toISOString() } },
      resolve: async () => ref.id === 1 ? bindDatabaseDriver(async sql => {
        if (sql === capacityReads.find(r => r.engine === 'mysql')!.sql) mysqlSizeReads++;
        return { rows: (await target.query(sql))[0] };
      }) : postgresCounterTransport(async sql => {
        if (sql === capacityReads.find(r => r.engine === 'postgresql')!.sql) pgSizeReads++;
        return pg.query(sql);
      }),
    }) }, () => now); scheduler.register(jobs);
    worker = new WorkerRuntime(new MysqlWorkflowStore(() => pool as never), `max131-${process.pid}`, 30);
    const formal = new MysqlFormalMetricStore(pool);
    consumer = new MetricConsumerService(policies, registry, { queryWindow: (...args) => formal.queryWindow(...args),
      inventory: (...args) => formal.inventory(...args), dimensions: (...args) => formal.dimensions(...args), latestCapacity: (...args) => formal.latestCapacity(...args),
      attempts: async ref => (await pool.query<RowDataPacket[]>("SELECT payload FROM metric_v2_attempts WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.binding_id')) = ?", [`instance:${ref.id}`]))[0].map(r => typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload),
    }, clock);
    app = Fastify(); await registerMetricConsumerRoutes(app, async request => { (request as any).user = request.headers.authorization === 'Bearer forbidden'
      ? { ...admin, permissions: ['instance:view'], instanceScopes: {} } : admin; }, consumer);
    app.get('/api/database/instances', async () => [1, 2].map(id => ({ id, name: id === 1 ? '容量验证 MySQL' : '容量验证 PostgreSQL',
      db_type: id === 1 ? 'mysql' : 'postgresql', db_version: resources.get(id)!.attributes['db.version'].value, host: '127.0.0.1', port: id === 1 ? mysqlPort : pgPort, health_status: 'unknown' })));
    app.get('/api/metrics-v2/config/resources/instance/:id/attempts', async () => []);
    api = await app.listen({ host: '127.0.0.1', port: 0 });
    vite = await createServer({ configFile: false, root: fileURLToPath(new URL('../../../../../frontend', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': api } }, logLevel: 'error' }); await vite.listen();
    web = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
    browser = await chromium.launch({ headless: true });
  }, 120000);
  afterAll(async () => {
    await browser?.close(); await vite?.close(); await app?.close(); await target?.end(); await pool?.end(); await pg?.end();
    if (pgRoot) { await pgRoot.query(`DROP DATABASE IF EXISTS ${targetDatabase}`); await pgRoot.end(); }
    if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.query(`DROP DATABASE IF EXISTS ${targetDatabase}`); await root.query(`DROP USER IF EXISTS '${user}'@'%'`); await root.end(); }
  });
  it('collects on the scheduler, publishes under accepted source tickets and matches real SQL bytes', async () => {
    expect(await scheduler.tick()).toBe(0); now += 10000; await cycle();
    // First cycle is shadow evidence; the existing rollout boundary must accept each discovered series.
    expect((await query(1)).json().metrics.find((m: any) => m.definition.id === capacityDefinition('mysql')!.id).series).toEqual([]);
    const control = new RolloutControl(pool);
    for (const point of await outputs()) {
      await control.initialize(point, { source: 'v2', read: 'v2', package: pins.get(Number(point.resource_id))!, revision: 1 });
    }
    now += 60000; await cycle(); now += 1;
    for (const [id, engine] of [[1, 'mysql'], [2, 'postgresql']] as const) {
      const read = capacityReads.find(r => r.engine === engine)!;
      const expected = id === 1 ? (await target.query<RowDataPacket[]>(read.sql))[0][0].bytes : (await pg.query(read.sql)).rows[0].bytes;
      const response = await query(id); expect(response.statusCode).toBe(200);
      const metric = response.json().metrics.find((m: any) => m.definition.id === read.fields[0].definition.id);
      const value = metric.series[0].buckets[0].value;
      expect(value).toEqual({ encoding: 'uint64', value: String(expected) });
      expect(BigInt(value.value)).toBeGreaterThan(0n); expect(BigInt(value.value)).toBeLessThan(10737418n);
      expect(metric.series[0].dimensions).toEqual(id === 1 ? {} : { database: targetDatabase });
      expect(metric.observed_at).toBeTruthy();
    }
    expect(mysqlSizeReads).toBe(2); expect(pgSizeReads).toBe(2);
  });
  it('shows matching nonzero list values on desktop/mobile; refresh and pagination never collect SQL', async () => {
    const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const evidence: unknown[] = [];
    await page.route('**/capacity-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><body><instances-page></instances-page><script type="module">import "/src/app/styles.css"; import "/src/app/ui/views/instances-db.ts";</script></body></html>' }));
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 }); await page.goto(`${web}/capacity-fixture`);
      const table = page.locator('resource-metrics-table'); await browserExpect(table.getByRole('columnheader', { name: '数据库大小', exact: true })).toBeVisible();
      for (const id of [1, 2]) {
        const row = table.getByRole('row').filter({ hasText: id === 1 ? '容量验证 MySQL' : '容量验证 PostgreSQL' });
        await browserExpect(row).toContainText('采集于'); await browserExpect(row).toContainText(/KiB|MiB/);
        const actual = (await query(id)).json(), metric = actual.metrics.find((m: any) => m.definition.unit === 'By');
        const bytes = Number(metric.series[0].buckets[0].value.value);
        const expectedLabel = bytes < 1048576 ? `${(bytes / 1024).toFixed(2)} KiB` : `${(bytes / 1048576).toFixed(2)} MiB`;
        await browserExpect(row).toContainText(expectedLabel);
        evidence.push({ width, id, metric, list: await row.innerText() });
      }
      await table.getByRole('button', { name: '刷新指标', exact: true }).click();
      await browserExpect(table.getByRole('button', { name: '刷新指标', exact: true })).toBeEnabled();
      // Exercise page changes using the real table with additional aliases; collection stays unchanged.
      await table.evaluate((el: any) => { el.entries = Array.from({ length: 21 }, (_, i) => ({ ...el.entries[0], id: i + 1 })); });
      await table.getByRole('button', { name: '下一页', exact: true }).click();
      await browserExpect(table.getByText('第 2 页', { exact: true })).toBeVisible();
      await table.getByRole('button', { name: '上一页', exact: true }).click();
      await browserExpect(table.getByText('第 1 页', { exact: true })).toBeVisible();
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    }
    expect(mysqlSizeReads).toBe(2); expect(pgSizeReads).toBe(2); expect(errors).toEqual([]);
    if (process.env.MAX131_EVIDENCE_DIR) {
      await mkdir(process.env.MAX131_EVIDENCE_DIR, { recursive: true });
      await writeFile(`${process.env.MAX131_EVIDENCE_DIR}/evidence.json`, JSON.stringify({ resources: [...resources.values()], scheduler_clock: 'accelerated two normal cycles', mysql_capacity_sql_reads: mysqlSizeReads, postgresql_capacity_sql_reads: pgSizeReads, evidence }, null, 2));
      await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(`${web}/capacity-fixture`);
      await browserExpect(page.locator('resource-metrics-table').getByText('采集于', { exact: false }).first()).toBeVisible();
      await page.screenshot({ path: `${process.env.MAX131_EVIDENCE_DIR}/database-size.png`, fullPage: true });
    }
    await page.close();
  }, 60000);
  it('retains stale capacity and rejects unauthorized reads without target SQL', async () => {
    now += 180000;
    for (const id of [1, 2]) {
      const metric = (await query(id)).json().metrics.find((m: any) => m.definition.unit === 'By');
      expect(metric.series[0].buckets[0].freshness).toBe('stale'); expect(metric.series[0].buckets[0].value).not.toBeNull();
    }
    const denied = await app.inject({ method: 'POST', url: '/api/metrics-v2/query', headers: { authorization: 'Bearer forbidden' }, payload: { resource: { type: 'instance', id: 1 }, latest_capacity: true } });
    expect(denied.statusCode).toBe(403); expect(mysqlSizeReads).toBe(2); expect(pgSizeReads).toBe(2);
    // Old configuration evidence and legacy read modes cannot become latest capacity.
    const formal = new MysqlFormalMetricStore(pool);
    expect(await formal.latestCapacity({ type: 'instance', id: 1 }, capacityDefinition('mysql')!, clock(), 2)).toBeNull();
    await pool.query("UPDATE metric_v2_rollout SET read_mode = 'legacy' WHERE resource_id = '1'");
    expect(await formal.latestCapacity({ type: 'instance', id: 1 }, capacityDefinition('mysql')!, clock(), 1)).toBeNull();
  });
});
