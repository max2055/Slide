/**
 * Dameng Methods -- source structure tests for Dameng-specific methods
 *
 * Verifies:
 * - getDamengMetrics, checkDamengHealth, getDamengSlowQueries, getDamengExplainPlan
 *   all use conn.dmConnection guards and conn.dmConnection.execute()
 * - getDamengActiveSessions method exists with V$SESSIONS query
 * - getDamengCapacity method exists with DBA_DATA_FILES / DBA_SEGMENTS queries
 * - getActiveSessions() and getCapacityInfo() have separate oracle/dameng branches
 * - Oracle methods unchanged (still use conn.oracleConnection)
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const DB_SERVICE_PATH = path.resolve(__dirname, '../database-service.ts');
const source = fs.readFileSync(DB_SERVICE_PATH, 'utf-8');

describe('getDamengMetrics Guard + Execute', () => {
  it('getDamengMetrics 守卫应检查 conn.dmConnection', () => {
    expect(source).toContain('getDamengMetrics(conn: DatabaseConnection');
    // The guard is: if (!conn.dmConnection) return null;
    const methodSection = source.match(/private async getDamengMetrics[\s\S]*?\n  \}/);
    expect(methodSection).not.toBeNull();
    expect(methodSection![0]).toContain('!conn.dmConnection');
  });

  it('getDamengMetrics 应使用 conn.dmConnection.execute()', () => {
    const methodSection = source.match(/private async getDamengMetrics[\s\S]*?\n  \}/);
    const executeCount = (methodSection![0].match(/conn\.dmConnection\.execute/g) || []).length;
    expect(executeCount).toBeGreaterThanOrEqual(8);
  });

  it('getDamengMetrics 查询 V$SESSIONS', () => {
    expect(source).toMatch(/getDamengMetrics[\s\S]*?V\$SESSIONS/);
  });
});

describe('getDamengSlowQueries Guard + Execute', () => {
  it('getDamengSlowQueries 守卫应检查 conn.dmConnection', () => {
    const methodSection = source.match(/private async getDamengSlowQueries[\s\S]*?\n  \}/);
    expect(methodSection).not.toBeNull();
    expect(methodSection![0]).toContain('!conn.dmConnection');
  });

  it('getDamengSlowQueries 应使用 conn.dmConnection.execute()', () => {
    const methodSection = source.match(/private async getDamengSlowQueries[\s\S]*?\n  \}/);
    expect(methodSection![0]).toContain('conn.dmConnection.execute(');
  });

  it('getDamengSlowQueries 查询 V$SQL_HISTORY', () => {
    expect(source).toMatch(/getDamengSlowQueries[\s\S]*?V\$SQL_HISTORY/);
  });
});

describe('checkDamengHealth Guard + Execute', () => {
  it('checkDamengHealth 守卫应检查 conn.dmConnection', () => {
    expect(source).toMatch(/checkDamengHealth[\s\S]*?!conn\.dmConnection\)/);
  });

  it('checkDamengHealth 应使用 conn.dmConnection.execute()', () => {
    expect(source).toMatch(/checkDamengHealth[\s\S]*conn\.dmConnection\.execute\(/);
  });

  it('checkDamengHealth 应使用 V$SESSIONS 查询', () => {
    expect(source).toMatch(/checkDamengHealth[\s\S]*V\$SESSIONS/);
  });

  it('checkDamengHealth 有 SELECT 1 FROM DUAL 连接测试', () => {
    expect(source).toMatch(/checkDamengHealth[\s\S]*SELECT 1 FROM DUAL/);
  });
});

describe('getDamengExplainPlan Guard + Execute', () => {
  it('getDamengExplainPlan 守卫应检查 conn.dmConnection', () => {
    const methodSection = source.match(/private async getDamengExplainPlan[\s\S]*?\n  \}/s);
    expect(methodSection).not.toBeNull();
    expect(methodSection![0]).toContain('!conn.dmConnection');
  });

  it('getDamengExplainPlan 应使用 conn.dmConnection.execute()', () => {
    const methodSection = source.match(/private async getDamengExplainPlan[\s\S]*?\n  \}/s);
    const executeCount = (methodSection![0].match(/conn\.dmConnection\.execute/g) || []).length;
    expect(executeCount).toBeGreaterThanOrEqual(2);
  });
});

describe('getDamengActiveSessions', () => {
  it('新方法 getDamengActiveSessions 应存在', () => {
    expect(source).toContain('getDamengActiveSessions(conn: DatabaseConnection)');
  });

  it('getDamengActiveSessions 守卫应检查 conn.dmConnection', () => {
    expect(source).toMatch(/getDamengActiveSessions[\s\S]*?!conn\.dmConnection\) return \[\]/);
  });

  it('getDamengActiveSessions 查询 V$SESSIONS', () => {
    expect(source).toMatch(/getDamengActiveSessions[\s\S]*?V\$SESSIONS/);
  });

  it('getDamengActiveSessions 排除自身连接 (SESSID)', () => {
    const methodSection = source.match(/private async getDamengActiveSessions[\s\S]*?\n  \}/s);
    expect(methodSection![0]).toMatch(/SESSID|SESS_ID/);
  });
});

describe('getDamengCapacity', () => {
  it('新方法 getDamengCapacity 应存在', () => {
    expect(source).toContain('getDamengCapacity(conn: DatabaseConnection)');
  });

  it('getDamengCapacity 守卫应检查 conn.dmConnection', () => {
    expect(source).toMatch(/getDamengCapacity[\s\S]*?!conn\.dmConnection\) return null/);
  });

  it('getDamengCapacity 查询 DBA_DATA_FILES', () => {
    expect(source).toMatch(/getDamengCapacity[\s\S]*?DBA_DATA_FILES/);
  });

  it('getDamengCapacity 查询 DBA_SEGMENTS', () => {
    expect(source).toMatch(/getDamengCapacity[\s\S]*?DBA_SEGMENTS/);
  });
});

describe('getActiveSessions dispatch -- separate oracle/dameng branches', () => {
  it('oracle 分支应使用 conn.oraclePool 守卫 + getOracleActiveSessions', () => {
    expect(source).toMatch(/conn\.db_type\s*===\s*'oracle'\s*&&\s*conn\.oraclePool[\s\S]*?getOracleActiveSessions/);
  });

  it('dameng 分支应使用 conn.dmConnection 守卫 + getDamengActiveSessions', () => {
    expect(source).toMatch(/conn\.db_type\s*===\s*'dameng'\s*&&\s*conn\.dmConnection[\s\S]*?getDamengActiveSessions/);
  });

  it('不应存在共享的 oracle || dameng 条件', () => {
    const sharedBranch = source.match(/conn\.db_type\s*===\s*'oracle'\s*\|\|\s*conn\.db_type\s*===\s*'dameng'/g);
    expect(sharedBranch).toBeNull();
  });

  it('getOracleActiveSessions 仍使用 conn.oracleConnection', () => {
    const methodSection = source.match(/private async getOracleActiveSessions[\s\S]*?\n  \}/s);
    expect(methodSection![0]).toContain('conn.oracleConnection.execute');
    expect(methodSection![0]).not.toContain('conn.dmConnection');
  });
});

describe('getCapacityInfo dispatch -- separate oracle/dameng branches', () => {
  it('oracle 分支应使用 conn.oraclePool 守卫 + getOracleCapacity', () => {
    expect(source).toMatch(/getCapacityInfo[\s\S]*?conn\.db_type\s*===\s*'oracle'\s*&&\s*conn\.oraclePool[\s\S]*?getOracleCapacity/);
  });

  it('dameng 分支应使用 conn.dmConnection 守卫 + getDamengCapacity', () => {
    expect(source).toMatch(/getCapacityInfo[\s\S]*?conn\.db_type\s*===\s*'dameng'\s*&&\s*conn\.dmConnection[\s\S]*?getDamengCapacity/);
  });

  it('不应存在共享的 oracle || dameng 条件', () => {
    const sharedBranch = source.match(/getCapacityInfo[\s\S]*?conn\.db_type\s*===\s*'oracle'\s*\|\|\s*conn\.db_type\s*===\s*'dameng'/g);
    expect(sharedBranch).toBeNull();
  });

  it('getOracleCapacity dispatch 仍使用 conn.oraclePool', () => {
    expect(source).toMatch(/conn\.db_type\s*===\s*'oracle'\s*&&\s*conn\.oraclePool[\s\S]*?getOracleCapacity/);
  });
});
