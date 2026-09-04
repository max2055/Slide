import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('problem feedback migration', () => {
  it('creates attributed feedback storage with Agent idempotency protection', async () => {
    const sql = await readFile(new URL('../../sql/migrations/084_problem_feedback.sql', import.meta.url), 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `problem_feedback`');
    expect(sql).toContain("ENUM('manual','agent')");
    expect(sql).toContain('UNIQUE KEY `uq_problem_feedback_idempotency`');
    expect(sql).toContain('ON DELETE SET NULL');
  });
});
