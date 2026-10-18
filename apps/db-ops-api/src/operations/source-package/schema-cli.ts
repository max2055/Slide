/** Explicit, local-only schema provisioning; never uses dbConnection/.env defaults. */
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { MigrationRunner } from '../../migrations/runner.js';
import { sourceFailure } from './config.js';

async function main() {
  const [mode, schema] = process.argv.slice(2);
  if (process.argv.length !== 4 || !['init', 'verify'].includes(mode)
    || !/^slide_v23_source_[a-f0-9]{8,32}(_restore)?$/.test(schema)
    || mode === 'init' && schema.endsWith('_restore')
    || process.env.DB_HOST !== '127.0.0.1' || !/^\d+$/.test(process.env.DB_PORT ?? '')
    || Number(process.env.DB_PORT) < 1024 || [3306,3307,3308].includes(Number(process.env.DB_PORT))) sourceFailure('LOCAL_SCHEMA_REQUIRED');
  const options = { host: '127.0.0.1', port: Number(process.env.DB_PORT), user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, timezone: 'Z' };
  if (!options.user) sourceFailure('EXPLICIT_DATABASE_USER_REQUIRED');
  const root = mysql.createPool(options);
  let pool: mysql.Pool | undefined;
  try {
    if (mode === 'init') await root.query(`CREATE DATABASE \`${schema}\` DEFAULT CHARACTER SET utf8mb4`);
    pool = mysql.createPool({ ...options, database: schema });
    pool.on('connection', c => c.query("SET time_zone='+00:00'"));
    const runner = new MigrationRunner(pool);
    await runner.run(); await runner.run();
    const [ledger] = await pool.query<RowDataPacket[]>('SELECT migration_id,checksum,status FROM app_schema_migrations ORDER BY migration_id');
    if (ledger.some(r => !['completed', 'baselined'].includes(r.status))) sourceFailure('MIGRATION_INCOMPLETE');
    const [work] = await pool.query<RowDataPacket[]>("SELECT id FROM workflow_jobs WHERE state NOT IN ('completed','cancelled') LIMIT 1");
    const [approvals] = await pool.query<RowDataPacket[]>('SELECT id FROM agent_tool_approvals LIMIT 1');
    const [executions] = await pool.query<RowDataPacket[]>('SELECT id FROM action_executions LIMIT 1');
    if (work.length || approvals.length || executions.length) sourceFailure('SCHEMA_NOT_QUIESCENT');
    const directory = join('/Users/max/Coding/40-Slide/outputs/2026-10-18-v23-source', schema);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(join(directory, `${mode}-ledger.json`), 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ schema, mode, at: new Date().toISOString(), ledger }, null, 2)); await file.sync(); }
    finally { await file.close(); }
    console.info(JSON.stringify({ schema, mode, migrations: ledger.length, activeJobs: 0, approvals: 0, executions: 0 }));
  } finally { await pool?.end(); await root.end(); }
}
main().catch(() => { console.error('V23_SOURCE_SCHEMA_FAILED_CLOSED; preserve schema and inspect before retry'); process.exitCode = 1; });
