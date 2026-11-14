import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import mysql, { type Pool } from 'mysql2/promise';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from './migrations/runner.js';
import type { MigrationPool } from './migrations/types.js';
import { dbConnection } from './db-connection.js';
import { metricDatabaseService } from './metric-database-service.js';
import { MetricRegistry } from './metric-registry.js';
import { ActorContextService } from './auth/actor-context.js';
import { createVerifyToken } from './auth-middleware.js';
import { requirePermission } from './auth/require-permission.js';

// Explicitly injected connection only. This suite never opens the default application DB.
describe.skipIf(process.env.METRIC_STORE_MYSQL !== 'true')('#333/#334 metric store real MySQL and HTTP', () => {
  const database = `max4_metric_store_${process.pid}`;
  let admin: Pool, pool: Pool, base: string;
  const app = Fastify();
  const registry = new MetricRegistry();
  const secret = randomBytes(32).toString('hex');
  let token: string;
  const refreshSchedule = vi.fn();
  const put = (id: string, body: unknown, auth: string | null = token) => fetch(`${base}/api/metrics/registry/${id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body),
  });

  beforeAll(async () => {
    const config = JSON.parse(process.env.METRIC_STORE_MYSQL_CONFIG!);
    if (!config.host || !config.port || !config.user) throw new Error('Explicit MySQL test configuration required');
    admin = mysql.createPool({ ...config, database: undefined });
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...config, database, connectionLimit: 4 });
    const oldMigrations = await mkdtemp(join(tmpdir(), 'max4-migrations-'));
    try {
      const directory = resolve(import.meta.dirname, '../sql/migrations');
      for (const name of await readdir(directory)) {
        if (name.endsWith('.sql') && name < '159_') await copyFile(join(directory, name), join(oldMigrations, name));
      }
      await new MigrationRunner(pool as unknown as MigrationPool, oldMigrations).run();
    } finally { await rm(oldMigrations, { recursive: true, force: true }); }
    const beforeUpgrade = (await pool.query<any[]>('SELECT id,target_type,threshold_template FROM metric_definitions ORDER BY target_type,id'))[0];
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    expect((await pool.query<any[]>('SELECT id,target_type,threshold_template FROM metric_definitions ORDER BY target_type,id'))[0]).toEqual(beforeUpgrade);
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    const [version] = await pool.query<any[]>('SELECT VERSION() AS version');
    console.info('METRIC_STORE_MYSQL', JSON.stringify({ database, port: config.port, version: version[0].version }));
    const [user] = await pool.execute<any>("INSERT INTO users(username,password_hash,status) VALUES('max4_writer','unused-fixture-hash','active')");
    await pool.execute("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE name='dba'", [user.insertId]);
    token = jwt.sign({ userId: user.insertId, sessionVersion: 1 }, secret);
    const verifyToken = createVerifyToken(secret, new ActorContextService(() => ({ execute: (sql, values) => pool.execute(sql, values as any) })));
    // Execute the actual server.ts route and target parser, without starting unrelated workers.
    const source = readFileSync(resolve(import.meta.dirname, '../server.ts'), 'utf8');
    const parser = source.slice(source.indexOf('  const metricTargetType ='), source.indexOf("  fastify.get('/api/metrics/registry'"));
    const start = source.indexOf("  fastify.put('/api/metrics/registry/:id'");
    const route = source.slice(start, source.indexOf("  fastify.delete('/api/metrics/registry/:id'", start));
    const compiled = ts.transpileModule(parser + route, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    new Function('fastify', 'verifyToken', 'requirePermission', 'metricDatabaseService', 'metricRegistry', 'monitorCollector', compiled)(
      app, verifyToken, requirePermission, metricDatabaseService, registry, { refreshSchedule },
    );
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  }, 60000);

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    }
  });

  it('rejects unknown and empty updates, including simultaneous HTTP requests, without inserting rows', async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => put('missing_id', index % 2 ? {} : { name: 'client supplied' })));
    expect(responses.map(response => response.status)).toEqual(Array(12).fill(404));
    await Promise.all(responses.map(response => response.arrayBuffer()));
    expect((await pool.query<any[]>("SELECT * FROM metric_definitions WHERE id='missing_id'"))[0]).toEqual([]);
    expect(refreshSchedule).not.toHaveBeenCalled();
  });

  it('round-trips all predefined metadata after empty-store seeding and reload', async () => {
    await pool.query('DELETE FROM metric_definitions');
    const defaults = new MetricRegistry().getAll();
    await registry.initialize();
    const loaded = new MetricRegistry();
    await loaded.initialize();
    for (const metric of defaults) {
      expect(loaded.getById(metric.id, metric.target_type)).toMatchObject({
        ...metric, value_type: metric.value_type ?? 'gauge', target_type: metric.target_type ?? 'instance',
      });
    }
    expect((await pool.query<any[]>('SELECT COUNT(*) AS total FROM metric_definitions'))[0][0].total).toBe(defaults.length);
  });

  it('repairs a legacy seed while retaining operator cadence, SQL, expression and thresholds', async () => {
    await pool.query(`UPDATE metric_definitions SET value_type='gauge',category=NULL,higher_is_worse=NULL,metadata_overrides=NULL,
      default_interval=77,is_collected=0,collection_sqls=?,compute_expr='value * 2',threshold_template=? WHERE target_type='server' AND id='network_rx_errors'`,
      [JSON.stringify({ mysql: 'SELECT 42' }), JSON.stringify({ warning: 1, error: 2, critical: 3 })]);
    await registry.refreshFromDB();
    expect(registry.getById('network_rx_errors', 'server')).toMatchObject({
      value_type: 'counter', category: 'server', higher_is_worse: true, default_interval: 77, is_collected: false,
      collection_sqls: { mysql: 'SELECT 42' }, compute_expr: 'value * 2', threshold_template: { warning: 1, error: 2, critical: 3 },
    });
  });

  it('updates builtin configuration, preserves explicit null/false and supports repeated no-ops', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await put('network_rx_errors?target_type=server', {
        default_interval: 81, is_collected: false, value_type: 'gauge', threshold_template: null,
        higher_is_worse: false, collection_sqls: null, compute_expr: null, category: null,
      });
      expect(response.status).toBe(200); await response.arrayBuffer();
    }
    const response = await put('network_rx_errors?target_type=server', {});
    expect(response.status).toBe(200); await response.arrayBuffer();
    const reloaded = new MetricRegistry(); await reloaded.initialize();
    expect(reloaded.getById('network_rx_errors', 'server')).toMatchObject({
      default_interval: 81, is_collected: false, value_type: 'gauge', threshold_template: null, higher_is_worse: false,
    });
    expect(reloaded.getById('network_rx_errors', 'server')?.collection_sqls).toBeUndefined();
    expect(reloaded.getById('network_rx_errors', 'server')?.compute_expr).toBeUndefined();
    expect(reloaded.getById('network_rx_errors', 'server')?.category).toBeUndefined();
    expect(await metricDatabaseService.deleteMetric('network_rx_errors', 'server')).toMatchObject({ success: false, reason: 'builtin' });
  });

  it('keeps the previous complete row when a database update fails', async () => {
    const before = await metricDatabaseService.getMetricById('cpu_usage');
    const response = await put('cpu_usage', { name: 'x'.repeat(101), default_interval: 42 });
    expect(response.status).toBe(400); await response.arrayBuffer();
    expect(await metricDatabaseService.getMetricById('cpu_usage')).toEqual(before);
  });

  it('enforces real JWT authentication and live database permission revocation', async () => {
    const unauthenticated = await put('cpu_usage', {}, null);
    expect(unauthenticated.status).toBe(401); await unauthenticated.arrayBuffer();
    await pool.query("DELETE ur FROM user_roles ur JOIN users u ON u.id=ur.user_id WHERE u.username='max4_writer'");
    const revoked = await put('cpu_usage', { default_interval: 33 });
    expect(revoked.status).toBe(403); await revoked.arrayBuffer();
    expect((await metricDatabaseService.getMetricById('cpu_usage'))?.default_interval).not.toBe(33);
  });
});
