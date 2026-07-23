import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';
import { assertSchemaInvariants } from '../../apps/db-ops-api/src/migrations/invariants.js';

const migrationsDir = resolve(import.meta.dirname, '../../apps/db-ops-api/sql/migrations');
const expected = (await readdir(migrationsDir)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
const connection = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

try {
  const pool = {
    query: (sql: string, values?: unknown[]) => connection.query(sql, values as any) as any,
  };
  await assertSchemaInvariants(pool);
  const [rows] = await connection.query<Array<{ migration_id: string; status: string }>>(
    'SELECT migration_id, status FROM app_schema_migrations ORDER BY migration_id',
  );
  const found = new Map(rows.map((row) => [row.migration_id, row.status]));
  const missing = expected.filter((migration) => !found.has(migration));
  const incomplete = rows.filter((row) => !['completed', 'baselined'].includes(row.status));
  if (missing.length || incomplete.length || rows.length !== expected.length) {
    throw new Error(`migration ledger invariant failed: expected=${expected.length} actual=${rows.length} missing=${missing.join(',') || '-'} incomplete=${incomplete.map((row) => row.migration_id).join(',') || '-'}`);
  }
  console.log(`bootstrap invariant valid: ${rows.length} migrations, schema invariant valid`);
} finally {
  await connection.end();
}
