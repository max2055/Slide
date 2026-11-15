import { describe, expect, it, vi } from 'vitest';
import type mysql from 'mysql2/promise';
import { AuthDatabaseService } from './auth-database-service.js';

// MAX-676 D1: profile updates must share the existing session revocation transaction.
function fixture(failAt?: 'profile' | 'revoke', affectedRows = 1) {
  const execute = vi.fn(async (sql: string, _values: unknown[]) => {
    if (failAt === 'profile' && sql.startsWith('UPDATE users')) throw new Error('profile unavailable');
    if (failAt === 'revoke' && sql.startsWith('UPDATE refresh_tokens')) throw new Error('revocation unavailable');
    return [{ affectedRows }];
  });
  const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() };
  const pool = { getConnection: vi.fn(async () => connection), execute: vi.fn() };
  return { connection, pool, service: new AuthDatabaseService(() => pool as unknown as mysql.Pool) };
}

describe('MAX-676 D1 atomic user update', () => {
  it('writes explicit empty email with status in one user mutation and revokes sessions before commit', async () => {
    const { service, connection, pool } = fixture();
    expect(await service.updateUserById(42, { status: 'inactive', email: '' })).toEqual({ success: true });
    const [sql, values] = connection.execute.mock.calls[0];
    expect(sql).toContain('email = ?');
    expect(sql).toContain('status = ?');
    expect(sql).toContain('session_version = session_version + 1');
    expect(values).toContain('');
    expect(values).toContain('inactive');
    expect(connection.execute).toHaveBeenCalledTimes(2);
    expect(connection.execute.mock.calls[1]).toEqual(['UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = ?', [42]]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.execute.mock.invocationCallOrder[1]).toBeLessThan(connection.commit.mock.invocationCallOrder[0]);
    expect(pool.execute).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  for (const failAt of ['profile', 'revoke'] as const) it(`rolls back without committing on ${failAt} failure`, async () => {
    const { service, connection } = fixture(failAt);
    expect((await service.updateUserById(42, { status: 'inactive', email: '' })).success).toBe(false);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('preserves historical status-only callers and omits email from SQL', async () => {
    const { service, connection } = fixture();
    expect(await service.updateUserById(42, { status: 'locked' })).toEqual({ success: true });
    expect(connection.execute.mock.calls[0][0]).not.toContain('email');
    expect(connection.execute.mock.calls[0][1]).toEqual(['locked', 42]);
    expect(connection.execute).toHaveBeenCalledTimes(2);
  });

  it('email-only retains status and does not invalidate sessions', async () => {
    const { service, connection } = fixture();
    expect(await service.updateUserById(42, { email: '' })).toEqual({ success: true });
    expect(connection.execute.mock.calls[0][0]).not.toContain('status');
    expect(connection.execute.mock.calls[0][0]).not.toContain('session_version');
    expect(connection.execute.mock.calls[0][1]).toEqual(['', 42]);
    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it('nonexistent users do not revoke sessions', async () => {
    const { service, connection } = fixture(undefined, 0);
    expect(await service.updateUserById(42, { email: '' })).toEqual({ success: false, error: '用户不存在' });
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.execute).toHaveBeenCalledTimes(1);
  });

  it('an empty update performs no mutation', async () => {
    const { service, pool } = fixture();
    expect((await service.updateUserById(42, {})).success).toBe(false);
    expect(pool.getConnection).not.toHaveBeenCalled();
  });
});
