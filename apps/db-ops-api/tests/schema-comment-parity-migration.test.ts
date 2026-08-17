import { describe, expect, it } from 'vitest';
import { loadMigrations, splitSqlStatements } from '../src/migrations/runner.js';

describe('schema comment parity migration', () => {
  it('fills the comment gaps after the immutable comment migration', async () => {
    const migrations = await loadMigrations();
    const original = migrations.find((migration) => migration.id === '058_complete_schema_comments.sql');
    const parity = migrations.find((migration) => migration.id === '064_schema_comment_parity.sql');

    expect(original, 'original schema comment migration').toBeDefined();
    expect(parity, 'forward schema comment parity migration').toBeDefined();
    expect(parity!.id > original!.id).toBe(true);
    for (const table of ['generated_skills', 'skill_execution_history', 'skill_usage_patterns']) {
      expect(parity!.sql).toContain(`ALTER TABLE \`${table}\` COMMENT =`);
    }
    for (const column of [
      'input_tokens',
      'output_tokens',
      'dimensions',
      'id',
      'created_at',
      'updated_at',
    ]) {
      expect(parity!.sql).toContain(`MODIFY COLUMN \`${column}\``);
    }
  });

  it('guards token comments for legacy baselines without the split token columns', async () => {
    const migrations = await loadMigrations();
    const parity = migrations.find((migration) => migration.id === '064_schema_comment_parity.sql');
    const statements = splitSqlStatements(parity!.sql);
    const executableStatements = statements.map((statement) => statement
      .replace(/^\s*--.*$/gm, '')
      .trim());

    expect(parity!.sql).toContain('information_schema.COLUMNS');
    expect(parity!.sql).toContain("COLUMN_NAME = 'input_tokens'");
    expect(parity!.sql).toContain("COLUMN_NAME = 'output_tokens'");
    expect(executableStatements.some((statement) => (
      statement.startsWith('ALTER TABLE `ai_chat_history`')
    ))).toBe(false);
  });

  it('guards snapshot-only skill table comments for legacy baselines', async () => {
    const migrations = await loadMigrations();
    const parity = migrations.find((migration) => migration.id === '064_schema_comment_parity.sql');
    const statements = splitSqlStatements(parity!.sql);
    const executableStatements = statements.map((statement) => statement
      .replace(/^\s*--.*$/gm, '')
      .trim());

    for (const table of ['generated_skills', 'skill_execution_history', 'skill_usage_patterns']) {
      expect(parity!.sql).toContain(`TABLE_NAME = '${table}'`);
      expect(executableStatements.some((statement) => (
        statement.startsWith(`ALTER TABLE \`${table}\``)
      ))).toBe(false);
    }
  });
});
