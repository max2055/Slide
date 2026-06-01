/**
 * 实例访问检查中间件工厂函数
 * 返回 Fastify preHandler，检查 request.user 是否有权访问指定实例
 *
 * 用法: preHandler: [verifyToken, requirePermission('instance:view'), requireInstanceAccess()]
 * 注意：必须在 verifyToken 之后运行，依赖 request.user 已设置
 *       实例 ID 必须来自 request.params.id（URL 参数），不可来自 request.body
 */

import { RbacService } from './rbac-service.js';

const rbacService = new RbacService();

export type AccessLevel = 'read-only' | 'read-write' | 'admin';

const ACCESS_LEVEL_HIERARCHY: Record<AccessLevel, number> = {
  'read-only': 0,
  'read-write': 1,
  'admin': 2,
};

export function requireInstanceAccess(minLevel?: AccessLevel) {
  return async (request: any, reply: any) => {
    const user = (request as any).user;
    if (!user) {
      return reply.code(401).send({ error: '请先登录' });
    }

    const userId = user.userId;

    // CR-03 fix: Check role-based wildcards before instance_permissions query
    // Admin with '*' or 'instance:*' wildcard passes all instance access checks
    const userPermissions = await rbacService.getUserPermissions(userId);
    if (userPermissions.has('*') || userPermissions.has('instance:*')) {
      return; // Wildcard: user has access to all instances
    }

    // 实例 ID 必须来自 URL 参数（规范规则）
    const instanceId = request.params?.id || request.params?.instanceId;
    if (!instanceId) {
      // 如果 body 中有不同 instanceId，记录警告
      if (request.body && request.body.instanceId !== undefined) {
        console.warn(
          '[rbac] 发现 request.body.instanceId 但 request.params.id 缺失:',
          'body.instanceId =', request.body.instanceId,
          '- 实例 ID 必须来自 URL params'
        );
      }
      return reply.code(400).send({ error: '缺少实例 ID' });
    }

    const accessLevel = await rbacService.checkInstanceAccessLevel(userId, Number(instanceId));
    if (!accessLevel) {
      return reply.code(403).send({ error: '无权访问该实例' });
    }

    if (minLevel) {
      const userNum = ACCESS_LEVEL_HIERARCHY[accessLevel as AccessLevel] ?? -1;
      const requiredNum = ACCESS_LEVEL_HIERARCHY[minLevel];
      if (userNum < requiredNum) {
        return reply.code(403).send({ error: '权限不足，需要 ' + minLevel + ' 级别' });
      }
    }
  };
}
