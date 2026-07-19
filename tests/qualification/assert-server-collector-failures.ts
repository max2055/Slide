import { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';
import { ServerCollector } from '../../apps/db-ops-api/src/server-collector.js';

process.env.ENCRYPTION_KEY ??= 'qualification-encryption-key-2026-07-19-not-production';
if (!await dbConnection.initialize()) throw new Error('qualification database connection failed');
const pool = dbConnection.getPool();
if (!pool) throw new Error('qualification database pool unavailable');
const suffix = `${Date.now()}-${process.pid}`;

try {
  const [result] = await pool.execute(
    `INSERT INTO servers (host, port, label, os_type, credential_type, credential_encrypted, status, collection_enabled)
     VALUES (?, 22, ?, 'linux', 'password', 'invalid-qualification-ciphertext', 'offline', 1)`,
    [`qualification-collector-${suffix}.invalid`, `Qualification collector ${suffix}`],
  ) as any;
  const id = Number(result.insertId);
  const collector = new ServerCollector({ collectionIntervalMs: 60_000, maxFailuresBeforeUnreachable: 3 });
  for (let i = 0; i < 3; i += 1) await (collector as any)._tick();
  const [rows] = await pool.execute<Array<{ status: string }>>('SELECT status FROM servers WHERE id = ?', [id]);
  if (rows[0]?.status !== 'unreachable') throw new Error(`collector did not mark three failures unreachable: ${rows[0]?.status}`);
  console.log(`server collector failure invariant valid: server=${id} failures=3 status=${rows[0].status}`);
} finally {
  await dbConnection.close();
}
