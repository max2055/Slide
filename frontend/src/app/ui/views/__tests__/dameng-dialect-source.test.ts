/**
 * Dameng Dialect -- frontend source structure tests
 *
 * Verifies:
 * - DamengDialect defined via SQLDialect.define() with correct config
 * - caseInsensitiveIdentifiers: true (per Pitfall 4)
 * - plsqlQuotingMechanism: true (Oracle-compatible)
 * - Builtins include V$DM_* system views
 * - Types include Dameng data types
 * - Dialect switching: dameng instances use DamengDialect, others use MySQL
 * - upperCaseKeywords: true for DamengDialect
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SQL_CONSOLE_PATH = path.resolve(__dirname, '../sql-console.ts');
const source = fs.readFileSync(SQL_CONSOLE_PATH, 'utf-8');

describe('DamengDialect definition', () => {
  it('SQLDialect 应从 @codemirror/lang-sql 导入', () => {
    expect(source).toContain("import { sql, MySQL, SQLDialect }");
    expect(source).toContain('from "@codemirror/lang-sql"');
  });

  it('DamengDialect 应通过 SQLDialect.define() 定义', () => {
    expect(source).toContain('const DamengDialect = SQLDialect.define({');
  });

  it('caseInsensitiveIdentifiers 应设置为 true', () => {
    expect(source).toContain('caseInsensitiveIdentifiers: true');
  });

  it('plsqlQuotingMechanism 应设置为 true', () => {
    expect(source).toContain('plsqlQuotingMechanism: true');
  });

  it('identifierQuotes 应设置为 "', () => {
    expect(source).toContain("identifierQuotes: '\"'");
  });

  it('builtin 应包含 V$SESSIONS', () => {
    expect(source).toContain('V$SESSIONS');
  });

  it('builtin 应包含 V$LOCK', () => {
    expect(source).toContain('V$LOCK');
  });

  it('builtin 应包含 DBA_DATA_FILES', () => {
    expect(source).toContain('DBA_DATA_FILES');
  });

  it('builtin 应包含 ALL_TAB_COLUMNS', () => {
    expect(source).toContain('ALL_TAB_COLUMNS');
  });

  it('types 应包含 Dameng 特有类型 VARCHAR2', () => {
    expect(source).toMatch(/types:[\s\S]*?VARCHAR2/);
  });

  it('keywords 应包含 TABLESPACE', () => {
    expect(source).toMatch(/keywords:[\s\S]*?TABLESPACE/);
  });
});

describe('Dialect switching logic', () => {
  it('dameng 实例应使用 DamengDialect', () => {
    expect(source).toMatch(/db_type\s*===\s*'dameng'\s*\?\s*DamengDialect/);
  });

  it('upperCaseKeywords 应在 Dameng 下为 true', () => {
    expect(source).toMatch(/upperCaseKeywords:\s*selectedDialect\s*===\s*(OracleDialect|DamengDialect)/);
  });
});
