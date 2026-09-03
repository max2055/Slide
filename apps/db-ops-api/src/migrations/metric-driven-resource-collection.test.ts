import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from './runner.js';

const migrationUrl = new URL('../../sql/migrations/083_metric_driven_resource_collection.sql', import.meta.url);

describe('metric-driven resource collection migration', () => {
  it('extends persisted schedule state to network devices without adding global interval settings', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain("ENUM('instance','server','network_device')");
    expect(sql).not.toContain('system_config');
    expect(splitSqlStatements(sql)).toHaveLength(1);
  });
});
