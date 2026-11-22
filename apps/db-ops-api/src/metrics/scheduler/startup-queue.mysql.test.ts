import { randomUUID } from 'node:crypto';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { PolicyError } from '../policy/model.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin, pin, resource } from '../policy/test-support.js';
import { MetricFormalization } from '../rollout/formalization.js';
import { MetricSchedulerLifecycle } from './lifecycle.js';
import { assertMetricSchedulerSchema } from './runtime.js';
import { schedulerSchemaProbes } from './runtime-test-support.js';
import { MetricScheduler } from './service.js';
import { MysqlScheduleStore } from './store.js';

// Explicit opt-in; the caller supplies a task-authorized endpoint in memory.
// This suite creates/drops only its UUID-named schema, never a shared database.
const config = process.env.METRIC_SCHEDULER_MYSQL_CONFIG;
describe.skipIf(!config)('MAX-521/522 isolated real MySQL startup and enqueue', () => {
  const database = `max521_${randomUUID().replaceAll('-', '')}`;
  const packages = createBuiltinRegistry();
  let root: Pool, pool: Pool;
  beforeAll(async () => {
    const options = JSON.parse(config!);
    if (!options.host || !options.port || !options.user) throw new Error('EXPLICIT_MYSQL_ENDPOINT_REQUIRED');
    root = mysql.createPool({ ...options, database: undefined, timezone: 'Z' });
    await root.query(`CREATE DATABASE \`${database}\``);
    pool = mysql.createPool({ ...options, database, timezone: 'Z', connectionLimit: 4 });
    await expect(assertMetricSchedulerSchema(pool)).rejects.toThrow('METRIC_SCHEMA_NOT_READY');
    await new MigrationRunner(pool as unknown as MigrationPool).run();
  }, 120000);
  afterAll(async () => {
    await pool?.end();
    if (root) { try { await root.query(`DROP DATABASE IF EXISTS \`${database}\``); } finally { await root.end(); } }
  });

  it('accepts migrated schema and blocks collection for every absent table and probed column despite intact migration history', async () => {
    await assertMetricSchedulerSchema(pool);
    const lifecycle = new MetricSchedulerLifecycle({ tick: async () => 0, register: () => {} }, { enabled: true });
    try {
      await lifecycle.start(new JobRegistry(), () => assertMetricSchedulerSchema(pool));
      expect(lifecycle.status().running).toBe(true);
    } finally { await lifecycle.stop(); }
    let tableCases = 0, columnCases = 0;
    for (const sql of await schedulerSchemaProbes()) {
      const match = /^SELECT (.+) FROM (\w+) LIMIT 0$/.exec(sql)!;
      const table = match[2], columns = match[1].split(', ');
      const checkBlocked = async () => {
        const scheduler = { tick: vi.fn(), register: vi.fn() };
        const lifecycle = new MetricSchedulerLifecycle(scheduler, { enabled: true });
        try {
          await expect(lifecycle.start(new JobRegistry(), () => assertMetricSchedulerSchema(pool))).rejects.toThrow(/^METRIC_SCHEMA_NOT_READY$/);
          expect(scheduler.register).not.toHaveBeenCalled(); expect(scheduler.tick).not.toHaveBeenCalled();
        } finally { await lifecycle.stop(); }
      };
      await pool.query(`RENAME TABLE \`${table}\` TO \`max521_original\``);
      try {
        await checkBlocked(); tableCases++;
        for (const column of columns) {
          // Materialize an empty projection without the selected column. This
          // also handles generated-column dependencies and FK-owned columns,
          // while leaving the migrated original (and ledger) untouched.
          const projection = columns.filter(value => value !== column).map(value => `\`${value}\``);
          await pool.query(`CREATE TABLE \`${table}\` AS SELECT 1 AS max521_placeholder${projection.length ? ', ' + projection.join(', ') : ''} FROM max521_original LIMIT 0`);
          try { await checkBlocked(); columnCases++; }
          finally { await pool.query(`DROP TABLE \`${table}\``); }
        }
      } finally { await pool.query(`RENAME TABLE \`max521_original\` TO \`${table}\``); }
    }
    await assertMetricSchedulerSchema(pool);
    expect(tableCases).toBeGreaterThanOrEqual(29); expect(columnCases).toBeGreaterThan(150);
    console.info('MAX521_SCHEMA_MATRIX', JSON.stringify({ tableCases, columnCases, restored: true }));
  }, 120000);

  it('refuses a missing shared lock row and accepts its restoration', async () => {
    await pool.query('DELETE FROM metric_policy_lock WHERE id=1');
    try { await expect(assertMetricSchedulerSchema(pool)).rejects.toThrow('METRIC_SCHEMA_NOT_READY'); }
    finally { await pool.query('INSERT INTO metric_policy_lock(id) VALUES(1)'); }
    await assertMetricSchedulerSchema(pool);
  });

  it('starts real scheduling after migrations; isolates first/middle/last repeated faults and preserves durable queue counts', async () => {
    const store = new MysqlScheduleStore(pool, packages, 'production');
    const policies = new PolicyService(new MysqlPolicyStore(() => pool), packages,
      { exists: async () => true, inventory: async ref => resource(ref.id) });
    for (const id of [1, 2, 3]) {
      await pool.query("INSERT INTO database_instances(id,name,host,port,database_name,username,password_encrypted,db_type,status) VALUES(?,?,'127.0.0.1',3308,?,'fixture','unused','mysql','active')", [id, `max521-${id}`, `max521-${id}`]);
      await policies.changeBinding(admin, { type: 'instance', id }, { expected_revision: 0, package: pin }, true);
    }
    let now = Date.now();
    const formalization = new MetricFormalization(pool, packages);
    const scheduler = MetricScheduler.forLegacyPackages(store, packages, { resolve: async () => { throw new Error('NO_TARGET_IO_EXPECTED'); } },
      () => now, undefined, formalization);
    for (const phase of ['formalization', 'enqueue'] as const) {
      for (const failed of [1, 2, 3]) {
        await pool.query('DELETE FROM metric_schedule'); await pool.query('DELETE FROM workflow_jobs');
        const originalReconcile = formalization.reconcile.bind(formalization), originalEnqueue = store.enqueue.bind(store);
        const fault = new PolicyError('PLAN_IDENTITY');
        const reconcileSpy = vi.spyOn(formalization, 'reconcile').mockImplementation(async (ref, revision) => {
          if (phase === 'formalization' && ref.id === failed) throw fault;
          return originalReconcile(ref, revision);
        });
        const enqueueSpy = vi.spyOn(store, 'enqueue').mockImplementation(async (value, time) => {
          if (phase === 'enqueue' && value.binding.resource.id === failed) throw fault;
          return originalEnqueue(value, time);
        });
        const lifecycle = new MetricSchedulerLifecycle(scheduler, { enabled: true });
        try {
          await lifecycle.start(new JobRegistry(), () => assertMetricSchedulerSchema(pool));
          expect(await lifecycle.stop()).toBe(true);
          now += 20000;
          expect(await scheduler.tick()).toBe(2);
          expect(await scheduler.tick()).toBe(0);
          const [jobs] = await pool.query<RowDataPacket[]>('SELECT payload FROM workflow_jobs ORDER BY id');
          expect(jobs).toHaveLength(2);
          expect(jobs.map(row => (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload).resource.id).sort())
            .toEqual([1, 2, 3].filter(id => id !== failed));
        } finally { await lifecycle.stop(); reconcileSpy.mockRestore(); enqueueSpy.mockRestore(); }
      }
    }
    // A persisted configuration can pass envelope decoding yet contradict the
    // immutable package's collector mapping. Exercise the real compiler fault.
    await pool.query('DELETE FROM metric_schedule'); await pool.query('DELETE FROM workflow_jobs');
    await pool.query(`UPDATE metric_policy_bindings SET payload=JSON_SET(payload,
      '$.resolved.metric_templates[0].source.raw_field', 'max521_invalid_mapping') WHERE resource_key='instance:1'`);
    expect((await store.scan()).rejected).toHaveLength(0);
    expect(await scheduler.tick()).toBe(0);
    now += 20000;
    expect(await scheduler.tick()).toBe(2);
    expect(await scheduler.tick()).toBe(0);
    const [healthy] = await pool.query<RowDataPacket[]>('SELECT resource_key FROM metric_schedule ORDER BY resource_key');
    expect(healthy.map(row => row.resource_key)).toEqual(['instance:2', 'instance:3']);
    const connection = await pool.getConnection();
    await connection.query('RENAME TABLE metric_policy_lock TO max521_lock_unavailable');
    try { await expect(scheduler.tick()).rejects.toMatchObject({ code: 'ER_NO_SUCH_TABLE' }); }
    finally { await connection.query('RENAME TABLE max521_lock_unavailable TO metric_policy_lock'); connection.release(); }
    const closedPool = mysql.createPool({ ...JSON.parse(config!), database });
    await closedPool.end();
    const unavailable = new MetricScheduler(new MysqlScheduleStore(closedPool, packages), packages,
      { resolve: async () => { throw new Error('NO_TARGET_IO_EXPECTED'); } });
    await expect(unavailable.tick()).rejects.toThrow('Pool is closed.');
    console.info('MAX522_QUEUE_MATRIX', JSON.stringify({ resourcePositions: 3, phases: 2, repeatedTicks: 3, healthyJobsPerCase: 2, globalSchemaFailure: 'propagated' }));
  }, 30000);
});
