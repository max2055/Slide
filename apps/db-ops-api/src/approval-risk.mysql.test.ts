import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./llm-service', () => ({ llmService: { chatWithTracking: vi.fn() } }));
vi.mock('./sql-executor', () => ({ sqlExecutor: { executeSql: vi.fn() } }));
import { llmService } from './llm-service.js';
import { sqlExecutor } from './sql-executor.js';
import { dbConnection } from './db-connection.js';
import { approvalService } from './approval-service.js';

// Model response substitute + real service + real MySQL; no provider requests.
// Only the two approval tables from the checked-in schema are needed here.
const port = Number(process.env.APPROVAL_TEST_MYSQL_PORT);
describe.skipIf(!port)('MAX-341 SQL approval risk persistence: isolated MySQL', () => {
  let pool: Pool;
  let created = false;
  const database = `approval_risk_${randomUUID().replaceAll('-', '')}`;
  const options = {
    host: process.env.APPROVAL_TEST_MYSQL_HOST ?? '127.0.0.1', port,
    user: process.env.APPROVAL_TEST_MYSQL_USER ?? 'root', password: process.env.APPROVAL_TEST_MYSQL_PASSWORD,
    connectionLimit: 1,
  };

  beforeAll(async () => {
    pool = mysql.createPool(options);
    await pool.query(`CREATE DATABASE ${database}`);
    created = true;
    await pool.end();
    pool = mysql.createPool({ ...options, database });
    await pool.query("SET SESSION sql_mode='STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'");
    const schema = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
    for (const table of ['approval_requests', 'approval_events']) {
      const statement = schema.match(new RegExp('CREATE TABLE IF NOT EXISTS `' + table + '` \\([\\s\\S]*?;'))?.[0];
      if (!statement) throw new Error(`Missing schema table: ${table}`);
      await pool.query(statement);
    }
    const operationsMigration = await readFile(new URL('../sql/migrations/026_operations.sql', import.meta.url), 'utf8');
    const approvalAlter = operationsMigration.match(/ALTER TABLE approval_requests[\s\S]*?;/)?.[0];
    if (!approvalAlter) throw new Error('Missing approval operation_id migration');
    await pool.query(approvalAlter);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    const [environment] = await pool.query<any[]>('SELECT VERSION() AS version, @@SESSION.sql_mode AS sql_mode');
    console.log('MAX341 MySQL environment:', environment[0]);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (created) await pool.query(`DROP DATABASE ${database}`);
    await pool?.end();
    console.log('MAX341 cleanup: disposable schema dropped; model calls=0');
  });

  it('confirms the real ENUM rejects an unvalidated model value', async () => {
    await expect(pool.execute("INSERT INTO approval_requests(instance_id,sql_text,sql_hash,risk_level) VALUES (1,'DROP TABLE fixture','fixture',?)", ['unexpected_fixture']))
      .rejects.toMatchObject({ code: 'WARN_DATA_TRUNCATED' });
    const [rows] = await pool.query<any[]>('SELECT COUNT(*) AS n FROM approval_requests');
    expect(Number(rows[0].n)).toBe(0);
  });

  const cases: Array<[unknown, string]> = [
    ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['critical', 'critical'],
    ['LOW', 'low'], ['Medium', 'medium'], ['HiGh', 'high'], ['CRITICAL', 'critical'],
    [' high\n', 'high'], ['', 'high'], ['  ', 'high'], [null, 'high'], [undefined, 'high'],
    [[], 'high'], [['low'], 'high'], [{}, 'high'], [{ value: 'low' }, 'high'],
    [0, 'high'], [1, 'high'], [false, 'high'], [true, 'high'], ['unexpected_fixture', 'high'],
  ];
  it.each(cases)('retains pending request, raw recommendation and normalized events for %j', async (input, expected) => {
    const recommendation = { risk_level: input, recommendation: 'reject', reasoning: 'fixture' };
    vi.mocked(llmService.chatWithTracking).mockResolvedValue({ content: JSON.stringify(recommendation) } as any);
    const result = await approvalService.submitForApproval({ instance_id: 1, sql_text: 'DROP TABLE fixture', submitted_by: 7 });
    expect(result).toMatchObject({ request_id: expect.any(Number), risk_level: expected, requires_approval: true });
    expect(await approvalService.getRequestById(result.request_id!)).toMatchObject({
      risk_level: expected, status: 'pending', ai_recommendation: JSON.parse(JSON.stringify(recommendation)), submitted_by: 7,
    });
    const events = await approvalService.getApprovalEvents(result.request_id!);
    expect(events.map(event => event.event_type)).toEqual(['submitted', 'ai_reviewed']);
    expect(events[1].event_data).toEqual({ risk_level: expected, recommendation: 'reject', reasoning: 'fixture' });
    expect((await approvalService.getPendingRequests([1])).map(row => row.id)).toContain(result.request_id);
    expect(sqlExecutor.executeSql).not.toHaveBeenCalled();
  });
});
