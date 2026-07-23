/**
 * requirePermission 中间件单元测试
 *
 * 权限只来自 verifyToken 构建的 ActorContext 快照。
 */

import { describe, it, expect, vi } from 'vitest';

import { requirePermission } from './require-permission.js';

describe('requirePermission middleware', () => {
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
    const request = { user: { userId: 1, username: 'test', permissions: ['alert:view'] } };
    const reply = makeReply();

    await requirePermission('instance:view')(request as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: '权限不足' });
  });

  it('should pass when user has direct permission match', async () => {
    const request = { user: { userId: 1, username: 'test', permissions: ['instance:view'] } };
    const reply = makeReply();

    await requirePermission('instance:view')(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('should pass when user has resource wildcard that covers required code', async () => {
    const request = { user: { userId: 1, username: 'test', permissions: ['instance:*'] } };
    const reply = makeReply();

    await requirePermission('instance:view')(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('should pass when multiple codes required and user has at least one', async () => {
    const request = { user: { userId: 1, username: 'test', permissions: ['alert:view'] } };
    const reply = makeReply();

    await requirePermission('instance:view', 'alert:view')(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('should pass with super admin wildcard *', async () => {
    const request = { user: { userId: 1, username: 'test', permissions: ['*'] } };
    const reply = makeReply();

    await requirePermission('anything:anything')(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('should pass when user has action wildcard *:action', async () => {
    const request = { user: { userId: 1, username: 'test', permissions: ['*:view'] } };
    const reply = makeReply();

    await requirePermission('instance:view')(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });
});
