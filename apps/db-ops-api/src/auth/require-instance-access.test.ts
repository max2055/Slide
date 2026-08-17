/**
 * requireInstanceAccess 中间件单元测试
 *
 * 实例授权只来自 verifyToken 构建的 ActorContext 快照。
 */

import { describe, it, expect, vi } from 'vitest';

import {
  filterByInstanceAccess,
  getAccessibleInstanceIds,
  hasInstanceAccess,
  hasUnrestrictedInstanceAccess,
  requireInstanceAccess,
  requireUnrestrictedInstanceAccess,
} from './require-instance-access.js';

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

  it('provides the same fail-closed check for instance IDs resolved from bodies or records', () => {
    const user = { permissions: ['instance:view'], instanceScopes: { 7: 'read-only', 8: 'read-write' } } as const;
    expect(hasInstanceAccess(user, 7, 'read-only')).toBe(true);
    expect(hasInstanceAccess(user, 7, 'read-write')).toBe(false);
    expect(hasInstanceAccess(user, 8, 'read-write')).toBe(true);
    expect(hasInstanceAccess(user, 9, 'read-only')).toBe(false);
    expect(hasInstanceAccess({ permissions: ['instance:*'], instanceScopes: {} }, 9, 'admin')).toBe(true);
  });

  it('filters instance-owned rows without leaking inaccessible instance metadata', () => {
    const user = { permissions: ['instance:view'], instanceScopes: { 7: 'read-only' } } as const;
    const rows = [{ id: 1, instance_id: 7 }, { id: 2, instance_id: 8 }, { id: 3, instance_id: null }];
    expect(filterByInstanceAccess(user, rows, (row) => row.instance_id)).toEqual([
      { id: 1, instance_id: 7 },
      { id: 3, instance_id: null },
    ]);
  });

  it('distinguishes unrestricted actors from actors with an explicit instance set', () => {
    expect(hasUnrestrictedInstanceAccess({ permissions: ['*'] })).toBe(true);
    expect(hasUnrestrictedInstanceAccess({ permissions: ['instance:*'] })).toBe(true);
    expect(hasUnrestrictedInstanceAccess({ permissions: ['instance:view'], instanceScopes: { 8: 'read-only' } })).toBe(false);
    expect(getAccessibleInstanceIds({ permissions: ['instance:view'], instanceScopes: { 8: 'read-only', 3: 'admin' } })).toEqual([3, 8]);
    expect(getAccessibleInstanceIds({ permissions: ['instance:view'], instanceScopes: {} })).toEqual([]);
    expect(getAccessibleInstanceIds({ permissions: ['instance:*'], instanceScopes: {} })).toBeNull();
  });

  it('blocks global instance operations for scoped actors', async () => {
    const reply = makeReply();
    await requireUnrestrictedInstanceAccess()({ user: { permissions: ['collector:manage'], instanceScopes: { 7: 'admin' } } }, reply as any);
    expect(reply.code).toHaveBeenCalledWith(403);

    const unrestrictedReply = makeReply();
    await requireUnrestrictedInstanceAccess()({ user: { permissions: ['instance:*'], instanceScopes: {} } }, unrestrictedReply as any);
    expect(unrestrictedReply.code).not.toHaveBeenCalled();
  });
});
