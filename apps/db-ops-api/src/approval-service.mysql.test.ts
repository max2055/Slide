import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { executeSql } = vi.hoisted(() => ({ executeSql: vi.fn() }));
vi.mock('./sql-executor', () => ({ sqlExecutor: { executeSql } }));
vi.mock('./llm-service', () => ({ llmService: {} }));
import { dbConnection } from './db-connection.js';
import { approvalService } from './approval-service.js';

// Real approval storage and target writes; the executor boundary is injected to
// simulate a lost driver response. This is not a full application/driver E2E.
const port = Number(process.env.APPROVAL_TEST_MYSQL_PORT);
describe.skipIf(!port)('SQL approval settlement: isolated MySQL', () => {
  let pool: Pool;
  let requestId: number;
  let created = false;
  const database = `sql_approval_test_${randomUUID().replaceAll('-', '')}`;
  const options = {
    host: process.env.APPROVAL_TEST_MYSQL_HOST ?? '127.0.0.1', port,
    user: process.env.APPROVAL_TEST_MYSQL_USER ?? 'root', password: process.env.APPROVAL_TEST_MYSQL_PASSWORD,
    connectionLimit: 5, multipleStatements: true,
  };
  beforeAll(async () => {
    pool = mysql.createPool(options);
    await pool.query(`CREATE DATABASE ${database}`);
    created = true;
    await pool.end();
    pool = mysql.createPool({ ...options, database });
    const schema = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
    for (const table of ['approval_requests', 'approval_events']) {
      const ddl = schema.match(new RegExp('CREATE TABLE IF NOT EXISTS `' + table + '` \\([\\s\\S]*?;'))?.[0];
      if (!ddl) throw new Error(`Missing schema for ${table}`);
      await pool.query(ddl);
    }
    await pool.query('ALTER TABLE approval_requests ADD operation_id CHAR(36) NULL');
    // Upgrade a pre-fix event enum, then verify migration is repeatable.
    await pool.query("ALTER TABLE approval_events MODIFY event_type ENUM('submitted','ai_reviewed','claimed','approved','rejected','executed','execution_failed','notified') NOT NULL");
    const migration = await readFile(new URL('../sql/migrations/151_approval_reconciliation_event.sql', import.meta.url), 'utf8');
    await pool.query(migration);
    await pool.query(migration);
    await pool.query('CREATE TABLE target_counter (n INT NOT NULL)');
    await pool.query('INSERT INTO target_counter VALUES (0)');
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (created) await pool.query(`DROP DATABASE ${database}`);
    await pool?.end();
  });
  beforeEach(async () => {
    executeSql.mockReset();
    await pool.query('DELETE FROM approval_events');
    await pool.query('DELETE FROM approval_requests');
    await pool.query('UPDATE target_counter SET n=0');
    const [result] = await pool.execute<any>(
      "INSERT INTO approval_requests (instance_id, sql_text, sql_hash) VALUES (7, 'UPDATE target_counter SET n=n+1', 'test-hash')",
    );
    requestId = result.insertId;
    executeSql.mockImplementation(async () => {
      await pool.query('UPDATE target_counter SET n=n+1');
      return { success: true, executionState: 'succeeded' };
    });
  });
  const review = (hooks = {}) => approvalService.reviewRequest(requestId, { action: 'approve', reviewed_by: 3 }, hooks);
  const state = async () => {
    const [rows] = await pool.query<any[]>('SELECT status, execution_result FROM approval_requests WHERE id=?', [requestId]);
    const [target] = await pool.query<any[]>('SELECT n FROM target_counter');
    return { ...rows[0], writes: target[0].n };
  };

  it.each(['onClaimed', 'onExecutionStarted'])('terminates %s failure without target writes', async hook => {
    expect((await review({ [hook]: async () => { throw new Error('hook failed'); } })).success).toBe(false);
    expect(await state()).toMatchObject({ status: 'execution_failed', writes: 0, execution_result: { executionState: 'not_started' } });
    expect(executeSql).not.toHaveBeenCalled();
  });

  it('terminates a confirmed pre-send driver rejection without target writes', async () => {
    executeSql.mockResolvedValue({ success: false, executionState: 'not_started', retryable: false });
    await review();
    expect(await state()).toMatchObject({ status: 'execution_failed', writes: 0 });
  });

  it('retains a real committed mutation after response loss and forbids replay', async () => {
    executeSql.mockImplementation(async () => {
      await pool.query('UPDATE target_counter SET n=n+1');
      throw new Error('lost response after commit');
    });
    await review();
    await review();
    expect(await state()).toMatchObject({ status: 'executing', writes: 1, execution_result: { executionState: 'unknown', retryable: false } });
    expect((await approvalService.getApprovalEvents(requestId)).map(e => e.event_type)).toContain('reconciliation_required');
    expect((await approvalService.getProcessedRequests(50, [7])).map(r => r.id)).toContain(requestId);
    expect(await approvalService.getProcessedRequests(50, [8])).toEqual([]);
    expect(await approvalService.getProcessedRequests(50, [])).toEqual([]);
  });

  it('executes exactly once under simultaneous real SQL compare-and-swap claims', async () => {
    const results = await Promise.all([review(), review()]);
    expect(results.filter(r => r.success)).toHaveLength(1);
    expect(await state()).toMatchObject({ status: 'executed', writes: 1 });
    expect(executeSql).toHaveBeenCalledTimes(1);
  });

  it('preserves executing and diagnostic event when terminal persistence fails', async () => {
    await pool.query("CREATE TRIGGER reject_outcome BEFORE UPDATE ON approval_requests FOR EACH ROW BEGIN IF NEW.status IN ('executed','execution_failed') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='outcome write rejected'; END IF; END");
    try {
      expect((await review()).execution_result).toMatchObject({ executionState: 'unknown', stage: 'outcome_persistence', observedResult: { success: true } });
      expect(await state()).toMatchObject({ status: 'executing', writes: 1, execution_result: { executionState: 'unknown' } });
      expect((await approvalService.getApprovalEvents(requestId)).map(e => e.event_type)).toContain('reconciliation_required');
      await review();
      expect(executeSql).toHaveBeenCalledTimes(1);
    } finally {
      await pool.query('DROP TRIGGER reject_outcome');
    }
  });
});
