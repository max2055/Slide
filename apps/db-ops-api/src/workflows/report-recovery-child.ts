// Qualification subprocess: fake report data, isolated database, real exit windows.
import mysql from 'mysql2/promise';
import { MysqlReportOccurrenceStore } from './report-occurrence-store.js';
import { MysqlWorkflowStore, WorkerRuntime } from './worker-runtime.js';
import { JobRegistry } from './job-registry.js';
import { registerReportScheduleHandler } from './report-schedule-handler.js';
import { reportDatabaseService } from '../report-database-service.js';

const database = process.env.REPORT_TEST_DATABASE;
if (!database?.match(/^report_recovery_\d+$/) || !Number(process.env.REPORT_TEST_MYSQL_PORT)) throw new Error('ISOLATED_REPORT_TEST_REQUIRED');
const pool = mysql.createPool({ host: '127.0.0.1', port: Number(process.env.REPORT_TEST_MYSQL_PORT),
  user: 'root', password: process.env.REPORT_TEST_MYSQL_PASSWORD ?? '', database, timezone: 'Z' });
const store = new MysqlReportOccurrenceStore(() => pool);
const window = process.argv[2];
const claim = store.claim.bind(store);
store.claim = async (...args) => { const result = await claim(...args); if (window === 'claimed') process.exit(77); return result; };
const create = store.createReport.bind(store);
store.createReport = async (...args) => { const result = await create(...args); if (window === 'saved' || window === 'pending') process.exit(77); return result; };
const complete = store.complete.bind(store);
store.complete = async (...args) => { await complete(...args); if (window === 'committed') process.exit(77); };
const registry = new JobRegistry();
registerReportScheduleHandler(registry, {
  reportConfigService: { getEnabledConfigs: async () => [] }, enqueueReportSchedule: async () => {},
  createOccurrenceStore: () => store,
  serverReportService: { generateAndPersist: async () => {
    const report = await reportDatabaseService.createReport({ name: 'isolated fake report', type: 'server_health',
      status: window === 'pending' ? 'pending' : 'completed', content: 'fixture' });
    return { success: true, reportId: report.id };
  } },
  reportService: { generateReport: async () => { throw new Error('UNEXPECTED_DATABASE_REPORT'); } },
});
await new WorkerRuntime(new MysqlWorkflowStore(() => pool as any), 'child').runOnce((job, context) => registry.execute(job, context));
await pool.end();
throw new Error('CRASH_WINDOW_NOT_REACHED');
