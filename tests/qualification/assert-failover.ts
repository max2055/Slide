import { randomUUID } from 'node:crypto';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';
import { WorkerLease } from '../../apps/db-ops-api/src/lifecycle/worker-lease.js';
import { MysqlWorkflowStore } from '../../apps/db-ops-api/src/workflows/worker-runtime.js';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 2,
  timezone: 'Z',
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const leaseName = `qualification-lease-${randomUUID()}`;
  const first = new WorkerLease(pool as any, leaseName, 1);
  const second = new WorkerLease(pool as any, leaseName, 1);
  if (!await first.acquire()) throw new Error('first worker did not acquire lease');
  if (await second.acquire()) throw new Error('second worker acquired a live lease');
  await delay(2_100);
  if (!await second.acquire()) throw new Error('second worker did not acquire expired lease');
  if (await first.renew()) throw new Error('expired owner renewed lease after takeover');
  if (!await second.renew()) throw new Error('new owner could not renew lease');

  const store = new MysqlWorkflowStore(() => pool as any);
  const jobId = randomUUID();
  await store.enqueue({ id: jobId, type: 'report.generate', schemaVersion: 1, payload: {}, idempotencyKey: `qualification-failover:${jobId}`, maxAttempts: 3 });
  // MySQL DATETIME has second precision; wait until this newly queued job is
  // eligible before asserting a worker claim.
  await delay(1_100);
  const oldClaim = await store.claim('11111111-1111-4111-8111-111111111111', 1);
  if (!oldClaim) {
    const [rows] = await pool.query('SELECT id, state, available_at, lease_owner, lease_expires_at, NOW() AS database_now FROM workflow_jobs WHERE id = ?', [jobId]);
    throw new Error(`first worker did not claim workflow job: ${JSON.stringify(rows)}`);
  }
  await delay(2_100);
  const newClaim = await store.claim('22222222-2222-4222-8222-222222222222', 30);
  if (!newClaim || newClaim.id !== jobId || newClaim.fencingToken <= oldClaim.fencingToken) {
    const [rows] = await pool.query('SELECT id, state, attempts, lease_owner, lease_expires_at, fencing_token, NOW() AS database_now FROM workflow_jobs WHERE id = ?', [jobId]);
    throw new Error(`new worker did not take over workflow job: ${JSON.stringify(rows)}`);
  }
  if (await store.complete(oldClaim.id, '11111111-1111-4111-8111-111111111111', oldClaim.fencingToken)) throw new Error('old worker completed after fencing takeover');
  if (!await store.complete(newClaim.id, '22222222-2222-4222-8222-222222222222', newClaim.fencingToken)) throw new Error('new worker could not complete workflow job');
  await second.release();
  console.log('failover invariant valid: lease takeover and workflow fencing enforced');
} finally {
  await pool.end();
}
