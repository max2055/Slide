/**
 * 实例访问检查中间件工厂函数
 * 返回 Fastify preHandler，检查 request.user 是否有权访问指定实例
 *
 * 用法: preHandler: [verifyToken, requirePermission('instance:view'), requireInstanceAccess()]
 * 注意：必须在 verifyToken 之后运行，依赖 request.user 已设置
 *       实例 ID 必须来自 request.params.id（URL 参数），不可来自 request.body
 */

export type AccessLevel = 'read-only' | 'read-write' | 'admin';

const ACCESS_LEVEL_HIERARCHY: Record<AccessLevel, number> = {
  'read-only': 0,
  'read-write': 1,
  'admin': 2,
};

type InstanceScopedActor = {
  permissions?: readonly string[];
  instanceScopes?: Readonly<Record<number, AccessLevel>>;
};

export function hasUnrestrictedInstanceAccess(actor: InstanceScopedActor | null | undefined): boolean {
  const permissions = new Set(Array.isArray(actor?.permissions) ? actor.permissions : []);
  return permissions.has('*') || permissions.has('instance:*');
}

/** null means unrestricted; an empty array means no instance access. */
export function getAccessibleInstanceIds(actor: InstanceScopedActor | null | undefined): number[] | null {
  if (hasUnrestrictedInstanceAccess(actor)) return null;
  return Object.keys(actor?.instanceScopes ?? {})
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .sort((a, b) => a - b);
}

export function hasInstanceAccess(
  actor: InstanceScopedActor | null | undefined,
  instanceId: number,
  minLevel: AccessLevel = 'read-only',
): boolean {
  if (!actor || !Number.isSafeInteger(instanceId) || instanceId <= 0) return false;
  if (hasUnrestrictedInstanceAccess(actor)) return true;
  const accessLevel = actor.instanceScopes?.[instanceId];
  return Boolean(accessLevel) && ACCESS_LEVEL_HIERARCHY[accessLevel!] >= ACCESS_LEVEL_HIERARCHY[minLevel];
}

export function filterByInstanceAccess<T>(
  actor: InstanceScopedActor | null | undefined,
  rows: readonly T[],
  instanceIdOf: (row: T) => number | null | undefined,
): T[] {
  return rows.filter((row) => {
    const instanceId = instanceIdOf(row);
    return instanceId == null || hasInstanceAccess(actor, Number(instanceId));
  });
}

export function requireInstanceAccess(minLevel?: AccessLevel) {
  return async (request: any, reply: any) => {
    const user = (request as any).user;
    if (!user) {
      return reply.code(401).send({ error: '请先登录' });
    }

    if (hasUnrestrictedInstanceAccess(user)) {
      return;
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

    const accessLevel = user.instanceScopes?.[Number(instanceId)] as AccessLevel | undefined;
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

export function requireUnrestrictedInstanceAccess() {
  return async (request: any, reply: any) => {
    if (!request.user) return reply.code(401).send({ error: '请先登录' });
    if (!hasUnrestrictedInstanceAccess(request.user)) {
      return reply.code(403).send({ error: '该操作需要不受限的实例管理权限' });
    }
  };
}
