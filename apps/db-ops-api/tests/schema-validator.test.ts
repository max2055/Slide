// GitHub #398 / OCR-0304: exercise the actual CLI, without a database.
import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures: string[] = [];
const schema = `
CREATE TABLE reports (type ENUM('health','performance','slow_query','capacity'), status ENUM('pending','completed','failed'), format ENUM('html','pdf','json'));
CREATE TABLE notification_channels (type ENUM('email','dingtalk','wecom','feishu','webhook'));
CREATE TABLE ai_analysis (analysis_type ENUM('topsql_analysis','alert_rca','fault_diagnosis','capacity_prediction','sql_audit','log_analysis'));
CREATE TABLE users (role ENUM('admin','viewer'), status ENUM('active','locked'));
CREATE TABLE database_logs (log_level ENUM('info','warning','error','critical'), source ENUM('mysql_error','pg_log','other'));
CREATE TABLE alert_rules (severity ENUM('warning','error','critical'));
`;

function cli(base = schema, migration = '') {
  const dir = mkdtempSync(join(tmpdir(), 'slide-schema-validator-'));
  fixtures.push(dir);
  mkdirSync(join(dir, 'tests'));
  mkdirSync(join(dir, 'sql/migrations'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  symlinkSync(join(root, 'src'), join(dir, 'src'));
  copyFileSync(join(root, 'tests/schema-validator.ts'), join(dir, 'tests/schema-validator.ts'));
  // A stale legacy schema must never override current migration definitions.
  writeFileSync(join(dir, 'sql/schema.sql'), schema);
  writeFileSync(join(dir, 'sql/migrations/000_schema_baseline.sql'), base);
  writeFileSync(join(dir, 'sql/migrations/999_contract.sql'), migration);
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'tests/schema-validator.ts'], {
    cwd: dir, encoding: 'utf8', timeout: 15000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { status: result.status, output: result.stdout + result.stderr };
}

afterEach(() => fixtures.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('schema-validator CLI (#398)', () => {
  it('accepts matching migration ENUMs', () => {
    const result = cli();
    expect(result.status).toBe(0);
    expect(result.output).toContain('10 passed, 0 failed, 0 missing, 0 uncovered');
  });

  it.each([
    ['deleted', 'ALTER TABLE reports DROP COLUMN type;'],
    ['renamed', 'ALTER TABLE reports RENAME COLUMN type TO kind;'],
    ['changed name', "ALTER TABLE reports CHANGE COLUMN type kind ENUM('health');"],
    ['changed type', 'ALTER TABLE reports MODIFY COLUMN type VARCHAR(40);'],
    ['mismatched', "ALTER TABLE reports MODIFY COLUMN type ENUM('health');"],
    ['table removed', 'DROP TABLE reports;'],
    ['unsupported dynamic', "SET @ddl = 'ALTER TABLE reports DROP COLUMN type'; PREPARE stmt FROM @ddl; EXECUTE stmt;"],
  ])('rejects %s contract through the real exit code', (_name, migration) => {
    const result = cli(schema, migration);
    expect(result.status).toBe(1);
    expect(result.output).not.toContain('10 passed');
    expect(result.output).toMatch(/reports\.type:[\s\S]*(MISSING|UNCOVERED|NOT ENUM|NOT IN ENUM)/);
  });

  it('reports an absent ENUM separately, without counting it passed', () => {
    const result = cli(schema.replace("type ENUM('health','performance','slow_query','capacity'), ", ''));
    expect(result.status).toBe(1);
    expect(result.output).toContain('9 passed, 0 failed, 1 missing, 0 uncovered');
  });

  it('recognizes ALTER-added ENUMs and migration file ordering', () => {
    const result = cli(schema.replace("type ENUM('health','performance','slow_query','capacity'), ", ''),
      "ALTER TABLE reports ADD COLUMN type ENUM('health','performance','slow_query','capacity');");
    expect(result.status).toBe(0);
    expect(result.output).toContain('10 passed, 0 failed, 0 missing, 0 uncovered');
  });

  it('does not interpret commented DDL as a migration', () => {
    expect(cli(schema, '-- ALTER TABLE reports DROP COLUMN type;\n/* DROP TABLE reports; */').status).toBe(0);
  });

  it('fails closed for unsupported target DDL', () => {
    const result = cli(schema, 'ALTER TABLE reports SOMETHING_UNSUPPORTED type;');
    expect(result.status).toBe(1);
    expect(result.output).toContain('UNCOVERED');
  });

  it('does not confuse FK references or conditional unrelated columns with contracts', () => {
    const result = cli(schema, `
      CREATE TABLE other (user_id INT, FOREIGN KEY (user_id) REFERENCES users(id));
      SET @ddl = 'ALTER TABLE reports ADD COLUMN extra INT';
      PREPARE stmt FROM @ddl; EXECUTE stmt;
      ALTER TABLE reports COMMENT = 'documentation';
    `);
    expect(result.status).toBe(0);
    expect(result.output).toContain('10 passed, 0 failed, 0 missing, 0 uncovered');
  });

  it('keeps uncertainty for conditional changes to a checked column', () => {
    const result = cli(schema, `SET @ddl = "ALTER TABLE reports MODIFY COLUMN type ENUM('health')";`);
    expect(result.status).toBe(1);
    expect(result.output).toContain('9 passed, 0 failed, 0 missing, 1 uncovered');
  });

  it('fails closed on multi-table DDL', () => {
    expect(cli(schema, 'DROP TABLE reports, users;').status).toBe(1);
    expect(cli(schema, 'DROP TABLE other, reports;').status).toBe(1);
  });

  it('handles qualified, quoted and case-varied column changes', () => {
    const result = cli(schema, 'AlTeR TABLE `app`.`reports` DROP COLUMN `type`;');
    expect(result.status).toBe(1);
    expect(result.output).toContain('MISSING');
  });

  it('does not split ENUM values or SQL comments inside strings', () => {
    const result = cli(schema, `ALTER TABLE reports MODIFY COLUMN type ENUM('health','performance','slow_query','capacity','a,b','x;--y');`);
    expect(result.status).toBe(0);
  });

  it.each([
    "SET @ddl = CONCAT('ALTER ', 'TABLE reports DROP COLUMN type'); PREPARE stmt FROM @ddl; EXECUTE stmt;",
    'SET @ddl = unknown_builder(); PREPARE stmt FROM @ddl; EXECUTE stmt;',
    'PREPARE stmt FROM @not_set; EXECUTE stmt;',
    "EXECUTE IMMEDIATE CONCAT('ALTER ', 'TABLE reports DROP COLUMN type');",
    "SET @ddl = 'SELECT 1'; SET @ddl = CONCAT('ALTER ', 'TABLE reports DROP COLUMN type'); PREPARE stmt FROM @ddl; EXECUTE stmt;",
    "SET @ddl = 'SELECT 1'; SELECT CONCAT('ALTER ', 'TABLE reports DROP COLUMN type') INTO @ddl; PREPARE stmt FROM @ddl; EXECUTE stmt;",
    "SET @ddl = 'SELECT 1'; SELECT 1, unknown_builder() INTO @unused, @ddl; PREPARE stmt FROM @ddl; EXECUTE stmt;",
    "SET @ddl = 'SELECT 1'; DO @ddl := unknown_builder(); PREPARE stmt FROM @ddl; EXECUTE stmt;",
    'CALL unknown_schema_change();',
  ])('does not count unresolved dynamic SQL as verified: %s', (migration) => {
    const result = cli(schema, migration);
    expect(result.status).toBe(1);
    expect(result.output).toContain('UNCOVERED');
    expect(result.output).not.toContain('10 passed');
  });

  it('accepts proven unrelated prepared SQL and unused text expressions', () => {
    const result = cli(schema, `
      SET @text = CONCAT('ALTER ', 'TABLE reports DROP COLUMN type');
      SET @ddl = 'SELECT 1'; PREPARE stmt FROM @ddl; EXECUTE stmt;
      PREPARE stmt FROM 'ALTER TABLE other ADD COLUMN extra INT'; EXECUTE stmt;
      SET @ddl = IF(@exists = 0, 'ALTER TABLE other ADD COLUMN note VARCHAR(20) COMMENT ''unrelated''', 'SELECT 1');
      PREPARE stmt FROM @ddl; EXECUTE stmt;
    `);
    expect(result.status).toBe(0);
  });
});
