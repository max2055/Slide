/**
 * Slide - Database Operations API Server
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

// 防止 cron 任务中的未处理异常导致进程退出
process.on('uncaughtException', (err) => {
  console.error('⚠️ 未捕获异常:', err.message);
  process.exitCode = 1;
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ 未处理拒绝:', reason);
  process.exitCode = 1;
});

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { authDatabaseService } from './src/auth-database-service.js';
import { createVerifyToken } from './src/auth-middleware.js';
import {
  actorContextService,
  signAccessToken,
} from './src/auth/actor-context.js';
import { requirePermission } from './src/auth/require-permission.js';
import { requireInstanceAccess } from './src/auth/require-instance-access.js';
import { RbacService } from './src/auth/rbac-service.js';
import { rbacApiRoutes } from './src/auth/rbac-api.js';
import { strictBody, warnUnknown } from './src/utils/strict-body.js';
import { instanceDatabaseService } from './src/instance-database-service.js';
import { llmDatabaseService } from './src/llm-database-service.js';
import { resolveProviderFromBaseUrl, getProvider } from './src/llm/provider-catalog.js';
import { alertDatabaseService } from './src/alert-database-service.js';
import { alertRuleTemplateService } from './src/alert-rule-template-service.js';
import { metricsDatabaseService } from './src/metrics-database-service.js';
import { databaseService } from './src/database-service.js';
import { llmService } from './src/llm-service.js';
import { dbConnection } from './src/db-connection.js';
import { loadSecurityConfig } from './src/config/security-config.js';
import { publicInstanceDto, publicNotificationDto, publicServerDto } from './src/security/public-dto.js';
import { monitorCollector } from './src/monitor-collector.js';
import { chatDatabaseService } from './src/chat-database-service.js';
import { handleChatSend } from './src/chat-handler.js';
import { registerChatRoutes } from './src/chat-routes.js';
import { reportService } from './src/report-service.js';
import { reportDatabaseService } from './src/report-database-service.js';
import { reportConfigService } from './src/report-config-database-service.js';
import { ReportType } from './src/report-database-service.js';
import { reportExporter } from './src/report-exporter.js';
import { alertEngine } from './src/alert-engine.js';
import { notificationDatabaseService } from './src/notification-database-service.js';
import { notificationService } from './src/notification-service.js';
import { schemaService } from './src/schema-service.js';
import { schemaDatabaseService } from './src/schema-database-service.js';
import { indexService } from './src/index-service.js';
import { indexDatabaseService } from './src/index-database-service.js';
import { topsqlAnalysisService } from './src/topsql-analysis-service.js';
import { alertRCAService } from './src/alert-rca-service.js';
import { faultDiagnosisService } from './src/fault-diagnosis-service.js';
import { metricRegistry } from './src/metric-registry.js';
import { metricDatabaseService } from './src/metric-database-service.js';
import { baselineCalculator } from './src/baseline-calculator.js';
import { alertEscalationService } from './src/alert-escalation-service.js';
import { alertSilenceService } from './src/alert-silence-service.js';
import { maintenanceWindowService } from './src/maintenance-window-service.js';
import { alertEventService } from './src/alert-event-service.js';
import { eventAggregator } from './src/event-aggregator.js';
import { capacityPredictor } from './src/capacity-predictor.js';
import { aiAnalysisDatabaseService } from './src/ai-analysis-database-service.js';
import { aiAnalysisConfigService } from './src/ai-analysis-config-service.js';
import { getAgentGreeting } from './src/agent-service.js';
import { scoringConfigService } from './src/scoring-config-service.js';
import { brandingConfigService } from './src/branding-config-service.js';
import { consistencyChecker } from './src/consistency-checker.js';
import { userPreferenceService } from './src/user-preference-service.js';
import { collectionCapabilityTracker } from './src/collection-capabilities.js';
import { resourceService } from './src/resources/resource-service.js';
import { capabilityService } from './src/resources/capability-service.js';
import { observationService } from './src/resources/observation-service.js';
import { sqlAuditService } from './src/sql-audit-service.js';
import { queryAuditLogs, auditLogManager, DatabaseAuditLogStore } from './src/audit/audit-log.js';
import { sqlExecutor } from './src/sql-executor.js';
import { classifySql } from './src/sql-validator.js';
import { PersistentOperationService } from './src/operations/operation-service.js';
import { MigrationRunner } from './src/migrations/runner.js';
import { WorkerLease } from './src/lifecycle/worker-lease.js';
import { JobRegistry } from './src/workflows/job-registry.js';
import { MysqlWorkflowStore, WorkerRuntime } from './src/workflows/worker-runtime.js';
import { createNotificationDispatchJob, isAlertEligibleForChannel, NotificationDispatchScheduler } from './src/workflows/notification-dispatch.js';
import { createReportNotificationJob, createReportScheduleJob, MysqlReportOccurrenceStore, ReportScheduler } from './src/report-scheduler.js';
import { assertCreatableDatabaseType, listAdapterCapabilities } from './src/adapters/capability-matrix.js';
import { approvalService } from './src/approval-service.js';
import { databaseLogService } from './src/database-log-service.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CronJobDatabaseService, cronJobService } from './src/cron/cron-job-service';
import { CronManager } from './src/cron/cron-manager';
import { CronExecutor } from './src/cron/cron-executor';
import { ScriptService, scriptService } from './src/cron/script-service';
import { CronJob } from 'cron';
import { getAgentEngine, createLLMProvider, loadPlatformTools } from './src/adapter/get-agent-engine.js';
import { DirectAdapter } from './src/adapter/direct-adapter.js';
import { AgentRunner } from '@slide/agent-core';
import { agentManagementService } from './src/agent-management-service.js';
import { startSessionCleanup, stopSessionCleanup } from './src/session-cleanup.js';
import { loadPredefinedSkills, skillRegistry } from './src/skills/loader.js';
import { promptManager } from './src/prompts/prompt-manager.js';
import { serverDatabaseService } from './src/server-database-service.js';
import { serverReportService } from './src/server-report-service.js';
import serverCollector from './src/server-collector.js';

const fastify = Fastify({
  logger: false,
});

// JWT 密钥
const securityConfig = loadSecurityConfig();
const JWT_SECRET = securityConfig.jwtSecret || 'development-only-jwt-secret-not-for-production';
const JWT_EXPIRES_IN = '1h';
const rbacService = new RbacService();
const operationService = new PersistentOperationService(() => dbConnection.getPool() as any);
const workflowWorkerId = randomUUID();
// Set only after the control-plane database and worker registry are ready.
let notificationWorkflowStore: MysqlWorkflowStore | undefined;

function approvalOperationLifecycle(actorId: number) {
  return {
    onClaimed: async (approval: { operation_id: string | null; id: number }) => {
      if (approval.operation_id) {
        await operationService.transition(approval.operation_id, 'claimed', 'APPROVAL_CLAIMED', actorId, { approvalRequestId: approval.id });
      }
    },
    onExecutionStarted: async (approval: { operation_id: string | null }) => {
      if (approval.operation_id) await operationService.transition(approval.operation_id, 'running', 'APPROVAL_EXECUTION_STARTED', actorId);
    },
    onCompleted: async (approval: { operation_id: string | null; id: number }, result: { success: boolean; error?: string }, executed: boolean) => {
      if (approval.operation_id) {
        await operationService.transition(
          approval.operation_id,
          result.success ? 'succeeded' : 'failed',
          result.success ? (executed ? 'APPROVAL_EXECUTION_SUCCEEDED' : 'APPROVAL_GRANTED') : 'APPROVAL_EXECUTION_FAILED',
          actorId,
          result.success ? { approvalRequestId: approval.id } : { approvalRequestId: approval.id, error: result.error ?? 'execution_failed' },
        );
      }
    },
    onRejected: async (requestId: number) => {
      const approval = await approvalService.getRequestById(requestId);
      if (approval?.operation_id) {
        await operationService.transition(approval.operation_id, 'cancelled', 'APPROVAL_REJECTED', actorId, { approvalRequestId: requestId });
      }
    },
  };
}

const verifyToken = createVerifyToken(JWT_SECRET, actorContextService);

async function start() {
  // 初始化数据库连接
  console.log('🔄 正在初始化数据库连接...');
  const dbInitialized = await dbConnection.initialize();
  if (!dbInitialized) {
    console.error('❌ 数据库连接失败');
    throw new Error('数据库连接失败');
  }
  console.log('✅ 数据库连接成功');

  // 初始化 SQL 执行历史持久化存储
  const pool = dbConnection.getPool();
  if (!pool) throw new Error('数据库连接池不可用');

  // Fail fast before registering auth routes or starting the WS adapter.
  await new MigrationRunner(pool as any).run();
  console.log('✅ Schema migration ledger is current');

  if (pool) {
    const dbAuditLogStore = new DatabaseAuditLogStore(pool);
    auditLogManager.setPersistentStore(dbAuditLogStore);
    console.log('✅ SQL 执行历史持久化存储已就绪');
  }

  // No timers, connection recovery, or provider work may run before the
  // listener is acquired. A second process must fail without worker effects.
  const initializeControlPlane = async () => {
  // 加载预定义技能到 skillRegistry
  try {
    const skills = await loadPredefinedSkills();
    for (const entry of skills) {
      skillRegistry.register(entry);
    }
    if (skills.length > 0) {
      console.log(`✅ 已加载 ${skills.length} 个 AI 技能`);
    }
  } catch (err) {
    console.warn('⚠️ 加载技能失败:', (err as Error).message);
  }

  // 加载 AI 分析提示词（支持 PROMPT_VERSION 切换）
  await promptManager.initialize();

  // 启动文件监听，支持热重载
  if (process.env.PROMPT_HOT_RELOAD !== 'false') {
    promptManager.startWatch();
  }

  // 启动会话清理服务（自动清理过期会话 + 消息数量限制）
  startSessionCleanup();

  // 初始化 LLM 服务（加载已启用的提供商）
  await llmService.initialize();

  // 自动重连所有 active 实例（服务重启后恢复连接池）
  console.log('🔄 正在恢复数据库连接...');
  try {
    const activeInstances = await instanceDatabaseService.getAllInstances();
    const activeList = (activeInstances || []).filter((inst: any) => inst.status === 'active');
    let reconnected = 0;
    for (const inst of activeList) {
      try {
        const password = await instanceDatabaseService.getInstancePassword(inst.id);
        if (!password) {
          console.warn(`  ⚠️  实例 ${inst.name} (id=${inst.id}) 未配置密码，跳过`);
          continue;
        }
        const ok = await databaseService.addConnection(inst.id, inst.name, {
          host: inst.host,
          port: inst.port,
          user: inst.username,
          password,
          database: inst.database_name || (inst.db_type === 'postgresql' ? 'postgres' : inst.db_type === 'mysql' ? 'mysql' : undefined),
          db_type: inst.db_type,
        });
        if (ok) reconnected++;
      } catch (e: any) {
        console.warn(`  ⚠️  实例 ${inst.name} (id=${inst.id}) 重连失败: ${e.message}`);
      }
    }
    console.log(`✅ 已恢复 ${reconnected}/${activeList.length} 个连接`);
  } catch (e: any) {
    console.warn('⚠️  自动重连失败（不影响启动）:', e.message);
  }

  // 清理过期 refresh tokens（超过30天过期）
  try {
    const deleted = await rbacService.cleanupExpiredRefreshTokens();
    if (deleted > 0) console.log(`🧹 清理了 ${deleted} 个过期的 refresh token`);
  } catch (e: any) {
    console.warn('⚠️ 清理过期 refresh token 失败:', e.message);
  }
  };

  // 注册 CORS
  await fastify.register(cors, {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  });

  // 健康检查
  fastify.get('/api/health', async (request, reply) => {
    reply.send({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  // 一致性健康检查（认证保护）
  fastify.get('/api/health/consistency', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const result = await consistencyChecker.runAllChecks();
      reply.send(result);
    } catch (err: any) {
      reply.code(500).send({ error: err.message });
    }
  });

  fastify.get('/api/health/readiness', { preHandler: [verifyToken] }, async (_request, reply) => {
    try {
      return reply.send(await consistencyChecker.resourceHealthTruth());
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // 手动触发容量采集（认证保护）
  fastify.post('/api/monitor/collect-capacity', { preHandler: [verifyToken] }, async (_request, reply) => {
    try {
      await (monitorCollector as any).collectCapacity();
      reply.send({ message: '容量采集完成' });
    } catch (err: any) {
      reply.code(500).send({ error: err.message });
    }
  });

  // 注册 verifyToken 装饰器供 rbac-api.ts 使用
  fastify.decorate('verifyToken', verifyToken);

  // 注册 RBAC 管理 API
  await fastify.register(rbacApiRoutes);

  // 版本信息（无需认证）
  fastify.get('/api/version', async (_request, reply) => {
    try {
      const [rows] = await dbConnection.getPool()!.query(
        'SELECT config_key, config_value FROM system_config WHERE config_key = ?',
        ['slide_version']
      ) as any;
      const config: Record<string, string> = {};
      for (const r of rows) config[r.config_key] = r.config_value;
      reply.send({
        version: config.slide_version || '1.2.0',
      });
    } catch {
      reply.send({ version: '1.2.0' });
    }
  });

  // ========== 文档查看 API ==========

  /** Doc titles in display order */
  const DOC_TITLES: Record<string, string> = {
    'README.html': '项目概述',
    'ARCHITECTURE.html': '系统架构',
    'PROJECT_STRUCTURE.html': '项目结构',
    'SECURITY.html': '安全机制',
    'USER-GUIDE.html': '用户手册',
    'OPERATIONS.html': '运维部署',
    'DEVELOPMENT-HISTORY.html': '开发历程',
    'DB-OPS-AI.html': '数据库运维与 AI 交互',
  };
  const DOC_ORDER = Object.keys(DOC_TITLES);

  fastify.get('/api/docs/list', { preHandler: [verifyToken] }, async (_request, reply) => {
    try {
      const docsDir = path.resolve(process.cwd(), '..', '..', 'docs', 'slide');
      const files = await fs.readdir(docsDir);
      const htmlFiles = files
        .filter(f => f.endsWith('.html'))
        .map(f => ({
          file: f,
          title: DOC_TITLES[f] || f.replace('.html', '').replace(/-/g, ' ').replace(/_/g, ' '),
        }))
        .sort((a, b) => DOC_ORDER.indexOf(a.file) - DOC_ORDER.indexOf(b.file));
      return reply.send({ docs: htmlFiles });
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to list docs' });
    }
  });

  fastify.get('/api/docs/files/:file', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { file } = request.params as { file: string };
      // Path traversal protection
      if (file.includes('..') || file.includes('/') || file.includes('\\')) {
        return reply.code(400).send({ error: 'Invalid file name' });
      }
      if (!file.endsWith('.html')) {
        return reply.code(400).send({ error: 'Only .html files allowed' });
      }
      const filePath = path.resolve(process.cwd(), '..', '..', 'docs', 'slide', file);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        return reply.header('Content-Type', 'text/html; charset=utf-8').send(content);
      } catch {
        return reply.code(404).send({ error: 'Document not found' });
      }
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to read doc' });
    }
  });

  // 登录接口
  fastify.post('/api/auth/login', async (request, reply) => {
    const check = strictBody(request.body as Record<string, unknown>,
      ['username', 'password'], 'POST /api/auth/login');
    if (check.error) return reply.code(400).send(check.error);
    const { username, password } = check.body as { username: string; password: string };

    if (!username || !password) {
      return reply.code(400).send({ error: '用户名和密码不能为空' });
    }

    try {
      // 验证用户
      const user = await authDatabaseService.getUserByUsername(username);
      if (!user) {
        return reply.code(401).send({ error: '用户名或密码错误' });
      }

      const passwordValid = await authDatabaseService.verifyPassword(username, password);
      if (!passwordValid) {
        return reply.code(401).send({ error: '用户名或密码错误' });
      }

      const actor = await actorContextService.loadActiveActor(
        user.id,
        undefined,
        String(request.id),
      );
      const token = signAccessToken(actor, JWT_SECRET, JWT_EXPIRES_IN);
      const refreshToken = await actorContextService.issueRefreshToken(actor);

      reply.send({
        token,
        refreshToken,
        expiresIn: 3600,
        user: {
          id: actor.userId,
          username: actor.username,
        },
      });
    } catch (error: any) {
      console.error('登录失败:', error);
      reply.code(500).send({ error: '登录失败：' + error.message });
    }
  });

  // ========== Refresh Token API ==========

  fastify.post('/api/auth/refresh', async (request, reply) => {
    const { refreshToken } = request.body as { refreshToken: string };
    if (!refreshToken) return reply.code(400).send({ error: '缺少 refreshToken' });

    try {
      const rotated = await actorContextService.rotateRefreshToken(
        refreshToken,
        String(request.id),
      );
      const newAccessToken = signAccessToken(rotated.actor, JWT_SECRET, JWT_EXPIRES_IN);
      reply.send({
        token: newAccessToken,
        refreshToken: rotated.refreshToken,
        expiresIn: 3600,
      });
    } catch {
      reply.code(401).send({ error: '无效的 refresh token' });
    }
  });

  // ========== 权限查询 API ==========

  fastify.get('/api/auth/permissions', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const user = (request as any).user;
      if (!user) return reply.code(401).send({ error: '请先登录' });
      reply.send([...user.permissions]);
    } catch (error: any) {
      console.error('获取权限失败:', error);
      reply.code(500).send({ error: '获取权限失败：' + error.message });
    }
  });

  // ========== 用户管理 API ==========

  // 列出所有用户
  fastify.get('/api/users', { preHandler: [verifyToken, requirePermission('admin:*')] }, async (request, reply) => {
    try {
      const users = await authDatabaseService.getAllUsers();
      reply.send(users);
    } catch (error: any) {
      reply.code(500).send({ error: '获取用户列表失败：' + error.message });
    }
  });

  // ========== 用户管理 API ==========

  // 创建用户
  fastify.post('/api/users', { preHandler: [verifyToken, requirePermission('admin:*')] }, async (request, reply) => {
    try {
      const check = strictBody(request.body as Record<string, unknown>,
        ['username', 'password', 'email'],
        'POST /api/users',
        { role: '角色分配请使用 POST /api/v1/rbac/users/{userId}/roles' });
      if (check.error) return reply.code(400).send(check.error);
      const { username, password, email } = check.body as { username: string; password: string; email?: string };
      if (!username || !password) {
        return reply.code(400).send({ error: '用户名和密码不能为空' });
      }
      if (password.length < 8) {
        return reply.code(400).send({ error: '密码长度至少 8 位' });
      }
      // role 分配通过 RBAC API (POST /api/v1/rbac/users/:userId/roles) 完成
      const result = await authDatabaseService.createUser(username, password, email);
      if (!result.success) {
        return reply.code(400).send(result);
      }
      reply.code(201).send(result);
    } catch (error: any) {
      reply.code(500).send({ error: '创建用户失败：' + error.message });
    }
  });

  // 更新用户
  fastify.put('/api/users/:id', { preHandler: [verifyToken, requirePermission('admin:*')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const check = strictBody(request.body as Record<string, unknown>,
        ['status', 'email'],
        'PUT /api/users/:id',
        { role: '角色更新请使用 POST/DELETE /api/v1/rbac/users/{userId}/roles' });
      if (check.error) return reply.code(400).send(check.error);
      const { status, email } = check.body as { status?: string; email?: string };
      const validStatuses = ['active', 'inactive', 'locked'];
      if (status && !validStatuses.includes(String(status))) {
        return reply.code(400).send({ error: '无效的状态' });
      }
      // role 更新通过 RBAC API (POST /api/v1/rbac/users/:userId/roles) 完成
      const result = await authDatabaseService.updateUserById(Number(id), { status: String(status) });
      if (!result.success) {
        return reply.code(400).send(result);
      }
      // email update if provided
      if (email && email !== '') {
        try {
          const pool = dbConnection.getPool();
          if (pool) {
            await pool.execute('UPDATE users SET email = ? WHERE id = ?', [email, Number(id)]);
          }
        } catch (_) { /* non-critical */ }
      }
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: '更新用户失败：' + error.message });
    }
  });

  // 删除用户
  fastify.delete('/api/users/:id', { preHandler: [verifyToken, requirePermission('admin:*')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const userId = (request as any).user?.userId;
      if (Number(id) === userId) {
        return reply.code(400).send({ error: '不能删除自己' });
      }
      const result = await authDatabaseService.deleteUserById(Number(id));
      if (!result.success) {
        return reply.code(400).send(result);
      }
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: '删除用户失败：' + error.message });
    }
  });

  // 重置密码
  fastify.post('/api/users/:id/password', { preHandler: [verifyToken, requirePermission('admin:*')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const { password } = request.body as { password: string };
      if (!password || password.length < 8) {
        return reply.code(400).send({ error: '密码长度至少 8 位' });
      }
      const result = await authDatabaseService.changePassword(Number(id), password);
      if (!result.success) {
        return reply.code(400).send(result);
      }
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: '重置密码失败：' + error.message });
    }
  });

  // 获取用户偏好
  fastify.get('/api/user/preferences', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const userId = (request as any).user.userId;
      const preferences = await userPreferenceService.getPreferences(userId);
      reply.send({ preferences });
    } catch (error: any) {
      reply.code(500).send({ error: '获取偏好失败：' + error.message });
    }
  });

  // 保存用户偏好
  fastify.put('/api/user/preferences', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const userId = (request as any).user.userId;
      const { preferences } = request.body as { preferences: Record<string, unknown> };
      if (!preferences || typeof preferences !== 'object') {
        return reply.code(400).send({ error: 'preferences 必须是对象' });
      }
      const result = await userPreferenceService.savePreferences(userId, preferences);
      if (!result.success) {
        return reply.code(400).send(result);
      }
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: '保存偏好失败：' + error.message });
    }
  });

  // 数据库实例列表
  fastify.get('/api/database/instances', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const instances = await instanceDatabaseService.getManagedInstances();
      reply.send(instances.map((instance) => publicInstanceDto(instance as unknown as Record<string, unknown>)));
    } catch (error: any) {
      reply.code(500).send({ error: '获取实例列表失败：' + error.message });
    }
  });

  // ========== LLM 配置管理 API (CRUD) ==========

  async function reloadChatProvider(): Promise<void> {
    const engine = await getAgentEngine();
    if (engine instanceof DirectAdapter) {
      const newProvider = await createLLMProvider();
      engine.setProvider(newProvider);
    }
    await llmService.reloadConfig();
  }

  // 列表
  fastify.get('/api/llm/configs', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const configs = await llmDatabaseService.getAllProviders();
      reply.send(configs);
    } catch (error: any) {
      reply.code(500).send({ error: '获取 LLM 配置失败：' + error.message });
    }
  });

  // 单个
  fastify.get('/api/llm/configs/:id', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const config = await llmDatabaseService.getProviderById(Number(id));
      if (!config) return reply.code(404).send({ error: '提供商不存在' });
      reply.send(config);
    } catch (error: any) {
      reply.code(500).send({ error: '获取 LLM 配置失败：' + error.message });
    }
  });

  // 创建
  fastify.post('/api/llm/configs', { preHandler: [verifyToken, requirePermission('llm:manage')] }, async (request, reply) => {
    try {
      const data = request.body as any;
      const result = await llmDatabaseService.configureProvider(data)
      warnUnknown(data, ['name','displayName','deploymentType','apiKey','apiFormat','model','baseURL','modelsSupported','contextWindow','supportsFunctionCall','supportsVision','inputCostPer1k','outputCostPer1k','enabled','temperature','maxTokens','timeoutMs','rateLimitPerMinute','dailyQuota'], 'POST /api/llm/configs');
      await reloadChatProvider();
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: '创建 LLM 配置失败：' + error.message });
    }
  });

  // 更新
  fastify.put('/api/llm/configs/:id', { preHandler: [verifyToken, requirePermission('llm:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const data = request.body as any;
      const existing = await llmDatabaseService.getProviderById(Number(id));
      if (!existing) return reply.code(404).send({ error: '提供商不存在' });
      const result = await llmDatabaseService.configureProvider({ ...existing, ...data, id: Number(id) });
      await reloadChatProvider();
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: '更新 LLM 配置失败：' + error.message });
    }
  });

  // 删除
  fastify.delete('/api/llm/configs/:id', { preHandler: [verifyToken, requirePermission('llm:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const provider = await llmDatabaseService.getProviderById(Number(id));
      if (!provider) return reply.code(404).send({ error: '提供商不存在' });
      const result = await llmDatabaseService.deleteProvider(provider.name);
      await reloadChatProvider();
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: '删除 LLM 配置失败：' + error.message });
    }
  });

  // 启用/禁用
  fastify.post('/api/llm/configs/:id/toggle', { preHandler: [verifyToken, requirePermission('llm:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const provider = await llmDatabaseService.getProviderById(Number(id));
      if (!provider) return reply.code(404).send({ error: '提供商不存在' });
      const result = await llmDatabaseService.toggleProvider(provider.name, !provider.enabled);
      await reloadChatProvider();
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: '切换状态失败：' + error.message });
    }
  });

  // 设为默认
  fastify.post('/api/llm/configs/:id/default', { preHandler: [verifyToken, requirePermission('llm:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const provider = await llmDatabaseService.getProviderById(Number(id));
      if (!provider) return reply.code(404).send({ error: '提供商不存在' });
      const result = await llmDatabaseService.setDefaultProvider(provider.name);
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: '设置默认失败：' + error.message });
    }
  });

  // 测试连接
  fastify.post('/api/llm/test', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const check = strictBody(request.body as Record<string, unknown>,
          ['providerName'], 'POST /api/llm/test');
        if (check.error) return reply.code(400).send(check.error);
        const { providerName } = check.body as { providerName: string };
      const provider = await llmDatabaseService.getProviderByName(providerName);
      if (!provider) return reply.code(404).send({ error: '提供商不存在' });
      const apiKey = provider.api_key_encrypted
        ? await llmDatabaseService.getProviderApiKey(provider.name)
        : '';
      if (!apiKey) return reply.code(400).send({ success: false, error: '未配置 API Key' });

      // 直接使用 OpenAI SDK 测试，不经过 callLLM
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({
        apiKey,
        baseURL: provider.api_base_url || undefined,
      });
      const response = await client.chat.completions.create({
        model: provider.default_model || 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
      });
      reply.send({
        success: true,
        message: `连接成功，模型: ${response.model || provider.default_model}`,
        provider: providerName,
      });
    } catch (error: any) {
      reply.send({
        success: false,
        error: error.status ? `${error.status} ${error.message}` : error.message,
        provider: request.body && (request.body as any).providerName,
      });
    }
  });

  // 根据 Base URL 查询已知模型列表
  // 供聊天界面模型下拉框使用 — 只展示每个 provider 实际配置的 default_model
  fastify.get('/api/models', { preHandler: [verifyToken] }, async (_request, reply) => {
    try {
      const providers = await llmDatabaseService.getEnabledProviders();
      const catalog: Array<{
        id: string; name: string; provider: string;
        contextWindow?: number; reasoning?: boolean;
      }> = [];
      for (const p of providers) {
        if (p.default_model) {
          catalog.push({
            id: p.default_model,
            name: p.default_model,
            provider: p.name,
            contextWindow: p.context_window || undefined,
            reasoning: false,
          });
        }
      }
      reply.send(catalog);
    } catch (err: any) {
      reply.code(500).send({ error: '获取模型列表失败：' + err.message });
    }
  });

  fastify.get('/api/llm/models', { preHandler: [verifyToken] }, async (request, reply) => {
    const { baseUrl } = request.query as { baseUrl?: string };
    if (!baseUrl) return reply.send({ models: [] });
    const providerId = resolveProviderFromBaseUrl(baseUrl);
    if (!providerId) return reply.send({ models: [] });
    const provider = getProvider(providerId);
    if (!provider) return reply.send({ models: [] });
    return reply.send({ models: provider.models.map(m => ({ id: m.id, name: m.name })) });
  });

  // 告警列表
  fastify.get('/api/alerts', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const q = request.query as any;
      const alerts = await alertDatabaseService.getAlerts({
        limit: q.limit ? parseInt(q.limit) : undefined,
        offset: q.offset ? parseInt(q.offset) : undefined,
        status: q.status || undefined,
        level: q.level || undefined,
      });
      reply.send(alerts);
    } catch (error: any) {
      reply.code(500).send({ error: '获取告警列表失败：' + error.message });
    }
  });

  // 确认告警（人工确认：设置 status = 'acknowledged'）
  fastify.post('/api/alerts/:id/read', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const result = await alertDatabaseService.acknowledgeAlert(Number(id));
      reply.send(result);
    } catch (error: any) { reply.code(500).send({ error: error.message }); }
  });

  fastify.delete('/api/alerts', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const { retentionDays } = request.query as { retentionDays?: number };
      // 默认保留最近 30 天；前端主动传 0 可强制清除全部
      const days = retentionDays !== undefined ? Number(retentionDays) : 30;
      const result = await alertDatabaseService.clearAllAlerts(days);
      if (result.success) {
        reply.send({ message: '已清除告警', deletedCount: result.deletedCount });
      } else {
        reply.code(500).send({ error: result.error });
      }
    } catch (error: any) {
      reply.code(500).send({ error: '清除告警失败：' + error.message });
    }
  });

  // 监控指标
  fastify.get('/api/metrics/:instanceId', { preHandler: [verifyToken] }, async (request, reply) => {
    const { instanceId } = request.params as any;
    try {
      const metrics = await metricsDatabaseService.getRealtimeMetrics(instanceId);
      reply.send(metrics);
    } catch (error: any) {
      reply.code(500).send({ error: '获取监控指标失败：' + error.message });
    }
  });

  await registerChatRoutes(fastify, {
    verifyToken,
    service: chatDatabaseService,
    handleChatSend,
  });

  fastify.get('/api/resources/:type/:id', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { type, id } = request.params as { type: 'instance' | 'server'; id: string };
      if ((type !== 'instance' && type !== 'server') || !Number.isInteger(Number(id)) || Number(id) < 1) return reply.code(400).send({ error: 'Invalid resource reference' });
      return reply.send({ detail: await resourceService.detail((request as any).user, { type, id: Number(id) }) });
    } catch (error: any) {
      return reply.code(error?.message === 'RESOURCE_FORBIDDEN' || error?.message === 'RESOURCE_NOT_FOUND' ? 404 : 500).send({ error: error?.message || 'Resource lookup failed' });
    }
  });

  fastify.get('/api/resources/:type/:id/relations', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { type, id } = request.params as { type: 'instance' | 'server'; id: string };
      if ((type !== 'instance' && type !== 'server') || !Number.isInteger(Number(id)) || Number(id) < 1) {
        return reply.code(400).send({ error: 'Invalid resource reference' });
      }
      const relations = await resourceService.currentRelations((request as any).user, { type, id: Number(id) });
      return reply.send({ relations });
    } catch (error: any) {
      return reply.code(error?.message === 'RESOURCE_FORBIDDEN' ? 404 : 500).send({ error: error?.message || 'Resource lookup failed' });
    }
  });

  fastify.post('/api/resources/:type/:id/relations', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { type, id } = request.params as { type: 'instance' | 'server'; id: string };
      const body = request.body as Record<string, unknown>;
      const target = body?.target as { type?: 'instance' | 'server'; id?: number } | undefined;
      if ((type !== 'instance' && type !== 'server') || !target || (target.type !== 'instance' && target.type !== 'server') || !Number.isInteger(Number(id)) || !Number.isInteger(target.id)) {
        return reply.code(400).send({ error: 'Invalid relation reference' });
      }
      await resourceService.createRelation((request as any).user, {
        source: { type, id: Number(id) }, target: { type: target.type, id: target.id },
        relationType: body.relationType as any, provenance: typeof body.provenance === 'string' ? body.provenance : '',
        validFrom: body.validFrom ? new Date(String(body.validFrom)) : new Date(),
        validUntil: body.validUntil ? new Date(String(body.validUntil)) : null,
      });
      return reply.code(201).send({ ok: true });
    } catch (error: any) {
      const code = error?.message === 'RESOURCE_FORBIDDEN' ? 404 : error?.message?.startsWith('RESOURCE_') ? 400 : 500;
      return reply.code(code).send({ error: error?.message || 'Resource relation failed' });
    }
  });

  fastify.get('/api/resources/:type/:id/capabilities/:key', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { type, id, key } = request.params as { type: 'instance' | 'server'; id: string; key: string };
      if ((type !== 'instance' && type !== 'server') || !Number.isInteger(Number(id)) || !key) return reply.code(400).send({ error: 'Invalid capability reference' });
      const capability = await capabilityService.get((request as any).user, { type, id: Number(id) }, key);
      return reply.send({ capability });
    } catch (error: any) {
      return reply.code(error?.message === 'RESOURCE_FORBIDDEN' ? 404 : 500).send({ error: error?.message || 'Capability lookup failed' });
    }
  });

  fastify.put('/api/resources/:type/:id/capabilities/:key', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { type, id, key } = request.params as { type: 'instance' | 'server'; id: string; key: string };
      const body = request.body as Record<string, unknown>;
      if ((type !== 'instance' && type !== 'server') || !Number.isInteger(Number(id)) || !key || typeof body.state !== 'string') return reply.code(400).send({ error: 'Invalid capability payload' });
      await capabilityService.put((request as any).user, {
        resource: { type, id: Number(id) }, key, state: body.state as any,
        evidence: body.evidence as Record<string, unknown> | undefined, reason: typeof body.reason === 'string' ? body.reason : undefined,
        checkedAt: body.checkedAt ? new Date(String(body.checkedAt)) : new Date(), validUntil: body.validUntil ? new Date(String(body.validUntil)) : null,
      });
      return reply.send({ ok: true });
    } catch (error: any) {
      const code = error?.message === 'RESOURCE_FORBIDDEN' ? 404 : error?.message?.startsWith('CAPABILITY_') ? 400 : 500;
      return reply.code(code).send({ error: error?.message || 'Capability update failed' });
    }
  });

  fastify.get('/api/resources/:type/:id/observations/:metricId', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { type, id, metricId } = request.params as { type: 'instance' | 'server'; id: string; metricId: string };
      const { validForMs, from, to, limit } = request.query as { validForMs?: string; from?: string; to?: string; limit?: string };
      const validity = validForMs === undefined ? 300_000 : Number(validForMs);
      if ((type !== 'instance' && type !== 'server') || !Number.isInteger(Number(id)) || !metricId || !Number.isFinite(validity) || validity < 1 || validity > 86_400_000) {
        return reply.code(400).send({ error: 'Invalid observation query' });
      }
      if (from !== undefined || to !== undefined || limit !== undefined) {
        const fromAt = new Date(String(from));
        const toAt = new Date(String(to));
        const parsedLimit = limit === undefined ? undefined : Number(limit);
        if (!from || !to || Number.isNaN(fromAt.getTime()) || Number.isNaN(toAt.getTime()) || (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 1_000))) {
          return reply.code(400).send({ error: 'Invalid observation range query' });
        }
        const observations = await observationService.range((request as any).user, { type, id: Number(id) }, metricId, {
          from: fromAt, to: toAt, validForMs: validity, limit: parsedLimit,
        });
        return reply.send({ observations });
      }
      const observation = await observationService.latest((request as any).user, { type, id: Number(id) }, metricId, { validForMs: validity });
      return reply.send({ observation });
    } catch (error: any) {
      const code = error?.message === 'RESOURCE_FORBIDDEN' ? 404 : error?.message === 'METRIC_ID_UNSUPPORTED' || error?.message === 'OBSERVATION_RANGE_INVALID' ? 400 : 500;
      return reply.code(code).send({ error: error?.message || 'Observation lookup failed' });
    }
  });

  // ========== Agent List API (DirectAdapter) ==========
  fastify.get('/api/agents', { preHandler: [verifyToken] }, async (_request, reply) => {
    const engine = await getAgentEngine();
    reply.send({
      defaultId: 'slide-db-ops',
      mainKey: 'main',
      scope: 'default',
      agents: [
        { id: 'slide-db-ops', name: 'Slide', identity: { name: 'Slide', avatarUrl: '' } },
      ],
      capabilities: engine.capabilities().features,
    });
  });

  // ========== Agent Management API ==========

  // GET /api/agent/skills — 列出所有技能
  fastify.get('/api/agent/skills', { preHandler: [verifyToken] }, async (_request, reply) => {
    try {
      const skills = agentManagementService.listSkills();
      return { ok: true, skills };
    } catch (error: any) {
      reply.code(500).send({ error: '获取技能列表失败：' + error.message });
    }
  });

  // POST /api/agent/skills/:name/toggle — 启用/禁用技能
  fastify.post('/api/agent/skills/:name/toggle', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const { enabled } = request.body as { enabled: boolean };
      const success = agentManagementService.toggleSkill(name, enabled);
      if (!success) {
        return reply.code(404).send({ ok: false, error: 'Skill not found' });
      }
      return { ok: true };
    } catch (error: any) {
      reply.code(500).send({ error: '切换技能状态失败：' + error.message });
    }
  });

  // GET /api/agent/tools — 列出所有工具
  fastify.get('/api/agent/tools', { preHandler: [verifyToken] }, async (_request, reply) => {
    try {
      const tools = await agentManagementService.listTools();
      return { ok: true, tools };
    } catch (error: any) {
      reply.code(500).send({ error: '获取工具列表失败：' + error.message });
    }
  });

  // GET /api/agent/status — 获取 Agent 运行时状态
  fastify.get('/api/agent/status', { preHandler: [verifyToken] }, async (_request, reply) => {
    try {
      const engine = await getAgentEngine();
      const caps = engine.capabilities();
      return {
        ok: true,
        status: {
          streaming: caps.streaming,
          toolCalling: caps.toolCalling,
          maxContextTokens: caps.maxContextTokens,
          supportsCustomSystemPrompt: caps.supportsCustomSystemPrompt,
        },
      };
    } catch (error: any) {
      reply.code(500).send({ error: '获取 Agent 状态失败：' + error.message });
    }
  });

  // ========== 提示词管理 API ==========

  // GET /api/ai/prompts — 列出所有提示词类型和版本
  fastify.get('/api/ai/prompts', { preHandler: [verifyToken, requirePermission('ai:view')] }, async (_request, reply) => {
    try {
      const types = promptManager.getAllTypes();
      return { ok: true, types };
    } catch (error: any) {
      reply.code(500).send({ error: '获取提示词列表失败：' + error.message });
    }
  });

  // GET /api/ai/prompts/:type — 获取单个类型的版本信息
  fastify.get('/api/ai/prompts/:type', { preHandler: [verifyToken, requirePermission('ai:view')] }, async (request, reply) => {
    try {
      const { type } = request.params as { type: string };
      const info = promptManager.getTypeInfo(type);
      if (!info) return reply.code(404).send({ error: '提示词类型不存在' });
      return { ok: true, ...info };
    } catch (error: any) {
      reply.code(500).send({ error: '获取提示词失败：' + error.message });
    }
  });

  // POST /api/ai/prompts/:type/switch — 切换活跃版本
  fastify.post('/api/ai/prompts/:type/switch', { preHandler: [verifyToken, requirePermission('ai:manage')] }, async (request, reply) => {
    try {
      const { type } = request.params as { type: string };
      const { version } = request.body as { version: number };
      if (!version || version < 1) return reply.code(400).send({ error: '版本号无效' });
      const info = promptManager.getTypeInfo(type);
      if (!info) return reply.code(404).send({ error: '提示词类型不存在' });
      const exists = info.versions.some(v => v.version === version);
      if (!exists) return reply.code(404).send({ error: `版本 v${version} 不存在` });
      promptManager.setActiveVersion(version);
      return { ok: true, activeVersion: version };
    } catch (error: any) {
      reply.code(500).send({ error: '切换版本失败：' + error.message });
    }
  });

  // PUT /api/ai/prompts/:type/versions/:version — 更新版本内容
  fastify.put('/api/ai/prompts/:type/versions/:version', { preHandler: [verifyToken, requirePermission('ai:manage')] }, async (request, reply) => {
    try {
      const { type, version: versionStr } = request.params as { type: string; version: string };
      const version = parseInt(versionStr, 10);
      const { content } = request.body as { content: string };
      if (!content) return reply.code(400).send({ error: '内容不能为空' });
      const ok = await promptManager.setVersionContent(type, version, content);
      if (!ok) return reply.code(404).send({ error: '版本不存在或保存失败' });
      return { ok: true, type, version, length: content.length };
    } catch (error: any) {
      reply.code(500).send({ error: '保存提示词失败：' + error.message });
    }
  });

  // POST /api/ai/prompts/:type/versions — 创建新版本
  fastify.post('/api/ai/prompts/:type/versions', { preHandler: [verifyToken, requirePermission('ai:manage')] }, async (request, reply) => {
    try {
      const { type } = request.params as { type: string };
      const { content } = request.body as { content: string };
      if (!content) return reply.code(400).send({ error: '内容不能为空' });
      const result = await promptManager.createVersion(type, content);
      if (!result) return reply.code(500).send({ error: '创建版本失败' });
      return { ok: true, ...result, type };
    } catch (error: any) {
      reply.code(500).send({ error: '创建版本失败：' + error.message });
    }
  });

  // POST /api/ai/prompts/:type/optimize — AI 辅助优化提示词
  fastify.post('/api/ai/prompts/:type/optimize', { preHandler: [verifyToken, requirePermission('ai:manage')] }, async (request, reply) => {
    try {
      const { type } = request.params as { type: string };
      const { version, focus } = request.body as { version?: number; focus?: string };

      const info = promptManager.getTypeInfo(type);
      if (!info) return reply.code(404).send({ error: '提示词类型不存在' });

      const v = version ?? info.activeVersion;
      const currentContent = promptManager.getVersionContent(type, v);
      if (!currentContent) return reply.code(404).send({ error: '版本内容不存在' });

      const displayType = { 'fault-diagnosis': '故障诊断', 'alert-rca': '告警根因分析', 'topsql-analysis': 'SQL 优化' }[type] || type;

      const optimizePrompt = `你是一个 AI 提示词优化专家。请分析下面这条用于指导 AI Agent 执行${displayType}任务的提示词，给出优化建议。

## 需要保持的要点
- 面向 AI Agent（不是人）的指令
- 必须包含可用的工具列表和工具说明
- 必须包含执行流程
- 必须要求最后调用 slide_complete_analysis 保存结果
- 输出 Markdown 格式要求

## 当前提示词
\`\`\`markdown
${currentContent}
\`\`\`

${focus ? `## 优化重点\n${focus}\n` : ''}
## 要求
1. 分析当前提示词的不足（具体指出哪些地方可以改进）
2. 给出优化后的完整提示词（直接可用）
3. 用一句话说明优化要点`;

      const engine = await getAgentEngine();
      const sessionKey = `prompt-optimize-${type}-${Date.now()}`;
      const result = await engine.invoke(sessionKey, optimizePrompt);
      const optimizedContent = result.content || '';

      return {
        ok: true,
        analysis: optimizedContent,
        type,
        currentVersion: v,
      };
    } catch (error: any) {
      reply.code(500).send({ error: 'AI 优化失败：' + error.message });
    }
  });

  // ========== 数据库实例管理 API ==========

  fastify.get('/api/adapters/capabilities', { preHandler: [verifyToken] }, async (_request, reply) => reply.send({ adapters: listAdapterCapabilities() }));

  // 创建实例
  fastify.post('/api/database/instances', { preHandler: [verifyToken, requirePermission('instance:create')] }, async (request, reply) => {
    try {
      const data = request.body as any;
      const result = await instanceDatabaseService.createInstance(data);
      warnUnknown(data, ['name','environment','db_type','host','port','username','password','database_name','max_connections','connection_timeout_ms','description','tags','created_by'], 'POST /api/database/instances');
      if (result.success) {
        reply.send({ id: result.instanceId, message: '创建成功' });
      } else {
        reply.code(400).send({ error: result.error });
      }
    } catch (error: any) {
      reply.code(500).send({ error: '创建实例失败：' + error.message });
    }
  });

  // 获取实例详情
  fastify.get('/api/database/instances/:id', { preHandler: [verifyToken, requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const instance = await instanceDatabaseService.getInstanceById(Number(id));
      if (!instance) {
        return reply.code(404).send({ error: '实例不存在' });
      }
      reply.send(publicInstanceDto(instance as unknown as Record<string, unknown>));
    } catch (error: any) {
      reply.code(500).send({ error: '获取实例详情失败：' + error.message });
    }
  });

  // 更新实例
  fastify.put('/api/database/instances/:id', { preHandler: [verifyToken, requirePermission('instance:update'), requireInstanceAccess('read-write')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const data = request.body as any;
      const result = await instanceDatabaseService.updateInstance(Number(id), data);
      warnUnknown(data, ['name','environment','db_type','host','port','username','password','database_name','max_connections','connection_timeout_ms','description','tags'], 'PUT /api/database/instances/:id');
      if (result.success) {
        reply.send({ message: '更新成功' });
      } else {
        reply.code(400).send({ error: result.error });
      }
    } catch (error: any) {
      reply.code(500).send({ error: '更新实例失败：' + error.message });
    }
  });

  // 删除实例
  fastify.delete('/api/database/instances/:id', { preHandler: [verifyToken, requirePermission('instance:delete'), requireInstanceAccess('admin')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const result = await instanceDatabaseService.deleteInstance(Number(id));
      if (result.success) {
        reply.send({ message: '删除成功' });
      } else {
        reply.code(400).send({ error: result.error });
      }
    } catch (error: any) {
      reply.code(500).send({ error: '删除实例失败：' + error.message });
    }
  });

  // 重新加载实例连接（测试成功保存密码后使用）
  fastify.post('/api/database/instances/:id/reload', { preHandler: [verifyToken, requirePermission('instance:manage'), requireInstanceAccess('read-write')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const instance = await instanceDatabaseService.getInstanceById(Number(id));
      if (!instance) {
        return reply.code(404).send({ error: '实例不存在' });
      }
      const password = await instanceDatabaseService.getInstancePassword(Number(id));
      if (!password) {
        return reply.code(400).send({ error: '实例未设置密码' });
      }
      const added = await databaseService.addConnection(Number(id), instance.name, {
        host: instance.host,
        port: instance.port,
        user: instance.username,
        password,
        database: instance.database_name || (instance.db_type === 'postgresql' ? 'postgres' : instance.db_type === 'mysql' ? 'mysql' : undefined),
        db_type: instance.db_type,
      });
      if (added) {
        await instanceDatabaseService.markInstanceActive(Number(id));
        reply.send({ success: true, message: '连接已建立' });
      } else {
        reply.code(500).send({ success: false, error: '连接建立失败' });
      }
    } catch (error: any) {
      reply.code(500).send({ error: '重载连接失败：' + error.message });
    }
  });

  // 测试连接
  fastify.post('/api/database/instances/test-connection', { preHandler: [verifyToken, requirePermission('instance:create')] }, async (request, reply) => {
    try {
      const check = strictBody(request.body as Record<string, unknown>,
          ['host', 'port', 'username', 'password', 'database_name', 'db_type'], 'POST /api/database/instances/test-connection');
        if (check.error) return reply.code(400).send(check.error);
        const { host, port, username, password, database_name, db_type } = check.body as { host: string; port: number; username: string; password: string; database_name?: string; db_type: string };
      try { assertCreatableDatabaseType(String(db_type)); } catch (error: any) { return reply.code(400).send({ error: error.message }); }
      const result = await instanceDatabaseService.testConnection({
        db_type,
        host,
        port: Number(port),
        username,
        password,
        database: database_name,
      });
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: '测试连接失败：' + error.message });
    }
  });

  // ========== 服务器管理 API ==========

  // 获取所有服务器
  fastify.get('/api/servers', { preHandler: [verifyToken, requirePermission('servers:view')] }, async (request, reply) => {
    try {
      const servers = await serverDatabaseService.getAllServers();
      reply.send(servers.map((server) => publicServerDto(server as unknown as Record<string, unknown>)));
    } catch (error: any) {
      reply.code(500).send({ error: '获取服务器列表失败：' + error.message });
    }
  });

  // 获取服务器详情
  fastify.get('/api/servers/:id', { preHandler: [verifyToken, requirePermission('servers:view')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const server = await serverDatabaseService.getServerById(Number(id));
      if (!server) {
        return reply.code(404).send({ error: '服务器不存在' });
      }
      // Strip credential_encrypted from response — never send encrypted blob to frontend
      const { credential_encrypted, ...safeServer } = server;
      // Decrypt and include username for edit-form pre-fill (but NOT password/key)
      try {
        const creds = serverDatabaseService.decryptCredentials(credential_encrypted);
        (safeServer as any).credential_username = creds.username;
      } catch {
        // If decryption fails, skip — frontend will show empty username field
      }
      reply.send(publicServerDto({ ...safeServer, credential_encrypted }));
    } catch (error: any) {
      reply.code(500).send({ error: '获取服务器详情失败：' + error.message });
    }
  });

  // 创建服务器
  fastify.post('/api/servers', { preHandler: [verifyToken, requirePermission('servers:manage')] }, async (request, reply) => {
    try {
      const data = request.body as any;
      warnUnknown(data, ['host','port','label','os_type','credential_type','credential_username','credential_value','created_by'], 'POST /api/servers');
      if (!data.host) return reply.code(400).send({ error: '缺少必填字段：host' });
      if (!data.os_type) return reply.code(400).send({ error: '缺少必填字段：os_type' });
      if (!data.credential_type) return reply.code(400).send({ error: '缺少必填字段：credential_type' });
      if (!data.credential_username) return reply.code(400).send({ error: '缺少必填字段：credential_username' });
      if (!data.credential_value) return reply.code(400).send({ error: '缺少必填字段：credential_value' });
      const result = await serverDatabaseService.createServer(data);
      if (result.success) {
        reply.send({ id: result.serverId, message: '创建成功' });
      } else {
        reply.code(400).send({ error: result.error });
      }
    } catch (error: any) {
      reply.code(500).send({ error: '创建服务器失败：' + error.message });
    }
  });

  // 更新服务器
  fastify.put('/api/servers/:id', { preHandler: [verifyToken, requirePermission('servers:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const data = request.body as any;
      warnUnknown(data, ['host','port','label','os_type','credential_type','credential_username','credential_value','collection_enabled'], 'PUT /api/servers/:id');
      const result = await serverDatabaseService.updateServer(Number(id), data);
      if (result.success) {
        reply.send({ message: '更新成功' });
      } else {
        reply.code(400).send({ error: result.error });
      }
    } catch (error: any) {
      reply.code(500).send({ error: '更新服务器失败：' + error.message });
    }
  });

  // 删除服务器
  fastify.delete('/api/servers/:id', { preHandler: [verifyToken, requirePermission('servers:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const result = await serverDatabaseService.deleteServer(Number(id));
      if (result.success) {
        reply.send({ message: '删除成功' });
      } else {
        reply.code(400).send({ error: result.error });
      }
    } catch (error: any) {
      reply.code(500).send({ error: '删除服务器失败：' + error.message });
    }
  });

  // 测试连接（stateless — accepts raw credentials, not encrypted）
  fastify.post('/api/servers/test-connection', { preHandler: [verifyToken, requirePermission('servers:manage')] }, async (request, reply) => {
    try {
      const check = strictBody(request.body as Record<string, unknown>,
          ['host', 'port', 'credential_type', 'credential_username', 'credential_value'], 'POST /api/servers/test-connection');
        if (check.error) return reply.code(400).send(check.error);
        const { host, port, credential_type, credential_username, credential_value } = check.body as { host: string; port: number; credential_type: string; credential_username: string; credential_value: string };
      const result = await serverDatabaseService.testConnection(String(host), Number(port), String(credential_type), String(credential_value), String(credential_username));
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: '测试连接失败：' + error.message });
    }
  });

  // 轮换密钥
  fastify.post('/api/servers/:id/rotate-key', { preHandler: [verifyToken, requirePermission('servers:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const data = request.body as any;
      warnUnknown(data, ['credential_type','credential_username','credential_value'], 'POST /api/servers/:id/rotate-key');
      if (!data.credential_type) return reply.code(400).send({ error: '缺少必填字段：credential_type' });
      if (!data.credential_username) return reply.code(400).send({ error: '缺少必填字段：credential_username' });
      if (!data.credential_value) return reply.code(400).send({ error: '缺少必填字段：credential_value' });
      const result = await serverDatabaseService.rotateKey(Number(id), data.credential_type, data.credential_username, data.credential_value);
      if (!result.success) {
        return reply.code(400).send({ error: result.message || '密钥轮换失败' });
      }
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: '密钥轮换失败：' + error.message });
    }
  });

  // ========== 服务器指标 API ==========

  // 批量获取所有服务器最新指标摘要
  fastify.get('/api/servers/metrics/summary', { preHandler: [verifyToken, requirePermission('servers:view')] }, async (request, reply) => {
    try {
      const pool = dbConnection.getPool();
      if (!pool) {
        return reply.code(500).send({ error: '数据库未连接' });
      }

      const [rows] = await pool.execute(
        `SELECT sm.server_id, sm.metric_name, sm.metric_value, sm.recorded_at
         FROM server_metrics sm
         INNER JOIN (
           SELECT server_id, metric_name, MAX(recorded_at) AS max_time
           FROM server_metrics
           GROUP BY server_id, metric_name
         ) latest ON sm.server_id = latest.server_id AND sm.metric_name = latest.metric_name AND sm.recorded_at = latest.max_time
         ORDER BY sm.server_id, sm.metric_name`
      ) as any;

      // Group by server_id
      const grouped: Record<number, { metrics: any[]; recorded_at: string | null }> = {};
      for (const row of rows) {
        const sid = row.server_id;
        if (!grouped[sid]) grouped[sid] = { metrics: [], recorded_at: null };
        grouped[sid].metrics.push(row);
        if (!grouped[sid].recorded_at || row.recorded_at > grouped[sid].recorded_at) {
          grouped[sid].recorded_at = row.recorded_at;
        }
      }

      reply.send({ servers: grouped, recorded_at: rows.length > 0 ? rows[0].recorded_at : null });
    } catch (error: any) {
      reply.code(500).send({ error: '获取指标摘要失败：' + error.message });
    }
  });

  // 获取服务器最新指标
  fastify.get('/api/servers/:id/metrics', { preHandler: [verifyToken, requirePermission('servers:view')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const pool = dbConnection.getPool();
      if (!pool) {
        return reply.code(500).send({ error: '数据库未连接' });
      }

      // Verify server exists
      const server = await serverDatabaseService.getServerById(Number(id));
      if (!server) {
        return reply.code(404).send({ error: '服务器不存在' });
      }

      // Get latest metric values (one row per metric_name)
      const [rows] = await pool.execute(
        `SELECT sm.server_id, sm.metric_name, sm.metric_value, sm.recorded_at
         FROM server_metrics sm
         INNER JOIN (
           SELECT metric_name, MAX(recorded_at) AS max_time
           FROM server_metrics
           WHERE server_id = ?
           GROUP BY metric_name
         ) latest ON sm.metric_name = latest.metric_name AND sm.recorded_at = latest.max_time
         WHERE sm.server_id = ?
         ORDER BY sm.metric_name`,
        [Number(id), Number(id)]
      ) as any;

      reply.send({ server_id: Number(id), metrics: rows, recorded_at: rows.length > 0 ? rows[0].recorded_at : null });
    } catch (error: any) {
      reply.code(500).send({ error: '获取服务器指标失败：' + error.message });
    }
  });

  // 获取服务器指标历史
  fastify.get('/api/servers/:id/metrics/history', { preHandler: [verifyToken, requirePermission('servers:view')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const { range = '1h', metric } = request.query as { range?: string; metric?: string };

      // Validate range parameter
      const validRanges = ['1h', '6h', '24h', '7d', '30d'];
      if (!validRanges.includes(range)) {
        return reply.code(400).send({ error: `range 必须为 ${validRanges.join('/')} 之一` });
      }

      const pool = dbConnection.getPool();
      if (!pool) {
        return reply.code(500).send({ error: '数据库未连接' });
      }

      // Verify server exists
      const server = await serverDatabaseService.getServerById(Number(id));
      if (!server) {
        return reply.code(404).send({ error: '服务器不存在' });
      }

      let whereClause = 'WHERE server_id = ? AND recorded_at >= NOW() - INTERVAL ?';
      const params: any[] = [Number(id)];

      // Map range to INTERVAL value
      const intervalMap: Record<string, string> = { '1h': '1 HOUR', '6h': '6 HOUR', '24h': '24 HOUR', '7d': '7 DAY', '30d': '30 DAY' };
      params.push(intervalMap[range] || '1 HOUR');

      // Optional metric filter (comma-separated)
      if (metric) {
        const metricNames = metric.split(',').map((m: string) => m.trim()).filter(Boolean);
        if (metricNames.length > 0) {
          // Validate metric names to prevent injection
          for (const mn of metricNames) {
            if (!/^[a-zA-Z0-9_-]+$/.test(mn)) {
              return reply.code(400).send({ error: `无效的指标名称: ${mn}` });
            }
          }
          whereClause += ` AND metric_name IN (${metricNames.map(() => '?').join(',')})`;
          params.push(...metricNames);
        }
      }

      const [rows] = await pool.execute(
        `SELECT id, server_id, metric_name, metric_value, recorded_at
         FROM server_metrics
         ${whereClause}
         ORDER BY recorded_at ASC`,
        params
      ) as any;

      reply.send({ server_id: Number(id), metrics: rows, range });
    } catch (error: any) {
      reply.code(500).send({ error: '获取服务器指标历史失败：' + error.message });
    }
  });

  // 手动触发单次采集
  fastify.post('/api/servers/:id/collect', { preHandler: [verifyToken, requirePermission('servers:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;

      // Verify server exists
      const server = await serverDatabaseService.getServerById(Number(id));
      if (!server) {
        return reply.code(404).send({ error: '服务器不存在' });
      }

      const result = await serverCollector.collectServer(Number(id));
      if (result.success) {
        reply.send({ success: true, metrics_count: result.metricsCount || 0 });
      } else {
        reply.code(500).send({ success: false, error: result.error || '采集失败' });
      }
    } catch (error: any) {
      reply.code(500).send({ error: '采集失败：' + error.message });
    }
  });

  // ========== 服务器报告 API ==========

  // POST /api/servers/reports/generate — Generate and persist server health report
  fastify.post('/api/servers/reports/generate', { preHandler: [verifyToken, requirePermission('servers:manage')] }, async (request, reply) => {
    try {
      const { server_id } = request.body as { server_id?: number };
      const result = await serverReportService.generateAndPersist(server_id ? [server_id] : undefined);
      if (result.success) {
        reply.send({ reportId: result.reportId, message: '报告生成并持久化成功' });
      } else {
        reply.code(500).send({ error: result.error || '生成服务器健康报告失败' });
      }
    } catch (error: any) {
      reply.code(500).send({ error: '生成服务器健康报告失败：' + error.message });
    }
  });

  // GET /api/servers/reports?format=html|md — Generate and return formatted report
  fastify.get('/api/servers/reports', { preHandler: [verifyToken, requirePermission('servers:view')] }, async (request, reply) => {
    try {
      const { format = 'html' } = request.query as { format?: string };
      const safeFormat = (format === 'md' || format === 'markdown') ? 'md' : 'html';
      const reportData = await serverReportService.generateReport();

      if (safeFormat === 'md') {
        const md = serverReportService.generateMarkdown(reportData);
        reply.header('Content-Type', 'text/markdown; charset=utf-8').send(md);
      } else {
        const html = serverReportService.generateHtml(reportData);
        reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
      }
    } catch (error: any) {
      reply.code(500).send({ error: '生成服务器健康报告失败：' + error.message });
    }
  });

  // SQL 执行
  fastify.post('/api/database/instances/:id/execute', { preHandler: [verifyToken, requirePermission('instance:query'), requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const check = strictBody(request.body as Record<string, unknown>,
          ['sql', 'database'], 'POST /api/database/instances/:id/execute');
        if (check.error) return reply.code(400).send(check.error);
        const { sql, database } = check.body;
      if (!sql) return reply.code(400).send({ error: '缺少参数：sql' });

      const instance = await instanceDatabaseService.getInstanceById(Number(id));
      if (!instance) return reply.code(404).send({ error: '实例不存在' });
      const classification = classifySql(String(sql), instance.db_type);
      if (classification.commandType !== 'read') {
        return reply.code(409).send({
          reasonCode: 'NEEDS_APPROVAL',
          classification: classification.commandType,
          detail: classification.reasonCode,
          approvalUrl: '/api/approval/submit',
        });
      }

      const user = (request as any).user;
      const rawIdempotency = request.headers['idempotency-key'];
      const idempotencyKey = typeof rawIdempotency === 'string' && rawIdempotency.length <= 128
        ? rawIdempotency
        : randomUUID();
      const operation = await operationService.create({
        actorId: user.userId,
        origin: 'sql-console',
        resource: { type: 'database-instance', id: String(id) },
        commandType: classification.commandType,
        risk: 'low',
        idempotencyKey,
        correlationId: user.requestId,
      });
      if (operation.state !== 'queued') {
        return reply.code(409).send({ reasonCode: 'OPERATION_ALREADY_EXISTS', operationId: operation.id, state: operation.state });
      }
      await operationService.transition(operation.id, 'claimed', 'READ_CLAIMED', user.userId);
      await operationService.transition(operation.id, 'running', 'READ_STARTED', user.userId);
      const result = await sqlExecutor.executeSql(Number(id), String(sql), {
        userId: String(user.userId),
        username: user.username,
        ipAddress: request.ip,
        database: typeof database === 'string' ? database : undefined,
      });
      await operationService.transition(
        operation.id,
        result.success ? 'succeeded' : 'failed',
        result.success ? 'READ_SUCCEEDED' : 'READ_FAILED',
        user.userId,
        result.success ? { rowCount: result.rowCount ?? 0, durationMs: result.duration_ms ?? 0 } : { error: result.error ?? 'execution_failed' },
      );
      if (!result.success) {
        return reply.code(400).send({ ...result, operationId: operation.id });
      }
      reply.send({ ...result, operationId: operation.id, correlationId: user.requestId });
    } catch (error: any) {
      reply.code(500).send({ error: 'SQL 执行失败：' + error.message });
    }
  });

  // SQL 审批
  fastify.post('/api/approval/submit', { preHandler: [verifyToken, requirePermission('approval:approve')] }, async (request, reply) => {
    try {
      const check = strictBody(request.body as Record<string, unknown>,
          ['instance_id', 'sql_text', 'database_name'], 'POST /api/approval/submit');
        if (check.error) return reply.code(400).send(check.error);
        const { instance_id, sql_text, database_name } = check.body;
      if (!instance_id || !sql_text) return reply.code(400).send({ error: '缺少参数' });
      const user = (request as any).user;
      const targetInstanceId = Number(instance_id);
      const canAccess = user.permissions?.includes?.('*') || user.permissions?.includes?.('instance:*') || user.instanceScopes?.[targetInstanceId];
      if (!canAccess) return reply.code(403).send({ error: '无权访问该实例' });
      const classification = classifySql(String(sql_text));
      if (classification.commandType === 'read') {
        return reply.code(400).send({ reasonCode: 'READ_DOES_NOT_REQUIRE_APPROVAL', executeUrl: `/api/database/instances/${targetInstanceId}/execute` });
      }
      const rawIdempotency = request.headers['idempotency-key'];
      const operation = await operationService.create({
        actorId: user.userId,
        origin: 'sql-approval',
        resource: { type: 'database-instance', id: String(targetInstanceId) },
        commandType: classification.commandType,
        risk: classification.commandType === 'ddl' ? 'high' : 'medium',
        idempotencyKey: typeof rawIdempotency === 'string' && rawIdempotency.length <= 128 ? rawIdempotency : randomUUID(),
        correlationId: user.requestId,
      });
      if (operation.state !== 'queued') return reply.code(409).send({ reasonCode: 'OPERATION_ALREADY_EXISTS', operationId: operation.id, state: operation.state });
      const result = await approvalService.submitForApproval({
        instance_id: targetInstanceId,
        sql_text: String(sql_text),
        submitted_by: user.userId,
        target_database: typeof database_name === 'string' ? database_name : undefined,
        operation_id: operation.id,
      });
      if (result.request_id) await operationService.setApproval(operation.id, result.request_id);
      await operationService.transition(operation.id, 'waiting_approval', 'NEEDS_APPROVAL', user.userId, { approvalRequestId: result.request_id ?? null, commandType: classification.commandType });
      reply.send({ ...result, operationId: operation.id, correlationId: user.requestId });
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/approval/batch-review', { preHandler: [verifyToken, requirePermission('approval:approve')] }, async (request, reply) => {
    try {
      const check = strictBody(request.body as Record<string, unknown>,
          ['ids', 'action', 'notes', 'execute_ids'], 'POST /api/approval/batch-review');
        if (check.error) return reply.code(400).send(check.error);
        const { ids, action, notes, execute_ids } = check.body as { ids: number[]; action: string; notes?: string; execute_ids?: number[] };
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i: any) => Number.isInteger(i) && i > 0)) {
        return reply.code(400).send({ error: 'ids 必须是非空的正整数数组' });
      }
      if (!action || !['approve', 'reject'].includes(String(action))) {
        return reply.code(400).send({ error: 'action 必须是 approve 或 reject' });
      }
      const user = (request as any).user;
      const items = (ids as number[]).map(id => ({
        id,
        action: String(action) as 'approve' | 'reject',
        execute_after_approve: execute_ids ? execute_ids.includes(id) : true,
      }));
      const results = await approvalService.batchReview(
        { items, reviewed_by: user?.userId, notes: String(notes || '') },
        () => approvalOperationLifecycle(user.userId),
      );

      // Fire-and-forget per-item notifications
      for (const result of results) {
        if (result.success) {
          try {
            const reqDetail = await approvalService.getRequestById(result.id);
            if (reqDetail) {
              // Resolve instance name for D-13 (notification includes instance name)
              const inst = await instanceDatabaseService.getInstanceById(reqDetail.instance_id);
              const instanceName = inst?.name || String(reqDetail.instance_id);

              const channels = await notificationDatabaseService.getEnabledChannels();
              for (const channel of channels) {
                const msg = notificationService.buildApprovalMessage(channel.type, {
                  action: String(action) as 'approve' | 'reject',
                  notes: String(notes || ''),
                  sqlSummary: reqDetail.sql_text.substring(0, 100),
                  instanceName,
                  submitTime: reqDetail.created_at,
                  reviewerName: user?.username || '',
                  riskLevel: reqDetail.risk_level,
                });
                notificationService.sendWithRetry(channel, msg).catch(e =>
                  console.error(`审批通知发送失败 (#${result.id}):`, e)
                );
              }

              // D-02: Record notification sent event in timeline
              await approvalService.writeEvent(result.id, 'notified', {
                action: action as 'approve' | 'reject',
                channel_count: channels.length,
              }, user?.userId).catch(e => console.error('写入通知事件失败:', e));
            }
          } catch (e) {
            console.error(`审批通知准备失败 (#${result.id}):`, e);
          }
        }
      }

      reply.send(results);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/approval/:id/review', { preHandler: [verifyToken, requirePermission('approval:approve')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const check = strictBody(request.body as Record<string, unknown>,
          ['action', 'notes', 'execute_after_approve'], 'POST /api/approval/:id/review');
        if (check.error) return reply.code(400).send(check.error);
        const { action, notes, execute_after_approve } = check.body as { action: string; notes?: string; execute_after_approve?: boolean };
      if (!action || !['approve', 'reject'].includes(String(action))) {
        return reply.code(400).send({ error: 'action 必须是 approve 或 reject' });
      }
      const user = (request as any).user;
      const result = await approvalService.reviewRequest(Number(id), {
        action: action as 'approve' | 'reject',
        reviewed_by: user?.userId,
        notes: typeof notes === 'string' ? notes : undefined,
        execute_after_approve: execute_after_approve !== false,
      }, approvalOperationLifecycle(user.userId));

      // Fire-and-forget notification
      if (result.success) {
        try {
          const reqDetail = await approvalService.getRequestById(Number(id));
          if (reqDetail) {
            // Resolve instance name for D-13 (notification includes instance name)
            const inst = await instanceDatabaseService.getInstanceById(reqDetail.instance_id);
            const instanceName = inst?.name || String(reqDetail.instance_id);

            const channels = await notificationDatabaseService.getEnabledChannels();
            for (const channel of channels) {
              const message = notificationService.buildApprovalMessage(channel.type, {
                action: action as 'approve' | 'reject',
                notes: typeof notes === 'string' ? notes : '',
                sqlSummary: reqDetail.sql_text.substring(0, 100),
                instanceName,
                submitTime: reqDetail.created_at,
                reviewerName: user?.username || '',
                riskLevel: reqDetail.risk_level,
              });
              notificationService.sendWithRetry(channel, message).catch(e =>
                console.error(`审批通知发送失败 (#${id}):`, e)
              );
            }

            // D-02: Record notification sent event in timeline
            await approvalService.writeEvent(Number(id), 'notified', {
              action,
              channel_count: channels.length,
            }, user?.userId).catch(e => console.error('写入通知事件失败:', e));
          }
        } catch (e) {
          console.error(`审批通知准备失败 (#${id}):`, e);
        }
      }

      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.get('/api/approval/pending', { preHandler: [verifyToken, requirePermission('approval:view')] }, async (request, reply) => {
    try {
      const list = await approvalService.getPendingRequests();
      reply.send(list);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.get('/api/operations', { preHandler: [verifyToken] }, async (request, reply) => {
    const user = (request as any).user;
    const rawLimit = Number((request.query as any)?.limit ?? 50);
    const operations = await operationService.listForActor(user.userId, Number.isSafeInteger(rawLimit) ? rawLimit : 50);
    return reply.send({ operations });
  });

  fastify.get('/api/operations/:id', { preHandler: [verifyToken] }, async (request, reply) => {
    const user = (request as any).user;
    const operation = await operationService.getForActor(String((request.params as any).id), user.userId);
    return operation ? reply.send(operation) : reply.code(404).send({ error: 'Operation not found' });
  });

  fastify.get('/api/operations/:id/events', { preHandler: [verifyToken] }, async (request, reply) => {
    const user = (request as any).user;
    const events = await operationService.eventsForActor(String((request.params as any).id), user.userId);
    return events ? reply.send({ events }) : reply.code(404).send({ error: 'Operation not found' });
  });

  fastify.post('/api/operations/:id/cancel', { preHandler: [verifyToken] }, async (request, reply) => {
    const user = (request as any).user;
    try {
      const operation = await operationService.cancelForActor(String((request.params as any).id), user.userId);
      return operation ? reply.send({ operation }) : reply.code(404).send({ error: 'Operation not found' });
    } catch (error) {
      return reply.code(409).send({ reasonCode: 'CANCEL_NOT_AVAILABLE' });
    }
  });

  fastify.post('/api/operations/:id/retry', { preHandler: [verifyToken] }, async (request, reply) => {
    const user = (request as any).user;
    try {
      const operation = await operationService.retryForActor(String((request.params as any).id), user.userId);
      if (operation?.approvalId) await approvalService.setOperationId(operation.approvalId, operation.id);
      return operation ? reply.code(202).send({ operation }) : reply.code(404).send({ error: 'Operation not found' });
    } catch {
      return reply.code(409).send({ reasonCode: 'RETRY_NOT_AVAILABLE' });
    }
  });

  // NOTE: /history MUST be registered BEFORE /:id to avoid Fastify route conflict
  fastify.get('/api/approval/history', { preHandler: [verifyToken, requirePermission('approval:view')] }, async (request, reply) => {
    try {
      const query = request.query as any;
      const rawLimit = parseInt(query.limit || '50', 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(rawLimit, 200) : 50;
      const list = await approvalService.getProcessedRequests(limit);
      reply.send(list);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.get('/api/approval/:id', { preHandler: [verifyToken, requirePermission('approval:view')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const req = await approvalService.getRequestById(Number(id));
      if (!req) return reply.code(404).send({ error: '审批请求不存在' });
      // Enrich with instance name and db_type for detail view (per D-03, checker fix)
      const inst = await instanceDatabaseService.getInstanceById(req.instance_id);
      return reply.send({
        ...req,
        instance_name: inst?.name || String(req.instance_id),
        db_type: inst?.db_type || 'mysql',
      });
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.get('/api/approval/:id/events', { preHandler: [verifyToken, requirePermission('approval:view')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const events = await approvalService.getApprovalEvents(Number(id));
      reply.send(events);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // 获取实例指标
  fastify.get('/api/database/instances/:id/metrics', { preHandler: [verifyToken, requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const metrics = await databaseService.getRealtimeMetrics(Number(id));
      if (!metrics) {
        return reply.code(404).send({ error: '无法获取指标，实例可能未连接' });
      }
      reply.send(metrics);
    } catch (error: any) {
      reply.code(500).send({ error: '获取指标失败：' + error.message });
    }
  });

  // 获取实例历史指标
  fastify.get('/api/database/instances/:id/metrics/history', { preHandler: [verifyToken, requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const { period = '1h', interval = '5m', metrics } = request.query as { period?: string; interval?: string; metrics?: string };

      // 验证参数范围
      const validPeriods = ['1h', '6h', '24h', '7d'];
      const validIntervals = ['1m', '5m', '15m', '1h'];
      if (!validPeriods.includes(period)) {
        return reply.code(400).send({ error: `period 必须为 ${validPeriods.join('/')} 之一` });
      }
      if (!validIntervals.includes(interval)) {
        return reply.code(400).send({ error: `interval 必须为 ${validIntervals.join('/')} 之一` });
      }

      const metricIds = metrics ? metrics.split(',').map(s => s.trim()).filter(Boolean) : undefined;
      // Validate metric IDs early — reject non-alphanumeric chars to prevent SQL injection
      if (metricIds) {
        const INVALID = metricIds.find(id => !/^[a-zA-Z0-9_-]+$/.test(id));
        if (INVALID) return reply.code(400).send({ error: `无效的指标 ID: ${INVALID}` });
      }
      const result = await metricsDatabaseService.getHistoricalMetricsWithRange(
        Number(id),
        period as '1h' | '6h' | '24h' | '7d',
        interval as '1m' | '5m' | '15m' | '1h',
        metricIds
      );
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: '获取历史指标失败：' + error.message });
    }
  });

  // 获取慢查询 (TopSQL)
  fastify.get('/api/database/instances/:id/topsql', { preHandler: [verifyToken, requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const { limit = 10 } = request.query as any;
      const queries = await databaseService.getSlowQueries(Number(id), Number(limit));
      if (!queries) {
        return reply.code(404).send({ error: '无法获取慢查询，实例可能未连接' });
      }
      reply.send(queries);
    } catch (error: any) {
      reply.code(500).send({ error: '获取慢查询失败：' + error.message });
    }
  });

  // 查询性能分析（QAN）
  fastify.get('/api/database/instances/:id/qan', { preHandler: [verifyToken, requirePermission('instance:view'), requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const query = request.query as any;
      const limit = Math.min(parseInt(query.limit || '20') || 20, 100);
      const data = await databaseService.getQueryAnalytics(Number(id), limit);
      if (!data) {
        return reply.code(404).send({ error: '无法获取 QAN 数据，实例可能未连接或数据库不支持' });
      }
      reply.send(data);
    } catch (error: any) {
      reply.code(500).send({ error: '获取 QAN 数据失败：' + error.message });
    }
  });

  // EXPLAIN 执行计划（JSON 格式）
  fastify.get('/api/database/instances/:id/explain', { preHandler: [verifyToken, requirePermission('instance:query'), requireInstanceAccess()] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const query = request.query as any;
      const sql = query.sql;
      if (!sql) return reply.code(400).send({ error: '缺少参数：sql' });
      // SQL injection guard: only allow single SELECT, trim trailing semicolon
      const cleanSql = sql.trim().replace(/;+\s*$/, '');
      if (!/^\s*(SELECT|WITH|EXPLAIN|SHOW|DESCRIBE)\b/i.test(cleanSql)) {
        return reply.code(400).send({ error: '只支持 SELECT 语句的 EXPLAIN' });
      }
      const plan = await databaseService.getExplainPlanJson(Number(id), sql);
      if (!plan) {
        return reply.code(404).send({ error: '无法获取执行计划，实例可能未连接' });
      }
      reply.send(plan);
    } catch (error: any) {
      reply.code(500).send({ error: '获取执行计划失败：' + error.message });
    }
  });

  // 获取数据库对象树（SQL 控制台用）
  // List all databases for an instance (for database selector dropdown)
  fastify.get('/api/database/instances/:id/databases', { preHandler: [verifyToken, requireInstanceAccess('read-only')] }, async (request, reply) => {
    const { id } = request.params as any;
    try {
      const conn = databaseService.getConnection(Number(id));
      if (!conn) return reply.send([]);
      if (conn.db_type === 'postgresql' && conn.pgClient) {
        const res = await conn.pgClient.query('SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname');
        reply.send((res.rows || []).map((r: any) => r.datname));
      } else if (conn.pool) {
        const [rows] = await conn.pool.query('SHOW DATABASES') as any;
        reply.send(rows.map((r: any) => r.Database));
      } else {
        reply.send([]);
      }
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.get('/api/database/instances/:id/schema-objects', { preHandler: [verifyToken, requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const objects = await databaseService.getSchemaObjects(Number(id));
      if (!objects) return reply.code(503).send({ error: '实例不可达或已离线，无法获取 schema 对象' });
      reply.send(objects);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // 查询历史（SQL 控制台用）— 数据库持久化版本
  fastify.get('/api/database/instances/:id/query-history', { preHandler: [verifyToken, requirePermission('instance:query'), requireInstanceAccess()] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const query = request.query as any;
      const rawLimit = parseInt(query.limit || '50', 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(rawLimit, 200) : 50;
      const offset = parseInt(query.offset || '0');
      const search = (query.search || '').trim();

      const filterParams: any = {
        eventType: 'sql_execution',
        limit,
        offset,
      };
      if (search) filterParams.search = search;
      if (id !== '0' && id !== 'all') filterParams.resourceId = String(id);

      const result = await queryAuditLogs(filterParams);

      reply.send({
        items: result.entries.map(e => ({
          id: e.id,
          sql: e.details?.sql || '',
          instanceName: e.details?.instanceName || '',
          instanceId: e.resourceId,
          durationMs: e.details?.durationMs || 0,
          rowCount: e.details?.rowCount || 0,
          status: e.result,
          timestamp: e.timestamp,
        })),
        total: result.total,
        limit,
        offset,
      });
    } catch (error: any) {
      reply.code(500).send({ error: '获取查询历史失败：' + error.message });
    }
  });

  // 获取会话列表
  fastify.get('/api/database/instances/:id/sessions', { preHandler: [verifyToken, requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const sessions = await databaseService.getActiveSessions(Number(id));
      if (!sessions) {
        return reply.code(404).send({ error: '无法获取会话，实例可能未连接' });
      }
      reply.send(sessions);
    } catch (error: any) {
      reply.code(500).send({ error: '获取会话失败：' + error.message });
    }
  });

  // 获取容量信息
  fastify.get('/api/database/instances/:id/capacity', { preHandler: [verifyToken, requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const capacity = await databaseService.getCapacityInfo(Number(id));
      if (!capacity) {
        return reply.code(404).send({ error: '无法获取容量信息，实例可能未连接' });
      }
      reply.send(capacity);
    } catch (error: any) {
      reply.code(500).send({ error: '获取容量信息失败：' + error.message });
    }
  });

  // 获取容量历史趋势
  fastify.get('/api/database/instances/:id/capacity/history', { preHandler: [verifyToken, requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const hours = Number((request.query as any)?.hours) || 168; // 默认 7 天
      const history = await metricsDatabaseService.getCapacityHistory(Number(id), hours);
      reply.send({ history });
    } catch (error: any) {
      reply.code(500).send({ error: '获取容量历史失败：' + error.message });
    }
  });

  // ========== 健康评分和采集能力 API (Phase 105) ==========

  // 获取健康评分历史趋势
  fastify.get('/api/database/instances/:id/health-history', {
    preHandler: [verifyToken, requireInstanceAccess('read-only')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const query = request.query as any;
        const days = Math.min(Math.max(1, parseInt(query.days) || 7), 90);
        const history = await instanceDatabaseService.getHealthScoreHistory(Number(id), days);
        reply.send(history);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    },
  });

  // 获取最新一次健康检查的详细 checks
  fastify.get('/api/database/instances/:id/health-checks', {
    preHandler: [verifyToken, requireInstanceAccess('read-only')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const latest = await instanceDatabaseService.getLatestHealthChecks(Number(id));
        if (!latest) {
          return reply.send({ checks: [], status: 'unknown' });
        }
        reply.send(latest);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    },
  });

  // 获取实例的采集能力状态
  fastify.get('/api/database/instances/:id/collection-capabilities', {
    preHandler: [verifyToken, requireInstanceAccess('read-only')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const instance = await instanceDatabaseService.getInstanceById(Number(id));
        if (!instance) {
          return reply.code(404).send({ error: '实例不存在' });
        }
        const capabilities = collectionCapabilityTracker.getCapabilities(Number(id), instance.db_type);
        reply.send(capabilities);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    },
  });

  // 获取当前评分权重配置
  fastify.get('/api/scoring/config', {
    preHandler: [verifyToken, requirePermission('metric:view')],
    handler: async (request, reply) => {
      try {
        const weights = await scoringConfigService.getWeights();
        reply.send(weights);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    },
  });

  // 更新评分权重配置
  fastify.put('/api/scoring/config', {
    preHandler: [verifyToken, requirePermission('metric:manage')],
    handler: async (request, reply) => {
      try {
        const body = request.body as any;
        const result = await scoringConfigService.saveWeights(body);
        if (result.success) {
          reply.send({ success: true });
        } else {
          reply.code(400).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    },
  });

  // 获取品牌配置
  fastify.get('/api/branding/config', {
    preHandler: [verifyToken],
    handler: async (request, reply) => {
      try {
        const config = await brandingConfigService.getBranding();
        reply.send(config);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    },
  });

  // 更新品牌配置
  fastify.put('/api/branding/config', {
    preHandler: [verifyToken],
    handler: async (request, reply) => {
      try {
        const body = request.body as any;
        const result = await brandingConfigService.saveBranding(body);
        if (result.success) {
          reply.send({ success: true });
        } else {
          reply.code(400).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    },
  });

  // Dashboard: aggregated data volume trend (DASH-02 / D-07)
  // Supports instance_id (D-06) and start_date/end_date (D-05) filtering
  fastify.get('/api/dashboard/capacity-trend', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const query = request.query as any;
      const hours = Number(query?.hours) || 168;
      const instance_id = query?.instance_id ? Number(query.instance_id) : null;
      const start_date = query?.start_date || null;
      const end_date = query?.end_date || null;
      const pool = dbConnection.getPool();
      if (!pool) return reply.code(500).send({ error: '数据库未连接' });

      // Build WHERE clause: support hours-based OR date-range-based filtering
      let whereClause = '';
      const params: any[] = [];

      if (start_date && end_date) {
        whereClause = 'WHERE recorded_at >= ? AND recorded_at < DATE_ADD(?, INTERVAL 1 DAY)';
        params.push(start_date, end_date);
      } else {
        whereClause = 'WHERE recorded_at >= NOW() - INTERVAL ? HOUR';
        params.push(hours);
      }

      if (instance_id) {
        whereClause += ' AND instance_id = ?';
        params.push(instance_id);
      }

      // Cross-instance aggregation with hour-level bucket
      const [rows] = await pool.execute(
        `SELECT
           DATE_FORMAT(recorded_at, '%Y-%m-%d %H:00:00') as time_bucket,
           SUM(total_size_gb) as total_size_gb,
           COUNT(DISTINCT instance_id) as instance_count
         FROM capacity_history
         ${whereClause}
         GROUP BY DATE_FORMAT(recorded_at, '%Y-%m-%d %H:00:00')
         ORDER BY time_bucket ASC`,
        params
      ) as any;

      // Current total uses the same managed-instance scope shown by instance management.
      let currentTotal = 0;
      if (instance_id) {
        const [current] = await pool.execute(
          `SELECT data_size_gb as current_total
           FROM database_instances
           WHERE id = ?`,
          [instance_id]
        ) as any;
        currentTotal = Number(current[0]?.current_total || 0);
      } else {
        const [current] = await pool.execute(
          `SELECT COALESCE(SUM(data_size_gb), 0) as current_total
           FROM database_instances`,
        ) as any;
        currentTotal = Number(current[0]?.current_total || 0);
      }

      reply.send({
        current_total_gb: currentTotal,
        trend: rows.map((r: any) => ({
          time: r.time_bucket,
          total_size_gb: Number(r.total_size_gb),
          instance_count: instance_id ? 1 : r.instance_count,
        })),
      });
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // Dashboard: AI analysis daily count (DASH-03 / D-15)
  fastify.get('/api/dashboard/ai-stats', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const pool = dbConnection.getPool();
      if (!pool) return reply.code(500).send({ error: '数据库未连接' });

      const [rows] = await pool.execute(
        `SELECT COUNT(*) as cnt, analysis_type
         FROM ai_analysis
         WHERE created_at >= CURDATE()
         GROUP BY analysis_type
         UNION ALL
         SELECT COUNT(*) as cnt, NULL as analysis_type
         FROM ai_analysis
         WHERE created_at >= CURDATE()`,
      ) as any;

      let today_total = 0;
      const breakdown: Record<string, number> = {};

      for (const r of rows) {
        if (r.analysis_type === null) {
          today_total = Number(r.cnt);
        } else {
          breakdown[r.analysis_type] = Number(r.cnt);
        }
      }

      reply.send({
        today_total,
        breakdown,
        last_updated: new Date().toISOString(),
      });
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // 获取容量数据库明细
  fastify.get('/api/database/instances/:id/capacity/databases', { preHandler: [verifyToken, requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const databases = await metricsDatabaseService.getCapacityDatabases(Number(id));
      reply.send({ databases });
    } catch (error: any) {
      reply.code(500).send({ error: '获取容量明细失败：' + error.message });
    }
  });

  // 手动触发容量采集
  fastify.post('/api/database/instances/:id/capacity/collect', {
    preHandler: [verifyToken, requirePermission('instance:manage'), requireInstanceAccess('read-write')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const capacity = await databaseService.getCapacityInfo(Number(id));
        if (!capacity || capacity.total_size_gb === undefined) {
          return reply.code(404).send({ error: '无法获取容量信息' });
        }
        const totalTableCount = capacity.databases
          ? capacity.databases.reduce((sum: number, db: any) => sum + (db.table_count || 0), 0)
          : 0;
        const result = await metricsDatabaseService.recordCapacity({
          instance_id: Number(id),
          total_size_gb: capacity.total_size_gb,
          db_count: capacity.databases?.length || 0,
          table_count: totalTableCount,
          databases: capacity.databases || [],
        });
        if (result.success) {
          reply.send({ success: true, data: { total_size_gb: capacity.total_size_gb, db_count: capacity.databases?.length, table_count: totalTableCount } });
        } else {
          reply.code(500).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: '容量采集失败：' + error.message });
      }
    }
  });

  // ========== 采集任务管理 API ==========

  // 启动采集任务
  fastify.post('/api/collector/start', {
    preHandler: [verifyToken, requirePermission('collector:manage')],
    handler: async (request, reply) => {
      const { type } = request.body as { type?: 'metrics' | 'slowQueries' | 'capacity' | 'all' };
      try {
        if (type === 'all' || !type) {
          monitorCollector.start();
          reply.send({ success: true, message: '所有采集任务已启动' });
        } else {
          // 单个任务启动（需要扩展 monitorCollector）
          reply.code(400).send({ error: '暂不支持单独启动特定任务类型' });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 停止采集任务
  fastify.post('/api/collector/stop', {
    preHandler: [verifyToken, requirePermission('collector:manage')],
    handler: async (request, reply) => {
      const { type } = request.body as { type?: 'metrics' | 'slowQueries' | 'capacity' | 'all' };
      try {
        if (type === 'all' || !type) {
          monitorCollector.stop();
          reply.send({ success: true, message: '所有采集任务已停止' });
        } else {
          reply.code(400).send({ error: '暂不支持单独停止特定任务类型' });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取采集状态
  fastify.get('/api/collector/status', {
    preHandler: [verifyToken, requirePermission('collector:view')],
    handler: async (request, reply) => {
      try {
        const status = monitorCollector.getStatus();
        reply.send(status);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // ========== 报表管理 API ==========

  // 获取报表统计
  fastify.get('/api/reports/stats', {
    preHandler: [verifyToken, requirePermission('report:view')],
    handler: async (request, reply) => {
      try {
        const stats = await reportDatabaseService.getReportStats();
        reply.send(stats);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取报表列表
  fastify.get('/api/reports', {
    preHandler: [verifyToken, requirePermission('report:view')],
    handler: async (request, reply) => {
      try {
        const { type, instance_id, status, target_type, page = '1', limit = '20' } = request.query as any;
        const filters = {
          type: type as any,
          instance_id: instance_id ? Number(instance_id) : undefined,
          status: status as any,
          target_type: target_type as any,
          limit: Number(limit),
          offset: (Number(page) - 1) * Number(limit),
        };
        const reports = await reportDatabaseService.getReportsByFilters(filters);
        reply.send(reports);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // ========== 定时报表配置 API ==========

  // 获取所有报表配置
  fastify.get('/api/reports/configs', {
    preHandler: [verifyToken, requirePermission('report:view')],
    handler: async (request, reply) => {
      try {
        const { target_type } = request.query as any;
        const configs = await reportConfigService.getConfigs();

        // Filter by target_type at route level
        let filtered = configs;
        if (target_type === 'server') {
          filtered = configs.filter((c: any) => c.server_id != null);
        } else if (target_type === 'instance') {
          filtered = configs.filter((c: any) => c.server_id == null);
        }

        // Compute next_run for each config
        const result = filtered.map((config: any) => {
          let next_run: string | null = null;
          try {
            const job = new CronJob(config.cron, () => {});
            const next = job.nextDates(1)[0];
            if (next) {
              next_run = next.toISO() ?? null;
            }
          } catch {
            // Invalid cron expression — skip next_run computation
          }
          return { ...config, next_run };
        });
        reply.send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 创建报表配置
  fastify.post('/api/reports/configs', {
    preHandler: [verifyToken, requirePermission('report:create')],
    handler: async (request, reply) => {
      try {
        const body = request.body as any;
        const { name, cron, type, instance_id, server_id, format, enabled, notification_channel_ids } = body;

        // Validate required fields
        if (!name || !cron || !type) {
          return reply.code(400).send({ error: '缺少必要参数：name, cron, type' });
        }
        if ((instance_id === undefined || instance_id === null) === (server_id === undefined || server_id === null)) {
          return reply.code(400).send({ error: 'instance_id 或 server_id 必须且只能提供一个' });
        }

        const validTypes = ['health', 'performance', 'slow_query', 'capacity', 'server_health'];
        if (!validTypes.includes(type)) {
          return reply.code(400).send({ error: `无效的报表类型：${type}，有效值：${validTypes.join(', ')}` });
        }

        const validFormats = ['html', 'pdf', 'md', 'json'];
        if (format && !validFormats.includes(format)) {
          return reply.code(400).send({ error: `无效的输出格式：${format}，有效值：${validFormats.join(', ')}` });
        }

        const channelIds = notification_channel_ids === undefined ? [] : notification_channel_ids;
        if (!Array.isArray(channelIds) || channelIds.length > 50
          || !channelIds.every((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0)) {
          return reply.code(400).send({ error: 'notification_channel_ids 必须为最多 50 个正整数' });
        }
        const uniqueChannelIds = [...new Set(channelIds.map(Number))];
        for (const channelId of uniqueChannelIds) {
          const channel = await notificationDatabaseService.getChannelById(channelId);
          if (!channel?.enabled) return reply.code(400).send({ error: `通知渠道不可用: ${channelId}` });
        }

        const result = await reportConfigService.createConfig({
          name,
          cron,
          type,
          instance_id: instance_id == null ? null : Number(instance_id),
          server_id: server_id == null ? undefined : Number(server_id),
          format: format || 'html',
          notification_channel_ids: uniqueChannelIds,
          enabled: enabled !== undefined ? enabled : true,
        });

        reply.send({ id: result.id, message: '创建成功' });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 更新报表配置
  fastify.put('/api/reports/configs/:id', {
    preHandler: [verifyToken, requirePermission('report:create')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const body = request.body as any;

        // Validate config exists
        const existing = await reportConfigService.getConfigById(Number(id));
        if (!existing) {
          return reply.code(404).send({ error: '报表配置不存在' });
        }

        // Validate type if provided
        if (body.type) {
          const validTypes = ['health', 'performance', 'slow_query', 'capacity'];
          if (!validTypes.includes(body.type)) {
            return reply.code(400).send({ error: `无效的报表类型：${body.type}，有效值：${validTypes.join(', ')}` });
          }
        }

        // Validate format if provided
        if (body.format) {
          const validFormats = ['html', 'pdf', 'md', 'json'];
          if (!validFormats.includes(body.format)) {
            return reply.code(400).send({ error: `无效的输出格式：${body.format}，有效值：${validFormats.join(', ')}` });
          }
        }

        let notificationChannelIds: number[] | undefined;
        if (body.notification_channel_ids !== undefined) {
          if (!Array.isArray(body.notification_channel_ids) || body.notification_channel_ids.length > 50
            || !body.notification_channel_ids.every((channelId: unknown) => Number.isSafeInteger(channelId) && Number(channelId) > 0)) {
            return reply.code(400).send({ error: 'notification_channel_ids 必须为最多 50 个正整数' });
          }
          notificationChannelIds = [...new Set(body.notification_channel_ids.map((channelId: unknown) => Number(channelId)))] as number[];
          for (const channelId of notificationChannelIds) {
            const channel = await notificationDatabaseService.getChannelById(channelId);
            if (!channel?.enabled) return reply.code(400).send({ error: `通知渠道不可用: ${channelId}` });
          }
        }
        const updated = await reportConfigService.updateConfig(Number(id), {
          name: body.name,
          cron: body.cron,
          type: body.type,
          instance_id: body.instance_id !== undefined ? Number(body.instance_id) : undefined,
          server_id: body.server_id !== undefined ? Number(body.server_id) : undefined,
          format: body.format,
          notification_channel_ids: notificationChannelIds,
          enabled: body.enabled !== undefined ? body.enabled : undefined,
        });

        if (!updated) {
          return reply.code(400).send({ error: '没有可更新的字段' });
        }

        reply.send({ message: '更新成功' });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 删除报表配置
  fastify.delete('/api/reports/configs/:id', {
    preHandler: [verifyToken, requirePermission('report:create')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;

        // Validate config exists
        const existing = await reportConfigService.getConfigById(Number(id));
        if (!existing) {
          return reply.code(404).send({ error: '报表配置不存在' });
        }

        await reportConfigService.deleteConfig(Number(id));
        reply.send({ message: '删除成功' });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取单个报表详情
  fastify.get('/api/reports/:id', {
    preHandler: [verifyToken, requirePermission('report:view')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const report = await reportDatabaseService.getReportById(Number(id));
        if (!report) {
          return reply.code(404).send({ error: '报表不存在' });
        }
        reply.send(report);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  fastify.get('/api/reports/:id/notifications', {
    preHandler: [verifyToken, requirePermission('report:view')],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };
      const reportId = Number(id);
      if (!Number.isSafeInteger(reportId) || reportId <= 0) return reply.code(400).send({ error: '无效的报表 ID' });
      if (!await reportDatabaseService.getReportById(reportId)) return reply.code(404).send({ error: '报表不存在' });
      return reply.send(await reportDatabaseService.getNotificationDeliveries(reportId));
    },
  });

  // 生成报表
  fastify.post('/api/reports/generate', {
    preHandler: [verifyToken, requirePermission('report:create')],
    handler: async (request, reply) => {
      try {
        const { type, instanceId, format = 'html' } = request.body as {
          type: string;
          instanceId: number;
          format?: string;
        };

        if (!type || !instanceId) {
          return reply.code(400).send({ error: '缺少必要参数：type, instanceId' });
        }

        const validTypes = ['health', 'performance', 'slow_query', 'capacity'];
        if (!validTypes.includes(type)) {
          return reply.code(400).send({ error: `无效的报表类型：${type}，有效值：${validTypes.join(', ')}` });
        }

        const validFormats = ['html', 'pdf', 'json', 'md', 'csv'] as const;
        const safeFormat: string = validFormats.includes(format as any) ? format : 'html';

        const report = await reportService.generateReport(type as 'health' | 'performance' | 'slow_query' | 'capacity', instanceId, { format: safeFormat as 'pdf' | 'html' | 'json' | 'csv' });
        reply.send({ id: report.id, status: report.status, name: report.name });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 下载报表
  fastify.get('/api/reports/:id/download', {
    preHandler: [verifyToken, requirePermission('report:view')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const { format } = request.query as { format?: 'pdf' | 'html' | 'json' | 'md' };

        const report = await reportDatabaseService.getReportById(Number(id));
        if (!report) {
          return reply.code(404).send({ error: '报表不存在' });
        }

        const exportFormat = format || report.format;
        const content = await reportExporter.export(report, exportFormat);
        const mimeType = reportExporter.getFormatMimeType(exportFormat);
        const fileName = `${report.name.replace(/[^a-zA-Z0-9]/g, '_')}.${reportExporter.getExtension(exportFormat)}`;

        reply
          .header('Content-Type', mimeType)
          .header('Content-Disposition', `attachment; filename="${fileName}"`)
          .send(content);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 删除报表
  fastify.delete('/api/reports/:id', {
    preHandler: [verifyToken, requirePermission('report:create')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        await reportDatabaseService.deleteReport(Number(id));
        reply.send({ message: '删除成功' });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // ========== 告警规则管理 API ==========

  // 获取告警规则列表
  fastify.get('/api/alert-rules', {
    preHandler: [verifyToken, requirePermission('alert:view')],
    handler: async (request, reply) => {
      try {
        const { enabled } = request.query as { enabled?: 'true' | 'false' };
        const rules = await alertDatabaseService.getAlertRules(
          enabled === 'true' || enabled === 'false' ? enabled === 'true' : undefined
        );
        reply.send(rules);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 创建告警规则
  fastify.post('/api/alert-rules', {
    preHandler: [verifyToken, requirePermission('alert:manage')],
    handler: async (request, reply) => {
      try {
        const data = request.body as any;
        // D-14: 验证 metric_name 存在于 metric_definitions 且 is_collected=true
        let metricDef: any = null;
        if (data.metric_name) {
          metricDef = metricRegistry.getById(data.metric_name);
          if (!metricDef) {
            reply.code(400).send({ error: `指标 "${data.metric_name}" 不存在` });
            return;
          }
          if (!metricDef.is_collected) {
            reply.code(400).send({ error: `指标 "${data.metric_name}" 未启用采集，无法创建告警规则` });
            return;
          }
        }
        const result = await alertDatabaseService.createAlertRule({
          name: data.name,
          description: data.description,
          metric_name: data.metric_name,
          operator: data.operator,
          threshold: Number(data.threshold),
          duration_seconds: Number(data.duration_seconds) || 60,
          severity: data.severity,
          notification_channels: data.notification_channels,
          threshold_type: data.threshold_type || 'static',
          threshold_template: data.threshold_template,
          dynamic_config: data.dynamic_config,
          silence_minutes: data.silence_minutes ?? 5,
          db_types: data.db_types || (metricDef ? metricDef.db_types : null),
          instance_ids: data.instance_ids || null,
          template_id: data.template_id ?? null,
          target_type: data.target_type || 'instance',
          server_id: data.server_id ?? null,
          created_by: (request as any).user?.userId,
        });
        if (result.success) {
          reply.send({ id: result.ruleId, message: '创建成功' });
        } else {
          reply.code(400).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 更新告警规则
  fastify.put('/api/alert-rules/:id', {
    preHandler: [verifyToken, requirePermission('alert:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const data = request.body as any;
        // D-14: 验证 metric_name 存在于 metric_definitions 且 is_collected=true
        if (data.metric_name) {
          const def = metricRegistry.getById(data.metric_name);
          if (!def) {
            reply.code(400).send({ error: `指标 "${data.metric_name}" 不存在` });
            return;
          }
          if (!def.is_collected) {
            reply.code(400).send({ error: `指标 "${data.metric_name}" 未启用采集，无法更新告警规则` });
            return;
          }
        }
        // 只传请求体中实际存在的字段，避免 Number(undefined) → NaN 污染数据库
        const updateData: Record<string, any> = {};
        if (data.name !== undefined) updateData.name = data.name;
        if (data.description !== undefined) updateData.description = data.description;
        if (data.metric_name !== undefined) updateData.metric_name = data.metric_name;
        if (data.operator !== undefined) updateData.operator = data.operator;
        if (data.threshold !== undefined) updateData.threshold = Number(data.threshold);
        if (data.duration_seconds !== undefined) updateData.duration_seconds = Number(data.duration_seconds);
        if (data.severity !== undefined) updateData.severity = data.severity;
        if (data.enabled !== undefined) updateData.enabled = data.enabled;
        if (data.notification_channels !== undefined) updateData.notification_channels = data.notification_channels;
        if (data.threshold_type !== undefined) updateData.threshold_type = data.threshold_type;
        if (data.threshold_template !== undefined) updateData.threshold_template = data.threshold_template;
        if (data.dynamic_config !== undefined) updateData.dynamic_config = data.dynamic_config;
        if (data.silence_minutes !== undefined) updateData.silence_minutes = data.silence_minutes;
        if (data.db_types !== undefined) updateData.db_types = data.db_types;
        if (data.instance_ids !== undefined) updateData.instance_ids = data.instance_ids;
        if (data.template_id !== undefined) updateData.template_id = data.template_id;
        if (data.target_type !== undefined) updateData.target_type = data.target_type;
        if (data.server_id !== undefined) updateData.server_id = data.server_id;

        const result = await alertDatabaseService.updateAlertRule(Number(id), updateData);
        if (result.success) {
          reply.send({ message: '更新成功' });
        } else {
          reply.code(400).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 删除告警规则
  fastify.delete('/api/alert-rules/:id', {
    preHandler: [verifyToken, requirePermission('alert:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const result = await alertDatabaseService.deleteAlertRule(Number(id));
        if (result.success) {
          reply.send({ message: '删除成功' });
        } else {
          reply.code(400).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // ========== 告警模板 API ==========

  // 获取告警模板列表
  fastify.get('/api/alert-rule-templates', {
    preHandler: [verifyToken, requirePermission('alert:view')],
    handler: async (request, reply) => {
      try {
        const { target_type, enabled } = request.query as { target_type?: string; enabled?: 'true' | 'false' };
        const templates = await alertRuleTemplateService.listTemplates({
          target_type: target_type || undefined,
          enabled: enabled === 'true' || enabled === 'false' ? enabled === 'true' : undefined,
        });
        reply.send(templates);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取单个告警模板
  fastify.get('/api/alert-rule-templates/:id', {
    preHandler: [verifyToken, requirePermission('alert:view')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const template = await alertRuleTemplateService.getTemplate(Number(id));
        if (!template) {
          return reply.code(404).send({ error: '模板不存在' });
        }
        reply.send(template);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 创建告警模板
  fastify.post('/api/alert-rule-templates', {
    preHandler: [verifyToken, requirePermission('alert:manage')],
    handler: async (request, reply) => {
      try {
        const data = request.body as any;
        const check = strictBody(request.body as Record<string, unknown>,
          ['name', 'metric_name', 'operator'], 'POST /api/alert-rule-templates');
        if (check.error) return reply.code(400).send(check.error);
        const result = await alertRuleTemplateService.createTemplate({
          name: data.name,
          description: data.description,
          target_type: data.target_type || 'instance',
          metric_name: data.metric_name,
          operator: data.operator,
          threshold_template: data.threshold_template,
          duration_seconds: Number(data.duration_seconds) || 60,
          severity: data.severity || 'warning',
          silence_minutes: data.silence_minutes ?? 5,
          enabled: data.enabled !== undefined ? data.enabled : true,
          created_by: (request as any).user?.userId,
        });
        if (result.success) {
          reply.send({ id: result.id, message: '创建成功' });
        } else {
          reply.code(400).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 更新告警模板
  fastify.put('/api/alert-rule-templates/:id', {
    preHandler: [verifyToken, requirePermission('alert:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const data = request.body as any;
        const updateData: Record<string, any> = {};
        if (data.name !== undefined) updateData.name = data.name;
        if (data.description !== undefined) updateData.description = data.description;
        if (data.target_type !== undefined) updateData.target_type = data.target_type;
        if (data.metric_name !== undefined) updateData.metric_name = data.metric_name;
        if (data.operator !== undefined) updateData.operator = data.operator;
        if (data.threshold_template !== undefined) updateData.threshold_template = data.threshold_template;
        if (data.duration_seconds !== undefined) updateData.duration_seconds = Number(data.duration_seconds);
        if (data.severity !== undefined) updateData.severity = data.severity;
        if (data.silence_minutes !== undefined) updateData.silence_minutes = data.silence_minutes;
        if (data.enabled !== undefined) updateData.enabled = data.enabled;

        const result = await alertRuleTemplateService.updateTemplate(Number(id), updateData);
        if (result.success) {
          reply.send({ message: '更新成功' });
        } else {
          reply.code(400).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 删除告警模板
  fastify.delete('/api/alert-rule-templates/:id', {
    preHandler: [verifyToken, requirePermission('alert:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const result = await alertRuleTemplateService.deleteTemplate(Number(id));
        if (result.success) {
          reply.send({ message: '删除成功' });
        } else {
          reply.code(400).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 告警引擎状态
  fastify.get('/api/alert-engine/status', {
    preHandler: [verifyToken, requirePermission('alert:view')],
    handler: async (request, reply) => {
      try {
        const status = alertEngine.getEvaluationStatus();
        reply.send(status);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 手动触发告警评估
  fastify.post('/api/alert-engine/evaluate', {
    preHandler: [verifyToken, requirePermission('alert:manage')],
    handler: async (request, reply) => {
      try {
        const result = await alertEngine.triggerEvaluation();
        reply.send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // SSRF 防护：验证 webhook URL 是否指向内部/私有 IP
  function validateWebhookUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      // 拒绝 localhost / 环回地址
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '[::1]') {
        return false;
      }

      // 拒绝 RFC 1918 私有 IP 段
      if (/^10\./.test(hostname) ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
          /^192\.168\./.test(hostname)) {
        return false;
      }

      // 拒绝链路本地地址（含云元数据端点）
      if (/^169\.254\./.test(hostname)) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  // ========== 通知渠道管理 API ==========

  // 获取通知渠道列表
  fastify.get('/api/notification/channels', {
    preHandler: [verifyToken, requirePermission('notification:view')],
    handler: async (request, reply) => {
      try {
        const { enabled } = request.query as { enabled?: 'true' | 'false' };
        const enabledFilter = enabled === 'true' ? true : enabled === 'false' ? false : undefined;
        const channels = await notificationDatabaseService.getChannels(enabledFilter);
        reply.send(channels.map((channel) => publicNotificationDto(channel as unknown as Record<string, unknown>)));
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 创建通知渠道
  fastify.post('/api/notification/channels', {
    preHandler: [verifyToken, requirePermission('admin:*')],
    handler: async (request, reply) => {
      try {
        const data = request.body as any;
        if (!data.name || !data.type || !data.config) {
          return reply.code(400).send({ error: '缺少必要参数：name, type, config' });
        }
        // 验证 webhook_url 格式与 SSRF 防护（T-04-01）
        if (data.config.webhook_url) {
          if (!data.config.webhook_url.startsWith('http://') && !data.config.webhook_url.startsWith('https://')) {
            return reply.code(400).send({ error: 'webhook_url 必须以 http:// 或 https:// 开头' });
          }
          if (!validateWebhookUrl(data.config.webhook_url)) {
            return reply.code(400).send({ error: 'webhook_url 不允许指向内部/私有网络地址' });
          }
        }
        const result = await notificationDatabaseService.createChannel({
          name: data.name,
          type: data.type,
          config: data.config,
          enabled: data.enabled !== undefined ? data.enabled : true,
        });
        if (result.success) {
          reply.send({ id: result.channelId, message: '创建成功' });
        } else {
          reply.code(400).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 更新通知渠道
  fastify.put('/api/notification/channels/:id', {
    preHandler: [verifyToken, requirePermission('admin:*')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const data = request.body as any;
        // 验证 webhook_url 格式与 SSRF 防护（T-04-01）
        if (data.config?.webhook_url) {
          if (!data.config.webhook_url.startsWith('http://') && !data.config.webhook_url.startsWith('https://')) {
            return reply.code(400).send({ error: 'webhook_url 必须以 http:// 或 https:// 开头' });
          }
          if (!validateWebhookUrl(data.config.webhook_url)) {
            return reply.code(400).send({ error: 'webhook_url 不允许指向内部/私有网络地址' });
          }
        }
        const result = await notificationDatabaseService.updateChannel(Number(id), {
          name: data.name,
          type: data.type,
          config: data.config,
          enabled: data.enabled,
        });
        if (result.success) {
          reply.send({ message: '更新成功' });
        } else {
          reply.code(400).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 删除通知渠道
  fastify.delete('/api/notification/channels/:id', {
    preHandler: [verifyToken, requirePermission('admin:*')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const result = await notificationDatabaseService.deleteChannel(Number(id));
        if (result.success) {
          reply.send({ message: '删除成功' });
        } else {
          reply.code(400).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 测试通知渠道
  fastify.post('/api/notification/channels/:id/test', {
    preHandler: [verifyToken, requirePermission('admin:*')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const channel = await notificationDatabaseService.getChannelById(Number(id));
        if (!channel) {
          return reply.code(404).send({ error: '通知渠道不存在' });
        }
        const testAlert = {
          id: 0,
          instance_id: null,
          alert_type: 'performance' as const,
          level: 'info' as const,
          title: '测试告警',
          message: '这是一条测试通知消息，请忽略。',
          metric_name: null,
          metric_value: null,
          threshold_value: null,
          tags: null,
          created_at: new Date(),
          instance_name: '测试实例',
          instance_host: null,
        };
        const message = notificationService.buildMessage(channel.type, testAlert, testAlert.instance_name);
        const result = await notificationService.send(channel, message);
        if (result.success) {
          reply.send({ success: true, message: '测试消息发送成功' });
        } else {
          reply.code(500).send({ success: false, error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取通知记录
  fastify.get('/api/notification/records', {
    preHandler: [verifyToken, requirePermission('notification:view')],
    handler: async (request, reply) => {
      try {
        const { alert_id, channel_id, status, limit = '50', offset = '0' } = request.query as any;
        const filters = {
          alert_id: alert_id ? Number(alert_id) : undefined,
          channel_id: channel_id ? Number(channel_id) : undefined,
          status: status || undefined,
          limit: Number(limit),
          offset: Number(offset),
        };
        const records = await notificationDatabaseService.getRecords(filters);
        reply.send(records);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // Dead-letter delivery replay is an explicit privileged action.  It resets
  // the durable job only; the original idempotency key remains unchanged.
  fastify.post('/api/notification/jobs/:id/replay', {
    preHandler: [verifyToken, requirePermission('notification:manage')],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };
      const check = strictBody(request.body as Record<string, unknown>, ['reason'], 'POST /api/notification/jobs/:id/replay');
      if (check.error) return reply.code(400).send(check.error);
      const reason = String((check.body as { reason?: unknown }).reason ?? '').trim();
      if (!reason || reason.length > 512) return reply.code(400).send({ error: '重放原因必须为 1-512 个字符' });
      if (!notificationWorkflowStore) return reply.code(503).send({ error: '通知工作流尚未就绪' });
      try {
        if (!await notificationWorkflowStore.isDeadLetter(id)) {
          return reply.code(409).send({ error: '仅可重放处于 dead_letter 状态的任务' });
        }
        await notificationDatabaseService.recordReplay(id, (request as any).user.userId, reason);
        const replayed = await notificationWorkflowStore.replayDeadLetter(id);
        if (!replayed) return reply.code(409).send({ error: '仅可重放处于 dead_letter 状态的任务' });
        return reply.send({ success: true, job_id: id, state: 'queued' });
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    },
  });

  fastify.get('/api/notification/dead-letters', {
    preHandler: [verifyToken, requirePermission('notification:view')],
    handler: async (request, reply) => {
      if (!notificationWorkflowStore) return reply.code(503).send({ error: '通知工作流尚未就绪' });
      const { limit = '50' } = request.query as { limit?: string };
      try {
        return reply.send(await notificationWorkflowStore.listDeadLetters(Number(limit)));
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    },
  });

  // ========== AI 分析 API ==========

  // 提交 AI 分析请求
  fastify.post('/api/ai/analysis', {
    preHandler: [verifyToken, requirePermission('ai:manage')],
    handler: async (request, reply) => {
      try {
        const { analysis_type, instance_id, related_id, trigger_type = 'manual' } = request.body as {
          analysis_type: 'topsql_analysis' | 'alert_rca' | 'fault_diagnosis' | 'capacity_prediction';
          instance_id?: number;
          related_id?: number;
          trigger_type?: 'manual' | 'auto';
        };

        // RCA resolves its sole subject from the referenced alert. A server
        // alert has no instance_id, so requiring one here made the browser
        // server-RCA action unreachable before AlertRCAService could validate
        // the server subject.
        if (!analysis_type || (analysis_type !== 'alert_rca' && !instance_id)) {
          return reply.code(400).send({ error: '缺少必要参数：analysis_type, instance_id' });
        }

        let analysisId: number;
        let rcaSessionKey: string | undefined;

        switch (analysis_type) {
          case 'topsql_analysis':
            if (!related_id) {
              return reply.code(400).send({ error: 'TopSQL 分析需要 related_id (slow_query_id)' });
            }
            analysisId = await topsqlAnalysisService.analyzeSlowQuery(related_id, instance_id, trigger_type);
            break;

          case 'alert_rca':
            if (!related_id) {
              return reply.code(400).send({ error: '告警 RCA 需要 related_id (alert_id)' });
            }
            const rcaResult = await alertRCAService.analyzeAlert(related_id, trigger_type);
            if (!rcaResult.success) {
              return reply.code(500).send({ error: rcaResult.error });
            }
            analysisId = rcaResult.analysisId!;
            rcaSessionKey = rcaResult.sessionKey;
            break;

          case 'fault_diagnosis':
            const diagnosisResult = await faultDiagnosisService.diagnoseInstance(instance_id, trigger_type);
            if (!diagnosisResult.success) {
              return reply.code(500).send({ error: diagnosisResult.error });
            }
            analysisId = diagnosisResult.analysisId!;
            break;

          case 'capacity_prediction': {
            const body = request.body as any;
            if (!body.metric) {
              return reply.code(400).send({ error: '容量预测需要 metric 参数' });
            }
            const horizon = body.horizon || '30d';
            const predictResult = await capacityPredictor.predict(instance_id, body.metric, horizon);
            return reply.send({ success: true, result: predictResult });
          }

          default:
            return reply.code(400).send({ error: `不支持的分析类型: ${analysis_type}` });
        }

        const sessionKeyPrefix: Record<string, string> = {
          fault_diagnosis: 'diagnosis',
          topsql_analysis: 'topsql',
        };
        const session_key = rcaSessionKey
          || (analysis_type in sessionKeyPrefix ? `${sessionKeyPrefix[analysis_type]}-${analysisId}` : undefined);
        reply.send({ id: analysisId, status: "running", session_key });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 轮询分析状态
  fastify.get('/api/ai/analysis/status/:id', {
    preHandler: [verifyToken, requirePermission('ai:view')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const record = await aiAnalysisDatabaseService.getAnalysisById(Number(id));
        if (!record) {
          return reply.code(404).send({ ok: false, error: '分析记录不存在' });
        }
        reply.send({
          ok: true,
          record: {
            id: record.id,
            analysis_type: record.analysis_type,
            instance_id: record.instance_id,
            status: record.status,
            created_at: record.created_at,
            updated_at: record.updated_at,
            result: record.result,
            error_message: record.error_message,
            duration_ms: record.duration_ms,
          }
        });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取分析历史记录
  fastify.get('/api/ai/analysis/history', {
    preHandler: [verifyToken, requirePermission('ai:view')],
    handler: async (request, reply) => {
      try {
        const { instance_id, analysis_type, limit } = request.query as {
          instance_id?: string;
          analysis_type?: string;
          limit?: string;
        };
        const filters: Record<string, any> = {};
        if (instance_id) filters.instance_id = parseInt(instance_id);
        if (analysis_type) filters.analysis_type = analysis_type;
        if (limit) filters.limit = parseInt(limit);
        const records = await aiAnalysisDatabaseService.getAnalysisList(filters);
        return { ok: true, records };
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 轮询分析状态（旧路径，保留兼容）
  fastify.get('/api/ai/analysis/:id/status', {
    preHandler: [verifyToken, requirePermission('ai:view')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const analysis = await aiAnalysisDatabaseService.getAnalysisById(Number(id));
        if (!analysis) {
          return reply.code(404).send({ error: '分析记录不存在' });
        }
        reply.send({
          id: analysis.id,
          status: analysis.status,
          analysis_type: analysis.analysis_type,
          instance_id: analysis.instance_id,
          created_at: analysis.created_at,
          completed_at: analysis.completed_at,
          error_message: analysis.error_message,
        });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取最近的已完成诊断（按 instance_id + analysis_type）
  fastify.get('/api/ai/analysis/recent', {
    preHandler: [verifyToken, requirePermission('ai:view')],
    handler: async (request, reply) => {
      try {
        const { instance_id, analysis_type, limit = '5' } = request.query as any;
        if (!instance_id || !analysis_type) {
          return reply.code(400).send({ error: '缺少必要参数：instance_id, analysis_type' });
        }
        const analyses = await aiAnalysisDatabaseService.getAnalysisList({
          instance_id: Number(instance_id),
          analysis_type,
          status: 'completed',
          limit: Number(limit),
        });
        reply.send(analyses);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取完整分析结果
  fastify.get('/api/ai/analysis/:id', {
    preHandler: [verifyToken, requirePermission('ai:view')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const analysis = await aiAnalysisDatabaseService.getAnalysisById(Number(id));
        if (!analysis) {
          return reply.code(404).send({ error: '分析记录不存在' });
        }
        reply.send(analysis);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取分析列表（带过滤）
  fastify.get('/api/ai/analysis', {
    preHandler: [verifyToken, requirePermission('ai:view')],
    handler: async (request, reply) => {
      try {
        const { analysis_type, instance_id, status, related_id, page = '1', limit = '20' } = request.query as any;
        const analyses = await aiAnalysisDatabaseService.getAnalysisList({
          analysis_type: analysis_type || undefined,
          instance_id: instance_id ? Number(instance_id) : undefined,
          status: status || undefined,
          related_id: related_id ? Number(related_id) : undefined,
          limit: Number(limit),
          offset: (Number(page) - 1) * Number(limit),
        });
        reply.send(analyses);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 删除分析记录
  fastify.delete('/api/ai/analysis/:id', {
    preHandler: [verifyToken, requirePermission('ai:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const result = await aiAnalysisDatabaseService.deleteAnalysis(Number(id));
        if (result.success) {
          reply.send({ message: '删除成功' });
        } else {
          reply.code(500).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 重新分析
  fastify.post('/api/ai/analysis/:id/reanalyze', {
    preHandler: [verifyToken, requirePermission('ai:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const existing = await aiAnalysisDatabaseService.getAnalysisById(Number(id));
        if (!existing) {
          return reply.code(404).send({ error: '分析记录不存在' });
        }

        if (existing.analysis_type === 'topsql_analysis' && existing.related_id) {
          const reanalyzeId = await topsqlAnalysisService.reanalyzeSlowQuery(existing.related_id, existing.instance_id);
          reply.send({ id: reanalyzeId, status: 'pending', message: '重新分析任务已提交' });
        } else if (existing.analysis_type === 'alert_rca' && existing.related_id) {
          const rcaResult = await alertRCAService.analyzeAlert(existing.related_id, 'manual');
          if (!rcaResult.success) {
            return reply.code(500).send({ error: rcaResult.error });
          }
          reply.send({ id: rcaResult.analysisId, status: 'pending', message: '重新分析任务已提交' });
        } else if (existing.analysis_type === 'fault_diagnosis') {
          const diagnosisResult = await faultDiagnosisService.diagnoseInstance(existing.instance_id, 'manual');
          if (!diagnosisResult.success) {
            return reply.code(500).send({ error: diagnosisResult.error });
          }
          reply.send({ id: diagnosisResult.analysisId, status: 'pending', message: '重新分析任务已提交' });
        } else {
          return reply.code(400).send({ error: '不支持重新分析该类型' });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取自动分析配置
  fastify.get('/api/ai/config', {
    preHandler: [verifyToken, requirePermission('ai:view')],
    handler: async (request, reply) => {
      try {
        const config = await aiAnalysisConfigService.getConfig();
        reply.send(config);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 保存自动分析配置
  fastify.put('/api/ai/config', {
    preHandler: [verifyToken, requirePermission('ai:manage')],
    handler: async (request, reply) => {
      try {
        const body = request.body as any;
        const result = await aiAnalysisConfigService.saveConfig(body);
        if (result.success) {
          reply.send({ success: true, message: '配置已保存' });
        } else {
          reply.code(400).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取 Agent 问候语
  fastify.get('/api/chat/greeting', { preHandler: [verifyToken] }, async (_request, reply) => {
    try {
      reply.send({ greeting: getAgentGreeting() });
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // ========== SQL 审核 API ==========

  // 提交 SQL 审核
  fastify.post('/api/sql/audit', {
    preHandler: [verifyToken, requirePermission('sql:audit')],
    handler: async (request, reply) => {
      try {
        const body = request.body as { sql_text: string; instance_id: number };
        const { sql_text, instance_id } = body;

        if (!sql_text || !sql_text.trim()) {
          return reply.code(400).send({ error: '缺少必要参数：sql_text' });
        }
        if (!instance_id || !Number.isInteger(instance_id) || instance_id <= 0) {
          return reply.code(400).send({ error: '缺少必要参数：instance_id（正整数）' });
        }
        if (sql_text.length > 50 * 1024) {
          return reply.code(400).send({ error: 'sql_text 超过最大长度（50KB）' });
        }

        const username = (request as any).user?.username || 'anonymous';
        const result = await sqlAuditService.submitAudit(sql_text.trim(), instance_id, username);

        reply.send({
          success: true,
          analysis_id: result.analysisId,
          record_id: result.recordId,
          pre_audit_results: result.preAuditResults,
        });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 查询单个审核结果
  fastify.get('/api/sql/audit/:id', {
    preHandler: [verifyToken, requirePermission('sql:view')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const result = await sqlAuditService.getAuditResult(Number(id));
        if (!result) {
          return reply.code(404).send({ error: '审核记录不存在' });
        }
        reply.send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 轮询审核状态
  fastify.get('/api/sql/audit/:id/status', {
    preHandler: [verifyToken, requirePermission('sql:view')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const analysis = await aiAnalysisDatabaseService.getAnalysisById(Number(id));
        if (!analysis) {
          return reply.code(404).send({ error: '审核记录不存在' });
        }
        reply.send({
          id: analysis.id,
          status: analysis.status,
          analysis_type: analysis.analysis_type,
          instance_id: analysis.instance_id,
          created_at: analysis.created_at,
          completed_at: analysis.completed_at,
          error_message: analysis.error_message,
        });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 实例审核历史
  fastify.get('/api/sql/audit/instance/:instanceId', {
    preHandler: [verifyToken, requirePermission('sql:view')],
    handler: async (request, reply) => {
      try {
        const { instanceId } = request.params as any;
        const { limit } = request.query as any;
        const history = await sqlAuditService.getAuditHistory(Number(instanceId), limit ? Number(limit) : 20);
        reply.send(history);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 批量审核慢查询
  fastify.post('/api/sql/audit/batch', {
    preHandler: [verifyToken, requirePermission('sql:audit')],
    handler: async (request, reply) => {
      try {
        const body = request.body as { slow_query_ids: number[]; instance_id: number };
        const { slow_query_ids, instance_id } = body;

        if (!slow_query_ids || !Array.isArray(slow_query_ids) || slow_query_ids.length === 0) {
          return reply.code(400).send({ error: '缺少必要参数：slow_query_ids（非空数组）' });
        }
        if (!instance_id || !Number.isInteger(instance_id) || instance_id <= 0) {
          return reply.code(400).send({ error: '缺少必要参数：instance_id（正整数）' });
        }

        const results: Array<{ slow_query_id: number; analysis_id: number; pre_audit_results: any[] }> = [];
        const username = (request as any).user?.username || 'anonymous';

        for (const sqId of slow_query_ids) {
          // 获取慢查询 SQL 文本
          const slowQueries = await metricsDatabaseService.getSlowQueries(instance_id, 1000);
          const sq = slowQueries.find((q) => q.id === sqId);
          if (!sq) {
            results.push({ slow_query_id: sqId, analysis_id: 0, pre_audit_results: [] });
            continue;
          }

          const auditResult = await sqlAuditService.submitAudit(sq.sql_text, instance_id, username);
          results.push({
            slow_query_id: sqId,
            analysis_id: auditResult.analysisId,
            pre_audit_results: auditResult.preAuditResults,
          });

          // 每个之间 await 50ms 避免 LLM 限流
          if (sqId !== slow_query_ids[slow_query_ids.length - 1]) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }

        reply.send({ success: true, results });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 容量预测（单指标）
  fastify.get('/api/ai/capacity/predict', {
    preHandler: [verifyToken, requirePermission('capacity:view')],
    handler: async (request, reply) => {
      try {
        const { instance_id: raw_id, instanceId: raw_camel, metric, horizon = '30d' } = request.query as {
          instance_id?: string;
          instanceId?: string;
          metric: string;
          horizon?: '7d' | '30d' | '90d';
        };

        const instance_id = raw_id || raw_camel;
        if (!instance_id) {
          return reply.code(400).send({ error: '缺少必要参数：instance_id' });
        }

        const validHorizons = ['7d', '30d', '90d'];
        if (!validHorizons.includes(horizon)) {
          return reply.code(400).send({ error: `horizon 必须为 ${validHorizons.join('/')} 之一` });
        }

        const result = await capacityPredictor.predict(Number(instance_id), metric, horizon);
        reply.send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 容量预测（全指标）
  fastify.get('/api/ai/capacity/predict/all', {
    preHandler: [verifyToken, requirePermission('capacity:view')],
    handler: async (request, reply) => {
      try {
        const { instance_id: raw_id, instanceId: raw_camel, horizon = '30d' } = request.query as {
          instance_id?: string;
          instanceId?: string;
          horizon?: '7d' | '30d' | '90d';
        };

        const instance_id = raw_id || raw_camel;
        if (!instance_id) {
          return reply.code(400).send({ error: '缺少必要参数：instance_id' });
        }

        const results = await capacityPredictor.predictAll(Number(instance_id), horizon as '7d' | '30d' | '90d');
        reply.send(results);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // ========== 日志分析 API ==========

  // 查询日志列表
  fastify.get('/api/logs', {
    preHandler: [verifyToken, requirePermission('log:view')],
    handler: async (request, reply) => {
      try {
        const { instanceId, level, startTime, endTime, limit, offset } = request.query as {
          instanceId: string;
          level?: string;
          startTime?: string;
          endTime?: string;
          limit?: string;
          offset?: string;
        };

        if (!instanceId || isNaN(Number(instanceId)) || Number(instanceId) <= 0) {
          return reply.code(400).send({ error: '缺少必要参数：instanceId（正整数）' });
        }

        const result = await databaseLogService.getLogs(Number(instanceId), {
          level: level || undefined,
          startTime: startTime || undefined,
          endTime: endTime || undefined,
          limit: limit ? Number(limit) : 50,
          offset: offset ? Number(offset) : 0,
        });
        reply.send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取日志统计
  fastify.get('/api/logs/stats', {
    preHandler: [verifyToken, requirePermission('log:view')],
    handler: async (request, reply) => {
      try {
        const { instanceId, hours } = request.query as {
          instanceId: string;
          hours?: string;
        };

        if (!instanceId || isNaN(Number(instanceId)) || Number(instanceId) <= 0) {
          return reply.code(400).send({ error: '缺少必要参数：instanceId（正整数）' });
        }

        const stats = await databaseLogService.getLogsStats(Number(instanceId), hours ? Number(hours) : 24);
        if (!stats) {
          return reply.code(500).send({ error: '获取日志统计失败' });
        }
        reply.send(stats);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 手动触发 AI 分析
  fastify.post('/api/logs/analyze', {
    preHandler: [verifyToken, requirePermission('log:manage')],
    handler: async (request, reply) => {
      try {
        const body = request.body as { logIds: number[]; instanceId: number };
        const { logIds, instanceId } = body;

        if (!logIds || !Array.isArray(logIds) || logIds.length === 0) {
          return reply.code(400).send({ error: '缺少必要参数：logIds（非空数组）' });
        }
        if (!instanceId || !Number.isInteger(instanceId) || instanceId <= 0) {
          return reply.code(400).send({ error: '缺少必要参数：instanceId（正整数）' });
        }

        // 查询指定 logIds 的日志内容
        const pool = dbConnection.getPool();
        if (!pool) {
          return reply.code(500).send({ error: '数据库未连接' });
        }

        const placeholders = logIds.map(() => '?').join(', ');
        const [rows] = await pool.execute(
          `SELECT id, instance_id, log_level, source, message, raw_content,
                  detected_patterns, collected_at, created_at
           FROM database_logs WHERE id IN (${placeholders})`,
          logIds
        ) as any;

        if (!Array.isArray(rows) || rows.length === 0) {
          return reply.code(404).send({ error: '未找到指定的日志记录' });
        }

        // 解析 detected_patterns JSON 字段
        const logs = rows.map((row: any) => {
          if (row.detected_patterns && typeof row.detected_patterns === 'string') {
            try { row.detected_patterns = JSON.parse(row.detected_patterns); } catch { row.detected_patterns = null; }
          }
          return row;
        });

        // 创建 AI 分析记录
        const createResult = await aiAnalysisDatabaseService.createAnalysis({
          analysis_type: 'log_analysis',
          instance_id: instanceId,
          trigger_type: 'manual',
          ttl_minutes: 1440,
        });

        if (!createResult.success || !createResult.analysisId) {
          return reply.code(500).send({ error: '创建分析记录失败' });
        }

        const analysisId = createResult.analysisId;

        // 后台执行分析（非阻塞，使用预创建的 analysisId）
        databaseLogService.triggerLogAnalysis(logs, instanceId, analysisId).catch((err) => {
          console.error(`[日志] 手动分析 #${analysisId} 失败:`, err);
        });

        reply.send({ success: true, analysisId });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 查询 AI 分析结果
  fastify.get('/api/logs/analysis/:analysisId', {
    preHandler: [verifyToken, requirePermission('log:view')],
    handler: async (request, reply) => {
      try {
        const { analysisId } = request.params as any;
        const analysis = await aiAnalysisDatabaseService.getAnalysisById(Number(analysisId));
        if (!analysis) {
          return reply.code(404).send({ error: '分析记录不存在' });
        }
        reply.send(analysis);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // ========== 实例表结构直接查询（SHOW TABLES / DESCRIBE）==========

  // 获取实例所有表（SHOW TABLES）
  fastify.get('/api/database/instances/:id/tables', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const conn = databaseService.getConnection(Number(id));
      if (!conn) return reply.code(404).send({ error: '实例连接不存在' });
      if (conn.db_type === 'mysql') {
        if (!conn.pool) return reply.code(500).send({ error: 'MySQL 连接池未初始化' });
        const [rows] = await conn.pool.execute(
          `SELECT TABLE_NAME, TABLE_COMMENT, TABLE_ROWS, DATA_LENGTH, CREATE_TIME, UPDATE_TIME
           FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = (SELECT DATABASE()) AND TABLE_TYPE = 'BASE TABLE'
           ORDER BY TABLE_NAME`
        );
        reply.send({ tables: rows });
      } else if (conn.db_type === 'postgresql') {
        const result = await conn.pgClient!.query(
          `SELECT tablename AS TABLE_NAME, obj_description(relfilenode, 'pg_class') AS TABLE_COMMENT
           FROM pg_catalog.pg_tables
           WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
           ORDER BY tablename`
        );
        reply.send({ tables: result.rows });
      } else {
        reply.code(400).send({ error: '不支持的数据库类型: ' + conn.db_type });
      }
    } catch (error: any) {
      reply.code(500).send({ error: '获取表列表失败：' + error.message });
    }
  });

  // 获取表结构详情（DESCRIBE）
  fastify.get('/api/database/instances/:id/tables/:tableName/describe', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { id, tableName } = request.params as any;
      const conn = databaseService.getConnection(Number(id));
      if (!conn) return reply.code(404).send({ error: '实例连接不存在' });
      if (conn.db_type === 'mysql') {
        if (!conn.pool) return reply.code(500).send({ error: 'MySQL 连接池未初始化' });
        const [rows] = await conn.pool.execute(
          `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION
           FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = (SELECT DATABASE()) AND TABLE_NAME = ?
           ORDER BY ORDINAL_POSITION`,
          [tableName]
        );
        reply.send({ columns: rows });
      } else if (conn.db_type === 'postgresql') {
        const result = await conn.pgClient!.query(
          `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length, ordinal_position
           FROM information_schema.columns
           WHERE table_name = $1 AND table_schema NOT IN ('pg_catalog', 'information_schema')
           ORDER BY ordinal_position`,
          [tableName]
        );
        reply.send({ columns: result.rows });
      } else {
        reply.code(400).send({ error: '不支持的数据库类型: ' + conn.db_type });
      }
    } catch (error: any) {
      reply.code(500).send({ error: '获取表结构失败：' + error.message });
    }
  });

  // 获取表索引信息（SHOW INDEX）
  fastify.get('/api/database/instances/:id/tables/:tableName/indexes', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { id, tableName } = request.params as any;
      const conn = databaseService.getConnection(Number(id));
      if (!conn) return reply.code(404).send({ error: '实例连接不存在' });
      if (conn.db_type === 'mysql') {
        if (!conn.pool) return reply.code(500).send({ error: 'MySQL 连接池未初始化' });
        const [rows] = await conn.pool.execute(
          `SELECT TABLE_NAME, NON_UNIQUE, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, COLLATION,
                  CARDINALITY, SUB_PART, PACKED, NULLABLE, INDEX_TYPE, COMMENT, INDEX_COMMENT
           FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = (SELECT DATABASE()) AND TABLE_NAME = ?
           ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
          [tableName]
        );
        reply.send({ indexes: rows });
      } else if (conn.db_type === 'postgresql') {
        const result = await conn.pgClient!.query(
          `SELECT schemaname, tablename, indexname, indexdef, tablespace
           FROM pg_catalog.pg_indexes
           WHERE tablename = $1 AND schemaname NOT IN ('pg_catalog', 'information_schema')
           ORDER BY indexname`,
          [tableName]
        );
        reply.send({ indexes: result.rows });
      } else {
        reply.code(400).send({ error: '不支持的数据库类型: ' + conn.db_type });
      }
    } catch (error: any) {
      reply.code(500).send({ error: '获取索引信息失败：' + error.message });
    }
  });

  // ========== 表结构管理 API ==========

  // 触发快照采集
  fastify.post('/api/schema/collect/:instanceId', {
    preHandler: [verifyToken, requirePermission('schema:manage'), requireInstanceAccess()],
    handler: async (request, reply) => {
      try {
        const { instanceId } = request.params as any;
        const result = await schemaService.collectSchema(Number(instanceId));
        if ('error' in result) {
          return reply.code(400).send({ success: false, error: result.error });
        }
        reply.send({ success: true, data: result });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取快照时间列表
  fastify.get('/api/schema/snapshots/:instanceId', {
    preHandler: [verifyToken, requirePermission('schema:view'), requireInstanceAccess()],
    handler: async (request, reply) => {
      try {
        const { instanceId } = request.params as any;
        const times = await schemaDatabaseService.getSnapshotTimes(Number(instanceId));
        reply.send(times);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取最新快照详情（所有表列信息）
  fastify.get('/api/schema/snapshot/:instanceId', {
    preHandler: [verifyToken, requirePermission('schema:view'), requireInstanceAccess()],
    handler: async (request, reply) => {
      try {
        const { instanceId } = request.params as any;
        const tableList = await schemaDatabaseService.getTableList(Number(instanceId));
        reply.send({ tables: tableList });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取变更检测列表
  fastify.get('/api/schema/changes/:instanceId', {
    preHandler: [verifyToken, requirePermission('schema:view'), requireInstanceAccess()],
    handler: async (request, reply) => {
      try {
        const { instanceId } = request.params as any;
        const result = await schemaService.detectChanges(Number(instanceId));
        if ('error' in result) {
          return reply.send({ changes: [] });
        }
        reply.send({ changes: result });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 触发变更检测（POST）
  fastify.post('/api/schema/changes/:instanceId', {
    preHandler: [verifyToken, requirePermission('schema:manage'), requireInstanceAccess()],
    handler: async (request, reply) => {
      try {
        const { instanceId } = request.params as any;
        const result = await schemaService.detectChanges(Number(instanceId));
        if ('hint' in result) {
          return reply.send({ success: true, changes: [], hint: (result as any).hint });
        }
        if ('error' in result) {
          return reply.send({ success: false, error: result.error, changes: [] });
        }
        reply.send({ success: true, changes: result });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取表详情
  fastify.get('/api/schema/table/:instanceId/:tableName', {
    preHandler: [verifyToken, requirePermission('schema:view'), requireInstanceAccess()],
    handler: async (request, reply) => {
      try {
        const { instanceId, tableName } = request.params as any;
        const detail = await schemaService.getTableDetail(Number(instanceId), tableName);
        if ('error' in detail) {
          return reply.code(404).send({ error: detail.error });
        }
        reply.send(detail);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // ========== 索引管理 API ==========

  // 触发索引采集
  fastify.post('/api/index/collect/:instanceId', {
    preHandler: [verifyToken, requirePermission('index:manage'), requireInstanceAccess()],
    handler: async (request, reply) => {
      try {
        const { instanceId } = request.params as any;
        const result = await indexService.collectIndexes(Number(instanceId));
        if ('error' in result) {
          return reply.code(400).send({ success: false, error: result.error });
        }
        reply.send({ success: true, data: result });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 触发冗余检测
  fastify.post('/api/index/detect/:instanceId', {
    preHandler: [verifyToken, requirePermission('index:manage'), requireInstanceAccess()],
    handler: async (request, reply) => {
      try {
        const { instanceId } = request.params as any;
        const result = await indexService.detectRedundantIndexes(Number(instanceId));
        if ('error' in result) {
          return reply.code(400).send({ success: false, error: result.error });
        }
        reply.send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取实例所有索引
  fastify.get('/api/indexes/:instanceId', {
    preHandler: [verifyToken, requirePermission('index:view'), requireInstanceAccess()],
    handler: async (request, reply) => {
      try {
        const { instanceId } = request.params as any;
        const indexes = await indexDatabaseService.getIndexesByInstance(Number(instanceId));
        reply.send(indexes);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取冗余索引报告（必须在 :tableName 之前）
  fastify.get('/api/indexes/:instanceId/redundancy', {
    preHandler: [verifyToken, requirePermission('index:view'), requireInstanceAccess()],
    handler: async (request, reply) => {
      try {
        const { instanceId } = request.params as any;
        const report = await indexDatabaseService.getRedundancyReport(Number(instanceId));
        reply.send(report);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取未使用索引列表（必须在 :tableName 之前）
  fastify.get('/api/indexes/:instanceId/unused', {
    preHandler: [verifyToken, requirePermission('index:view'), requireInstanceAccess()],
    handler: async (request, reply) => {
      try {
        const { instanceId } = request.params as any;
        const unused = await indexDatabaseService.getUnusedIndexes(Number(instanceId));
        reply.send(unused);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取指定表的索引
  fastify.get('/api/indexes/:instanceId/:tableName', {
    preHandler: [verifyToken, requirePermission('index:view'), requireInstanceAccess()],
    handler: async (request, reply) => {
      try {
        const { instanceId, tableName } = request.params as any;
        const indexes = await indexDatabaseService.getIndexesByTable(Number(instanceId), tableName);
        reply.send(indexes);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // ========================================
  // Phase 06 新增 API 路由
  // ========================================

  // --- 指标注册表 (4 条) ---
  fastify.get('/api/metrics/registry', { preHandler: [verifyToken, requirePermission('metric:view')] }, async (request, reply) => {
    try {
      const { target_type } = request.query as { target_type?: string };
      const metrics = target_type
        ? metricRegistry.getByTargetType(target_type)
        : metricRegistry.getAll();
      reply.send(metrics);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.get('/api/metrics/registry/:id', { preHandler: [verifyToken, requirePermission('metric:view')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const metric = metricRegistry.getById(id);
      if (!metric) {
        reply.code(404).send({ error: `指标 ${id} 未找到` });
        return;
      }
      reply.send(metric);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.get('/api/metrics/registry/db-types/:type', { preHandler: [verifyToken, requirePermission('metric:view')] }, async (request, reply) => {
    try {
      const { type } = request.params as any;
      const metrics = metricRegistry.getByDbType(type);
      reply.send(metrics);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // --- 指标注册表写操作 (3 条) ---
  fastify.post('/api/metrics/registry', { preHandler: [verifyToken, requirePermission('metric:write')] }, async (request, reply) => {
    try {
      const body = request.body as any;
      // 验证必填字段
      if (!body.id || !body.name || !body.unit || !body.db_types || !body.aggregation || body.default_interval === undefined) {
        reply.code(400).send({ error: '缺少必填字段: id, name, unit, db_types, aggregation, default_interval' });
        return;
      }
      // SQL 白名单校验 (D-12) — validate each DB type's SQL in collection_sqls
      if (body.collection_sqls) {
        const { validateSqlIsSelectOnly } = await import('./src/sql-validator.js');
        for (const [dbType, sql] of Object.entries(body.collection_sqls as Record<string, string>)) {
          const validation = validateSqlIsSelectOnly(sql as string);
          if (!validation.valid) {
            reply.code(400).send({ error: `SQL 验证失败 [${dbType}]: ${validation.error}` });
            return;
          }
        }
      }
      const result = await metricDatabaseService.createMetric(body);
      if (!result.success) {
        reply.code(400).send(result);
        return;
      }
      await metricRegistry.refreshFromDB();
      monitorCollector.refreshSchedule();
      reply.code(201).send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.put('/api/metrics/registry/:id', { preHandler: [verifyToken, requirePermission('metric:write')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const body = request.body as any;
      // SQL 白名单校验 (D-12) — validate each DB type's SQL
      if (body.collection_sqls) {
        const { validateSqlIsSelectOnly } = await import('./src/sql-validator.js');
        for (const [dbType, sql] of Object.entries(body.collection_sqls as Record<string, string>)) {
          const validation = validateSqlIsSelectOnly(sql as string);
          if (!validation.valid) {
            reply.code(400).send({ error: `SQL 验证失败 [${dbType}]: ${validation.error}` });
            return;
          }
        }
      }
      const result = await metricDatabaseService.updateMetric(id, body);
      if (!result.success) {
        reply.code(400).send(result);
        return;
      }
      await metricRegistry.refreshFromDB();
      monitorCollector.refreshSchedule();
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.delete('/api/metrics/registry/:id', { preHandler: [verifyToken, requirePermission('metric:write')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const result = await metricDatabaseService.deleteMetricWithRefCheck(id);
      if (!result.success) {
        if (result.reason === 'builtin') {
          reply.code(403).send({ error: '预定义指标不可删除' });
          return;
        }
        if (result.reason === 'has_alerts') {
          reply.code(400).send({
            error: '该指标被告警规则引用，无法删除',
            referencedBy: result.referencedBy,
          });
          return;
        }
        if (result.reason === 'not_found') {
          reply.code(404).send({ error: '指标未找到' });
          return;
        }
        reply.code(400).send(result);
        return;
      }
      await metricRegistry.refreshFromDB();
      monitorCollector.refreshSchedule();
      reply.send({ success: true });
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // --- AI SQL 生成 (Phase 106, D-10) ---
  fastify.post('/api/metrics/generate-sql', {
    preHandler: [verifyToken, requirePermission('metric:write')],
  }, async (request, reply) => {
    try {
      const check = strictBody(request.body as Record<string, unknown>,
          ['db_type', 'description', 'instance_id'], 'POST /api/metrics/generate-sql');
        if (check.error) return reply.code(400).send(check.error);
        const { db_type, description, instance_id } = check.body as { db_type?: string; description?: string; instance_id?: number };
      if (!description) {
        reply.code(400).send({ error: '请提供指标描述' });
        return;
      }
      const { generateCollectionSql } = await import('./src/sql-generator.js');
      const result = await generateCollectionSql(db_type || 'mysql', description, instance_id ? Number(instance_id) : undefined);
      if (result.error) {
        reply.code(400).send(result);
        return;
      }
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // --- 基线计算 (2 条) ---
  fastify.post('/api/baseline/compute', { preHandler: [verifyToken, requirePermission('baseline:manage')] }, async (request, reply) => {
    try {
      const result = await baselineCalculator.computeAllBaselines();
      reply.send({ success: true, ...result });
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.get('/api/baseline/:instanceId/:metricName', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { instanceId, metricName } = request.params as any;
      const baseline = await baselineCalculator.getCachedBaseline(Number(instanceId), metricName);
      if (!baseline) {
        reply.code(404).send({ error: '基线未找到' });
        return;
      }
      reply.send(baseline);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // 基线调度管理
  fastify.get('/api/baseline/schedule', { preHandler: [verifyToken, requirePermission('baseline:view')] }, async (request, reply) => {
    reply.send({
      computeCron: '0 2 * * *',
      cleanupCron: '0 3 * * 0',
      computeDescription: '每天凌晨 2 点自动计算所有实例 x 指标的基线',
      cleanupDescription: '每周日凌晨 3 点清理过期基线（保留 30 天）',
    });
  });

  // --- 升级规则 (5 条) ---
  fastify.get('/api/alerts/escalation/rules', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const rules = await alertEscalationService.getEscalationRules();
      reply.send(rules);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/alerts/escalation/rules', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const result = await alertEscalationService.createEscalationRule(request.body as any);
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.put('/api/alerts/escalation/rules/:id', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const result = await alertEscalationService.updateEscalationRule(Number(id), request.body as any);
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.delete('/api/alerts/escalation/rules/:id', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const result = await alertEscalationService.deleteEscalationRule(Number(id));
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/alerts/escalation/check', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const result = await alertEscalationService.checkEscalations();
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // --- 手动升级告警 (1 条) ---
  fastify.post('/api/alerts/:id/escalate', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const check = strictBody(request.body as Record<string, unknown>,
          ['new_level'], 'POST /api/alerts/:id/escalate');
        if (check.error) return reply.code(400).send(check.error);
        const { new_level } = check.body as { new_level: string };
      if (!new_level) {
        reply.code(400).send({ error: '缺少 new_level 参数' });
        return;
      }
      const result = await alertEscalationService.manualEscalation(Number(id), new_level);
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // --- 维护窗口 (5 条) ---
  fastify.get('/api/maintenance-windows', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const windows = await maintenanceWindowService.getMaintenanceWindows();
      reply.send(windows);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/maintenance-windows', { preHandler: [verifyToken, requirePermission('maintenance:manage')] }, async (request, reply) => {
    try {
      const result = await maintenanceWindowService.createMaintenanceWindow(request.body as any);
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.put('/api/maintenance-windows/:id', { preHandler: [verifyToken, requirePermission('maintenance:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const result = await maintenanceWindowService.updateMaintenanceWindow(Number(id), request.body as any);
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.delete('/api/maintenance-windows/:id', { preHandler: [verifyToken, requirePermission('maintenance:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const result = await maintenanceWindowService.deleteMaintenanceWindow(Number(id));
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.get('/api/maintenance-windows/check/:instanceId', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { instanceId } = request.params as any;
      const result = await maintenanceWindowService.isActiveMaintenanceWindow(Number(instanceId));
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // --- 静默期 (4 条) ---
  fastify.get('/api/silence', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const silences = await alertSilenceService.getActiveSilences();
      reply.send(silences);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/silence', { preHandler: [verifyToken, requirePermission('silence:manage')] }, async (request, reply) => {
    try {
      const check = strictBody(request.body as Record<string, unknown>,
          ['instance_id', 'metric_name', 'duration_minutes'], 'POST /api/silence');
        if (check.error) return reply.code(400).send(check.error);
        const { instance_id, metric_name, duration_minutes } = check.body as { instance_id: number; metric_name: string; duration_minutes: number };
      const result = await alertSilenceService.silence(instance_id, metric_name, duration_minutes);
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.delete('/api/silence/:id', { preHandler: [verifyToken, requirePermission('silence:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const result = await alertSilenceService.clearSilence(Number(id));
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/silence/cleanup', { preHandler: [verifyToken, requirePermission('silence:manage')] }, async (request, reply) => {
    try {
      const count = await alertSilenceService.cleanupExpiredSilences();
      reply.send({ cleaned: count });
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // --- 事件管理 (10 条) ---
  fastify.get('/api/alerts/events', { preHandler: [verifyToken, requirePermission('alert:view')] }, async (request, reply) => {
    try {
      const events = await alertEventService.getEvents(request.query as any);
      reply.send(events);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.get('/api/alerts/events/stats', { preHandler: [verifyToken, requirePermission('alert:view')] }, async (request, reply) => {
    try {
      const stats = await alertEventService.getEventStats();
      reply.send(stats);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.get('/api/alerts/events/:id', { preHandler: [verifyToken, requirePermission('alert:view')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const event = await alertEventService.getEventById(Number(id));
      if (!event) {
        reply.code(404).send({ error: '事件未找到' });
        return;
      }
      reply.send(event);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/alerts/events', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const result = await alertEventService.createEvent(request.body as any);
      reply.code(201).send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.put('/api/alerts/events/:id', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const result = await alertEventService.updateEvent(Number(id), request.body as any);
      if (!result.success) {
        return reply.code(400).send({ error: result.error });
      }
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.delete('/api/alerts/events/:id', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const result = await alertEventService.deleteEvent(Number(id));
      if (!result.success) {
        return reply.code(400).send({ error: result.error });
      }
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/alerts/events/:id/assign', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const check = strictBody(request.body as Record<string, unknown>,
          ['user_id'], 'POST /api/alerts/events/:id/assign');
        if (check.error) return reply.code(400).send(check.error);
        const { user_id } = check.body as { user_id: number };
      const result = await alertEventService.assignEvent(Number(id), user_id);
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/alerts/events/:id/investigate', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const result = await alertEventService.startInvestigation(Number(id));
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/alerts/events/:id/note', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const check = strictBody(request.body as Record<string, unknown>,
          ['note'], 'POST /api/alerts/events/:id/note');
        if (check.error) return reply.code(400).send(check.error);
        const { note } = check.body as { note: string };
      const result = await alertEventService.addHandlerNote(Number(id), note);
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/alerts/events/:id/rca', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const result = await alertEventService.triggerRCAForEvent(Number(id));
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/alerts/events/:id/resolve', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const check = strictBody(request.body as Record<string, unknown>,
          ['resolution_notes'], 'POST /api/alerts/events/:id/resolve');
        if (check.error) return reply.code(400).send(check.error);
        const { resolution_notes } = check.body as { resolution_notes: string };
      const result = await alertEventService.resolveEvent(Number(id), resolution_notes);
      reply.code(result.success ? 200 : 409).send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/alerts/events/:id/close', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const result = await alertEventService.closeEvent(Number(id));
      reply.code(result.success ? 200 : 409).send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/alerts/events/:id/verify-recovery', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const check = strictBody(request.body as Record<string, unknown>, ['reason'], 'POST /api/alerts/events/:id/verify-recovery');
      if (check.error) return reply.code(400).send(check.error);
      const reason = String((check.body as { reason?: unknown }).reason ?? '').trim();
      if (!reason) return reply.code(400).send({ error: '缺少恢复验证说明' });
      const result = await alertEventService.verifyRecovery(Number(id), reason, (request as any).user.userId);
      reply.code(result.success ? 200 : 409).send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/alerts/events/:id/postmortem', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const check = strictBody(request.body as Record<string, unknown>,
          ['postmortem'], 'POST /api/alerts/events/:id/postmortem');
        if (check.error) return reply.code(400).send(check.error);
        const { postmortem } = check.body;
      const result = await alertEventService.addPostmortem(Number(id), postmortem);
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.get('/api/alerts/events/:id/logs', { preHandler: [verifyToken, requirePermission('alert:view')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const logs = await alertEventService.getEventLogs(Number(id));
      reply.send(logs);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.get('/api/alerts/events/mttr', { preHandler: [verifyToken, requirePermission('alert:view')] }, async (request, reply) => {
    try {
      const stats = await alertEventService.getMTTRStats();
      reply.send(stats);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.get('/api/alerts/events/search', { preHandler: [verifyToken, requirePermission('alert:view')] }, async (request, reply) => {
    try {
      const result = await alertEventService.searchEvents(request.query as any);
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  // --- 事件聚合 (1 条) ---
  fastify.post('/api/alerts/aggregate', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const result = await eventAggregator.aggregate();
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  let cronManager: CronManager | undefined;
  let engine: any;
  let workflowTimer: ReturnType<typeof setInterval> | undefined;
  const startWorkers = async () => {
  await initializeControlPlane();
  // 初始化 Agent Engine 并启动 WS 传输层
  console.log('🚀 正在启动 Agent Engine...');
  engine = await getAgentEngine();
  await engine.start();
  console.log('🔌 Agent Engine 已启动: DirectAdapter');

  // 从数据库加载指标定义（含 collection_sqls 和 compute_expr）
  await metricRegistry.initialize();

  const workflowStore = new MysqlWorkflowStore(() => dbConnection.getPool() as any);
  notificationWorkflowStore = workflowStore;
  const workflowRegistry = new JobRegistry();
  const notificationScheduler = new NotificationDispatchScheduler(notificationDatabaseService, notificationService, workflowStore);
  const enqueueNotificationDispatch = async (availableAt = new Date()) => {
    await workflowStore.enqueue(createNotificationDispatchJob(availableAt));
  };
  const enqueueReportSchedule = async (availableAt = new Date()) => {
    await workflowStore.enqueue(createReportScheduleJob(availableAt));
  };
  const enqueueReportNotifications = async (reportId: number, channelIds: readonly number[]) => {
    await Promise.all(channelIds.map((channelId) => workflowStore.enqueue(createReportNotificationJob(reportId, channelId))));
  };
  workflowRegistry.register('capacity.collect', async () => { await monitorCollector.collectCapacityNow(); });
  workflowRegistry.register('baseline.cleanup', async () => { await baselineCalculator.cleanupOldBaselines(); });
  workflowRegistry.register('alert.evaluate', async () => { await alertEngine.triggerEvaluation(); });
  workflowRegistry.register('report.schedule', async () => {
    // Commit the successor before generating reports so a restart cannot
    // silently stop all scheduled report processing.
    await enqueueReportSchedule(new Date(Date.now() + 60_000));
    const occurrences = new MysqlReportOccurrenceStore(() => dbConnection.getPool() as any);
    const scheduler = new ReportScheduler(reportConfigService, occurrences);
    for (const occurrence of await scheduler.claimDue()) {
      try {
        const config = await reportConfigService.getConfigById(occurrence.configId);
        if (!config) throw new Error('REPORT_CONFIG_NOT_FOUND');
        const reportId = config.type === 'server_health'
          ? (await serverReportService.generateAndPersist(config.server_id ? [config.server_id] : undefined)).reportId
          : (await reportService.generateReport(config.type as any, config.instance_id, { format: config.format as any })).id;
        if (!reportId) throw new Error('REPORT_GENERATION_FAILED');
        await occurrences.complete(occurrence, reportId);
        await enqueueReportNotifications(reportId, config.notification_channel_ids);
      } catch (error) {
        await occurrences.fail(occurrence, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }
  });
  workflowRegistry.register('notification.dispatch', async () => {
    await notificationScheduler.enqueuePending();
    // The next durable tick is committed before this job is completed. A
    // restart therefore resumes the current or next tick without an in-memory timer.
    await enqueueNotificationDispatch(new Date(Date.now() + 10_000));
  });
  workflowRegistry.register('notification.deliver', async (payload, job) => {
    const alertId = Number(payload.alertId);
    const channelId = Number(payload.channelId);
    if (!Number.isSafeInteger(alertId) || !Number.isSafeInteger(channelId)) throw new Error('NOTIFICATION_PAYLOAD_INVALID');
    const [alert, channel] = await Promise.all([
      notificationDatabaseService.getAlertById(alertId),
      notificationDatabaseService.getChannelById(channelId),
    ]);
    if (!alert || !channel || !channel.enabled || !isAlertEligibleForChannel(alert, channel)) return;
    await notificationDatabaseService.recordDeliveryAttempt({ job_id: job.id, alert_id: alertId, channel_id: channelId, attempt_number: job.attempts, status: 'started' });
    try {
      await notificationService.deliverAlertToChannel(alert, channel);
      await notificationDatabaseService.recordDeliveryAttempt({ job_id: job.id, alert_id: alertId, channel_id: channelId, attempt_number: job.attempts, status: 'sent' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await notificationDatabaseService.recordDeliveryAttempt({ job_id: job.id, alert_id: alertId, channel_id: channelId, attempt_number: job.attempts, status: 'failed', error_code: message.slice(0, 128), error_message: message });
      throw error;
    }
  });
  workflowRegistry.register('report.notify', async (payload, job) => {
    const reportId = Number(payload.reportId);
    const channelId = Number(payload.channelId);
    if (!Number.isSafeInteger(reportId) || reportId <= 0 || !Number.isSafeInteger(channelId) || channelId <= 0) {
      throw new Error('REPORT_NOTIFICATION_PAYLOAD_INVALID');
    }
    const [report, channel] = await Promise.all([
      reportDatabaseService.getReportById(reportId),
      notificationDatabaseService.getChannelById(channelId),
    ]);
    if (!report || !channel || !channel.enabled) {
      await reportDatabaseService.recordNotificationDelivery({
        jobId: job.id, reportId, channelId, attemptNumber: job.attempts, status: 'skipped', errorCode: 'REPORT_OR_CHANNEL_UNAVAILABLE',
      });
      return;
    }
    await reportDatabaseService.recordNotificationDelivery({
      jobId: job.id, reportId, channelId, attemptNumber: job.attempts, status: 'started',
    });
    const result = await notificationService.send(channel, {
      type: 'scheduled_report',
      report: { id: report.id, name: report.name, type: report.type, format: report.format, status: report.status },
      downloadPath: `/api/reports/${report.id}/download`,
    });
    if (!result.success) {
      await reportDatabaseService.recordNotificationDelivery({
        jobId: job.id, reportId, channelId, attemptNumber: job.attempts, status: 'failed',
        errorCode: result.error?.slice(0, 128), errorMessage: result.error,
      });
      throw new Error(result.error || 'REPORT_NOTIFICATION_FAILED');
    }
    await reportDatabaseService.recordNotificationDelivery({
      jobId: job.id, reportId, channelId, attemptNumber: job.attempts, status: 'sent',
    });
  });
  const workflowRuntime = new WorkerRuntime(workflowStore, workflowWorkerId);
  await enqueueNotificationDispatch();
  await enqueueReportSchedule();
  workflowTimer = setInterval(() => { void workflowRuntime.runOnce((job) => workflowRegistry.execute(job)).catch((error) => console.error('Workflow worker failed:', error)); }, 1_000);

  // 启动监控采集
  monitorCollector.start();

  // 从 metric-registry 同步告警规则
  await alertEngine.syncRulesFromRegistry();

  // 启动告警评估
  alertEngine.startEvaluationLoop();
  console.log('✅ 告警引擎已启动：每 60 秒评估规则');

  // 创建默认升级规则并启动升级 CronJob
  await alertEscalationService.createDefaultRules();
  alertEscalationService.start();

  // 通知推送服务暂不自动启动（待完善通知渠道配置 UI）
  // notificationService.start();
  console.log('⏸ 通知推送服务：未启动（待配置通知渠道）');

  console.log('🔄 正在加载数据库实例连接...');
  const instances = await instanceDatabaseService.getAllInstances();
  for (const instance of instances) {
    try {
      const password = await instanceDatabaseService.getInstancePassword(instance.id);
      if (password) {
        const added = await databaseService.addConnection(
          instance.id,
          instance.name,
          {
            host: instance.host,
            port: instance.port,
            user: instance.username,
            password: password,
            database: instance.database_name || (instance.db_type === 'postgresql' ? 'postgres' : instance.db_type === 'mysql' ? 'mysql' : undefined),
            db_type: instance.db_type,
          }
        );
        if (added) {
          console.log(`✅ 已加载实例：${instance.name}`);
          // 执行初始健康检查
          const health = await databaseService.checkHealth(instance.id);
          console.log(`   ❤️ 健康状态：${health?.status ?? 'unknown'} (${health?.health_score ?? 0})`);
        } else {
          // 连接失败，更新健康状态为 critical
          console.log(`❌ 实例连接失败：${instance.name}，标记为 critical`);
          await instanceDatabaseService.updateHealthStatus(instance.id, 0, 'critical');
        }
      } else {
        // 无法获取密码，标记为 unknown
        console.log(`⚠️ 无法获取实例密码：${instance.name}，标记为 unknown`);
        await instanceDatabaseService.updateHealthStatus(instance.id, 0, 'unknown');
      }
    } catch (error: any) {
      console.error(`❌ 实例连接失败：${instance.name}`, error.message);
      // 发生异常，更新健康状态为 critical
      await instanceDatabaseService.updateHealthStatus(instance.id, 0, 'critical');
    }
  }
  console.log(`✅ 已加载 ${instances.length} 个数据库实例`);

  // ========== CronManager 初始化 ==========
  const cronProvider = await createLLMProvider();
  const cronRunner = new AgentRunner(cronProvider);
  const cronTools = await loadPlatformTools();
  const cronExecutor = new CronExecutor(cronRunner, cronTools, cronProvider);
  cronManager = new CronManager(cronJobService, cronExecutor, workflowStore);
  await cronManager.start();

  // 清理崩溃残留的 running 日志
  try {
    const reaperPool = (await import('./src/db-connection')).dbConnection.getPool();
    if (reaperPool) {
      const [reaperResult] = await reaperPool.execute(
        "UPDATE cron_job_logs SET status = 'error', error_message = 'Server 重启，任务被中断', finished_at = NOW() WHERE status = 'running'"
      ) as any;
      if (reaperResult.affectedRows > 0) {
        console.log(`[CronManager] 清理了 ${reaperResult.affectedRows} 条残留 running 日志`);
      }
    }
  } catch (err: any) {
    console.warn('[CronManager] 清理残留 running 日志失败 (非致命):', err.message);
  }

  // 维护窗口缓存刷新 - 每 5 分钟
  maintenanceWindowService.startCacheRefresh(5);

  // 标记历史数据为估算值（新公式无法回推）
  try {
    const pool = (await import('./src/db-connection')).dbConnection.getPool();
    if (pool) {
      const [result] = await pool.execute(
        "UPDATE metrics_history SET is_estimated = TRUE WHERE recorded_at >= NOW() - INTERVAL 30 DAY AND is_estimated = 0"
      ) as any;
      if (result.affectedRows > 0) console.log(`📊 已标记 ${result.affectedRows} 条历史指标为估算值`);
    }
  } catch (e) { /* 非阻塞 */ }

  };

  // ========== Cron 任务管理 API ==========

  // 获取所有定时任务
  fastify.get('/api/cron/jobs', {
    preHandler: [verifyToken, requirePermission('cron:view')],
    handler: async (request, reply) => {
      try {
        const jobs = await cronJobService.getJobs();
        reply.send(jobs);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取单个定时任务
  fastify.get('/api/cron/jobs/:id', {
    preHandler: [verifyToken, requirePermission('cron:view')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const job = await cronJobService.getJobById(Number(id));
        if (!job) return reply.code(404).send({ error: '定时任务不存在' });
        reply.send(job);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
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

        // Validate cron expression
        try {
          new CronJob(body.cron_expr, () => {});
        } catch {
          return reply.code(400).send({ error: '无效的 cron 表达式' });
        }

        const id = await cronJobService.createJob({
          name: body.name,
          task_description: body.task_description,
          cron_expr: body.cron_expr,
          task_type: body.task_type,
          script_id: body.script_id,
          target_instance_id: body.target_instance_id,
          timezone: body.timezone,
          description: body.description,
          timeout_seconds: body.timeout_seconds,
          retry_count: body.retry_count,
        });

        await cronManager!.reload();
        reply.code(201).send({ id, message: '创建成功' });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
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

        const existing = await cronJobService.getJobById(Number(id));
        if (!existing) return reply.code(404).send({ error: '定时任务不存在' });

        // Validate cron expression if provided
        if (body.cron_expr) {
          try {
            new CronJob(body.cron_expr, () => {});
          } catch {
            return reply.code(400).send({ error: '无效的 cron 表达式' });
          }
        }

        const updated = await cronJobService.updateJob(Number(id), {
          task_description: body.task_description,
          cron_expr: body.cron_expr,
          enabled: body.enabled,
          task_type: body.task_type,
          script_id: body.script_id,
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
        await cronManager!.reload();

        reply.send({ message: '更新成功' });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
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

        const existing = await cronJobService.getJobById(Number(id));
        if (!existing) return reply.code(404).send({ error: '定时任务不存在' });

        await cronJobService.toggleJob(Number(id), body.enabled);

        // Reload CronManager to apply changes
        await cronManager!.reload();

        reply.send({ message: body.enabled ? '已启用' : '已停用' });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
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
        const config = await cronJobService.getJobById(Number(id));
        if (!config) return reply.code(404).send({ error: '定时任务不存在' });

        // Route through CronManager.executeJob() which handles task_type branching:
        // script jobs → executeScriptJob() (SqlExecutor), agent jobs → cronExecutor.execute()
        await cronManager!.executeJob(config);

        reply.send({ message: '执行完成' });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 删除定时任务
  fastify.delete('/api/cron/jobs/:id', {
    preHandler: [verifyToken, requirePermission('cron:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;

        const existing = await cronJobService.getJobById(Number(id));
        if (!existing) return reply.code(404).send({ error: '定时任务不存在' });

        const deleted = await cronJobService.deleteJob(Number(id));
        if (!deleted) {
          return reply.code(500).send({ error: '删除失败，数据库操作未生效' });
        }
        await cronManager!.reload();
        reply.send({ message: '删除成功' });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
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
        const query = request.query as any;
        const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
        const offset = Math.max(Number(query.offset) || 0, 0);

        const result = await cronJobService.getLogs(Number(id), limit, offset);
        reply.send(result);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
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
        reply.code(500).send({ error: error.message });
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
        reply.code(500).send({ error: error.message });
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
        reply.code(500).send({ error: error.message });
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
        });

        if (!updated) {
          return reply.code(400).send({ error: '没有可更新的字段' });
        }

        reply.send({ message: '更新成功' });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
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

        await scriptService.deleteScript(Number(id));
        reply.send({ message: '删除成功' });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 测试执行脚本（dry-run，结果限制100行）
  fastify.post('/api/cron/scripts/:id/test', {
    preHandler: [verifyToken, requirePermission('cron:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const body = request.body as any;

        if (!body.instance_id || typeof body.instance_id !== 'number') {
          return reply.code(400).send({ error: '缺少必要参数：instance_id（数字类型）' });
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
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 启动 HTTP API 服务器
  const port = process.env.PORT || process.env.BACKEND_PORT || process.env.API_PORT || 3000;
  await fastify.listen({ port: Number(port), host: '0.0.0.0' });
  const workerLease = new WorkerLease(pool as any);
  if (await workerLease.acquire()) {
    await startWorkers();
    const heartbeat = setInterval(() => {
      void workerLease.renew().then((renewed) => {
        if (!renewed) console.error('Worker lease lost; workers require operator intervention');
      }).catch((error) => console.error('Worker lease heartbeat failed:', error));
    }, 10_000);
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(heartbeat);
      if (workflowTimer) clearInterval(workflowTimer);
      monitorCollector.stop();
      alertEngine.stopEvaluationLoop();
      alertEscalationService.stop();
      stopSessionCleanup();
      promptManager.stopWatch();
      await cronManager?.stop();
      await engine?.dispose?.();
      await workerLease.release();
      await fastify.close();
      await dbConnection.close();
    };
    process.once('SIGTERM', () => void shutdown());
    process.once('SIGINT', () => void shutdown());
  } else {
    console.warn('Worker lease is held by another process; this replica will serve API requests only');
  }
  console.log(`🚀 服务器已启动：http://localhost:${port}`);
}

start().catch((err) => {
  console.error('服务器启动失败:', err);
  process.exit(1);
});
