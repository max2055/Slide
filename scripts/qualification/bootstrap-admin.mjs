import path from 'node:path';
import { pathToFileURL } from 'node:url';
import '../../apps/db-ops-api/node_modules/dotenv/config.js';
import bcrypt from '../../apps/db-ops-api/node_modules/bcrypt/bcrypt.js';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';

const DEAD_LETTER_JOB_ID = '00000000-0000-4000-8000-000000000139';
const RCA_SERVER_HOST = 'qualification-server-rca.invalid';
const RCA_ALERT_TITLE = 'Qualification server RCA browser alert';
const INJECTABLE_STEPS = new Set(['after-rca', 'before-commit']);

export function assertInjectableStep(step) {
  if (step && !INJECTABLE_STEPS.has(step)) {
    throw new Error('unknown qualification bootstrap failure injection');
  }
}

async function markStep(step, { failAfterStep, afterStep }) {
  if (typeof afterStep === 'function') await afterStep(step);
  if (failAfterStep === step) {
    throw new Error(`qualification bootstrap injected failure after ${step}`);
  }
}

async function applyQualificationDdl(db) {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS qualification_approval_counter (
      id INT NOT NULL PRIMARY KEY,
      value INT NOT NULL
    ) ENGINE=InnoDB`,
  );
  await db.execute(
    `ALTER TABLE qualification_approval_counter
       COMMENT = 'Qualification approval execution counter',
       MODIFY COLUMN id INT NOT NULL COMMENT 'Counter ID',
       MODIFY COLUMN value INT NOT NULL COMMENT 'Counter value'`,
  );
}

async function applyQualificationFixtures(db, passwordHash, options) {
  await db.execute(
    `DELETE ip FROM instance_permissions ip
     JOIN database_instances i ON i.id = ip.instance_id
     WHERE i.name = 'qualification-query-target' AND i.environment = 'testing'`,
  );
  await db.execute("DELETE FROM database_instances WHERE name = 'qualification-query-target' AND environment = 'testing'");
  await db.execute('DELETE FROM notification_delivery_replays WHERE workflow_job_id = ?', [DEAD_LETTER_JOB_ID]);
  await db.execute('DELETE FROM notification_delivery_attempts WHERE workflow_job_id = ?', [DEAD_LETTER_JOB_ID]);
  await db.execute('DELETE FROM workflow_jobs WHERE id = ?', [DEAD_LETTER_JOB_ID]);
  await db.execute(
    `INSERT INTO workflow_jobs
      (id, job_type, schema_version, payload, idempotency_key, state, attempts, max_attempts, last_error)
     VALUES (?, 'notification.deliver', 1, ?, 'qualification:dead-letter:139', 'dead_letter', 5, 5, 'qualification delivery failure')`,
    [DEAD_LETTER_JOB_ID, JSON.stringify({ alertId: 0, channelId: 0 })],
  );
  await db.execute('DELETE FROM ai_analysis WHERE cache_key = ?', ['qualification:server-rca-browser']);
  await db.execute('DELETE FROM alerts WHERE title = ?', [RCA_ALERT_TITLE]);
  await db.execute('DELETE FROM servers WHERE host = ? AND port = 22', [RCA_SERVER_HOST]);
  const [serverInsert] = await db.execute(
    `INSERT INTO servers (host, port, label, os_type, credential_type, credential_encrypted, status, collection_enabled)
     VALUES (?, 22, 'Qualification server RCA', 'linux', 'password', 'qualification-only', 'online', 0)`,
    [RCA_SERVER_HOST],
  );
  const serverId = Number(serverInsert.insertId);
  const [alertInsert] = await db.execute(
    `INSERT INTO alerts (server_id, alert_type, level, title, message, status, metric_name, metric_value, threshold_value)
     VALUES (?, 'availability', 'critical', ?, 'Qualification browser RCA fixture', 'unread', 'cpu_usage', '95', '80')`,
    [serverId, RCA_ALERT_TITLE],
  );
  const alertId = Number(alertInsert.insertId);
  await db.execute(
    `INSERT INTO ai_analysis
      (analysis_type, target_type, server_id, related_id, status, trigger_type, cache_key, result, completed_at, session_key)
     VALUES ('alert_rca', 'server', ?, ?, 'completed', 'manual', ?, ?, NOW(), 'qualification-server-rca-session')`,
    [serverId, alertId, `alert:${alertId}:server:${serverId}`, JSON.stringify({ summary: 'Qualification server RCA completed.' })],
  );
  await markStep('after-rca', options);
  await db.execute(
    'INSERT INTO qualification_approval_counter (id, value) VALUES (1, 0) ON DUPLICATE KEY UPDATE value = 0',
  );
  const [updated] = await db.execute(
    "UPDATE users SET password_hash = ?, status = 'active' WHERE username = 'admin'",
    [passwordHash],
  );
  if (!Number(updated.affectedRows)) throw new Error('qualification admin seed is missing');
  await db.execute(
    "INSERT IGNORE INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u JOIN roles r ON r.name = 'admin' WHERE u.username = 'admin'",
  );
  await db.execute(
    "INSERT INTO users (username, password_hash, status) VALUES ('qualification-viewer', ?, 'active') ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), status = 'active'",
    [passwordHash],
  );
  await db.execute(
    "INSERT IGNORE INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u JOIN roles r ON r.name = 'viewer' WHERE u.username = 'qualification-viewer'",
  );
  const [admins] = await db.execute("SELECT id FROM users WHERE username = 'admin'");
  const adminId = admins[0]?.id;
  if (!adminId) throw new Error('qualification admin seed is missing');
  await db.execute(
    `INSERT INTO chat_sessions (session_id, user_id, title, message_count, last_message_at)
     VALUES ('qualification-admin-private-session', ?, 'qualification private session', 1, NOW())
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), message_count = VALUES(message_count), last_message_at = VALUES(last_message_at)`,
    [adminId],
  );
  await db.execute(
    `INSERT INTO chat_messages (session_id, message_id, role, content)
     VALUES ('qualification-admin-private-session', 'qualification-admin-private-message', 'user', 'private qualification message')
     ON DUPLICATE KEY UPDATE content = VALUES(content)`,
  );
  await markStep('before-commit', options);
}

export async function prepareQualificationAdmin(db, { password, failAfterStep, afterStep } = {}) {
  if (!password) throw new Error('qualification bootstrap requires QUALIFICATION_ADMIN_PASSWORD');
  assertInjectableStep(failAfterStep);
  const [current] = await db.query('SELECT DATABASE() AS name');
  const database = String(current[0]?.name ?? '');
  if (!database.startsWith('db_ops_ai_qualification')) {
    throw new Error('qualification bootstrap refuses a non-qualification database');
  }
  // DDL implicitly commits in MySQL, so it stays outside the fixture transaction.
  console.error('qualification bootstrap phase=ddl');
  await applyQualificationDdl(db);
  const passwordHash = await bcrypt.hash(password, 12);
  console.error('qualification bootstrap phase=dml');
  await db.beginTransaction();
  try {
    await applyQualificationFixtures(db, passwordHash, { failAfterStep, afterStep });
    await db.commit();
  } catch (error) {
    try {
      await db.rollback();
    } catch (rollbackError) {
      console.error('qualification bootstrap phase=rollback-failed');
      throw new Error(`${error.message}; rollback failed: ${rollbackError.message}`, { cause: error });
    }
    console.error('qualification bootstrap phase=rollback');
    throw error;
  }
  console.error('qualification bootstrap phase=commit');
}

async function main() {
  const database = process.env.QUALIFICATION_DB_NAME ?? 'db_ops_ai_qualification';
  const password = process.env.QUALIFICATION_ADMIN_PASSWORD;
  if (!database.startsWith('db_ops_ai_qualification') || !password) {
    throw new Error('qualification bootstrap requires QUALIFICATION_DB_NAME and QUALIFICATION_ADMIN_PASSWORD');
  }
  // Test-only seam. Qualification runs must leave this unset.
  const failAfterStep = process.env.QUALIFICATION_BOOTSTRAP_FAIL_AFTER || undefined;
  assertInjectableStep(failAfterStep);
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database,
  });
  try {
    await prepareQualificationAdmin(db, { password, failAfterStep });
    console.log('qualification admin prepared');
  } finally {
    await db.end();
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
