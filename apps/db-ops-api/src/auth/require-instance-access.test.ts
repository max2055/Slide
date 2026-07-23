/**
 * requireInstanceAccess 中间件单元测试
 *
 * 实例授权只来自 verifyToken 构建的 ActorContext 快照。
 */

import { describe, it, expect, vi } from 'vitest';

import { requireInstanceAccess } from './require-instance-access.js';

describe('requireInstanceAccess middleware', () => {
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
    const request = { user: { userId: 1, permissions: [], instanceScopes: {} }, params: {} };
    const reply = makeReply();

    await requireInstanceAccess()(request as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ error: '缺少实例 ID' });
  });

  it('should return 403 when checkInstanceAccessLevel returns null', async () => {
    const request = { user: { userId: 1, permissions: [], instanceScopes: {} }, params: { id: '42' } };
    const reply = makeReply();

    await requireInstanceAccess()(request as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: '无权访问该实例' });
  });

  it('should pass when checkInstanceAccessLevel returns a valid level', async () => {
    const request = {
      user: { userId: 1, permissions: [], instanceScopes: { 42: 'read-only' } },
      params: { id: '42' },
    };
    const reply = makeReply();

    await requireInstanceAccess()(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('should return 403 when user level is below minLevel (read-only < read-write)', async () => {
    const request = {
      user: { userId: 1, permissions: [], instanceScopes: { 42: 'read-only' } },
      params: { id: '42' },
    };
    const reply = makeReply();

    await requireInstanceAccess('read-write')(request as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: '权限不足，需要 read-write 级别' });
  });

  it('should pass when user level meets minLevel', async () => {
    const request = {
      user: { userId: 1, permissions: [], instanceScopes: { 42: 'admin' } },
      params: { id: '42' },
    };
    const reply = makeReply();

    await requireInstanceAccess('read-write')(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('should pass wildcard users without level check', async () => {
    const request = { user: { userId: 1, permissions: ['*'], instanceScopes: {} }, params: { id: '42' } };
    const reply = makeReply();

    await requireInstanceAccess('admin')(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('should pass instance:* wildcard users without level check', async () => {
    const request = { user: { userId: 1, permissions: ['instance:*'], instanceScopes: {} }, params: { id: '42' } };
    const reply = makeReply();

    await requireInstanceAccess('admin')(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });
});
