/**
 * RBAC 管理 API 路由
 * 在 /api/v1/rbac/* 下提供角色、权限、用户-角色绑定、实例权限的管理端点
 *
 * 所有端点均要求 admin:* 权限
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RbacService } from './rbac-service.js';
import { requirePermission } from './require-permission.js';

const rbacService = new RbacService();

function isPositiveId(value: unknown): boolean {
  return (typeof value === 'number' || (typeof value === 'string' && /^[0-9]+$/.test(value)))
    && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

// Run after authentication/authorization, before destructuring or accessing storage.
async function validateRbacInput(request: FastifyRequest, reply: FastifyReply) {
  for (const [name, value] of Object.entries(request.params ?? {})) {
    if (!isPositiveId(value)) {
      return reply.code(400).send({ error: `${name} 必须为正安全整数` });
    }
  }
  if (request.method === 'POST' || request.method === 'PUT') {
    const body = request.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(body))) {
      return reply.code(400).send({ error: '请求体必须为 JSON 对象' });
    }
  }
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function validDescription(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.length <= 255);
}

export async function rbacApiRoutes(fastify: FastifyInstance, _options: any) {
  // verifyToken 由调用者传入，在 Plan 03 中直接从 server.ts 导入
  // 这里通过装饰器模式注入
  const verifyToken = (fastify as any).verifyToken;

  fastify.register(async function rbacScope(fastify) {

    // =========================================================
    // Roles
    // =========================================================

    // 列出所有角色
    fastify.get('/roles', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (_request, reply) => {
      try {
        const roles = await rbacService.listRoles();
        reply.send(roles);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    // 创建角色
    fastify.post('/roles', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      try {
        const { name, description } = request.body as { name: string; description?: string };
        if (!validText(name, 50)) {
          return reply.code(400).send({ error: '角色名称为必填项，长度 1-50 字符' });
        }
        if (!validDescription(description)) {
          return reply.code(400).send({ error: '描述必须为不超过 255 字符的字符串或 null' });
        }
        const result = await rbacService.createRole(name, description);
        if (!result.success) {
          return reply.code(400).send({ error: result.error });
        }
        reply.code(201).send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    // 获取角色详情
    fastify.get('/roles/:id', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      try {
        const { id } = request.params as any;
        const role = await rbacService.getRole(Number(id));
        if (!role) {
          return reply.code(404).send({ error: '角色不存在' });
        }
        reply.send(role);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    // 更新角色
    fastify.put('/roles/:id', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      try {
        const { id } = request.params as any;
        const { name, description } = request.body as { name?: string; description?: string };
        if (name !== undefined && !validText(name, 50)) {
          return reply.code(400).send({ error: '角色名称长度为 1-50 字符' });
        }
        if (!validDescription(description)) {
          return reply.code(400).send({ error: '描述必须为不超过 255 字符的字符串或 null' });
        }
        const result = await rbacService.updateRole(Number(id), { name, description });
        if (!result.success) {
          return reply.code(400).send({ error: result.error });
        }
        reply.send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    // 删除角色
    fastify.delete('/roles/:id', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      try {
        const { id } = request.params as any;
        const result = await rbacService.deleteRole(Number(id));
        if (!result.success) {
          return reply.code(400).send({ error: result.error });
        }
        reply.send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    // =========================================================
    // Permissions
    // =========================================================

    // 列出所有权限（支持按资源过滤）
    fastify.get('/permissions', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      try {
        const { resource } = request.query as { resource?: string };
        const permissions = await rbacService.listPermissions(resource);
        reply.send(permissions);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    // 创建权限
    fastify.post('/permissions', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      try {
        const { code, name, resource, action, description } = request.body as {
          code: string;
          name: string;
          resource: string;
          action: string;
          description?: string;
        };

        // 验证 code 格式: resource:action (D-01)
        if (!validText(code, 100) || !/^[a-z_]+:[a-z_]+$/.test(code)) {
          return reply.code(400).send({ error: '权限代码格式必须为 resource:action（如 instance:view）' });
        }
        if (!validText(name, 100) || !validText(resource, 50) || !validText(action, 50)) {
          return reply.code(400).send({ error: '权限名称、resource、action 为必填字符串，长度分别为 1-100、1-50、1-50 字符' });
        }
        if (code !== `${resource}:${action}`) {
          return reply.code(400).send({ error: '权限代码必须与 resource:action 一致' });
        }
        if (!validDescription(description)) {
          return reply.code(400).send({ error: '描述必须为不超过 255 字符的字符串或 null' });
        }

        const result = await rbacService.createPermission(code, name, resource, action, description);
        if (!result.success) {
          return reply.code(400).send({ error: result.error });
        }
        reply.code(201).send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    // 删除权限
    fastify.delete('/permissions/:id', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      try {
        const { id } = request.params as any;
        const result = await rbacService.deletePermission(Number(id));
        if (!result.success) {
          return reply.code(400).send({ error: result.error });
        }
        reply.send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    // =========================================================
    // Role-Permission assignment
    // =========================================================

    // 为角色分配权限
    fastify.post('/roles/:roleId/permissions', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      try {
        const { roleId } = request.params as any;
        const { permissionId } = request.body as { permissionId: number };
        if (!isPositiveId(permissionId)) {
          return reply.code(400).send({ error: 'permissionId 必须为正安全整数' });
        }
        const result = await rbacService.assignPermissionToRole(Number(roleId), Number(permissionId));
        if (!result.success) {
          return reply.code(400).send({ error: result.error });
        }
        reply.code(201).send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    // 撤销角色权限
    fastify.delete('/roles/:roleId/permissions/:permissionId', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      try {
        const { roleId, permissionId } = request.params as any;
        const result = await rbacService.revokePermissionFromRole(Number(roleId), Number(permissionId));
        if (!result.success) {
          return reply.code(400).send({ error: result.error });
        }
        reply.send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    // 获取角色的权限列表
    fastify.get('/roles/:roleId/permissions', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      try {
        const { roleId } = request.params as any;
        const permissions = await rbacService.getRolePermissions(Number(roleId), { strict: true });
        reply.send(permissions);
      } catch {
        reply.code(503).send({ error: "角色权限读取失败，请稍后重试" });
      }
    });

    // =========================================================
    // User-Role assignment
    // =========================================================

    fastify.put('/users/:userId/roles', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      const { userId } = request.params as { userId: string };
      const { roleIds, expectedRoleIds } = request.body as { roleIds: unknown; expectedRoleIds: unknown };
      const validIds = (ids: unknown): ids is number[] => Array.isArray(ids)
        && ids.every(id => typeof id === 'number' && isPositiveId(id)) && new Set(ids).size === ids.length;
      if (!validIds(roleIds) || !validIds(expectedRoleIds)) {
        return reply.code(400).send({ error: 'roleIds 和 expectedRoleIds 必须为无重复的正安全整数数组' });
      }
      const result = await rbacService.replaceUserRoles(Number(userId), roleIds, expectedRoleIds);
      return reply.code(result.success ? 200 : result.conflict ? 409 : 400).send(result);
    });

    // 为用户分配角色
    fastify.post('/users/:userId/roles', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      try {
        const { userId } = request.params as any;
        const { roleId } = request.body as { roleId: number };
        if (!isPositiveId(roleId)) {
          return reply.code(400).send({ error: 'roleId 必须为正安全整数' });
        }
        const result = await rbacService.assignRoleToUser(Number(userId), Number(roleId));
        if (!result.success) {
          return reply.code(400).send({ error: result.error });
        }
        reply.code(201).send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    // 撤销用户角色
    fastify.delete('/users/:userId/roles/:roleId', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      try {
        const { userId, roleId } = request.params as any;
        const result = await rbacService.revokeRoleFromUser(Number(userId), Number(roleId));
        if (!result.success) {
          return reply.code(400).send({ error: result.error });
        }
        reply.send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    // 获取用户的角色列表
    fastify.get('/users/:userId/roles', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      try {
        const { userId } = request.params as any;
        const roles = await rbacService.getUserRoles(Number(userId));
        reply.send(roles);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    // =========================================================
    // Instance permissions
    // =========================================================

    // 授予用户实例访问权限
    fastify.post('/users/:userId/instances', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      try {
        const { userId } = request.params as any;
        const { instanceId, accessLevel } = request.body as { instanceId: number; accessLevel?: string };
        if (!isPositiveId(instanceId)) {
          return reply.code(400).send({ error: 'instanceId 必须为正安全整数' });
        }
        if (accessLevel && !['read-only', 'read-write', 'admin'].includes(accessLevel)) {
          return reply.code(400).send({ error: 'accessLevel 必须为 read-only/read-write/admin 之一' });
        }
        const result = await rbacService.grantInstanceAccess(Number(userId), Number(instanceId), accessLevel || 'read-only');
        if (!result.success) {
          return reply.code(400).send({ error: result.error });
        }
        reply.code(201).send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    // 撤销用户实例访问权限
    fastify.delete('/users/:userId/instances/:instanceId', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      try {
        const { userId, instanceId } = request.params as any;
        const result = await rbacService.revokeInstanceAccess(Number(userId), Number(instanceId));
        if (!result.success) {
          return reply.code(400).send({ error: result.error });
        }
        reply.send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    // 获取用户可访问的实例列表（含 access_level）
    fastify.get('/users/:userId/instances', {
      preHandler: [verifyToken, requirePermission('admin:*'), validateRbacInput],
    }, async (request, reply) => {
      try {
        const { userId } = request.params as any;
        const instances = await rbacService.getUserInstanceAccess(Number(userId), { strict: true });
        reply.send(instances);
      } catch {
        reply.code(503).send({ error: "用户实例权限读取失败，请稍后重试" });
      }
    });

  }, { prefix: '/api/v1/rbac' });
}
