import { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';
import { serverAlertEvaluator } from '../../apps/db-ops-api/src/server-alert-evaluator.js';
import { alertRCAService } from '../../apps/db-ops-api/src/alert-rca-service.js';
import { aiAnalysisDatabaseService } from '../../apps/db-ops-api/src/ai-analysis-database-service.js';
import { alertEngine } from '../../apps/db-ops-api/src/alert-engine.js';

const suffix = `${Date.now()}-${process.pid}`;
process.env.ENCRYPTION_KEY ??= 'qualification-encryption-key-2026-07-19-not-production';

if (!await dbConnection.initialize()) throw new Error('qualification database connection failed');
const pool = dbConnection.getPool();
if (!pool) throw new Error('qualification database pool unavailable');

const [serverResult] = await pool.execute(
  `INSERT INTO servers (host, port, label, os_type, credential_type, credential_encrypted, status, collection_enabled)
   VALUES (?, 22, ?, 'linux', 'password', 'qualification-only', 'online', 1)`,
  [`qualification-alert-${suffix}.invalid`, `Qualification alert ${suffix}`],
) as any;
const serverId = Number(serverResult.insertId);

const [ruleResult] = await pool.execute(
  `INSERT INTO alert_rules
   (target_type, name, metric_name, operator, threshold, duration_seconds, severity, enabled, silence_minutes, server_id)
   VALUES ('server', ?, 'cpu_usage', '>', 80, 0, 'critical', 1, 0, ?)`,
  [`Qualification CPU threshold ${suffix}`, serverId],
) as any;
const ruleId = Number(ruleResult.insertId);

try {
  await pool.execute(
    'INSERT INTO server_metrics (server_id, metric_name, metric_value, recorded_at) VALUES (?, \'cpu_usage\', 95, NOW())',
    [serverId],
  );
  await serverAlertEvaluator.evaluateServerRules();
  const [alerts] = await pool.execute<Array<{ id: number; server_id: number; metric_name: string; metric_value: string; level: string }>>(
    `SELECT id, server_id, metric_name, metric_value, level
     FROM alerts WHERE server_id = ? AND metric_name = 'cpu_usage' ORDER BY id DESC LIMIT 1`,
    [serverId],
  );
  const alert = alerts[0];
  if (!alert || Number(alert.server_id) !== serverId || Number(alert.metric_value) !== 95 || alert.level !== 'critical') {
    throw new Error('server metric did not create the expected alert');
  }

  const rca = await alertRCAService.analyzeAlert(alert.id, 'manual');
  if (!rca.success || !rca.analysisId) throw new Error(`server RCA creation failed: ${rca.error ?? 'unknown error'}`);
  const analysis = await aiAnalysisDatabaseService.getAnalysisById(rca.analysisId);
  if (!analysis || analysis.analysis_type !== 'alert_rca' || analysis.server_id !== serverId || analysis.related_id !== alert.id || !analysis.session_key) {
    throw new Error('server RCA was not persisted with its server subject');
  }

  const [instanceResult] = await pool.execute(
    `INSERT INTO database_instances (name, environment, db_type, host, port, username, password_encrypted, status)
     VALUES (?, 'testing', 'mysql', ?, 3306, 'qualification', 'qualification-only', 'active')`,
    [`qualification-instance-${suffix}`, `qualification-instance-${suffix}.invalid`],
  ) as any;
  const instanceId = Number(instanceResult.insertId);
  const [instanceRuleResult] = await pool.execute(
    `INSERT INTO alert_rules
     (target_type, name, metric_name, operator, threshold, duration_seconds, severity, enabled, silence_minutes, instance_ids)
     VALUES ('instance', ?, 'qualification_load', '>', 80, 0, 'critical', 1, 0, ?)`,
    [`Qualification instance CPU threshold ${suffix}`, JSON.stringify([instanceId])],
  ) as any;
  await pool.execute('INSERT INTO metrics_history (instance_id, metrics_data, recorded_at) VALUES (?, ?, NOW())', [instanceId, JSON.stringify({ qualification_load: 95 })]);
  await alertEngine.evaluateAndCreateAlerts();
  const [instanceAlerts] = await pool.execute<Array<{ id: number; instance_id: number; metric_value: string; level: string }>>(
    `SELECT id, instance_id, metric_value, level FROM alerts
     WHERE instance_id = ? AND metric_name = 'qualification_load' ORDER BY id DESC LIMIT 1`, [instanceId],
  );
  const instanceAlert = instanceAlerts[0];
  if (!instanceAlert || Number(instanceAlert.instance_id) !== instanceId || Number(instanceAlert.metric_value) !== 95 || instanceAlert.level !== 'critical') {
    throw new Error('instance metric did not create the expected alert');
  }
  const instanceRca = await alertRCAService.analyzeAlert(instanceAlert.id, 'manual');
  const instanceAnalysis = instanceRca.analysisId ? await aiAnalysisDatabaseService.getAnalysisById(instanceRca.analysisId) : null;
  if (!instanceRca.success || !instanceAnalysis || instanceAnalysis.instance_id !== instanceId || instanceAnalysis.related_id !== instanceAlert.id) {
    throw new Error('instance RCA was not persisted with its instance subject');
  }
  console.log(`alert-RCA invariant valid: server=${serverId} rule=${ruleId} alert=${alert.id} analysis=${analysis.id}; instance=${instanceId} rule=${instanceRuleResult.insertId} alert=${instanceAlert.id} analysis=${instanceAnalysis.id}`);
} finally {
  // The enclosing qualification script drops this database. Closing the pool
  // lets this assertion exit without retaining the bridge's background timer.
  await dbConnection.close();
}
