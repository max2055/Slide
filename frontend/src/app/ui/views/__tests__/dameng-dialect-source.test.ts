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
import '../sql-console.js';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { MySQL } from '@codemirror/lang-sql';
import fs from 'fs';
import path from 'path';

// Exercise production language support and CodeMirror completion behavior,
// independent of local variable names in the dialect selection implementation.
async function keywordLabels(dbType: string) {
  const Page = customElements.get('sql-console-page')!;
  const page = new Page() as any;
  page.instances = [{ id: 1, db_type: dbType }];
  page.selectedId = 1;
  const support = page._sqlLanguage();
  const state = EditorState.create({ extensions: [support] });
  const labels: string[] = [];
  for (const source of state.languageDataAt<any>('autocomplete', 0)) {
    const result = await source(new CompletionContext(state, 0, true));
    labels.push(...(result?.options || []).map((option: any) => option.label));
  }
  return { labels, language: support.language };
}

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
  it('dameng 实例应使用 DamengDialect', async () => {
    const { labels, language } = await keywordLabels('dameng');
    expect(language).not.toBe(MySQL.language);
    expect(labels).toContain('DM_SQL_CREATE_HUGE_TABLE');
    expect(labels).not.toContain('PLS_INTEGER');
  });

  it('upperCaseKeywords 应在 Dameng 下为 true', async () => {
    const { labels } = await keywordLabels('dameng');
    expect(labels).toContain('SELECT');
    expect(labels).not.toContain('select');
  });

  it('切回 MySQL 应恢复 MySQL 方言和默认小写关键词', async () => {
    const { labels, language } = await keywordLabels('mysql');
    expect(language).toBe(MySQL.language);
    expect(labels).toContain('select');
    expect(labels).not.toContain('SELECT');
  });
});
