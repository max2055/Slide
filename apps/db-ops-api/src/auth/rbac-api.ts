/**
 * RBAC 管理 API 路由
 * 在 /api/v1/rbac/* 下提供角色、权限、用户-角色绑定、实例权限的管理端点
 *
 * 所有端点均要求 admin:* 权限
 */

import { FastifyInstance } from 'fastify';
import { RbacService } from './rbac-service.js';
import { requirePermission } from './require-permission.js';

const rbacService = new RbacService();

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
      preHandler: [verifyToken, requirePermission('admin:*')],
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
      preHandler: [verifyToken, requirePermission('admin:*')],
    }, async (request, reply) => {
      try {
        const { name, description } = request.body as { name: string; description?: string };
        if (!name || typeof name !== 'string' || name.length < 1 || name.length > 50) {
          return reply.code(400).send({ error: '角色名称为必填项，长度 1-50 字符' });
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
      preHandler: [verifyToken, requirePermission('admin:*')],
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
      preHandler: [verifyToken, requirePermission('admin:*')],
    }, async (request, reply) => {
      try {
        const { id } = request.params as any;
        const { name, description } = request.body as { name?: string; description?: string };
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
      preHandler: [verifyToken, requirePermission('admin:*')],
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
      preHandler: [verifyToken, requirePermission('admin:*')],
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
      preHandler: [verifyToken, requirePermission('admin:*')],
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
        if (!code || !/^[a-z_]+:[a-z_]+$/.test(code)) {
          return reply.code(400).send({ error: '权限代码格式必须为 resource:action（如 instance:view）' });
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
      preHandler: [verifyToken, requirePermission('admin:*')],
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
      preHandler: [verifyToken, requirePermission('admin:*')],
    }, async (request, reply) => {
      try {
        const { roleId } = request.params as any;
        const { permissionId } = request.body as { permissionId: number };
        if (!permissionId || !Number.isInteger(Number(permissionId)) || Number(permissionId) <= 0) {
          return reply.code(400).send({ error: 'permissionId 必须为正整数' });
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
      preHandler: [verifyToken, requirePermission('admin:*')],
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
      preHandler: [verifyToken, requirePermission('admin:*')],
    }, async (request, reply) => {
      try {
        const { roleId } = request.params as any;
        const permissions = await rbacService.getRolePermissions(Number(roleId));
        reply.send(permissions);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    // =========================================================
    // User-Role assignment
    // =========================================================

    // 为用户分配角色
    fastify.post('/users/:userId/roles', {
      preHandler: [verifyToken, requirePermission('admin:*')],
    }, async (request, reply) => {
      try {
        const { userId } = request.params as any;
        const { roleId } = request.body as { roleId: number };
        if (!roleId || !Number.isInteger(Number(roleId)) || Number(roleId) <= 0) {
          return reply.code(400).send({ error: 'roleId 必须为正整数' });
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
      preHandler: [verifyToken, requirePermission('admin:*')],
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
      preHandler: [verifyToken, requirePermission('admin:*')],
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
      preHandler: [verifyToken, requirePermission('admin:*')],
    }, async (request, reply) => {
      try {
        const { userId } = request.params as any;
        const { instanceId, accessLevel } = request.body as { instanceId: number; accessLevel?: string };
        if (!instanceId || !Number.isInteger(Number(instanceId)) || Number(instanceId) <= 0) {
          return reply.code(400).send({ error: 'instanceId 必须为正整数' });
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
      preHandler: [verifyToken, requirePermission('admin:*')],
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
      preHandler: [verifyToken, requirePermission('admin:*')],
    }, async (request, reply) => {
      try {
        const { userId } = request.params as any;
        const instances = await rbacService.getUserInstanceAccess(Number(userId));
        reply.send(instances);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

  }, { prefix: '/api/v1/rbac' });
}
