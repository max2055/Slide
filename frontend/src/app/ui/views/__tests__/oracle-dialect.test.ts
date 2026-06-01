/**
 * OracleDialect -- source structure test (GAP-08 / D-04)
 *
 * Verifies that sql-console.ts defines OracleDialect via SQLDialect.define()
 * with the correct Oracle-specific identifiers, caseInsensitiveIdentifiers: true.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SQL_CONSOLE_PATH = path.resolve(__dirname, '../sql-console.ts');
const source = fs.readFileSync(SQL_CONSOLE_PATH, 'utf-8');

describe('GAP-08 / D-04: OracleDialect PL/SQL dialect definition', () => {
  it('应使用 SQLDialect.define() 定义 OracleDialect', () => {
    expect(source).toContain('const OracleDialect = SQLDialect.define({');
  });

  it('builtin 应包含 V$SESSION 系统视图', () => {
    expect(source).toContain('V$SESSION');
  });

  it('builtin 应包含 DBA_TABLESPACES 系统视图', () => {
    expect(source).toContain('DBA_TABLESPACES');
  });

  it('builtin 应包含 NVL 函数', () => {
    expect(source).toContain('NVL');
  });

  it('builtin 应包含 DECODE 函数', () => {
    expect(source).toContain('DECODE');
  });

  it('types 应包含 VARCHAR2 类型', () => {
    expect(source).toContain('VARCHAR2');
  });

  it('types 应包含 PLS_INTEGER 类型', () => {
    expect(source).toContain('PLS_INTEGER');
  });

  it('应设置 caseInsensitiveIdentifiers: true', () => {
    expect(source).toContain('caseInsensitiveIdentifiers: true');
  });

  it('Dialect 切换逻辑应基于 db_type === "oracle"', () => {
    expect(source).toContain("db_type === 'oracle'");
  });
});
