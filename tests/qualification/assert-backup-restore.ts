import { randomUUID } from 'node:crypto';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';
import { assertSchemaInvariants } from '../../apps/db-ops-api/src/migrations/invariants.js';

const mode = process.argv[2];
if (mode !== 'seed' && mode !== 'verify') throw new Error('usage: assert-backup-restore.ts {seed|verify}');
const connection = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  timezone: 'Z',
});
const marker = 'qualification-backup-fixture';

try {
  if (mode === 'seed') {
    await connection.execute("INSERT INTO users (username, password_hash, status) VALUES (?, ?, 'active')", [`${marker}-user`, 'not-a-production-password']);
    const [userRows] = await connection.query<Array<{ id: number }>>('SELECT id FROM users WHERE username = ?', [`${marker}-user`]);
    const userId = userRows[0].id;
    await connection.execute(
      "INSERT INTO database_instances (name, environment, db_type, host, port, username, password_encrypted, status) VALUES (?, 'testing', 'mysql', '127.0.0.1', 3306, 'qualification', 'ciphertext-fixture', 'active')",
      [`${marker}-instance`],
    );
    const [instanceRows] = await connection.query<Array<{ id: number }>>('SELECT id FROM database_instances WHERE name = ?', [`${marker}-instance`]);
    await connection.execute(
      "INSERT INTO alert_events (event_id, title, status, severity, instance_id) VALUES (?, ?, 'resolved', 'warning', ?)",
      [`${marker}-event`, 'qualification recovery event', instanceRows[0].id],
    );
    const operationId = randomUUID();
    await connection.execute(
      "INSERT INTO operations (id, actor_id, origin, resource_type, resource_id, command_type, risk, idempotency_key, correlation_id, state) VALUES (?, ?, 'qualification', 'instance', ?, 'read', 'low', ?, ?, 'queued')",
      [operationId, userId, String(instanceRows[0].id), `${marker}-operation`, randomUUID()],
    );
    await connection.execute(
      "INSERT INTO workflow_jobs (id, job_type, schema_version, payload, idempotency_key) VALUES (?, 'report.generate', 1, JSON_OBJECT('fixture', ?), ?)",
      [randomUUID(), marker, `${marker}-workflow`],
    );
    console.log('backup fixture seeded');
  } else {
    await assertSchemaInvariants({ query: (sql: string, values?: unknown[]) => connection.query(sql, values as any) as any });
    const checks: Array<[string, string, unknown[]]> = [
      ['user', 'SELECT COUNT(*) AS count FROM users WHERE username = ?', [`${marker}-user`]],
      ['instance', 'SELECT COUNT(*) AS count FROM database_instances WHERE name = ?', [`${marker}-instance`]],
      ['event', 'SELECT COUNT(*) AS count FROM alert_events WHERE event_id = ?', [`${marker}-event`]],
      ['operation', 'SELECT COUNT(*) AS count FROM operations WHERE idempotency_key = ?', [`${marker}-operation`]],
      ['workflow', 'SELECT COUNT(*) AS count FROM workflow_jobs WHERE idempotency_key = ?', [`${marker}-workflow`]],
      ['ledger', 'SELECT COUNT(*) AS count FROM app_schema_migrations', []],
    ];
    for (const [name, sql, values] of checks) {
      const [rows] = await connection.query<Array<{ count: number }>>(sql, values);
      if (Number(rows[0]?.count) < 1) throw new Error(`backup restore missing ${name}`);
    }
    console.log('backup restore invariant valid: schema, ledger, user, instance, event, operation, workflow');
  }
} finally {
  await connection.end();
}
