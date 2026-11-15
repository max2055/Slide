/**
 * OracleDialect -- source structure test (GAP-08 / D-04)
 *
 * Verifies that sql-console.ts defines OracleDialect via SQLDialect.define()
 * with the correct Oracle-specific identifiers, caseInsensitiveIdentifiers: true.
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

  it('Dialect 切换逻辑应基于实例 db_type 使用 Oracle 方言', async () => {
    const { labels, language } = await keywordLabels('oracle');
    expect(language).not.toBe(MySQL.language);
    expect(labels).toContain('V$SESSION');
    expect(labels).not.toContain('V$SESSIONS');
    expect(labels).toContain('PLS_INTEGER');
    expect(labels).toContain('SELECT');
    expect(labels).not.toContain('select');
  });
});
