import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mysql, { type Pool } from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { hashApprovedSql } from '../src/security/approval-execution-authorizer.js';

const state = vi.hoisted(() => ({ control: null as any, target: null as any, audit: vi.fn() }));
vi.mock('../src/db-connection.js', () => ({ dbConnection: { getPool: () => state.control } }));
vi.mock('../src/database-service', () => ({ databaseService: {
  ensureConnectionAlive: async () => true,
  getConnection: () => ({ db_type: 'mysql', name: 'isolated-target', pool: state.target }),
} }));
vi.mock('../src/audit/audit-log', () => ({ auditLogManager: { logSqlExecution: state.audit } }));
vi.mock('../src/security/security-event-service.js', () => ({ securityEventService: { record: async () => {} } }));
import { sqlExecutor } from '../src/sql-executor.js';
import { SqlExecutionIntentStore } from '../src/audit/sql-execution-intent.js';

// Explicit opt-in: run only against a disposable MySQL instance, never app DBs.
const enabled = process.env.SQL_INTENT_TEST_PORT;
describe.skipIf(!enabled)('isolated MySQL control / target fault injection', () => {
  let admin: Pool;
  let control: Pool;
  let target: Pool;
  const sql = 'UPDATE intent_counter SET counter_value = counter_value + 1 WHERE id = 1';
  const grant = { approvalRequestId: 1, operationId: 'operation-1', reviewerId: 2 };
  const run = () => sqlExecutor.executeSql(1, sql, { approvalGrant: grant });
  const value = async () => Number((await target.query<any[]>('SELECT counter_value FROM intent_counter'))[0][0].counter_value);
  const store = () => new SqlExecutionIntentStore(() => control);
  beforeAll(async () => {
    admin = mysql.createPool({ host: '127.0.0.1', port: Number(enabled), user: 'root', timezone: 'Z' });
    await admin.query('CREATE DATABASE IF NOT EXISTS max58_control');
    await admin.query('CREATE DATABASE IF NOT EXISTS max58_target');
    control = mysql.createPool({ host: '127.0.0.1', port: Number(enabled), user: 'root', timezone: 'Z', database: 'max58_control' });
    target = mysql.createPool({ host: '127.0.0.1', port: Number(enabled), user: 'root', timezone: 'Z', database: 'max58_target' });
    await control.query(await readFile(new URL('../sql/migrations/091_sql_execution_intents.sql', import.meta.url), 'utf8'));
    await control.query(`CREATE TABLE IF NOT EXISTS approval_requests (
      id INT PRIMARY KEY, instance_id INT, sql_hash VARCHAR(64), status VARCHAR(32),
      operation_id VARCHAR(128), reviewed_by INT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, target_database VARCHAR(255))`);
    await target.query('CREATE TABLE IF NOT EXISTS intent_counter (id INT PRIMARY KEY, counter_value INT)');
  });
  beforeEach(async () => {
    state.control = control;
    state.target = target;
    state.audit.mockReset().mockResolvedValue(undefined);
    await control.query('DELETE FROM sql_execution_intents');
    await control.query('DELETE FROM approval_requests');
    await control.execute(`INSERT INTO approval_requests (id, instance_id, sql_hash, status, operation_id, reviewed_by) VALUES (1, 1, ?, 'executing', ?, 2)`, [hashApprovedSql(sql), grant.operationId]);
    await target.query('REPLACE INTO intent_counter VALUES (1, 0)');
  });
  afterAll(async () => { await Promise.all([control?.end(), target?.end(), admin?.end()]); });
  it('persists exact intent without userId and acknowledges successful result', async () => {
    expect(await run()).toMatchObject({ success: true, executionState: 'succeeded' });
    expect(await value()).toBe(1);
    expect(await store().inspect(grant.operationId)).toMatchObject({ sql_text: sql, instance_id: 1, reviewer_id: 2, actor_id: '2', state: 'succeeded' });
  });
  it('fails closed when intent table is unavailable', async () => {
    await control.query('RENAME TABLE sql_execution_intents TO unavailable_intents');
    try {
      expect(await run()).toMatchObject({ success: false, executionState: 'not_started' });
      expect(await value()).toBe(0);
    } finally { await control.query('RENAME TABLE unavailable_intents TO sql_execution_intents'); }
  });
  it.each(['reviewer', 'sql', 'instance', 'database'])('rejects changed approval binding: %s', async (binding) => {
    const changed = { ...grant, ...(binding === 'reviewer' ? { reviewerId: 3 } : {}) };
    const result = await sqlExecutor.executeSql(binding === 'instance' ? 2 : 1,
      binding === 'sql' ? sql + ' ' : sql, { approvalGrant: changed, ...(binding === 'database' ? { database: 'max58_target' } : {}) });
    expect(result.success).toBe(false);
    expect(await value()).toBe(0);
  });
  it('concurrent repeated operations dispatch once', async () => {
    const results = await Promise.all([run(), run()]);
    expect(results.filter(r => r.success)).toHaveLength(1);
    expect(await value()).toBe(1);
  });
  it('audit failure keeps durable uncertainty after committed SQL and blocks retry', async () => {
    state.audit.mockRejectedValue(new Error('injected audit outage'));
    expect(await run()).toMatchObject({ executionState: 'unknown', retryable: false });
    expect(await value()).toBe(1);
    expect(await store().inspect(grant.operationId)).toMatchObject({ state: 'unknown', result_json: { targetAcknowledged: true } });
    await run();
    expect(await value()).toBe(1);
    // A fresh store has no process-local memory; recovery only records external evidence.
    await store().reconcile(grant.operationId, true, 'test-operator', 'executor fenced; target intent_counter verified as 1');
    expect(await store().inspect(grant.operationId)).toMatchObject({ state: 'reconciled_applied' });
    await run();
    expect(await value()).toBe(1);
  });
  it('loss of control DB after target commit leaves recoverable intent', async () => {
    state.audit.mockImplementation(async () => { state.control = null; });
    expect(await run()).toMatchObject({ executionState: 'unknown', retryable: false });
    expect(await value()).toBe(1);
    expect(await store().inspect(grant.operationId)).toMatchObject({ state: 'unknown', result_json: null });
  });
  it('process interruption after intent never replays automatically', async () => {
    await store().begin({ instanceId: 1, sql }, grant);
    expect(await value()).toBe(0);
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/sql-intent-recovery.ts', 'inspect', grant.operationId], {
      env: { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: enabled, DB_USER: 'root', DB_PASSWORD: '', DB_NAME: 'max58_control' },
    });
    expect(JSON.parse(stdout)).toMatchObject({ state: 'unknown', operation_id: grant.operationId, sql_text: sql });
    expect(await run()).toMatchObject({ success: false, retryable: false });
    await store().reconcile(grant.operationId, false, 'test-operator', 'executor fenced before dispatch; intent_counter verified as 0');
    expect(await store().inspect(grant.operationId)).toMatchObject({ state: 'reconciled_not_applied' });
    expect(await value()).toBe(0);
  });
});
