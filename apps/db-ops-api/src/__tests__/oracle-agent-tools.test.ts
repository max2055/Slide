/**
 * Oracle Agent Tools -- enum/union/port verification (GAP-03 / D-09, GAP-04 / CR-01)
 *
 * GAP-03: Verify test_connection.ts and add_database.ts have 'oracle' in their
 *          db_type enums, union types, and default ports.
 * GAP-04: Verify oracle_ash_report.ts uses correct parameter name l_etime.
 *
 * These tests read source files directly via fs since importing the tool modules
 * triggers side-effect registration chains that require actual Oracle driver.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const TOOLS_DIR = path.resolve(__dirname, '../tools/generated/slide-self-mgmt');

function readToolSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(TOOLS_DIR, relativePath), 'utf-8');
}

describe('GAP-03 / D-09: Agent tools have oracle in db_type enums', () => {
  const testConnection = readToolSource('test_connection.ts');

  it('test_connection.ts enum 应包含 oracle', () => {
    const enumMatch = testConnection.match(/enum:\s*\[([^\]]+)\]/);
    expect(enumMatch).not.toBeNull();
    expect(enumMatch![1]).toContain("'oracle'");
  });

  it('test_connection.ts description 应提及 oracle', () => {
    expect(testConnection).toContain('oracle');
  });

  const addDatabase = readToolSource('add_database.ts');

  it('add_database.ts union type 应包含 oracle', () => {
    // Check the AddDatabaseArgs.db_type union type definition
    expect(addDatabase).toMatch(/db_type.*:.*'mysql'.*'oracle'/);
  });

  it('add_database.ts enum 应包含 oracle', () => {
    const enumMatch = addDatabase.match(/enum:\s*\[([^\]]+)\]/);
    expect(enumMatch).not.toBeNull();
    expect(enumMatch![1]).toContain("'oracle'");
  });

  it('add_database.ts defaultPorts 应包含 oracle: [1521]', () => {
    expect(addDatabase).toContain('oracle: [1521]');
  });

  it('add_database.ts description 应提及 Oracle', () => {
    expect(addDatabase).toContain('Oracle');
  });
});

describe('GAP-04 / CR-01: oracle_ash_report.ts uses correct parameter name', () => {
  const ashReport = readToolSource('oracle_ash_report.ts');

  it('ASH_REPORT_HTML() 应使用 l_etime 参数', () => {
    expect(ashReport).toContain('l_etime');
  });

  it('ASH_REPORT_HTML() 不应包含 l_instime 参数', () => {
    expect(ashReport).not.toContain('l_instime');
  });
});
