import { describe, expect, it } from 'vitest';
import { loadMigrations } from '../src/migrations/runner.js';

describe('metric definition migration parity', () => {
  it('restores runtime columns omitted from legacy installations', async () => {
    const migrations = await loadMigrations();
    const parity = migrations.find((migration) => migration.id === '052_metric_definition_runtime_parity.sql');

    expect(parity, 'metric definition parity migration').toBeDefined();
    expect(parity!.sql).toContain('information_schema.COLUMNS');
    expect(parity!.sql).toContain('information_schema.STATISTICS');
    expect(parity!.sql).toMatch(/ADD COLUMN collection_sqls JSON DEFAULT NULL/);
    expect(parity!.sql).toMatch(/ADD COLUMN compute_expr VARCHAR\(500\) DEFAULT NULL/);
    expect(parity!.sql).toMatch(/ADD COLUMN template_id INT UNSIGNED DEFAULT NULL/);
    expect(parity!.sql).toMatch(/ADD INDEX idx_template_id \(template_id\)/);
  });
});
