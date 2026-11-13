/** #300: explicit disposable MySQL acceptance; never loads private credentials.
 * MAX487_TEST_MYSQL_URL=<admin URL> pnpm --filter slide-api exec tsx tests/provider-alert-contract.mysql.ts
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import { MigrationRunner, loadMigrations, splitSqlStatements, statementsForExecution } from '../src/migrations/runner.js';
import { dbConnection } from '../src/db-connection.js';
import { llmDatabaseService } from '../src/llm-database-service.js';
import { alertDatabaseService } from '../src/alert-database-service.js';

assert(process.env.MAX487_TEST_MYSQL_URL, 'MAX487_TEST_MYSQL_URL required');
const url = new URL(process.env.MAX487_TEST_MYSQL_URL);
assert.equal(url.port, '3308', 'authorized test endpoint only');
const schema = `max487_${randomBytes(6).toString('hex')}`;
const admin = mysql.createPool(url.toString());
url.pathname = `/${schema}`;
const pool = mysql.createPool(url.toString());
const directory = await mkdtemp(join(tmpdir(), 'slide-max487-'));
const migrations = await loadMigrations();
const repair = migrations.find(m => m.id === '158_restore_provider_alert_contracts.sql')!;
let child: ReturnType<typeof spawn> | undefined;
let exited: Promise<unknown> | undefined;
let serverLogs = '';
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = (server.address() as any).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return value;
}
async function names() {
  const [rows] = await pool.query<any[]>("SELECT name, display_name FROM llm_providers WHERE name LIKE 'max487_%' ORDER BY name");
  return rows;
}
async function applyRepair() {
  const c = await pool.getConnection();
  try { for (const sql of statementsForExecution(repair)) await c.query(sql); }
  catch (error) { c.destroy(); throw error; }
  c.release();
}
try {
  await admin.query(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  console.log(JSON.stringify({ schema, endpoint: `${url.hostname}:${url.port}`, version: (await admin.query<any[]>('SELECT VERSION() version'))[0][0].version }));
  const emptySchema = `${schema}_empty`;
  await admin.query(`CREATE DATABASE ${emptySchema}`);
  const emptyUrl = new URL(url); emptyUrl.pathname = `/${emptySchema}`;
  const emptyPool = mysql.createPool(emptyUrl.toString());
  try {
    await new MigrationRunner(emptyPool).run(); await new MigrationRunner(emptyPool).run();
    const [c] = await emptyPool.query<any[]>("SHOW COLUMNS FROM llm_providers LIKE 'display_name'");
    assert.equal(c[0].Type, 'varchar(100)');
    console.log('PASS empty database full migration chain and ledger rerun');
  } finally { await emptyPool.end(); await admin.query(`DROP DATABASE ${emptySchema}`); }
  // Pre-058 ledger, actual baseline and incremental migration chain.
  const source = new URL('../sql/migrations/', import.meta.url);
  for (const file of await readdir(source)) if (/^\d+_.+\.sql$/.test(file) && file < '058_') await copyFile(new URL(file, source), join(directory, file));
  // Current global invariants require post-057 columns/comments. The historical
  // fixture must fail that final check, while every included migration completes.
  await assert.rejects(new MigrationRunner(pool, directory).run(), /Schema invariant failed/);
  const [incomplete] = await pool.query<any[]>("SELECT migration_id FROM app_schema_migrations WHERE status NOT IN ('completed','baselined')");
  assert.equal(incomplete.length, 0);
  const expected = [51, 75, 100].map((n, i) => ({ name: `max487_${i}`, display_name: '名'.repeat(n) }));
  for (const item of expected) await pool.execute('INSERT INTO llm_providers(name,display_name) VALUES (?,?)', [item.name, item.display_name]);
  const original058 = migrations.find(m => m.id === '058_complete_schema_comments.sql')!;
  const originalProviderAlter = splitSqlStatements(original058.sql).find(sql => sql.includes('ALTER TABLE `llm_providers`'))!;
  await assert.rejects(pool.query(originalProviderAlter), /Data too long/);
  assert.deepEqual(await names(), expected);
  console.log('REPRODUCED original 058 fails with Data too long on existing 51–100 character names; original rows retained');
  for (const file of await readdir(source)) if (/^\d+_.+\.sql$/.test(file) && file < '158_') await copyFile(new URL(file, source), join(directory, file));
  await new MigrationRunner(pool, directory).run();
  assert.deepEqual(await names(), expected);
  console.log('PASS pre-058 -> 157 preserves 51/75/100 characters; immutable 058 expansion remains TEXT');
  const [insert] = await pool.execute<any>("INSERT INTO alert_rules(name,metric_name,operator,threshold,severity,threshold_type,silence_minutes) VALUES ('max487','fixture','>',90,'warning',NULL,NULL)");
  const ruleId = insert.insertId;
  // Invalid legacy values fail before defaults/data/DDL; unknown values are retained.
  await pool.execute("UPDATE alert_rules SET threshold_type='invalid', silence_minutes=-1 WHERE id=?", [ruleId]);
  await assert.rejects(applyRepair(), /Check constraint/);
  const [bad] = await pool.query<any[]>('SELECT threshold_type,silence_minutes FROM alert_rules WHERE id=?', [ruleId]);
  assert.deepEqual(bad[0], { threshold_type: 'invalid', silence_minutes: -1 });
  console.log('PASS invalid legacy values rejected without data rewrite');
  await pool.execute('UPDATE alert_rules SET threshold_type=NULL,silence_minutes=NULL WHERE id=?', [ruleId]);
  await applyRepair();
  assert.deepEqual(await names(), expected);
  console.log('PASS forward repair preserves every existing 51/75/100 character display name');
  // Simulate a deployment on which original 058 has already narrowed the column.
  await pool.execute('UPDATE llm_providers SET display_name=name WHERE name LIKE ?', ['max487_%']);
  await pool.query("ALTER TABLE llm_providers MODIFY display_name VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '显示名称'");
  const runner = new MigrationRunner(pool); await runner.run(); await runner.run(); await applyRepair();
  const [columns] = await pool.query<any[]>(`SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,COLLATION_NAME,COLUMN_COMMENT
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND
    ((TABLE_NAME='llm_providers' AND COLUMN_NAME IN ('display_name','api_key_encrypted')) OR
     (TABLE_NAME='alert_rules' AND COLUMN_NAME IN ('threshold_type','silence_minutes'))) ORDER BY TABLE_NAME,COLUMN_NAME`);
  assert.equal(columns.find(c => c.COLUMN_NAME === 'display_name').COLUMN_TYPE, 'varchar(100)');
  assert.equal(columns.find(c => c.COLUMN_NAME === 'api_key_encrypted').COLUMN_TYPE, 'text');
  assert.equal(columns.find(c => c.COLUMN_NAME === 'threshold_type').COLUMN_TYPE, "enum('static','dynamic')");
  for (const c of columns.filter(c => c.COLUMN_NAME !== 'api_key_encrypted')) assert.equal(c.IS_NULLABLE, 'NO');
  console.log(JSON.stringify({ schemaAudit: columns }));
  assert.deepEqual((await pool.query<any[]>('SELECT threshold_type,silence_minutes FROM alert_rules WHERE id=?', [ruleId]))[0][0], { threshold_type: 'static', silence_minutes: 5 });
  await assert.rejects(pool.query('UPDATE alert_rules SET threshold_type=NULL WHERE id=?', [ruleId]));
  await assert.rejects(pool.query("UPDATE alert_rules SET threshold_type='unknown' WHERE id=?", [ruleId]));
  await assert.rejects(pool.query('UPDATE alert_rules SET silence_minutes=NULL WHERE id=?', [ruleId]));
  await assert.rejects(pool.query('UPDATE alert_rules SET silence_minutes=-1 WHERE id=?', [ruleId]));
  console.log('PASS original-058 deployment repair, NULL defaults, final schema, SQL invalid rejection and repeat execution');
  await dbConnection.initialize({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: schema });
  for (const displayName of ['名'.repeat(51), '名'.repeat(100), '😀'.repeat(100), '']) {
    assert((await llmDatabaseService.configureProvider({ name: 'max487_save', displayName })).success);
    assert.equal((await llmDatabaseService.getProviderByName('max487_save'))!.display_name, displayName);
  }
  assert.equal((await llmDatabaseService.configureProvider({ name: 'max487_save', displayName: '名'.repeat(101) })).success, false);
  assert.equal((await llmDatabaseService.getProviderByName('max487_save'))!.display_name, '');
  assert((await alertDatabaseService.updateAlertRule(ruleId, { threshold_type: 'dynamic', silence_minutes: 0 })).success);
  console.log('PASS real production services insert/update/read including 100 astral Unicode characters, empty string and zero silence');
  await pool.execute('UPDATE llm_providers SET enabled=FALSE,is_default=FALSE');
  const password = randomBytes(24).toString('hex');
  const [actor] = await pool.execute<any>('INSERT INTO users(username,password_hash,status) VALUES(?,?,?)', ['max487_actor', await bcrypt.hash(password, 10), 'active']);
  await pool.execute("INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE name='admin'", [actor.insertId]);
  const httpPort = await port(); const wsPort = await port();
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: process.cwd(), stdio: ['ignore','pipe','pipe'], env: {
    ...process.env, NODE_ENV: 'test', DB_HOST: url.hostname, DB_PORT: url.port, DB_USER: decodeURIComponent(url.username),
    DB_PASSWORD: decodeURIComponent(url.password), DB_NAME: schema, JWT_SECRET_KEY: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('hex'), PORT: String(httpPort), AGENT_WS_PORT: String(wsPort), PROMPT_HOT_RELOAD: 'false',
  } });
  exited = once(child, 'exit');
  child.stdout!.on('data', c => { serverLogs += c; }); child.stderr!.on('data', c => { serverLogs += c; });
  console.log(JSON.stringify({ ownedServer: { pid: child.pid, httpPort, wsPort, cwd: process.cwd(), command: 'node --import tsx server.ts', logs: 'captured in memory; credentials excluded from evidence' } }));
  const base = `http://127.0.0.1:${httpPort}`;
  let ready = false;
  for (let i = 0; i < 600; i++) {
    assert(child.exitCode === null && child.signalCode === null, 'server exited before readiness');
    try { ready = (await fetch(`${base}/api/health/ready`)).ok; } catch {}
    if (ready) break; await new Promise(r => setTimeout(r, 100));
  }
  assert(ready, 'server readiness timeout');
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ username: 'max487_actor', password }) });
  assert.equal(login.status, 200); const token = (await login.json() as any).token;
  assert(token, 'login token');
  const request = async (path: string, method: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: {'content-type':'application/json', authorization: `Bearer ${token}`}, ...(body ? {body: JSON.stringify(body)} : {}) });
    return { status: response.status, body: await response.json() as any };
  };
  let id: number | undefined;
  for (const displayName of ['名'.repeat(51), '名'.repeat(100), '😀'.repeat(100)]) {
    const result = await request(id ? `/api/llm/configs/${id}` : '/api/llm/configs', id ? 'PUT' : 'POST', { name: 'max487_http', displayName, enabled: false });
    assert.equal(result.body.success, true, JSON.stringify(result)); id = result.body.providerId;
    assert.equal((await request(`/api/llm/configs/${id}`, 'GET')).body.display_name, displayName);
    assert.equal((await pool.query<any[]>('SELECT display_name FROM llm_providers WHERE id=?',[id]))[0][0].display_name, displayName);
  }
  for (const displayName of ['名'.repeat(101), null, 123]) {
    assert.equal((await request(`/api/llm/configs/${id}`, 'PUT', {displayName})).body.success, false);
    assert.equal((await request('/api/llm/configs', 'POST', {name:'max487_bad',displayName})).body.success, false);
  }
  for (const patch of [{ threshold_type: null },{ threshold_type: 'bad' },{ silence_minutes: null },{ silence_minutes: -1 },{ silence_minutes: 1.5 }]) {
    assert.equal((await request(`/api/alert-rules/${ruleId}`, 'PUT', patch)).status, 400);
  }
  assert.equal((await request(`/api/alert-rules/${ruleId}`, 'PUT', {threshold_type:'static',silence_minutes:0})).status, 200);
  console.log('PASS actual server.ts login/JWT -> POST/PUT/GET -> MySQL; 51/100 names preserved, invalid names rejected; alert null/invalid rejected and zero accepted; no model calls');
} finally {
  if (child && exited) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => { if (child!.exitCode === null && child!.signalCode === null) child!.kill('SIGKILL'); }, 15000);
    await exited; clearTimeout(timer);
  }
  await dbConnection.close(); await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${schema}`);
  assert.equal((await admin.query<any[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [schema]))[0].length, 0);
  await admin.end(); await rm(directory, {recursive:true,force:true});
  console.log('CLEANUP PASS: owned server stopped, handles closed, disposable schema and migration directory removed; shared containers unchanged');
}
