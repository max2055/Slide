import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./llm-service.js', () => ({ llmService: { chatWithTracking: vi.fn() } }));
vi.mock('./database-service.js', () => ({ databaseService: { getConnection: vi.fn(), getExplainPlan: vi.fn() } }));
vi.mock('./ai-analysis-database-service.js', () => ({ aiAnalysisDatabaseService: {
  findByCacheKey: vi.fn(), createAnalysis: vi.fn(), updateStatus: vi.fn(), completeAnalysis: vi.fn(), failAnalysis: vi.fn(),
} }));
vi.mock('./db-connection.js', () => ({ dbConnection: { getPool: vi.fn() } }));

import { sqlAuditService } from './sql-audit-service.js';
import { dbConnection } from './db-connection.js';
import { databaseService } from './database-service.js';
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';
import { llmService } from './llm-service.js';

const internal = sqlAuditService as any;
const list = (count: number) => Array.from({ length: count }, (_, i) => String(i)).join(',');
const risks = (sql: string, pattern: string) => sqlAuditService.detectRisks(sql).filter(r => r.pattern === pattern);

beforeEach(() => vi.resetAllMocks());

describe('MAX-545 / #594: audit context table names', () => {
  it.each([
    ['SELECT * FROM users', ['users']],
    ["SELECT * FROM fd_db.users WHERE note='from secrets'", ['users']],
    ['SELECT * FROM db.schema.users JOIN db.schema.roles ON 1=1', ['users', 'roles']],
    ['SELECT * FROM `fd_db`.`user``names`', ['user`names']],
    ['SELECT * FROM "db"."User Names"', ['User Names']],
    ['UPDATE fd_db.users SET x=1', ['users']],
    ['INSERT INTO fd_db.users SELECT * FROM other.roles', ['users', 'roles']],
    ['SELECT * FROM users /* JOIN secrets */ -- FROM hidden\n WHERE id=1', ['users']],
    ["SELECT 'FROM secrets', $$JOIN hidden$$ FROM users", ['users']],
    ['SELECT * FROM (SELECT * FROM fd_db.users) u JOIN roles r ON 1=1', ['users', 'roles']],
    ["SELECT 'it''s from secrets', $tag$JOIN hidden$tag$ FROM users", ['users']],
  ])('extracts actual table names: %s', (sql, expected) => {
    expect(internal._extractTableNames(sql)).toEqual(expected);
  });

  it('uses the table name for both index and statistics lookups', async () => {
    const execute = vi.fn().mockResolvedValue([[]]);
    vi.mocked(dbConnection.getPool).mockReturnValue({ execute } as any);
    vi.mocked(databaseService.getConnection).mockReturnValue({ connected: true, pool: { execute }, config: { database: 'fd_db' } } as any);
    const sql = "SELECT * FROM fd_db.users WHERE note='from secrets'";
    await internal._getIndexInfo(1, sql);
    await internal._getTableStats(1, sql);
    expect(execute.mock.calls.map(call => call[1])).toEqual([[1, 'users'], ['fd_db', 'users']]);
  });
});

describe('MAX-547 / #597: WHERE belongs to the audited statement', () => {
  it.each([
    'UPDATE users SET x=1', 'DELETE FROM users',
    "UPDATE users SET note='WHERE id=1'", 'UPDATE users SET somewhere=1 /* WHERE id=1 */',
    'UPDATE users SET x=(SELECT id FROM other WHERE id=1)',
    'SELECT * FROM other WHERE id=1; UPDATE users SET x=1',
    'WITH source AS (SELECT * FROM other WHERE id=1) UPDATE users SET x=1',
    'DELETE FROM users WHERE id=1; UPDATE users SET x=1',
    'UPDATE users SET `where`=1',
  ])('reports unsafe writes: %s', sql => {
    expect(risks(sql, 'MISSING WHERE')).toEqual([expect.objectContaining({ level: 'error' })]);
  });

  it.each(['SELECT COUNT(*) FROM users', 'SELECT * FROM users'])('does not turn an unfiltered read into P0: %s', sql => {
    expect(internal._calculateRiskLevel(sqlAuditService.detectRisks(sql))).not.toBe('P0');
  });

  it.each([
    'SELECT * FROM users WHERE id=1', 'UPDATE users SET x=1 WHERE id=1', 'DELETE FROM users WHERE id=1',
    'SELECT * FROM users WHERE id=1 FOR UPDATE',
  ])('does not report filtered statements: %s', sql => {
    expect(risks(sql, 'MISSING WHERE')).toEqual([]);
  });
});

