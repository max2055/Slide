import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from './db-connection.js';
import { brandingConfigService as service, DEFAULTS } from './branding-config-service.js';

describe('MAX-670 / #319 / #499 branding partial updates', () => {
  let connection: any;
  let pool: any;
  beforeEach(() => {
    connection = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn(),
      execute: vi.fn().mockResolvedValue([{}]) };
    connection.execute.mockImplementation(async (sql: string) => sql.startsWith('SELECT')
      ? [[{ config_value: JSON.stringify({ ...DEFAULTS, product_name: 'Existing' }) }]] : [{}]);
    pool = { getConnection: vi.fn().mockResolvedValue(connection), execute: vi.fn() };
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['cli_name', 'product_name', 'env_prefix', 'state_dir'])('rejects explicit null for %s without writing', async field => {
    expect((await service.saveBranding({ cli_name: 'valid', product_name: 'Valid', [field]: null } as any)).success).toBe(false);
    expect(pool.getConnection).not.toHaveBeenCalled();
  });
  it.each([null, [], 7, 'bad', {}, { extra: 'bad' }, { product_name: 7 }, { product_name: [] },
    { state_dir: ' ' }, { cli_name: 'UPPER' }, { env_prefix: 'lower' }, { product_name: undefined }])(
    'rejects invalid patch %j', async patch => {
      expect((await service.saveBranding(patch as any)).success).toBe(false);
      expect(pool.getConnection).not.toHaveBeenCalled();
    });
  it('uses only one transaction connection and preserves unspecified fields', async () => {
    expect(await service.saveBranding({ state_dir: '.new' })).toEqual({ success: true });
    expect(pool.execute).not.toHaveBeenCalled();
    expect(pool.getConnection).toHaveBeenCalledTimes(1);
    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    const [sql, args] = connection.execute.mock.calls[2];
    expect(sql).toMatch(/^UPDATE system_config SET config_value/);
    expect(JSON.parse(args[0])).toEqual({ ...DEFAULTS, product_name: 'Existing', state_dir: '.new' });
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });
  it.each(['null', '[]', '5', '{', '{"product_name":null}', '{"cli_name":3}', '{"env_prefix":"lower"}'])(
    'keeps invalid storage %s untouched and returns legal read fallback', async stored => {
      pool.execute.mockResolvedValue([[{ config_value: stored }]]);
      connection.execute.mockImplementation(async (sql: string) => sql.startsWith('SELECT')
        ? [[{ config_value: stored }]] : [{}]);
      expect(await service.getBranding()).toEqual(DEFAULTS);
      expect((await service.saveBranding({ product_name: 'New' })).error).toMatch(/已存品牌配置无效/);
      expect(connection.execute.mock.calls.some(([sql]: [string]) => sql.startsWith('UPDATE'))).toBe(false);
      expect(connection.rollback).toHaveBeenCalledOnce();
      expect(connection.commit).not.toHaveBeenCalled();
    });
  it('does not use the forgiving getter when a locked read fails, and can recover', async () => {
    const execute = connection.execute.getMockImplementation()!;
    connection.execute.mockImplementation(async (sql: string, ...args: unknown[]) => {
      if (sql.startsWith('SELECT')) throw new Error('read unavailable');
      return execute(sql, ...args);
    });
    expect((await service.saveBranding({ cli_name: 'new' })).success).toBe(false);
    expect(connection.execute.mock.calls).toHaveLength(2);
    expect(connection.rollback).toHaveBeenCalledOnce();
    connection.execute.mockImplementation(execute);
    expect((await service.saveBranding({ cli_name: 'new' })).success).toBe(true);
  });
  it('destroys a connection if rollback cannot be confirmed', async () => {
    connection.execute.mockRejectedValue(new Error('write failed'));
    connection.rollback.mockRejectedValue(new Error('connection lost'));
    expect((await service.saveBranding({ product_name: 'New' })).success).toBe(false);
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
  });
  it('reports connection acquisition failure without attempting a write', async () => {
    pool.getConnection.mockRejectedValue(new Error('pool unavailable'));
    expect((await service.saveBranding({ product_name: 'New' })).success).toBe(false);
    expect(connection.execute).not.toHaveBeenCalled();
  });
  it.each(['insert', 'update', 'commit'])('rolls back on %s failure and releases', async stage => {
    if (stage === 'commit') connection.commit.mockRejectedValue(new Error('commit failed'));
    else {
      const execute = connection.execute.getMockImplementation()!;
      connection.execute.mockImplementation(async (sql: string, ...args: unknown[]) => {
        if (sql.startsWith(stage.toUpperCase())) throw new Error(`${stage} failed`);
        return execute(sql, ...args);
      });
    }
    expect((await service.saveBranding({ product_name: 'New' })).success).toBe(false);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });
});
