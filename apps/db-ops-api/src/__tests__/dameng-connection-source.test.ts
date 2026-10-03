/**
 * Dameng Connection -- source structure tests
 *
 * Verifies:
 * - dmdb driver import and dmConnection field in DatabaseConnection interface
 * - addConnection() dameng branch uses dmdb.getConnection(), sets oracleConnection to null
 * - removeConnection() handles dmConnection.close()
 * - All dispatch guards use conn.dmConnection for dameng type
 */
import { describe, it, expect, vi } from 'vitest';
import { databaseService } from '../database-service.js';
import fs from 'fs';
import path from 'path';

const DB_SERVICE_PATH = path.resolve(__dirname, '../database-service.ts');
const source = fs.readFileSync(DB_SERVICE_PATH, 'utf-8');
const INSTANCE_DB_SERVICE_PATH = path.resolve(__dirname, '../instance-database-service.ts');
const instanceSource = fs.readFileSync(INSTANCE_DB_SERVICE_PATH, 'utf-8');

describe('Dameng: dmdb import + dmConnection interface', () => {
  it('数据库服务应导入 dmdb 驱动', () => {
    expect(source).toContain("import dmdb from 'dmdb'");
  });

  it('DatabaseConnection 接口应包含 dmConnection 字段', () => {
    expect(source).toContain('dmConnection: dmdb.Connection | null');
  });
});

describe('Dameng: addConnection() 达梦连接分支', () => {
  it('addConnection dameng 分支应使用 dmdb.getConnection()', () => {
    expect(source).toContain('dmdb.getConnection({');
  });

  it('dmdb.getConnection 应包含 connectString 参数', () => {
    const match = source.match(/dmdb\.getConnection\(\{[\s\S]*?connectString:/);
    expect(match).not.toBeNull();
  });

  it('dmdb.getConnection 应包含 connectTimeout: 5000', () => {
    expect(source).toContain('connectTimeout: 5000');
  });

  it('达梦连接分支应设置 oracleConnection: null', () => {
    // The addConnection dameng branch must set oracleConnection to null
    expect(source).toMatch(/dmConnection[\s\S]*?oracleConnection:\s*null/);
  });
});

describe('Dameng: testConnection() 达梦连接参数', () => {
  it('测试连接应与正式连接一致关闭不兼容的登录加密', () => {
    const testConnection = instanceSource.slice(instanceSource.indexOf('async testConnection'));
    expect(testConnection).toMatch(/dmdb\.getConnection\(\{[\s\S]*?loginEncrypt:\s*false/);
  });
});

describe('Dameng: removeConnection()', () => {
  it('removeConnection 应关闭 dmConnection 并移除连接', async () => {
    const service = new (databaseService.constructor as any)();
    const dmConnection = { close: vi.fn().mockResolvedValue(undefined) };
    service.connections.set(9, { id: 9, dmConnection, connected: true });
    await service.removeConnection(9);
    expect(dmConnection.close).toHaveBeenCalledOnce();
    expect(service.getConnection(9)).toBeNull();
  });
});

describe('Dameng: 调度器守卫使用 conn.dmConnection', () => {
  it('getRealtimeMetrics dameng 守卫使用 conn.dmConnection', () => {
    expect(source).toMatch(/conn\.db_type\s*===\s*'dameng'\s*&&\s*conn\.dmConnection/);
  });

  it('getSlowQueries dameng 守卫使用 conn.dmConnection', () => {
    // Find all matches
    const matches = source.match(/conn\.db_type\s*===\s*'dameng'\s*&&\s*conn\.dmConnection/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(5);
  });

  it('checkHealth dameng 守卫使用 conn.dmConnection', () => {
    expect(source).toMatch(/checkHealth[\s\S]*?conn\.db_type\s*===\s*'dameng'\s*&&\s*conn\.dmConnection/);
  });

  it('getExplainPlan dameng 守卫使用 conn.dmConnection', () => {
    expect(source).toMatch(/dbType\s*===\s*'dameng'\s*&&\s*conn\.dmConnection/);
  });
});
