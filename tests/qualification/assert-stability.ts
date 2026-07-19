import { randomUUID } from 'node:crypto';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';
import { MysqlWorkflowStore } from '../../apps/db-ops-api/src/workflows/worker-runtime.js';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 24,
  timezone: 'Z',
});

try {
  const key = `qualification-stability:${randomUUID()}`;
  const store = new MysqlWorkflowStore(() => pool as any);
  await Promise.all(Array.from({ length: 20 }, () => store.enqueue({
    id: randomUUID(), type: 'notification.deliver', schemaVersion: 1,
    payload: { alertId: 1, channelId: 1 }, idempotencyKey: key,
  })));
  const [rows] = await pool.query<Array<{ count: number }>>('SELECT COUNT(*) AS count FROM workflow_jobs WHERE idempotency_key = ?', [key]);
  if (Number(rows[0]?.count) !== 1) throw new Error(`expected one idempotent workflow job, got ${rows[0]?.count}`);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const claimed = await store.claim('33333333-3333-4333-8333-333333333333', 30);
  if (!claimed) throw new Error('stability job was not claimable');
  if (!await store.complete(claimed.id, '33333333-3333-4333-8333-333333333333', claimed.fencingToken)) throw new Error('stability job did not complete');
  console.log('stability invariant valid: concurrent idempotent enqueue produced one completed job');
} finally {
  await pool.end();
}
