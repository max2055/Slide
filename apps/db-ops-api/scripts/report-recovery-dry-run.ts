import mysql from 'mysql2/promise';
import { reportRecoveryInventory } from '../src/workflows/report-recovery-inventory.js';

// Deliberately no .env auto-load and no write/apply mode. Supply the approved
// target explicitly; the exported manifest contains IDs/status, never content.
if (!process.env.DB_NAME || !process.env.DB_HOST || !process.env.DB_USER) throw new Error('EXPLICIT_REPORT_INVENTORY_TARGET_REQUIRED');
const pool = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, timezone: 'Z' });
try {
  const result = await reportRecoveryInventory(pool, Number(process.argv[2] ?? 0), Number(process.argv[3] ?? 200));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally { await pool.end(); }
