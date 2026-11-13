/**
 * requireInstanceAccess 中间件单元测试
 *
 * 实例授权只来自 verifyToken 构建的 ActorContext 快照。
 */

import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

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

  it.each([[['instance:view']]])('intersects list, filter and URL access with the boundary for permissions %j', async (permissions) => {
    const user = { permissions, instanceScopes: { 7: 'read-only', 8: 'admin' },
      resourceBoundary: { instanceIds: [7, 9] } } as const;
    expect(getAccessibleInstanceIds(user)).toEqual([7]);
    expect(hasUnrestrictedInstanceAccess(user)).toBe(false);
    expect(filterByInstanceAccess(user, [7, 8, 9], (id) => id)).toEqual([7]);
    for (const id of [8, 9]) {
      expect(hasInstanceAccess(user, id)).toBe(false);
      const reply = makeReply();
      await requireInstanceAccess()({ user, params: { id: String(id) } }, reply);
      expect(reply.code).toHaveBeenCalledWith(403);
    }
    const reply = makeReply();
    await requireInstanceAccess()({ user, params: { instanceId: '7' } }, reply);
    expect(reply.code).not.toHaveBeenCalled();
  });

  // MAX-346 / #497: global grants remain effective inside a resource boundary.
  it.each([{ permissions: ['*'] }, { permissions: ['instance:*'] }, { roles: ['admin'] }])(
    'limits global grant %j to valid boundary IDs without requiring scopes', async (grant) => {
      const user = { ...grant, instanceScopes: {}, resourceBoundary: { instanceIds: [9, 7, 9, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1] } };
      expect(getAccessibleInstanceIds(user)).toEqual([7, 9]);
      expect(hasUnrestrictedInstanceAccess(user)).toBe(false);
      for (const level of ['read-only', 'read-write', 'admin'] as const) {
        expect(hasInstanceAccess(user, 7, level)).toBe(true);
        expect(hasInstanceAccess(user, 8, level)).toBe(false);
      }
      expect(filterByInstanceAccess(user, [7, 8, 9], (id) => id)).toEqual([7, 9]);
      for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(hasInstanceAccess(user, id)).toBe(false);
      }
      const reply = makeReply();
      await requireInstanceAccess('admin')({ user, params: { id: '9' } }, reply);
      expect(reply.code).not.toHaveBeenCalled();
      const globalReply = makeReply();
      await requireUnrestrictedInstanceAccess()({ user }, globalReply);
      expect(globalReply.code).toHaveBeenCalledWith(403);
    },
  );

  it('applies the boundary to the actual get_instance_summary handler', async () => {
    const { instanceDatabaseService } = await import('../instance-database-service.js');
    const { getInstanceSummaryTool } = await import('../tools/ops/get_instance_summary.js');
    const rows = [{ id: 1, name: 'allowed' }, { id: 2, name: 'denied' }];
    const single = vi.spyOn(instanceDatabaseService, 'getInstanceById').mockResolvedValue(rows[0] as any);
    const all = vi.spyOn(instanceDatabaseService, 'getAllInstances').mockResolvedValue(rows as any);
    const context = { actor: { permissions: ['instance:*'], instanceScopes: {}, resourceBoundary: { instanceIds: [1] } } } as any;
    try {
      expect(await getInstanceSummaryTool.handler({ instance_id: 1 }, context)).toMatchObject({ success: true, data: { count: 1 } });
      single.mockClear();
      expect(await getInstanceSummaryTool.handler({ instance_id: 2 }, context)).toMatchObject({ success: false, errorCode: 'INSTANCE_SCOPE_DENIED' });
      expect(single).not.toHaveBeenCalled();
      expect(await getInstanceSummaryTool.handler({}, context)).toMatchObject({ success: true, data: { count: 1, instances: [{ id: 1 }] } });
    } finally {
      single.mockRestore();
      all.mockRestore();
    }
  });

  it('enforces the boundary through a real Fastify HTTP listener', async () => {
    const app = Fastify();
    app.decorateRequest('user', null);
    app.addHook('preHandler', async (request) => {
      (request as any).user = { permissions: ['instance:*'], instanceScopes: {}, resourceBoundary: { instanceIds: [1] } };
    });
    app.get('/instances/:id', { preHandler: requireInstanceAccess('admin') }, async () => ({ allowed: true }));
    app.get('/instances', async (request) => ({ ids: getAccessibleInstanceIds((request as any).user) }));
    app.get('/global', { preHandler: requireUnrestrictedInstanceAccess() }, async () => ({ allowed: true }));
    try {
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      expect((await fetch(`${base}/instances/1`)).status).toBe(200);
      expect((await fetch(`${base}/instances/2`)).status).toBe(403);
      expect((await fetch(`${base}/instances/0`)).status).toBe(400);
      expect((await fetch(`${base}/global`)).status).toBe(403);
      expect(await (await fetch(`${base}/instances`)).json()).toEqual({ ids: [1] });
    } finally {
      await app.close();
    }
  });

  it('preserves scope minimum levels within a boundary', () => {
    const user = { permissions: ['instance:view'], instanceScopes: { 7: 'read-only', 8: 'admin' }, resourceBoundary: { instanceIds: [7, 9] } } as const;
    expect(hasInstanceAccess(user, 7)).toBe(true);
    expect(hasInstanceAccess(user, 7, 'read-write')).toBe(false);
    expect(hasInstanceAccess(user, 8, 'admin')).toBe(false);
    expect(hasInstanceAccess(user, 9)).toBe(false);
    expect(getAccessibleInstanceIds(user)).toEqual([7]);
  });

  it('an empty boundary denies all explicit grants and wildcards', async () => {
    const user = { permissions: ['*'], instanceScopes: { 7: 'admin' }, resourceBoundary: { instanceIds: [] } } as const;
    expect(getAccessibleInstanceIds(user)).toEqual([]);
    const reply = makeReply();
    await requireInstanceAccess()({ user, params: { id: '7' } }, reply);
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it.each(['0', '-1', '1.5', 'NaN', '9007199254740992'])('rejects invalid URL instance ID %s even for an unrestricted actor', async (id) => {
    const reply = makeReply();
    await requireInstanceAccess()({ user: { permissions: ['*'] }, params: { id } }, reply);
    expect(reply.code).toHaveBeenCalledWith(400);
  });

  it('lists only valid access levels and enforces the same default level at the URL boundary', async () => {
    const user = { permissions: [], instanceScopes: { 7: 'unknown', 8: 'read-only' } } as any;
    expect(getAccessibleInstanceIds(user)).toEqual([8]);
    const reply = makeReply();
    await requireInstanceAccess()({ user, params: { id: '7' } }, reply);
    expect(reply.code).toHaveBeenCalledWith(403);
  });
});
