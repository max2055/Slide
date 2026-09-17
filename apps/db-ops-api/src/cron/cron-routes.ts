import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { CronJob } from 'cron';
import { cronJobService } from './cron-job-service.js';
import { scriptService } from './script-service.js';
import type { CronManager } from './cron-manager.js';
import { bindScript } from './script-policy.js';
import { sqlExecutor } from '../sql-executor.js';
import { requirePermission } from '../auth/require-permission.js';
import { getAccessibleInstanceIds, hasInstanceAccess, hasUnrestrictedInstanceAccess } from '../auth/require-instance-access.js';
import { expensiveOperationRateLimitConfig } from '../security/http-security.js';

export function registerCronRoutes(fastify: FastifyInstance, verifyToken: preHandlerHookHandler, getCronManager: () => CronManager) {
  async function bindJobScript(request: any, body: any, existing?: any) {
    const target = body.target_instance_id === undefined ? existing?.target_instance_id ?? null : body.target_instance_id;
    if (target !== null && (!Number.isSafeInteger(target) || target <= 0)) throw new Error('CRON_INVALID_TARGET');
    const taskType = body.task_type ?? existing?.task_type ?? 'agent';
    if (!['agent', 'script'].includes(taskType)) throw new Error('CRON_INVALID_TASK_TYPE');
    if (taskType !== 'script') return null;
    if (existing?.script_binding && body.script_id === undefined && body.target_instance_id === undefined &&
        body.task_type === undefined && body.control_sql_capability === undefined) return existing.script_binding;
    const scriptId = body.script_id === undefined ? existing?.script_id : body.script_id;
    if (!Number.isSafeInteger(scriptId) || scriptId <= 0) throw new Error('CRON_SCRIPT_REQUIRED');
    const script = await scriptService.getScriptById(scriptId);
    if (!script) throw new Error('CRON_SCRIPT_NOT_FOUND');
    // Only server-authorized actor identity is persisted; request bindings are ignored.
    return bindScript(script, target, body.control_sql_capability, String(request.user.userId ?? request.user.id ?? request.user.username));
  }

  // ========== Cron 任务管理 API ==========

  async function requireCronJobAccess(request: any, reply: any, jobId: number, minLevel: 'read-only' | 'read-write' = 'read-only') {
    const job = await cronJobService.getJobById(jobId);
    const allowed = job && (job.target_instance_id == null
      ? hasUnrestrictedInstanceAccess(request.user)
      : hasInstanceAccess(request.user, Number(job.target_instance_id), minLevel));
    if (!allowed) {
      reply.code(404).send({ error: '定时任务不存在' });
      return null;
    }
    return job;
  }

  // 获取所有定时任务
  fastify.get('/api/cron/jobs', {
    preHandler: [verifyToken, requirePermission('cron:view')],
    handler: async (request, reply) => {
      try {
        const jobs = await cronJobService.getJobs(getAccessibleInstanceIds((request as any).user));
        reply.send(jobs);
      } catch (error: any) {
        reply.code(error.message === 'CRON_SCRIPT_ACCESS_DENIED' ? 403 : error.message?.startsWith('CRON_') ? 400 : 500).send({ error: error.message });
      }
    }
  });

  // 获取单个定时任务
  fastify.get('/api/cron/jobs/:id', {
    preHandler: [verifyToken, requirePermission('cron:view')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const job = await requireCronJobAccess(request, reply, Number(id));
        if (!job) return;
        reply.send(job);
      } catch (error: any) {
        reply.code(error.message === 'CRON_SCRIPT_ACCESS_DENIED' ? 403 : error.message?.startsWith('CRON_') ? 400 : 500).send({ error: error.message });
      }
    }
  });

  // 新建定时任务
  fastify.post('/api/cron/jobs', {
    preHandler: [verifyToken, requirePermission('cron:manage')],
    handler: async (request, reply) => {
      try {
        const body = request.body as any;

        // Validate required fields
        if (!body.name || !body.task_description || !body.cron_expr) {
          return reply.code(400).send({ error: '缺少必要参数：name, task_description, cron_expr' });
        }
        if (body.target_instance_id == null) {
          if (!hasUnrestrictedInstanceAccess((request as any).user)) {
            return reply.code(403).send({ error: '创建全局定时任务需要不受限的实例管理权限' });
          }
        } else if (!hasInstanceAccess((request as any).user, Number(body.target_instance_id), 'read-write')) {
          return reply.code(403).send({ error: '无权以读写级别访问目标实例' });
        }

        // Validate cron expression
        try {
          new CronJob(body.cron_expr, () => {});
        } catch {
          return reply.code(400).send({ error: '无效的 cron 表达式' });
        }

        const scriptBinding = await bindJobScript(request, body);
        const id = await cronJobService.createJob({
          name: body.name,
          task_description: body.task_description,
          cron_expr: body.cron_expr,
          task_type: body.task_type,
          script_id: body.script_id,
          script_binding: scriptBinding,
          target_instance_id: body.target_instance_id,
          timezone: body.timezone,
          description: body.description,
          timeout_seconds: body.timeout_seconds,
          retry_count: body.retry_count,
        });

        await getCronManager().reload();
        reply.code(201).send({ id, message: '创建成功' });
      } catch (error: any) {
        reply.code(error.message === 'CRON_SCRIPT_ACCESS_DENIED' ? 403 : error.message?.startsWith('CRON_') ? 400 : 500).send({ error: error.message });
      }
    }
  });

  // 更新定时任务
  fastify.put('/api/cron/jobs/:id', {
    preHandler: [verifyToken, requirePermission('cron:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const body = request.body as any;

        const existing = await requireCronJobAccess(request, reply, Number(id), 'read-write');
        if (!existing) return;
        if (body.target_instance_id !== undefined) {
          if (body.target_instance_id == null) {
            if (!hasUnrestrictedInstanceAccess((request as any).user)) {
              return reply.code(403).send({ error: '创建全局定时任务需要不受限的实例管理权限' });
            }
          } else if (!hasInstanceAccess((request as any).user, Number(body.target_instance_id), 'read-write')) {
            return reply.code(403).send({ error: '无权以读写级别访问目标实例' });
          }
        }

        // Validate cron expression if provided
        if (body.cron_expr) {
          try {
            new CronJob(body.cron_expr, () => {});
          } catch {
            return reply.code(400).send({ error: '无效的 cron 表达式' });
          }
        }

        const scriptBinding = await bindJobScript(request, body, existing);
        const updated = await cronJobService.updateJob(Number(id), {
          task_description: body.task_description,
          cron_expr: body.cron_expr,
          enabled: body.enabled,
          task_type: body.task_type,
          script_id: body.script_id,
          script_binding: scriptBinding,
          target_instance_id: body.target_instance_id,
          timezone: body.timezone,
          description: body.description,
          timeout_seconds: body.timeout_seconds,
          retry_count: body.retry_count,
        });

        if (!updated) {
          return reply.code(400).send({ error: '没有可更新的字段' });
        }

        // Reload CronManager to apply changes
        await getCronManager().reload();

        reply.send({ message: '更新成功' });
      } catch (error: any) {
        reply.code(error.message === 'CRON_SCRIPT_ACCESS_DENIED' ? 403 : error.message?.startsWith('CRON_') ? 400 : 500).send({ error: error.message });
      }
    }
  });

  // 启停定时任务
  fastify.post('/api/cron/jobs/:id/toggle', {
    preHandler: [verifyToken, requirePermission('cron:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const body = request.body as any;

        if (body.enabled === undefined) {
          return reply.code(400).send({ error: '缺少 enabled 参数' });
        }

        const existing = await requireCronJobAccess(request, reply, Number(id), 'read-write');
        if (!existing) return;

        await cronJobService.toggleJob(Number(id), body.enabled);

        // Reload CronManager to apply changes
        await getCronManager().reload();

        reply.send({ message: body.enabled ? '已启用' : '已停用' });
      } catch (error: any) {
        reply.code(error.message === 'CRON_SCRIPT_ACCESS_DENIED' ? 403 : error.message?.startsWith('CRON_') ? 400 : 500).send({ error: error.message });
      }
    }
  });

  // 手动触发定时任务（通过 CronManager.executeJob 处理 script/agent 分支）
  fastify.post('/api/cron/jobs/:id/run', {
    preHandler: [verifyToken, requirePermission('cron:manage')],
    handler: async (request, reply) => {
      const startTime = Date.now();
      try {
        const { id } = request.params as any;
        const config = await requireCronJobAccess(request, reply, Number(id), 'read-write');
        if (!config) return;

        // Route through CronManager.executeJob() which handles task_type branching:
        // script jobs → executeScriptJob() (SqlExecutor), agent jobs → cronExecutor.execute()
        await getCronManager().executeJob(config);

        reply.send({ message: '执行完成' });
      } catch (error: any) {
        reply.code(error.message === 'CRON_SCRIPT_ACCESS_DENIED' ? 403 : error.message?.startsWith('CRON_') ? 400 : 500).send({ error: error.message });
      }
    }
  });

  // 删除定时任务
  fastify.delete('/api/cron/jobs/:id', {
    preHandler: [verifyToken, requirePermission('cron:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;

        const existing = await requireCronJobAccess(request, reply, Number(id), 'read-write');
        if (!existing) return;

        const deleted = await cronJobService.deleteJob(Number(id));
        if (!deleted) {
          return reply.code(500).send({ error: '删除失败，数据库操作未生效' });
        }
        await getCronManager().reload();
        reply.send({ message: '删除成功' });
      } catch (error: any) {
        reply.code(error.message === 'CRON_SCRIPT_ACCESS_DENIED' ? 403 : error.message?.startsWith('CRON_') ? 400 : 500).send({ error: error.message });
      }
    }
  });

  // Cron 表达式预览：返回接下来 5 次执行时间
  fastify.get('/api/cron/jobs/preview', {
    preHandler: [verifyToken, requirePermission('cron:view')],
    handler: async (request, reply) => {
      try {
        const { expr } = request.query as { expr?: string };
        if (!expr) {
          return reply.code(400).send({ error: '缺少 expr 参数', dates: [] });
        }
        const job = new CronJob(expr, () => {});
        const dates = job.nextDates(5).map((d: any) => d.toISOString?.() ?? d);
        reply.send({ dates });
      } catch {
        reply.code(400).send({ error: '无效的 cron 表达式', dates: [] });
      }
    }
  });

  // 获取定时任务执行日志
  fastify.get('/api/cron/jobs/:id/logs', {
    preHandler: [verifyToken, requirePermission('cron:view')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        if (!await requireCronJobAccess(request, reply, Number(id))) return;
        const query = request.query as any;
        const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
        const offset = Math.max(Number(query.offset) || 0, 0);

        const result = await cronJobService.getLogs(Number(id), limit, offset);
        reply.send(result);
      } catch (error: any) {
        reply.code(error.message === 'CRON_SCRIPT_ACCESS_DENIED' ? 403 : error.message?.startsWith('CRON_') ? 400 : 500).send({ error: error.message });
      }
    }
  });

  // ========== Script管理 API ==========

  // 获取所有脚本
  fastify.get('/api/cron/scripts', {
    preHandler: [verifyToken, requirePermission('cron:view')],
    handler: async (request, reply) => {
      try {
        const scripts = await scriptService.getAllScripts();
        reply.send(scripts);
      } catch (error: any) {
        reply.code(error.message === 'CRON_SCRIPT_ACCESS_DENIED' ? 403 : error.message?.startsWith('CRON_') ? 400 : 500).send({ error: error.message });
      }
    }
  });

  // 获取单个脚本详情
  fastify.get('/api/cron/scripts/:id', {
    preHandler: [verifyToken, requirePermission('cron:view')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const script = await scriptService.getScriptById(Number(id));
        if (!script) return reply.code(404).send({ error: '脚本不存在' });
        reply.send(script);
      } catch (error: any) {
        reply.code(error.message === 'CRON_SCRIPT_ACCESS_DENIED' ? 403 : error.message?.startsWith('CRON_') ? 400 : 500).send({ error: error.message });
      }
    }
  });

  // 新建脚本
  fastify.post('/api/cron/scripts', {
    preHandler: [verifyToken, requirePermission('cron:manage')],
    handler: async (request, reply) => {
      try {
        const body = request.body as any;

        if (!body.name || typeof body.name !== 'string') {
          return reply.code(400).send({ error: '缺少必要参数：name' });
        }
        if (!body.content || typeof body.content !== 'string' || !body.content.trim()) {
          return reply.code(400).send({ error: '缺少必要参数：content' });
        }
        const validDbTypes = ['mysql', 'postgresql', 'oracle', 'dameng', 'mongodb', 'redis', 'elasticsearch'];
        if (!body.target_db_type || !validDbTypes.includes(body.target_db_type)) {
          return reply.code(400).send({ error: `无效的 target_db_type，可选值：${validDbTypes.join(', ')}` });
        }

        const id = await scriptService.createScript({
          name: body.name,
          description: body.description,
          content: body.content,
          target_db_type: body.target_db_type,
          script_type: body.script_type || 'sql',
        });

        reply.code(201).send({ id, message: '创建成功' });
      } catch (error: any) {
        reply.code(error.message === 'CRON_SCRIPT_ACCESS_DENIED' ? 403 : error.message?.startsWith('CRON_') ? 400 : 500).send({ error: error.message });
      }
    }
  });

  // 更新脚本
  fastify.put('/api/cron/scripts/:id', {
    preHandler: [verifyToken, requirePermission('cron:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const body = request.body as any;

        const existing = await scriptService.getScriptById(Number(id));
        if (!existing) return reply.code(404).send({ error: '脚本不存在' });

        const updated = await scriptService.updateScript(Number(id), {
          name: body.name,
          description: body.description,
          content: body.content,
          target_db_type: body.target_db_type,
          script_type: body.script_type,
        }, (request as any).user);

        if (!updated) {
          return reply.code(400).send({ error: '没有可更新的字段' });
        }

        reply.send({ message: '更新成功' });
      } catch (error: any) {
        reply.code(error.message === 'CRON_SCRIPT_ACCESS_DENIED' ? 403 : error.message?.startsWith('CRON_') ? 400 : 500).send({ error: error.message });
      }
    }
  });

  // 删除脚本
  fastify.delete('/api/cron/scripts/:id', {
    preHandler: [verifyToken, requirePermission('cron:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;

        const existing = await scriptService.getScriptById(Number(id));
        if (!existing) return reply.code(404).send({ error: '脚本不存在' });

        await scriptService.deleteScript(Number(id), (request as any).user);
        reply.send({ message: '删除成功' });
      } catch (error: any) {
        reply.code(error.message === 'CRON_SCRIPT_ACCESS_DENIED' ? 403 : error.message?.startsWith('CRON_') ? 400 : 500).send({ error: error.message });
      }
    }
  });

  // 测试执行脚本（dry-run，结果限制100行）
  fastify.post('/api/cron/scripts/:id/test', {
    config: { rateLimit: expensiveOperationRateLimitConfig },
    preHandler: [verifyToken, requirePermission('cron:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const body = request.body as any;

        if (!body.instance_id || typeof body.instance_id !== 'number') {
          return reply.code(400).send({ error: '缺少必要参数：instance_id（数字类型）' });
        }
        if (!hasInstanceAccess((request as any).user, Number(body.instance_id), 'read-only')) {
          return reply.code(403).send({ error: '无权访问该实例' });
        }

        const script = await scriptService.getScriptById(Number(id));
        if (!script) return reply.code(404).send({ error: '脚本不存在' });

        const result = await sqlExecutor.executeSql(body.instance_id, script.content, {
          database: body.database || undefined,
        });

        // Limit rows returned to 100 to avoid large payloads
        if (result.rows && result.rows.length > 100) {
          result.rows = result.rows.slice(0, 100);
          result.rowCount = result.rows.length;
        }

        reply.send(result);
      } catch (error: any) {
        reply.code(error.message === 'CRON_SCRIPT_ACCESS_DENIED' ? 403 : error.message?.startsWith('CRON_') ? 400 : 500).send({ error: error.message });
      }
    }
  });

}
