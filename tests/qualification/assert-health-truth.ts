import { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';
import { ConsistencyChecker } from '../../apps/db-ops-api/src/consistency-checker.js';

if (!await dbConnection.initialize()) throw new Error('qualification database connection failed');
const pool = dbConnection.getPool();
if (!pool) throw new Error('qualification database pool unavailable');
const suffix = `${Date.now()}-${process.pid}`;

try {
  await pool.execute(
    `INSERT INTO database_instances (name, environment, db_type, host, port, username, password_encrypted, status, health_status)
     VALUES (?, 'testing', 'mysql', ?, 3306, 'qualification', 'qualification-only', 'active', 'healthy')`,
    [`qualification-health-instance-${suffix}`, `qualification-health-instance-${suffix}.invalid`],
  ) as any;
  await pool.execute(
    `INSERT INTO servers (host, port, label, os_type, credential_type, credential_encrypted, status, collection_enabled)
     VALUES (?, 22, ?, 'linux', 'password', 'qualification-only', 'offline', 1)`,
    [`qualification-health-server-${suffix}.invalid`, `Qualification health server ${suffix}`],
  );
  const [job] = await pool.execute(
    `INSERT INTO cron_jobs (name, task_description, cron_expr, task_type, handler_key)
     VALUES (?, 'qualification health workflow', '* * * * *', 'agent', 'qualification.health')`,
    [`qualification-health-job-${suffix}`],
  ) as any;
  await pool.execute('INSERT INTO cron_job_logs (job_id, status, started_at) VALUES (?, \'error\', NOW())', [job.insertId]);
  const truth = await new ConsistencyChecker().resourceHealthTruth();
  if (truth.controlPlane.status !== 'healthy'
    || truth.managedAvailability.status !== 'degraded'
    || truth.dataFreshness.status !== 'critical'
    || truth.workflow.status !== 'degraded'
    || truth.overall !== 'critical') {
    throw new Error(`unexpected health aggregation: ${JSON.stringify(truth)}`);
  }
  console.log(`health truth invariant valid: overall=${truth.overall} control=${truth.controlPlane.status} availability=${truth.managedAvailability.status} freshness=${truth.dataFreshness.status} workflow=${truth.workflow.status}`);
} finally {
  await dbConnection.close();
}
