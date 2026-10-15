/** MAX-176 disposable real API environment. Never points the server at a shared database. */
import { parse } from 'dotenv';
import { readFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';

const root = resolve(import.meta.dirname, '../../..');
const supplied = process.env.MAX176_ENV_FILE ? parse(readFileSync(process.env.MAX176_ENV_FILE)) : process.env;
const database = `slide_ui_max176_${process.pid}`;
const connection = { host: supplied.DB_HOST || '127.0.0.1', port: Number(supplied.DB_PORT || 3306), user: supplied.DB_USER || 'root', password: supplied.DB_PASSWORD || '' };
const env = { ...process.env, DB_HOST: connection.host, DB_PORT: String(connection.port), DB_USER: connection.user, DB_PASSWORD: connection.password, DB_NAME: database,
  NODE_ENV: 'development', PORT: '3176', AGENT_WS_PORT: '29776', AGENT_WORKSPACE: resolve(root, '.runtime/max176/agent'),
  JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  METRICS_V2_COLLECTION_ENABLED: 'false', SLIDE_MEMORY_PIPELINE_ENABLED: 'false', PROMPT_HOT_RELOAD: 'false', AGENT_SKILL_DIRS: '', AGENT_SKILL_DIGESTS: '{}' };
mkdirSync(resolve(root, '.runtime/max176'), { recursive: true });
const log = openSync(resolve(root, '.runtime/max176/backend.log'), 'w');
const cwd = resolve(root, 'apps/db-ops-api');
let server;
let init;
let allocated = false;
const control = await mysql.createConnection(connection);
async function cleanup() {
  for (const child of [server, init]) if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  // Only the database allocated by this invocation can be removed.
  if (!/^slide_ui_max176_\d+$/.test(database)) throw new Error('Unsafe cleanup');
  if (allocated) {
    await control.query(`DROP DATABASE IF EXISTS \`${database}\``);
    const [remaining] = await control.execute('SELECT COUNT(*) AS count FROM information_schema.schemata WHERE schema_name=?', [database]);
    if (remaining[0].count !== 0) throw new Error('Disposable database cleanup failed');
    console.log(`MAX-176 cleanup verified: DB=${database} absent; child processes exited.`);
  }
  await control.end(); closeSync(log);
}
let stopping = false;
async function stop(code = 0) { if (stopping) return; stopping = true; await cleanup(); process.exit(code); }
process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
try {
  await control.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  allocated = true;
  init = spawn(process.execPath, ['--import', 'tsx', 'init-db.ts'], { cwd, env, stdio: ['ignore', log, log] });
  await new Promise((resolve, reject) => { init.once('error', reject); init.once('exit', code => code === 0 ? resolve() : reject(new Error(`Database init failed: ${code}; see .runtime/max176/backend.log`))); });
  await control.query(`USE \`${database}\``);
  const [identity] = await control.query('SELECT DATABASE() AS db');
  if (identity[0].db !== database || !/^slide_ui_max176_\d+$/.test(database)) throw new Error('Unexpected fixture database');
  const [disabled] = await control.query("UPDATE llm_providers SET enabled=0 WHERE api_key_encrypted IS NULL OR api_key_encrypted=''");
  console.log(`Verified disposable DB=${database}; disabled ${disabled.affectedRows} keyless migration seed Providers only.`);
  // Public disposable test fixture password; never a real account credential.
  const hash = await bcrypt.hash(process.env.MAX176_TEST_PASSWORD || 'max176-isolated-test-only', 10);
  await control.execute("UPDATE users SET password_hash=?, status='active' WHERE username='admin'", [hash]);
  const [users] = await control.query("SELECT id FROM users WHERE username='admin'");
  const userId = users[0].id;
  for (let i = 0; i < 14; i++) {
    const key = `max176-${String(i).padStart(4, '0')}-session`;
    await control.execute('INSERT INTO chat_sessions (session_id,user_id,title,message_count,last_message_at,metadata) VALUES (?,?,?,?,NOW(),?)', [key, userId, i === 0 ? '数据库健康核查 · 长内容验收' : `资源巡检对话 ${i}`, i === 0 ? 105 : 1, JSON.stringify({ status: i % 2 ? 'completed' : 'active' })]);
    for (let j = 0; j < (i === 0 ? 105 : 1); j++) await control.execute('INSERT INTO chat_messages (session_id,message_id,role,content,created_at) VALUES (?,?,?,?,DATE_ADD("2026-10-15 08:00:00", INTERVAL ? SECOND))', [key, `${key}-${j}`, j % 2 ? 'assistant' : 'user', j === 104 ? '<think>核对资源证据与缺口</think>完整答复：' + '长内容可追溯，无需发起模型调用。'.repeat(200) : `真实存储验收消息 ${j}`, j]);
  }
  server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd, env, stdio: ['ignore', log, log] });
  server.once('exit', code => { if (!stopping) { console.error(`MAX-176 API exited ${code}; see .runtime/max176/backend.log`); void stop(1); } });
  console.log(`MAX-176 isolated API PID=${server.pid} DB=${database} PORT=3176 WS=29776; only disposable keyless seed Providers disabled; no shared changes.`);
} catch (error) { if (!stopping) { console.error(error.message); await cleanup(); process.exit(1); } }
