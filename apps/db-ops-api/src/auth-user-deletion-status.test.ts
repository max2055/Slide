import { describe, expect, it, vi } from 'vitest';
import type mysql from 'mysql2/promise';
import { AuthDatabaseService } from './auth-database-service.js';

describe('MAX-673 / #492 deletion across user statuses', () => {
  function fixture(status: string, username = 'ordinary') {
    const execute = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT')) {
        return [status === 'nonexistent' || (sql.includes('status = "active"') && status !== 'active')
          ? [] : [{ id: 42, username, status }]];
      }
      return [{ affectedRows: 1 }];
    });
    return { execute, service: new AuthDatabaseService(() => ({ execute }) as unknown as mysql.Pool) };
  }

  for (const status of ['active', 'inactive', 'locked']) {
    it(`deletes an existing ${status} user without changing authentication lookup`, async () => {
      const { service, execute } = fixture(status);
      expect(await service.getUserById(42)).toEqual(status === 'active'
        ? expect.objectContaining({ id: 42 }) : null);
      expect(await service.deleteUserById(42)).toEqual({ success: true });
      expect(execute).toHaveBeenCalledWith('DELETE FROM users WHERE id = ?', [42]);
    });

    it(`protects the ${status} admin account`, async () => {
      const { service, execute } = fixture(status, 'admin');
      expect(await service.deleteUserById(42)).toEqual({ success: false, error: '不能删除管理员账户' });
      expect(execute.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(false);
    });
  }

  it('reports a nonexistent user without attempting deletion', async () => {
    const { service, execute } = fixture('nonexistent');
    expect(await service.deleteUserById(42)).toEqual({ success: false, error: '用户不存在' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('reports lookup failures as deletion failures, without leaking SQL or claiming absence', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('SQL secret details'));
    const service = new AuthDatabaseService(() => ({ execute }) as unknown as mysql.Pool);
    expect(await service.deleteUserById(42)).toEqual({ success: false, error: '删除用户失败，请稍后重试' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
