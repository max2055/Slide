/**
 * requirePermission 中间件单元测试
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

import { requirePermission } from './require-permission.js';
import { dbConnection } from '../db-connection.js';

describe('requirePermission middleware', () => {
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
    const reply = makeReply();
    await requirePermission('instance:view')({ user: undefined } as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: '请先登录' });
  });

  it('should return 403 when user lacks the required permission', async () => {
    // Mock no matching permissions returned
    mockExecute.mockResolvedValue([[{ code: 'alert:view' }]]);

    const request = { user: { userId: 1, username: 'test' } };
    const reply = makeReply();

    await requirePermission('instance:view')(request as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: '权限不足' });
  });

  it('should pass when user has direct permission match', async () => {
    mockExecute.mockResolvedValue([[{ code: 'instance:view' }]]);

    const request = { user: { userId: 1, username: 'test' } };
    const reply = makeReply();

    await requirePermission('instance:view')(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('should pass when user has resource wildcard that covers required code', async () => {
    mockExecute.mockResolvedValue([[{ code: 'instance:*' }]]);

    const request = { user: { userId: 1, username: 'test' } };
    const reply = makeReply();

    await requirePermission('instance:view')(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('should pass when multiple codes required and user has at least one', async () => {
    mockExecute.mockResolvedValue([[{ code: 'alert:view' }]]);

    const request = { user: { userId: 1, username: 'test' } };
    const reply = makeReply();

    await requirePermission('instance:view', 'alert:view')(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('should pass with super admin wildcard *', async () => {
    mockExecute.mockResolvedValue([[{ code: '*' }]]);

    const request = { user: { userId: 1, username: 'test' } };
    const reply = makeReply();

    await requirePermission('anything:anything')(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('should pass when user has action wildcard *:action', async () => {
    mockExecute.mockResolvedValue([[{ code: '*:view' }]]);

    const request = { user: { userId: 1, username: 'test' } };
    const reply = makeReply();

    await requirePermission('instance:view')(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });
});
