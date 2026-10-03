import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
    require: (id: string) => {
      if (id !== './src/db-connection') throw new Error(`Unexpected startup import: ${id}`);
      return { dbConnection: { getPool: () => pool } };
    },
    initializeControlPlane: vi.fn(), getAgentEngine: vi.fn(async () => service),
    createMetricSchedulerLifecycle: () => service, assertMetricSchedulerSchema: vi.fn(),
    registerWorkflowHandlers: vi.fn(), createCronToolRegistry: vi.fn(),
    createLLMProvider: vi.fn(), createNotificationDispatchJob: vi.fn(),
    createReportScheduleJob: vi.fn(), createReportNotificationJob: vi.fn(),
    createCapacityConsistencyJob: vi.fn(), workflowWorkerId: 'metric-quality-test',
    setInterval: vi.fn(), clearInterval: vi.fn(),
  };
  for (const name of ['metricRegistry', 'notificationDatabaseService', 'notificationService',
    'consistencyChecker', 'alertDatabaseService', 'faultDiagnosisService', 'monitorCollector',
    'baselineCalculator', 'alertEngine', 'reportConfigService', 'serverReportService',
    'reportService', 'reportDatabaseService', 'networkDeviceCollector', 'configBackupScheduler',
    'alertEscalationService', 'instanceDatabaseService', 'databaseService', 'cronJobService',
    'maintenanceWindowService']) context[name] = service;
  for (const name of ['MysqlWorkflowStore', 'JobRegistry', 'NotificationDispatchScheduler',
    'CapacityConsistencyMonitor', 'MysqlReportOccurrenceStore', 'WorkerRuntime',
    'AgentRunner', 'CronExecutor', 'CronManager']) context[name] = InertWorker;
  await runInNewContext(startup, context);
}

describe('metric quality at worker startup', () => {
  it('does not issue metric-history mutations on first or repeated startup', async () => {
    const execute = vi.fn(async () => [{ affectedRows: 0 }, []]) as any;
    await startWorkers({ execute });
    await startWorkers({ execute });
    // This also verifies the real startup SQL path ran, rather than a no-op test.
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('UPDATE cron_job_logs'));
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
    await pool.query(`CREATE TABLE metrics_history (
      id INT PRIMARY KEY, is_estimated BOOLEAN, recorded_at DATETIME, qps DECIMAL(10,2))`);
    await pool.query(`CREATE TABLE cron_job_logs (
      status VARCHAR(20), error_message TEXT, finished_at DATETIME)`);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    }
  });
  it('preserves accurate writes and existing estimated/unknown history across both starts', async () => {
    await pool.query(`INSERT INTO metrics_history VALUES
      (1, FALSE, NOW(), 11.25), (2, TRUE, NOW(), 22.50),
      (3, NULL, NOW(), 33.75), (4, FALSE, NOW() - INTERVAL 60 DAY, 44.50)`);
    const snapshot = async () => (await pool.query('SELECT * FROM metrics_history ORDER BY id'))[0];
    const before = await snapshot();
    await startWorkers(pool);
    expect(await snapshot()).toEqual(before);
    await pool.query('INSERT INTO metrics_history VALUES (5, FALSE, NOW(), 55.25)');
    const second = await snapshot();
    await startWorkers(pool);
    expect(await snapshot()).toEqual(second);
  });
});
