import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from '../migrations/runner.js';

const migrationUrl = new URL('../../sql/migrations/070_network_device_resource_foundation.sql', import.meta.url);

describe('network-device migration security contract', () => {
  it('widens existing target enums instead of treating column presence as completion', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql.match(/MAX\(LOCATE\('network_device', COLUMN_TYPE\)\)/g)?.length).toBeGreaterThanOrEqual(5);
    expect(sql).toContain("ALTER TABLE resource_relations MODIFY COLUMN");
    expect(sql).toContain("ALTER TABLE resource_capabilities MODIFY COLUMN");
  });

  it('seeds separated view, manage, and backup permissions with read-only DBA access', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    for (const permission of ['network_devices:view', 'network_devices:manage', 'network_devices:backup']) {
      expect(sql).toContain(`'${permission}'`);
    }
    expect(sql).toMatch(/WHERE r\.name IN \('admin','network-operator'\)/);
    expect(sql).toMatch(/WHERE r\.name = 'dba'/);
    expect(sql).toMatch(/p\.code = 'network_devices:view'/);
  });

  it('parses every migration statement without splitting quoted SQL', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    const statements = splitSqlStatements(sql);
    expect(statements.length).toBeGreaterThan(20);
    expect(statements.some((statement) => statement.includes('PREPARE slide_070_stmt'))).toBe(true);
    expect(statements.every((statement) => statement.trim().length > 0)).toBe(true);
  });
});

