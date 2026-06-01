/**
 * Dameng Agent Tools -- source structure tests
 *
 * Verifies:
 * - instance-database-service.ts: testConnection dameng branch uses dmdb dynamic import
 * - database-service.ts: getSchemaObjects dameng branch queries ALL_TAB_COLUMNS
 * - add_database.ts: 'dameng' in union type, enum, description, defaultPort
 * - test_connection.ts: 'dameng' in enum + dmConnection fast-path
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const DB_SERVICE_PATH = path.resolve(__dirname, '../database-service.ts');
const INSTANCE_DB_SERVICE_PATH = path.resolve(__dirname, '../instance-database-service.ts');
const TOOLS_DIR = path.resolve(__dirname, '../tools/generated/slide-self-mgmt');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(TOOLS_DIR, relativePath), 'utf-8');
}

const dbServiceSource = fs.readFileSync(DB_SERVICE_PATH, 'utf-8');
const instanceDbServiceSource = fs.readFileSync(INSTANCE_DB_SERVICE_PATH, 'utf-8');

describe('instance-database-service.ts: testConnection dameng branch', () => {
  it('terConnection dameng 分支应动态导入 dmdb', () => {
    expect(instanceDbServiceSource).toContain("const dmdb = (await import('dmdb')).default");
  });

  it('testConnection dameng 分支使用 dmdb.getConnection()', () => {
    expect(instanceDbServiceSource).toMatch(/dmdb\.getConnection\(\{[\s\S]*?connectString:/);
  });

  it('testConnection dameng 分支使用 connectTimeout: 5000', () => {
    const damengBranch = instanceDbServiceSource.match(/if \(config\.db_type === 'dameng'\)[\s\S]*?\n      \}/);
    expect(damengBranch).not.toBeNull();
    expect(damengBranch![0]).toContain('connectTimeout: 5000');
  });
});

describe('database-service.ts: getSchemaObjects dameng branch', () => {
  it('getSchemaObjects dameng 分支使用 conn.dmConnection', () => {
    // Ensure the dameng branch exists in getSchemaObjects
    expect(dbServiceSource).toMatch(/getSchemaObjects[\s\S]*?conn\.db_type\s*===\s*'dameng'\s*&&\s*conn\.dmConnection/);
  });

  it('getSchemaObjects dameng 分支查询 ALL_TAB_COLUMNS', () => {
    expect(dbServiceSource).toMatch(/ALL_TAB_COLUMNS[\s\S]*?WHERE owner NOT IN \('SYS', 'SYSDBA', 'SYSAUDITOR'/);
  });

  it('getSchemaObjects dameng 分支使用 row[0]..row[4] 构建 schemaMap', () => {
    const methodSection = dbServiceSource.match(/getSchemaObjects[\s\S]*?\n  \}\n\n/s);
    const damengSection = methodSection![0].match(/conn\.db_type\s*===\s*'dameng'[\s\S]*?ALL_TAB_COLUMNS[\s\S]*?return \[\.\.\.schemaMap\]/);
    expect(damengSection).not.toBeNull();
  });
});

describe('add_database.ts: dameng support', () => {
  const addDatabase = readSource('add_database.ts');

  it('AddDatabaseArgs.db_type 联合类型应包含 dameng', () => {
    expect(addDatabase).toMatch(/db_type.*:.*'mysql'.*'dameng'/);
  });

  it('parameters.properties.db_type.enum 应包含 dameng', () => {
    const enumMatch = addDatabase.match(/enum:\s*\[([^\]]+)\]/);
    expect(enumMatch).not.toBeNull();
    expect(enumMatch![1]).toContain("'dameng'");
  });

  it('tool description 应提及 达梦', () => {
    expect(addDatabase).toContain('达梦');
  });

  it('db_type description 应包含 dameng', () => {
    expect(addDatabase).toContain('dameng');
  });

  it('defaultPorts 应包含 dameng: [5236]', () => {
    expect(addDatabase).toContain('dameng: [5236]');
  });
});

describe('test_connection.ts: dameng support', () => {
  const testConnection = readSource('test_connection.ts');

  it('参数 enum 应包含 dameng', () => {
    const enumMatch = testConnection.match(/enum:\s*\[([^\]]+)\]/);
    expect(enumMatch).not.toBeNull();
    expect(enumMatch![1]).toContain("'dameng'");
  });

  it('db_type description 应提及 dameng', () => {
    expect(testConnection).toContain('dameng');
  });

  it('dmConnection fast-path 应存在', () => {
    expect(testConnection).toContain('conn.dmConnection');
    expect(testConnection).toMatch(/} else if \(conn\.dmConnection\) \{[\s\S]*?conn\.dmConnection\.execute\('SELECT 1 FROM DUAL'\)/);
  });
});
