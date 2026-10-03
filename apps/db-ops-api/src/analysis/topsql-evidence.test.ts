import { beforeEach, describe, expect, it, vi } from 'vitest';
const { authorize, explain, execute } = vi.hoisted(() => ({ authorize: vi.fn(), explain: vi.fn(), execute: vi.fn() }));
vi.mock('./analysis-identity.js', () => ({ authorizeAnalysisRequest: authorize, analysisAuthorizationVersion: () => 'auth' }));
vi.mock('../database-service.js', () => ({ databaseService: { getConnection: () => ({ db_type: 'mysql' }), getExplainPlan: explain } }));
vi.mock('../sql-executor.js', () => ({ sqlExecutor: { executeSql: execute } }));
import { collectTopSqlEvidence } from './topsql-evidence.js';
import { freezeEvidence } from './analysis-evidence.js';
const actor = { userId: 7, username: 'op', roles: [], permissions: ['ai:manage'], sessionVersion: 1, instanceScopes: { 42: 'read-only' as const }, requestId: 'test' };
const query = (sql_text = "SELECT * FROM orders WHERE id=1") => ({ sql_text, schema_name: 'shop', avg_time_ms: 7 }) as any;
beforeEach(() => { vi.clearAllMocks(); authorize.mockResolvedValue(undefined); explain.mockResolvedValue('MySQL 执行计划:\n  表：orders'); execute.mockResolvedValue({ success: true, rows: [{ TABLE_NAME: 'orders' }] }); });
describe('TopSQL server collection boundary', () => {
  it.each([
    ['double', 'SELECT `email2` FROM `orders2` WHERE email="FAKE_DOUBLE_VALUE"', 'Filter: email="FAKE_DOUBLE_VALUE"'],
    ['escaped double', String.raw`SELECT * FROM orders WHERE email="FAKE_DOUBLE\"VALUE"`, String.raw`Filter: email="FAKE_DOUBLE\"VALUE"`],
    ['doubled single', "SELECT * FROM orders WHERE email='FAKE_SINGLE''VALUE'", "Filter: email='FAKE_SINGLE''VALUE'"],
  ])('redacts %s business literals before returning and freezing SQL/plan evidence', async (_name, sql, predicate) => {
    explain.mockResolvedValue(`MySQL 执行计划:\n${predicate}`);
    const result = await collectTopSqlEvidence(42, query(sql), actor);
    for (const safe of [result, freezeEvidence({ type: 'instance', id: 42 }, 'auth', result)]) {
      expect(JSON.stringify(safe)).not.toContain('FAKE_');
      expect(JSON.stringify(safe)).toContain('[REDACTED]');
    }
    expect(explain).toHaveBeenCalledWith(42, sql);
  });
  it('records gaps instead of retaining unknown SQL or malformed plans', async () => {
    const unknown = await collectTopSqlEvidence(42, query('unknown FAKE_BUSINESS_VALUE'), actor);
    expect(unknown.sql).toBeNull();
    expect(unknown.gaps).toContainEqual(expect.objectContaining({ code: 'SQL_REDACTION_UNAVAILABLE' }));
    explain.mockResolvedValue('MySQL 执行计划:\nFilter: email="FAKE_UNCLOSED');
    const malformed = await collectTopSqlEvidence(42, query(), actor);
    expect(malformed.explain).toBeNull();
    expect(malformed.gaps).toContainEqual(expect.objectContaining({ code: 'EXPLAIN_REDACTION_UNAVAILABLE' }));
  });
  it('collects SQL, statistics, schema, indexes and safe EXPLAIN after authorization with bounded metadata reads', async () => {
    const result = await collectTopSqlEvidence(42, query(), actor);
    expect(result).toMatchObject({ explain: 'MySQL 执行计划:\n  表：orders', schema: [{ TABLE_NAME: 'orders' }], indexes: [{ TABLE_NAME: 'orders' }], gaps: [] });
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(explain.mock.invocationCallOrder[0]);
    for (const args of execute.mock.calls) { expect(args[1]).toMatch(/^SELECT .* LIMIT 1000$/); expect(args[2].timeoutMs).toBe(5000); }
  });
  it.each(['UPDATE orders SET id=2', 'EXPLAIN ANALYZE SELECT 1', 'SELECT sleep(10)', 'SELECT 1; DELETE FROM orders', 'not SQL'])('never explains unknown or unsafe SQL %s', async sql => {
    const result = await collectTopSqlEvidence(42, query(sql), actor);
    expect(explain).not.toHaveBeenCalled(); expect(result.explain).toBeNull(); expect(result.gaps.some(g => g.scope === 'explain')).toBe(true);
  });
  it('authorization denial prevents all target database access', async () => {
    authorize.mockRejectedValue(new Error('ANALYSIS_AUTHORITY_REVOKED'));
    await expect(collectTopSqlEvidence(42, query(), actor)).rejects.toThrow('ANALYSIS_AUTHORITY_REVOKED');
    expect(explain).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it('collection failure, empty metadata and oversized plans form gaps, never fabricated evidence', async () => {
    explain.mockResolvedValue('x'.repeat(64_001)); execute.mockResolvedValue({ success: false });
    const result = await collectTopSqlEvidence(42, query(), actor);
    expect(result).toMatchObject({ explain: null, schema: null, indexes: null }); expect(result.gaps).toHaveLength(3);
  });
});
