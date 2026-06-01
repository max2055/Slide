/**
 * Oracle Database Service -- source structure tests (GAP-05 / WR-01, GAP-06 / WR-02, GAP-07 / D-14)
 *
 * GAP-05: Verify getOracleMetrics() uses 'user commits' (not 'commit workcount')
 * GAP-06: Verify checkOracleHealth() has try/catch DBA fallback
 * GAP-07: Verify addConnection uses createPool() with pool defaults, removeConnection closes pool
 *
 * These are source-level checks since we cannot run against a real Oracle database.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const DB_SERVICE_PATH = path.resolve(__dirname, '../database-service.ts');
const source = fs.readFileSync(DB_SERVICE_PATH, 'utf-8');

describe('GAP-05 / WR-01: getOracleMetrics() uses "user commits"', () => {
  it('SQL 查询中 CASE WHEN 使用 "user commits"', () => {
    // Line ~835: SUM(CASE WHEN NAME = 'user commits' THEN VALUE ELSE 0 END) as commits
    const caseWhenMatch = source.match(/CASE\s+WHEN\s+NAME\s*=\s*'user\s+commits'/g);
    expect(caseWhenMatch).not.toBeNull();
    expect(caseWhenMatch!.length).toBeGreaterThanOrEqual(1);
  });

  it('WHERE IN 子句包含 "user commits"', () => {
    const whereInMatch = source.match(/WHERE\s+NAME\s+IN\s*\([\s\S]*?'user\s+commits'[\s\S]*?\)/);
    expect(whereInMatch).not.toBeNull();
  });

  it('不应包含已废弃的 "commit workcount"', () => {
    expect(source).not.toContain("'commit workcount'");
  });

  it('"user commits" 应出现至少 2 次（CASE WHEN + WHERE IN）', () => {
    const matches = source.match(/'user\s+commits'/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

describe('GAP-06 / WR-02: checkOracleHealth() try/catch DBA fallback', () => {
  it('checkOracleHealth 方法应包含 try/catch 包裹的 DBA 表空间查询（带 [OracleHealth] 标记）', () => {
    // Check that DBA_DATA_FILES appears in a try/catch with [OracleHealth] marker
    const oracleHealthTryCatch = source.match(/try\s*\{[\s\S]*?DBA_DATA_FILES[\s\S]*?\}\s*catch[\s\S]*?\[OracleHealth\][\s\S]*?tablespaceUsage\s*=\s*null/);
    expect(oracleHealthTryCatch).not.toBeNull();
  });

  it('checkOracleHealth 降级消息应包含 "DBA 视图权限不足"', () => {
    expect(source).toContain('[OracleHealth] DBA 视图权限不足');
  });

  it('checkOracleHealth 中 tablespaceUsage 在 try/catch 后应赋值为 null', () => {
    // In checkOracleHealth the tablespaceUsage starts as null, and catch also sets null
    const oracleHealthNullCount = (source.match(/tablespaceUsage\s*=\s*null/g) || []).length;
    expect(oracleHealthNullCount).toBeGreaterThanOrEqual(2);
  });
});

describe('GAP-07 / D-14: Oracle pool management', () => {
  it('addConnection Oracle 分支应使用 oracledb.createPool()', () => {
    expect(source).toContain('oracledb.createPool(');
  });

  it('createPool 应包含 poolMax 配置', () => {
    expect(source).toContain('poolMax:');
  });

  it('createPool 应包含 poolMin 配置', () => {
    expect(source).toContain('poolMin:');
  });

  it('createPool 应包含 poolTimeout 配置', () => {
    expect(source).toContain('poolTimeout:');
  });

  it('removeConnection 应包含 oraclePool.close', () => {
    expect(source).toContain('oraclePool.close');
  });
});
