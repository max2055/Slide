import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { SqlExecutionIntentStore } from '../src/audit/sql-execution-intent.js';

// Privileged local operator tool. Uses control DB credentials; never opens target connections.
const [action, operationId, outcome, operator, evidenceFile, fence] = process.argv.slice(2);
if (!operationId || !['inspect', 'reconcile'].includes(action) ||
    (action === 'reconcile' && (!['applied', 'not-applied'].includes(outcome) || !operator || !evidenceFile || fence !== '--executor-fenced'))) {
  throw new Error('Usage: tsx scripts/sql-intent-recovery.ts inspect <operation> | reconcile <operation> <applied|not-applied> <operator> <evidence-file> --executor-fenced');
}
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'db_ops_ai', timezone: 'Z',
});
try {
  const store = new SqlExecutionIntentStore(() => pool);
  if (action === 'reconcile') {
    await store.reconcile(operationId, outcome === 'applied', operator, await readFile(evidenceFile, 'utf8'));
  }
  const intent = await store.inspect(operationId);
  if (!intent) throw new Error('SQL_INTENT_NOT_FOUND');
  process.stdout.write(JSON.stringify(intent, null, 2) + '\n');
} finally {
  await pool.end();
}
