import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { splitSqlStatements } from '../migrations/runner.js';

// Execute the actual worker-start function without binding ports, launching agents,
// scheduling collectors or loading application .env. Keep direct startup SQL real.
const source = ts.createSourceFile('server.ts',
  readFileSync(new URL('../../server.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
let worker: ts.ArrowFunction | undefined;
function findWorker(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'startWorkers'
    && node.initializer && ts.isArrowFunction(node.initializer)) worker = node.initializer;
  ts.forEachChild(node, findWorker);
}
findWorker(source);
if (!worker) throw new Error('server.ts worker startup not found');
const startup = ts.transpileModule(`const startWorkers = ${worker.getText(source)}; startWorkers();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

async function startWorkers(pool: Pick<Pool, 'execute'>) {
  const service = {
    start: vi.fn(), initialize: vi.fn(), syncRulesFromRegistry: vi.fn(),
    startEvaluationLoop: vi.fn(), createDefaultRules: vi.fn(), startCacheRefresh: vi.fn(),
    getAllInstances: vi.fn(async () => []), enqueue: vi.fn(),
  };
  class InertWorker {
    start = vi.fn();
    enqueue = vi.fn();
  }
  const context: Record<string, unknown> = {
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pool, dbConnection: { getPool: () => pool },
    instanceRemovalService: { configure: vi.fn(), remove: vi.fn() },
    instanceRemovalStore: { pendingIds: vi.fn(async () => []) },
    require: (id: string) => {
      if (id !== './src/db-connection') throw new Error(`Unexpected startup import: ${id}`);
      return { dbConnection: { getPool: () => pool } };
    },
    initializeLeaderConnections: vi.fn(), startSessionCleanup: vi.fn(),
    startup: { assertOwned: vi.fn(async () => {}), step: async (operation: () => Promise<unknown>) => operation() },
    process: { env: { PROMPT_HOT_RELOAD: 'false' } }, promptManager: { startWatch: vi.fn() },
    getAgentEngine: vi.fn(async () => service),
    createMetricSchedulerLifecycle: () => service, assertMetricSchedulerSchema: vi.fn(),
    startMetricRetention: vi.fn(), registerWorkflowHandlers: vi.fn(), registerCronRunHandler: vi.fn(), createCronToolRegistry: vi.fn(),
    createLLMProvider: vi.fn(), createNotificationDispatchJob: vi.fn(),
    createReportScheduleJob: vi.fn(), createReportNotificationJob: vi.fn(),
    createCapacityConsistencyJob: vi.fn(), workflowWorkerId: 'metric-quality-test',
    analysisDispatchStore: { assertSchema: vi.fn(), recoverLegacy: vi.fn(), recover: vi.fn() },
    registerAnalysisDispatchHandler: vi.fn(), registerAnalysisRecoveryHandler: vi.fn(),
    authorizeAnalysisRequest: vi.fn(), analysisConfigurationVersion: vi.fn(), createAnalysisRecoveryJob: vi.fn(),
    workflowConcurrency: () => 3,
    setInterval: vi.fn(), clearInterval: vi.fn(),
  };
  for (const name of ['metricRegistry', 'notificationDatabaseService', 'notificationService',
    'consistencyChecker', 'alertDatabaseService', 'faultDiagnosisService', 'monitorCollector',
    'baselineCalculator', 'alertEngine', 'reportConfigService', 'serverReportService',
    'reportService', 'reportDatabaseService', 'networkDeviceCollector', 'configBackupScheduler',
    'alertEscalationService', 'instanceDatabaseService', 'databaseService', 'cronJobService',
    'maintenanceWindowService']) context[name] = service;
  for (const name of ['MysqlWorkflowStore', 'JobRegistry', 'NotificationDispatchScheduler',
    'CapacityConsistencyMonitor', 'MysqlReportOccurrenceStore', 'BoundedWorkflowRuntime',
    'AgentRunner', 'CronExecutor', 'CronManager']) context[name] = InertWorker;
  await runInNewContext(startup, context);
  expect(service.start).toHaveBeenCalled();
}

describe('metric quality at worker startup', () => {
  it('does not issue metric-history mutations on first or repeated startup', async () => {
    const execute = vi.fn(async () => [{ affectedRows: 0 }, []]) as any;
    await startWorkers({ execute });
    await startWorkers({ execute });
    // W07 removes the legacy reaper; unowned logs require manual review.
    expect(execute.mock.calls.filter(([sql]) => /UPDATE cron_job_logs/i.test(sql))).toEqual([]);
    expect(execute.mock.calls.filter(([sql]) => /metrics_history/i.test(sql))).toEqual([]);
  });
});

// Explicit opt-in uses only a dedicated disposable localhost MySQL, no .env.
const port = Number(process.env.METRIC_QUALITY_TEST_MYSQL_PORT);
describe.skipIf(!port)('metric quality startup with isolated MySQL', () => {
  let admin: Pool;
  let pool: Pool;
  const database = `metric_quality_${process.pid}`;
  beforeAll(async () => {
    admin = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database });
    const baseline = readFileSync(new URL('../../sql/migrations/000_schema_baseline.sql', import.meta.url), 'utf8');
    const metricsTable = splitSqlStatements(baseline).find(sql => /CREATE TABLE IF NOT EXISTS `metrics_history`/.test(sql));
    if (!metricsTable) throw new Error('metrics_history baseline not found');
    await pool.query(metricsTable);
    await pool.query(`CREATE TABLE cron_job_logs (
      run_id CHAR(36), status VARCHAR(20), error_message TEXT, finished_at DATETIME)`);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    }
  });
  it('preserves accurate writes and existing estimated/unknown history across both starts', async () => {
    await pool.query(`INSERT INTO metrics_history (id, instance_id, is_estimated, recorded_at, qps) VALUES
      (1, 9, FALSE, NOW(), 11.25), (2, 9, TRUE, NOW(), 22.50),
      (3, 9, NULL, NOW(), 33.75), (4, 9, FALSE, NOW() - INTERVAL 60 DAY, 44.50)`);
    const snapshot = async () => (await pool.query('SELECT * FROM metrics_history ORDER BY id'))[0];
    const before = await snapshot();
    await startWorkers(pool);
    expect(await snapshot()).toEqual(before);
    await pool.query('INSERT INTO metrics_history (id, instance_id, is_estimated, recorded_at, qps) VALUES (5, 9, FALSE, NOW(), 55.25)');
    const second = await snapshot();
    await startWorkers(pool);
    expect(await snapshot()).toEqual(second);
  });
  it('exports candidates of any age with source and counts, without restoring flags', async () => {
    await pool.query('DELETE FROM metrics_history');
    await pool.query(`INSERT INTO metrics_history (id, instance_id, is_estimated, recorded_at, qps) VALUES
      (1, 9, FALSE, NOW(), 11.25), (2, 9, TRUE, NOW(), 22.50),
      (3, 9, NULL, NOW(), 33.75), (4, 9, TRUE, NOW() - INTERVAL 60 DAY, 44.50)`);
    const before = (await pool.query('SELECT * FROM metrics_history ORDER BY id'))[0];
    const sql = readFileSync(new URL('../../sql/diagnostics/metric-quality-candidates.sql', import.meta.url), 'utf8');
    const connection = await pool.getConnection();
    const results: any[] = [];
    try {
      for (const statement of splitSqlStatements(sql)) results.push((await connection.query(statement))[0]);
    } finally {
      await connection.rollback();
      connection.release();
    }
    const rows = results.filter(Array.isArray);
    expect(rows[0]).toEqual([expect.objectContaining({
      source_table: 'metrics_history', candidate_count: 2, review_status: 'source-quality-unverified',
    })]);
    expect(rows[1].map(row => row.id)).toEqual([2, 4]);
    expect(rows[1].every(row => row.provenance === 'legacy-formula-version-unavailable')).toBe(true);
    expect((await pool.query('SELECT * FROM metrics_history ORDER BY id'))[0]).toEqual(before);
  });
});
