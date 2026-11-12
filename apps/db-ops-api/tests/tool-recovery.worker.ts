/** Foreground child fixture for tool-recovery.integration.ts. No credentials in IPC. */
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import { dbConnection } from '../src/db-connection.js';
import { stableArgumentsHash } from '../src/security/agent-tool-idempotency-service.js';
import { addDatabaseBatchTool } from '../src/tools/generated/slide-self-mgmt/add_database_batch.js';
import { addDatabaseTool } from '../src/tools/generated/slide-self-mgmt/add_database.js';

const mode = process.env.RECOVERY_MODE!;
if (mode === 'hash') {
  const args = { aa: 'x', z: 'y' };
  const legacy = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
  process.send!({ event: 'hash', stable: stableArgumentsHash(args), legacy });
  process.disconnect!();
} else {
  const pool = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME, connectionLimit: 4 });
  const query = pool.query.bind(pool);
  const hold = async () => {
    process.send!({ event: 'cutpoint', pid: process.pid });
    await new Promise<void>(() => {});
  };
  // These cutpoints surround real SQL and the unmodified item handler.
  pool.query = (async (sql: string, values?: unknown[]) => {
    if (sql.includes('SET state = ?') && mode === 'before-finish') await hold();
    if (sql.includes('SET state = ?') && mode === 'finish-failure') throw new Error('injected finish failure');
    const result = await query(sql, values);
    if (sql.includes('SET state = ?') && mode === 'finish-lost-ack') throw new Error('injected lost finish acknowledgement');
    if (sql.includes('JSON_SET') && mode === 'checkpoint-lost-ack' && (values?.[1] as string).includes('"completed"')) throw new Error('injected lost checkpoint acknowledgement');
    if (sql.startsWith('INSERT INTO agent_tool_idempotency') && mode === 'claim') await hold();
    if (sql.includes('JSON_SET') && mode === 'partial' && (values?.[1] as string).includes('"completed"')) await hold();
    if (sql.includes('lease_until = TIMESTAMPADD') && mode === 'live') process.send!({ event: 'heartbeat' });
    return result;
  }) as typeof pool.query;
  dbConnection.getPool = () => pool;
  const original = addDatabaseTool.handler;
  addDatabaseTool.handler = async (...args) => {
    const result = await original(...args);
    if (mode === 'uncheckpointed' || mode === 'live') await hold();
    return result;
  };
  try {
    const key = process.env.RECOVERY_KEY!;
    const args = { concurrency: 1, databases: [0, 1].map(index => ({ db_type: 'mysql', name: `${key}_${index}`, host: '10.77.0.1', port: 3308, username: 'fixture', database_name: `${key}_${index}` })) };
    const result = await addDatabaseBatchTool.handler(args, { actor: { userId: 7, isAdmin: true } as any, sessionId: 'recovery-session', idempotencyKey: key });
    process.send!({ event: 'result', result });
  } finally {
    await pool.end();
    process.disconnect!();
  }
}
