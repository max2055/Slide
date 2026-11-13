import { describe, expect, it } from 'vitest';
import { loadMigrations, statementsForExecution } from '../src/migrations/runner.js';

describe('#300 immutable migration upgrade compatibility', () => {
  it('retains 058 checksum source but never executes its display name narrowing', async () => {
    const migration = (await loadMigrations()).find(m => m.id === '058_complete_schema_comments.sql')!;
    expect(migration.sql).toContain('MODIFY COLUMN `display_name` varchar(50)');
    const sql = statementsForExecution(migration).join('\n');
    expect(sql).toContain('MODIFY COLUMN `display_name` varchar(100)');
    expect(sql).toContain('MODIFY COLUMN `api_key_encrypted` text');
  });
});