describe('MAX-550 / #593: IN list boundaries', () => {
  it.each([
    `SELECT * FROM users JOIN (SELECT ${list(101)} FROM roles) r ON 1=1`,
    `SELECT 'in (${list(101)})' FROM users`,
    `SELECT * FROM users /* IN (${list(101)}) */`,
    `SELECT $body$in (${list(101)})$body$ FROM users`,
    `SELECT * FROM users WHERE id IN (SELECT ${list(101)} FROM roles)`,
    'SELECT * FROM users WHERE id IN (1,2,3)',
    `SELECT * FROM users WHERE id IN (${list(100)})`,
    `SELECT * FROM users WHERE id IN (concat('${list(101)}', 'x'), 2)`,
  ])('ignores non-lists and lists up to 100: %s', sql => {
    expect(risks(sql, 'LARGE IN CLAUSE')).toEqual([]);
  });

  it.each([
    `SELECT * FROM users WHERE id IN (${list(101)})`,
    `SELECT * FROM users WHERE id NOT IN (${Array.from({ length: 101 }, () => "concat('a,b', 'c')").join(',')})`,
  ])('warns for 101 actual values: %s', sql => {
    expect(risks(sql, 'LARGE IN CLAUSE')).toEqual([expect.objectContaining({ message: expect.stringContaining('101') })]);
  });
});

describe('audit submission integration (isolated dependencies)', () => {
  it('keeps corrected risks and explicit context degradation when metadata is unavailable', async () => {
    const execute = vi.fn().mockImplementation(async (query: string) => {
      if (query.includes('FROM index_info')) throw new Error('metadata unavailable');
      return [{ insertId: 21 }];
    });
    vi.mocked(dbConnection.getPool).mockReturnValue({ execute } as any);
    vi.mocked(aiAnalysisDatabaseService.createAnalysis).mockResolvedValue({ success: true, analysisId: 31 });
    vi.mocked(databaseService.getExplainPlan).mockRejectedValue(new Error('explain unavailable'));
    vi.mocked(llmService.chatWithTracking).mockResolvedValue({ success: true, content: '{}' } as any);
    const submitted = await sqlAuditService.submitAudit('UPDATE db.users SET x=1', 1);
    await vi.waitFor(() => expect(aiAnalysisDatabaseService.completeAnalysis).toHaveBeenCalled());
    expect(submitted.preAuditResults).toContainEqual(expect.objectContaining({ pattern: 'MISSING WHERE', level: 'error' }));
    const prompt = vi.mocked(llmService.chatWithTracking).mock.calls[0][0][0].content;
    expect(prompt).toContain('表: users - 索引查询失败');
    expect(prompt).toContain('数据库实例未连接');
    expect(prompt).toContain('EXPLAIN 获取失败');
  });

  it.each([
    ['UPDATE users SET x=1', 'error', 'P0'],
    ['SELECT COUNT(*) FROM users', 'warning', 'P2'],
    ['UPDATE users SET x=1 WHERE id=1', 'info', 'P2'],
  ])('persists the static risk for %s and completes analysis', async (sql, level, risk) => {
    const execute = vi.fn().mockResolvedValue([{ insertId: 21 }]);
    vi.mocked(dbConnection.getPool).mockReturnValue({ execute } as any);
    vi.mocked(aiAnalysisDatabaseService.createAnalysis).mockResolvedValue({ success: true, analysisId: 31 });
    vi.mocked(databaseService.getExplainPlan).mockResolvedValue('plan' as any);
    vi.mocked(llmService.chatWithTracking).mockResolvedValue({ success: true, content: '{}' } as any);
    const result = await sqlAuditService.submitAudit(sql, 1, 'tester');
    expect(result.recordId).toBe(21);
    expect(execute.mock.calls[0][1].slice(3, 5)).toEqual([level, risk]);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(
      'UPDATE sql_audit_records SET status = ? WHERE id = ?', ['completed', 21],
    ));
    expect(aiAnalysisDatabaseService.completeAnalysis).toHaveBeenCalledWith(31, expect.objectContaining({
      result: expect.objectContaining({ pre_audit_results: result.preAuditResults }),
    }));
  });
});
