/**
 * requireInstanceAccess 中间件单元测试
 *
 * 遵循 rbac-service.test.ts 模式: 模拟 dbConnection 层而非 RbacService 类
 * 中间件导入 RbacService 时自动获取模拟的 getPool()
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dbConnection — RbacService 内部使用 getPool()
vi.mock('../db-connection.js', () => ({
  dbConnection: {
    getPool: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

import { requireInstanceAccess } from './require-instance-access.js';
import { dbConnection } from '../db-connection.js';

describe('requireInstanceAccess middleware', () => {
  let mockExecute: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute = vi.fn();
    (dbConnection.getPool as any).mockReturnValue({ execute: mockExecute });
  });

  const makeReply = () => ({
    code: vi.fn().mockReturnThis(),
    send: vi.fn(),
  });

  it('should return 401 when no user in request', async () => {
    const request = { user: undefined, params: { id: '42' } };
    const reply = makeReply();

    await requireInstanceAccess()(request as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: '请先登录' });
  });

  it('should return 400 when request.params.id is missing', async () => {
    const request = { user: { userId: 1, username: 'test' }, params: {} };
    const reply = makeReply();

    await requireInstanceAccess()(request as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ error: '缺少实例 ID' });
  });

  it('should return 403 when checkInstanceAccessLevel returns null', async () => {
    // No rows -> checkInstanceAccessLevel returns null
    mockExecute.mockResolvedValue([[]]);

    const request = { user: { userId: 1, username: 'test' }, params: { id: '42' } };
    const reply = makeReply();

    await requireInstanceAccess()(request as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: '无权访问该实例' });
  });

  it('should pass when checkInstanceAccessLevel returns a valid level', async () => {
    mockExecute.mockResolvedValue([[{ access_level: 'read-only' }]]);

    const request = { user: { userId: 1, username: 'test' }, params: { id: '42' } };
    const reply = makeReply();

    await requireInstanceAccess()(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('should return 403 when user level is below minLevel (read-only < read-write)', async () => {
    // Mock getUserPermissions to return non-wildcard set
    mockExecute
      .mockResolvedValueOnce([[]])                                    // getUserPermissions
      .mockResolvedValueOnce([[{ access_level: 'read-only' }]]);      // checkInstanceAccessLevel

    const request = { user: { userId: 1, username: 'test' }, params: { id: '42' } };
    const reply = makeReply();

    await requireInstanceAccess('read-write')(request as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: '权限不足，需要 read-write 级别' });
  });

  it('should pass when user level meets minLevel', async () => {
    mockExecute
      .mockResolvedValueOnce([[]])                                    // getUserPermissions
      .mockResolvedValueOnce([[{ access_level: 'admin' }]]);          // checkInstanceAccessLevel

    const request = { user: { userId: 1, username: 'test' }, params: { id: '42' } };
    const reply = makeReply();

    await requireInstanceAccess('read-write')(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('should pass wildcard users without level check', async () => {
    // getUserPermissions returns ['*'] -> wildcard, no instance query needed
    mockExecute.mockResolvedValue([[{ code: '*' }]]);

    const request = { user: { userId: 1, username: 'admin' }, params: { id: '42' } };
    const reply = makeReply();

    await requireInstanceAccess('admin')(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('should pass instance:* wildcard users without level check', async () => {
    mockExecute.mockResolvedValue([[{ code: 'instance:*' }]]);

    const request = { user: { userId: 1, username: 'admin' }, params: { id: '42' } };
    const reply = makeReply();

    await requireInstanceAccess('admin')(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });
});
