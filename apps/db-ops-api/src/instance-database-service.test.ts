import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createPool: vi.fn(),
  getPool: vi.fn(() => null),
  encryptData: vi.fn((value: string) => `encrypted:${value}`),
  decryptData: vi.fn((value: string) => value),
  needsEncryptionMigration: vi.fn(() => false),
}));

vi.mock('mysql2/promise', () => ({
  createPool: mocks.createPool,
  default: { createPool: mocks.createPool },
}));

vi.mock('./db-connection.js', () => ({
  dbConnection: {
    getPool: mocks.getPool,
    isConnected: vi.fn(() => false),
  },
  encryptData: mocks.encryptData,
  decryptData: mocks.decryptData,
  needsEncryptionMigration: mocks.needsEncryptionMigration,
}));

import { instanceDatabaseService } from './instance-database-service.js';

const validConfig = {
  db_type: 'mysql',
  host: '203.0.113.10',
  port: 3306,
  username: 'monquery',
  password: 'secret',
};

describe('instance database connection test credential errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['', '   ', null, undefined])('asks for a username before attempting a connection when username is %j', async (username) => {
    const result = await instanceDatabaseService.testConnection({
      ...validConfig,
      username,
    });

    expect(result).toEqual({ success: false, message: '请输入用户名' });
    expect(mocks.createPool).not.toHaveBeenCalled();
  });

  it.each(['', '   ', null, undefined])('asks for a password before attempting a connection when password is %j', async (password) => {
    const result = await instanceDatabaseService.testConnection({
      ...validConfig,
      password,
    });

    expect(result).toEqual({ success: false, message: '请输入密码' });
    expect(mocks.createPool).not.toHaveBeenCalled();
  });

  it.each([
    { code: 'ER_ACCESS_DENIED_ERROR', message: "Access denied for user 'monquery'" },
    { code: '28P01', message: 'password authentication failed for user "monquery"' },
    { code: 'ORA-01017', message: 'ORA-01017: invalid username/password; logon denied' },
    { code: '-2501', message: '[-2501] 用户名或密码错误' },
    { code: 'ORA-24415', message: 'ORA-24415: Missing or null username.' },
  ])('normalizes authentication failure ($code) to a credential error', async ({ code, message }) => {
    const connectionError = Object.assign(new Error(message), { code });
    mocks.createPool.mockReturnValue({
      getConnection: vi.fn().mockRejectedValue(connectionError),
      end: vi.fn().mockResolvedValue(undefined),
    });

    const result = await instanceDatabaseService.testConnection(validConfig);

    expect(result).toEqual({ success: false, message: '连接失败：用户名或密码错误' });
  });

  it.each([
    Object.assign(new Error('DM login failed'), { errCode: -2501 }),
    Object.assign(new Error('driver rejected credentials'), { errorNum: 1017 }),
    Object.assign(new Error('Access denied'), { errno: 1045 }),
    Object.assign(new Error('authentication rejected'), { code: 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR' }),
    Object.assign(new Error('invalid authorization'), { sqlState: '28000' }),
    Object.assign(new Error('account locked'), { code: '3118' }),
    Object.assign(new Error('password lock'), { errno: 3955 }),
  ])('recognizes numeric or driver-specific authentication fields', async (connectionError) => {
    mocks.createPool.mockReturnValue({
      getConnection: vi.fn().mockRejectedValue(connectionError),
      end: vi.fn().mockResolvedValue(undefined),
    });

    await expect(instanceDatabaseService.testConnection(validConfig)).resolves.toEqual({
      success: false,
      message: '连接失败：用户名或密码错误',
    });
  });

  it.each([
    new Error('ORA-28000: the account is locked'),
    new Error('28P01: password authentication failed'),
    new Error('ER_ACCOUNT_HAS_BEEN_LOCKED'),
    new Error('[-2501] login rejected'),
  ])('recognizes an authentication code embedded only in the error message', async (connectionError) => {
    mocks.createPool.mockReturnValue({
      getConnection: vi.fn().mockRejectedValue(connectionError),
      end: vi.fn().mockResolvedValue(undefined),
    });

    await expect(instanceDatabaseService.testConnection(validConfig)).resolves.toEqual({
      success: false,
      message: '连接失败：用户名或密码错误',
    });
  });

  it('checks all driver error fields when a generic code masks an authentication code', async () => {
    const connectionError = Object.assign(new Error('database rejected login'), {
      code: 'ECONNRESET',
      errorNum: 1017,
    });
    mocks.createPool.mockReturnValue({
      getConnection: vi.fn().mockRejectedValue(connectionError),
      end: vi.fn().mockResolvedValue(undefined),
    });

    await expect(instanceDatabaseService.testConnection(validConfig)).resolves.toEqual({
      success: false,
      message: '连接失败：用户名或密码错误',
    });
  });

  it('keeps database privilege errors distinct from invalid credentials', async () => {
    const connectionError = Object.assign(new Error('Access denied for user to database'), {
      code: 'ER_DBACCESS_DENIED_ERROR',
    });
    mocks.createPool.mockReturnValue({
      getConnection: vi.fn().mockRejectedValue(connectionError),
      end: vi.fn().mockResolvedValue(undefined),
    });

    await expect(instanceDatabaseService.testConnection(validConfig)).resolves.toEqual({
      success: false,
      message: '连接失败：Access denied for user to database',
    });
  });

  it('does not mark an instance as credentialed when it is created without a password', async () => {
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[], undefined])
        .mockResolvedValueOnce([[], undefined])
        .mockResolvedValueOnce([{ insertId: 42, affectedRows: 1 }, undefined]),
    };
    mocks.getPool.mockReturnValue(pool);

    const result = await instanceDatabaseService.createInstance({
      name: 'pending-db',
      environment: 'testing',
      db_type: 'mysql',
      host: '203.0.113.10',
      port: 3306,
      username: 'monquery',
      password: '',
    });

    expect(result).toEqual({ success: true, instanceId: 42 });
    expect(mocks.encryptData).not.toHaveBeenCalled();
    const [insertSql, insertValues] = pool.execute.mock.calls[2] as [string, unknown[]];
    expect(insertSql).toMatch(/health_score\s*,\s*health_status/);
    expect(insertValues).toEqual(expect.arrayContaining([0, 'unknown']));
    expect(insertValues[6]).toBe('');
  });

  it.each([null, undefined, '   '])('treats a runtime %j create password as pending credentials', async (password) => {
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[], undefined])
        .mockResolvedValueOnce([[], undefined])
        .mockResolvedValueOnce([{ insertId: 43, affectedRows: 1 }, undefined]),
    };
    mocks.getPool.mockReturnValue(pool);

    const result = await instanceDatabaseService.createInstance({
      name: 'pending-runtime-password',
      environment: 'testing',
      db_type: 'mysql',
      host: '203.0.113.11',
      port: 3306,
      username: 'monquery',
      password: password as any,
    });

    expect(result).toEqual({ success: true, instanceId: 43 });
    expect(mocks.encryptData).not.toHaveBeenCalled();
    expect(pool.execute.mock.calls[2][1][6]).toBe('');
  });

  it.each([null, undefined, '', '   '])('does not replace an existing password for a runtime %j update value', async (password) => {
    const current = {
      id: 44,
      name: 'existing-db',
      environment: 'testing',
      db_type: 'mysql',
      host: '203.0.113.12',
      port: 3306,
    };
    const pool = {
      execute: vi.fn().mockResolvedValueOnce([[current], undefined]),
    };
    mocks.getPool.mockReturnValue(pool);

    const result = await instanceDatabaseService.updateInstance(44, { password: password as any });

    expect(result).toEqual({ success: true });
    expect(pool.execute).toHaveBeenCalledTimes(1);
    expect(mocks.encryptData).not.toHaveBeenCalled();
  });

  it('returns an empty password for an instance with an empty stored credential', async () => {
    const pool = {
      execute: vi.fn().mockResolvedValueOnce([[{
        id: 45,
        password_encrypted: '',
      }], undefined]),
    };
    mocks.getPool.mockReturnValue(pool);
    mocks.decryptData.mockImplementationOnce(() => {
      throw new Error('empty ciphertext must not be decrypted');
    });

    await expect(instanceDatabaseService.getInstancePassword(45)).resolves.toBe('');
  });

  it('keeps instance metadata available when its stored credential is empty', async () => {
    const pool = {
      execute: vi.fn().mockResolvedValueOnce([[{
        id: 46,
        db_type: 'dameng',
        host: '203.0.113.46',
        port: 5236,
        username: 'monquery',
        password_encrypted: '',
        database_name: null,
      }], undefined]),
    };
    mocks.getPool.mockReturnValue(pool);
    mocks.decryptData.mockImplementationOnce(() => {
      throw new Error('empty ciphertext must not be decrypted');
    });

    await expect(instanceDatabaseService.getInstanceWithDecryptedPassword(46)).resolves.toMatchObject({
      id: 46,
      username: 'monquery',
      password: '',
    });
  });
});
