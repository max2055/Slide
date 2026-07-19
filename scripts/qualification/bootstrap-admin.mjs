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
  await db.execute(
    `CREATE TABLE IF NOT EXISTS qualification_approval_counter (
      id INT NOT NULL PRIMARY KEY,
      value INT NOT NULL
    ) ENGINE=InnoDB`,
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
