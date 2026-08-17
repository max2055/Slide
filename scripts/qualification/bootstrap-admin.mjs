import '../../apps/db-ops-api/node_modules/dotenv/config.js';
import bcrypt from '../../apps/db-ops-api/node_modules/bcrypt/bcrypt.js';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';

const database = process.env.QUALIFICATION_DB_NAME ?? 'db_ops_ai_qualification';
const password = process.env.QUALIFICATION_ADMIN_PASSWORD;
if (!database.startsWith('db_ops_ai_qualification') || !password) {
  throw new Error('qualification bootstrap requires QUALIFICATION_DB_NAME and QUALIFICATION_ADMIN_PASSWORD');
}

const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database,
});
try {
  await db.execute(
    `DELETE ip FROM instance_permissions ip
     JOIN database_instances i ON i.id = ip.instance_id
     WHERE i.name = 'qualification-query-target' AND i.environment = 'testing'`,
  );
  await db.execute("DELETE FROM database_instances WHERE name = 'qualification-query-target' AND environment = 'testing'");
  const deadLetterJobId = '00000000-0000-4000-8000-000000000139';
  await db.execute('DELETE FROM notification_delivery_replays WHERE workflow_job_id = ?', [deadLetterJobId]);
  await db.execute('DELETE FROM notification_delivery_attempts WHERE workflow_job_id = ?', [deadLetterJobId]);
  await db.execute('DELETE FROM workflow_jobs WHERE id = ?', [deadLetterJobId]);
  await db.execute(
    `INSERT INTO workflow_jobs
      (id, job_type, schema_version, payload, idempotency_key, state, attempts, max_attempts, last_error)
     VALUES (?, 'notification.deliver', 1, ?, 'qualification:dead-letter:139', 'dead_letter', 5, 5, 'qualification delivery failure')`,
    [deadLetterJobId, JSON.stringify({ alertId: 0, channelId: 0 })],
  );
  const rcaServerHost = 'qualification-server-rca.invalid';
  const rcaAlertTitle = 'Qualification server RCA browser alert';
  await db.execute('DELETE FROM ai_analysis WHERE cache_key = ?', ['qualification:server-rca-browser']);
  await db.execute('DELETE FROM alerts WHERE title = ?', [rcaAlertTitle]);
  await db.execute('DELETE FROM servers WHERE host = ? AND port = 22', [rcaServerHost]);
  const [serverInsert] = await db.execute(
    `INSERT INTO servers (host, port, label, os_type, credential_type, credential_encrypted, status, collection_enabled)
     VALUES (?, 22, 'Qualification server RCA', 'linux', 'password', 'qualification-only', 'online', 0)`,
    [rcaServerHost],
  );
  const serverId = Number(serverInsert.insertId);
  const [alertInsert] = await db.execute(
    `INSERT INTO alerts (server_id, alert_type, level, title, message, status, metric_name, metric_value, threshold_value)
     VALUES (?, 'availability', 'critical', ?, 'Qualification browser RCA fixture', 'unread', 'cpu_usage', '95', '80')`,
    [serverId, rcaAlertTitle],
  );
  const alertId = Number(alertInsert.insertId);
  await db.execute(
    `INSERT INTO ai_analysis
      (analysis_type, target_type, server_id, related_id, status, trigger_type, cache_key, result, completed_at, session_key)
     VALUES ('alert_rca', 'server', ?, ?, 'completed', 'manual', ?, ?, NOW(), 'qualification-server-rca-session')`,
    [serverId, alertId, `alert:${alertId}:server:${serverId}`, JSON.stringify({ summary: 'Qualification server RCA completed.' })],
  );
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
  await db.execute(
    'INSERT INTO qualification_approval_counter (id, value) VALUES (1, 0) ON DUPLICATE KEY UPDATE value = 0',
  );
  const hash = await bcrypt.hash(password, 12);
  const [updated] = await db.execute(
    "UPDATE users SET password_hash = ?, status = 'active' WHERE username = 'admin'",
    [hash],
  );
  if (!Number(updated.affectedRows)) throw new Error('qualification admin seed is missing');
  await db.execute(
    "INSERT IGNORE INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u JOIN roles r ON r.name = 'admin' WHERE u.username = 'admin'",
  );
  await db.execute(
    "INSERT INTO users (username, password_hash, status) VALUES ('qualification-viewer', ?, 'active') ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), status = 'active'",
    [hash],
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
  console.log('qualification admin prepared');
} finally {
  await db.end();
}
