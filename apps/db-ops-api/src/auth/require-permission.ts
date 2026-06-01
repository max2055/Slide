/**
 * 权限检查中间件工厂函数
 * 返回 Fastify preHandler，检查 request.user 是否有指定权限
 *
 * 用法: preHandler: [verifyToken, requirePermission('instance:view')]
 * 注意：必须在 verifyToken 之后运行，依赖 request.user 已设置
 *
 * 通配符支持:
 * - 直接匹配: requirePermission('instance:view') 匹配 Set(['instance:view'])
 * - 资源通配符: requirePermission('instance:view') 匹配 Set(['instance:*'])
 * - 动作通配符: requirePermission('instance:view') 匹配 Set(['*:view'])
 * - 超级管理员: requirePermission('anything:anything') 匹配 Set(['*'])
 */

import { RbacService } from './rbac-service.js';

const rbacService = new RbacService();

export function requirePermission(...requiredCodes: string[]) {
  return async (request: any, reply: any) => {
    const user = (request as any).user;
    if (!user) {
      return reply.code(401).send({ error: '请先登录' });
    }

    const userId = user.userId;
    const userPermissions = await rbacService.getUserPermissions(userId);

    const hasAccess = requiredCodes.some(code => hasPermission(userPermissions, code));
    if (!hasAccess) {
      return reply.code(403).send({ error: '权限不足' });
    }
  };
}

/**
 * 通配符权限匹配函数
 * 检查用户权限集合是否包含指定权限码（支持通配符）
 */
function hasPermission(userPermissions: Set<string>, requiredCode: string): boolean {
  // 直接匹配
  if (userPermissions.has(requiredCode)) return true;

  // 超级管理员通配符
  if (userPermissions.has('*')) return true;

  // 资源通配符: resource:*
  const colonIdx = requiredCode.indexOf(':');
  if (colonIdx !== -1) {
    const resourcePrefix = requiredCode.substring(0, colonIdx) + ':*';
    if (userPermissions.has(resourcePrefix)) return true;
  }

  // 动作通配符: *:action
  if (colonIdx !== -1) {
    const actionSuffix = '*:' + requiredCode.substring(colonIdx + 1);
    if (userPermissions.has(actionSuffix)) return true;
  }

  return false;
}
