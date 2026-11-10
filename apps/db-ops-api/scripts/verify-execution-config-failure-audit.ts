/** MAX-348 / #562: real Fastify/JWT/MySQL failure rehearsal; disposable schema only.
 * pnpm --filter slide-api exec tsx scripts/verify-execution-config-failure-audit.ts
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import mysql from 'mysql2';
import { splitSqlStatements } from '../src/migrations/runner.js';
import { ActorContextService, applyActorSecuritySchema, signAccessToken } from '../src/auth/actor-context.js';
import { createVerifyToken } from '../src/auth-middleware.js';
import { dbConnection } from '../src/db-connection.js';
import { auditLogManager, DatabaseAuditLogStore } from '../src/audit/audit-log.js';
import { registerAgentSecurityRoutes } from '../src/security/agent-security-routes.js';

const container = process.env.MYSQL_TEST_CONTAINER ?? 'slide-local-mysql-1';
const database = `audit_562_${process.pid}_${Date.now()}`;
// Socket transport via docker exec: no published port or credential disclosure.
function executor(useDatabase: boolean): any {
  const query = async (statement: string, values?: any[]) => {
    const output = execFileSync('docker', ['exec', '-i', container, 'sh', '-c',
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --batch --raw'], {
      input: `${useDatabase ? `USE ${database};` : ''}\n${mysql.format(statement, values)};`,
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!output) return [[]];
    const [header, ...lines] = output.split('\n');
    const keys = header.split('\t');
    return [lines.map(line => Object.fromEntries(line.split('\t').map((value, index) => [keys[index],
      value === 'NULL' ? null : /^-?\d+$/.test(value) ? Number(value) : value])))];
  };
  return { query, execute: query, getConnection: async () => ({ execute: query, release() {} }), end: async () => {} };
}
const admin = executor(false);
let pool: any;
let created = false;
const app = Fastify();
const originalGetPool = dbConnection.getPool;
try {
  await admin.query(`CREATE DATABASE ${database}`);
  created = true;
  pool = executor(true);
  console.log('Environment:', (await pool.query('SELECT VERSION() AS version, @@transaction_isolation AS isolation_level'))[0]);
  const tables = new Set(['users', 'database_instances', 'chat_sessions', 'roles', 'permissions', 'role_permissions', 'user_roles', 'instance_permissions']);
  const baseline = readFileSync(new URL('../sql/migrations/000_schema_baseline.sql', import.meta.url), 'utf8');
  for (const sql of splitSqlStatements(baseline)) {
    if (tables.has(sql.match(/CREATE TABLE IF NOT EXISTS `([^`]+)`/i)?.[1] ?? '')) await pool.query(sql);
  }
  for (const sql of splitSqlStatements(readFileSync(new URL('../sql/migrations/005_add_refresh_tokens_and_grant_expiry.sql', import.meta.url), 'utf8'))) await pool.query(sql);
  await applyActorSecuritySchema(pool);
  const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
  for (const table of ['system_config', 'audit_log_entries']) {
    await pool.query(schema.match(new RegExp('CREATE TABLE IF NOT EXISTS `' + table + '` \\([\\s\\S]*?;'))![0]);
  }
  await pool.query("INSERT INTO users (id, username, password_hash) VALUES (7, 'audit-admin', 'not-a-login-hash')");
  await pool.query("INSERT INTO roles (id, name) VALUES (1, 'admin')");
  await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES (7, 1)');
  const contexts = new ActorContextService(() => pool as any);
  const secret = randomUUID();
  const token = signAccessToken(await contexts.loadActiveActor(7, 1), secret);
  // Wire production singleton services to this disposable real database.
  dbConnection.getPool = () => pool as any;
  auditLogManager.setPersistentStore(new DatabaseAuditLogStore(pool as any));
  await registerAgentSecurityRoutes(app, createVerifyToken(secret, contexts));
  const put = (payload: object, authorization = `Bearer ${token}`) => app.inject({ method: 'PUT', url: '/api/agent/security/config', headers: { authorization }, payload });
  assert.equal((await put({ approvalEnabled: false }, 'Bearer invalid')).statusCode, 401);
  for (const payload of [{ approvalEnabled: false }, { restrictedNetworkEnabled: false }, { approvalEnabled: false, restrictedNetworkEnabled: false }]) {
    await pool.query('DELETE FROM system_config');
    await pool.query("INSERT INTO system_config (config_key, config_value, value_type) VALUES ('agent_tool_approval_enabled', 'true', 'boolean'), ('agent_sandbox_network_enabled', 'true', 'boolean')");
    await pool.query('DELETE FROM audit_log_entries');
    await pool.query("ALTER TABLE system_config ADD CONSTRAINT reject_false CHECK (config_value <> 'false')");
    const response = await put(payload);
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { reasonCode: 'EXECUTION_CONFIG_UPDATE_FAILED' });
    const [rows] = await pool.query('SELECT * FROM audit_log_entries ORDER BY resource_id');
    assert.equal(rows.length, Object.keys(payload).length);
    for (const row of rows) {
      assert.equal(String(row.user_id), '7'); assert.equal(row.username, 'audit-admin');
      assert.equal(row.result, 'failure'); assert.equal(row.error_message, 'EXECUTION_CONFIG_UPDATE_FAILED');
      assert.deepEqual(typeof row.details_json === 'string' ? JSON.parse(row.details_json) : row.details_json, { oldValue: true, newValue: false });
    }
    assert.deepEqual(rows.map(row => row.resource_id).sort(), Object.keys(payload).map(key => key === 'approvalEnabled' ? 'agent_tool_approval_enabled' : 'agent_sandbox_network_enabled').sort());
    assert.equal((await pool.query("SELECT COUNT(*) n FROM system_config WHERE config_value = 'true'"))[0][0].n, 2);
    console.log('PASS real SQL rejection, unchanged config and failure audit:', JSON.stringify(payload), rows.length);
    await pool.query('ALTER TABLE system_config DROP CHECK reject_false');
  }
  await pool.query("ALTER TABLE system_config ADD CONSTRAINT reject_false CHECK (config_value <> 'false')");
  await pool.query('DROP TABLE audit_log_entries');
  const response = await put({ approvalEnabled: false, restrictedNetworkEnabled: false });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { reasonCode: 'EXECUTION_CONFIG_UPDATE_FAILED' });
  console.log('PASS real audit-table failure preserves safe 500 response; invalid JWT denied');
} finally {
  dbConnection.getPool = originalGetPool;
  await app.close(); await pool?.end();
  if (created) await admin.query(`DROP DATABASE IF EXISTS ${database}`);
  if (created) assert.equal((await admin.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database]))[0].length, 0);
  await admin.end();
  console.log('Disposable schema cleanup verified; no business configuration changed');
}
