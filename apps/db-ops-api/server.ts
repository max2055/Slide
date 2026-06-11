/**
 * Slide - Database Operations API Server
 */
import 'dotenv/config';

// 防止 cron 任务中的未处理异常导致进程退出
process.on('uncaughtException', (err) => console.error('⚠️ 未捕获异常:', err.message));
process.on('unhandledRejection', (reason) => console.error('⚠️ 未处理拒绝:', reason));

import Fastify from 'fastify';
import { randomBytes, createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import cors from '@fastify/cors';
import { authDatabaseService } from './src/auth-database-service.js';
import { requirePermission } from './src/auth/require-permission.js';
import { requireInstanceAccess } from './src/auth/require-instance-access.js';
import { RbacService } from './src/auth/rbac-service.js';
import { rbacApiRoutes } from './src/auth/rbac-api.js';
import { strictBody, warnUnknown } from './src/utils/strict-body.js';
import { instanceDatabaseService } from './src/instance-database-service.js';
import { llmDatabaseService } from './src/llm-database-service.js';
import { resolveProviderFromBaseUrl, getProvider } from './src/llm/provider-catalog.js';
import { alertDatabaseService } from './src/alert-database-service.js';
import { metricsDatabaseService } from './src/metrics-database-service.js';
import { databaseService } from './src/database-service.js';
import { llmService } from './src/llm-service.js';
import { dbConnection } from './src/db-connection.js';
import { monitorCollector } from './src/monitor-collector.js';
import { chatDatabaseService } from './src/chat-database-service.js';
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
import { userPreferenceService } from './src/user-preference-service.js';
import { collectionCapabilityTracker } from './src/collection-capabilities.js';
import { sqlAuditService } from './src/sql-audit-service.js';
import { queryAuditLogs, auditLogManager, DatabaseAuditLogStore } from './src/audit/audit-log.js';
import { sqlExecutor } from './src/sql-executor.js';
import { approvalService } from './src/approval-service.js';
import { databaseLogService } from './src/database-log-service.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CronJobDatabaseService, cronJobService } from './src/cron/cron-job-service';
import { CronManager } from './src/cron/cron-manager';
import { CronExecutor } from './src/cron/cron-executor';
import { CronJob } from 'cron';
import { getAgentEngine, createLLMProvider, loadPlatformTools } from './src/adapter/get-agent-engine.js';
import { DirectAdapter } from './src/adapter/direct-adapter.js';
import { AgentRunner } from '@slide/agent-core';

const fastify = Fastify({
  logger: false,
});

// JWT 密钥
const JWT_SECRET = process.env.JWT_SECRET_KEY || randomBytes(32).toString('hex');
const JWT_EXPIRES_IN = '1h';
const rbacService = new RbacService();

// JWT 验证中间件
async function verifyToken(request: any, reply: any) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({ error: '未提供认证令牌' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    // 验证用户状态和角色（防止 JWT 在角色/状态变更后仍然有效）
    try {
      const currentUser = await authDatabaseService.getUserById(decoded.userId);
      if (!currentUser) {
        // 用户不存在、被删除或状态已改为 inactive/locked
        return reply.code(401).send({ error: '用户已失效，请重新登录' });
      }
      // role removed in Phase 84: users.role column dropped by migration
      (request as any).user = decoded;
    } catch {
      // DB 查询失败时降级处理：使用 JWT 中的缓存角色，不影响现有请求
      console.warn('[auth] 用户状态查询失败，使用 JWT 缓存角色');
      (request as any).user = decoded;
    }
  } catch (err) {
    return reply.code(401).send({ error: '无效的认证令牌' });
  }
}

async function start() {
  // 安全检查：ENCRYPTION_KEY 必须配置
  if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
    console.warn('⚠  ENCRYPTION_KEY 未设置或长度不足 32 字符');
    console.warn('   请在 .env 中添加：ENCRYPTION_KEY=your-random-key-at-least-32-chars');
    console.warn('   已加密的数据库密码仍可用旧默认值解密，但新加密数据不安全。');
  }

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
  if (pool) {
    const dbAuditLogStore = new DatabaseAuditLogStore(pool);
    auditLogManager.setPersistentStore(dbAuditLogStore);
    console.log('✅ SQL 执行历史持久化存储已就绪');
  }

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
    const { username, password } = check.body;

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

      // 生成 JWT 令牌
      const token = jwt.sign(
        {
          userId: user.id,
          username: user.username,
          // role removed in Phase 84: users.role column dropped by migration
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );

      // 生成 refresh token (7天有效期)
      const rt = await rbacService.createRefreshToken(user.id, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

      reply.send({
        token,
        refreshToken: rt.token,
        expiresIn: 3600,
        user: {
          id: user.id,
          username: user.username,
          // role removed in Phase 84: users.role column dropped by migration
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

    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
    const stored = await rbacService.validateRefreshToken(tokenHash);
    if (!stored) return reply.code(401).send({ error: '无效的 refresh token' });

    // Replay detection per D-02: if already revoked, revoke ALL tokens for this user
    if (stored.revoked) {
      console.warn('[security] Refresh token replay detected for user', stored.user_id);
      await rbacService.revokeAllUserTokens(stored.user_id);
      return reply.code(401).send({ error: 'refresh token 已被使用，请重新登录' });
    }

    // Check expiry
    if (new Date(stored.expires_at) < new Date()) {
      return reply.code(401).send({ error: 'refresh token 已过期，请重新登录' });
    }

    // Revoke current token (rotation)
    await rbacService.revokeRefreshToken(stored.id);

    // Fetch user for username claim in JWT
    let username = String(stored.user_id);
    try {
      const user = await authDatabaseService.getUserById(stored.user_id);
      if (user) username = user.username;
    } catch {}

    // Issue new tokens
    const newAccessToken = jwt.sign(
      { userId: stored.user_id, username },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    const rt = await rbacService.createRefreshToken(stored.user_id, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    reply.send({
      token: newAccessToken,
      refreshToken: rt.token,
      expiresIn: 3600,
    });
  });

  // ========== 权限查询 API ==========

  fastify.get('/api/auth/permissions', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const user = (request as any).user;
      if (!user) return reply.code(401).send({ error: '请先登录' });
      const permissions = await rbacService.getUserPermissions(user.userId);
      reply.send(Array.from(permissions));
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
      const { username, password, email } = check.body;
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
      const { status, email } = check.body;
      const validStatuses = ['active', 'inactive', 'locked'];
      if (status && !validStatuses.includes(status)) {
        return reply.code(400).send({ error: '无效的状态' });
      }
      // role 更新通过 RBAC API (POST /api/v1/rbac/users/:userId/roles) 完成
      const result = await authDatabaseService.updateUserById(Number(id), { status });
      if (!result.success) {
        return reply.code(400).send(result);
      }
      // email update if provided
      if (email && email !== '') {
        try {
          const pool = (await import('./src/db-connection.js')).dbConnection.getPool();
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
      const instances = await instanceDatabaseService.getAllInstances();
      reply.send(instances);
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
      warnUnknown(data, ['name','displayName','deploymentType','apiKey','apiFormat','model','baseURL','modelsSupported','contextWindow','supportsFunctionCall','supportsVision','inputCostPer1k','outputCostPer1k','enabled','temperature','maxTokens','timeoutMs','rateLimitPerMinute','dailyQuota'], 'POST /api/llm/configs');;
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
      const result = await llmDatabaseService.configureProvider({ ...data, id: Number(id) });
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
        const { providerName } = check.body;
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

  // 聊天历史

	  // 聊天发送 (DirectAdapter / IAgentEngine)
	  fastify.post('/api/chat/send', { preHandler: [verifyToken] }, async (request, reply) => {
	    try {
	      const check = strictBody(request.body as Record<string, unknown>,
	        ['message', 'sessionKey'], 'POST /api/chat/send');
	      if (check.error) return reply.code(400).send(check.error);
	      const { message, sessionKey } = check.body;
	      if (!message) {
	        return reply.code(400).send({ error: 'message is required' });
	      }
	      const { handleChatSend } = await import('./src/chat-handler.js');
	      const result = await handleChatSend({
	        sessionKey: sessionKey || `api_${Date.now()}`,
	        message,
	      });
	      reply.send({ reply: result.finalContent, usage: result.usage });
	    } catch (error: any) {
	      reply.code(500).send({ error: 'Chat send failed: ' + error.message });
	    }
	  });

  fastify.get('/api/chat/history', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { sessionKey, limit: limitStr } = request.query as { sessionKey?: string; limit?: string };
      const limit = limitStr ? parseInt(limitStr, 10) || 200 : 200;
      const parseContent = (rawContent: string) => {
        const thinkRe = /<think>([\s\S]*?)<\/think>/;
        const match = thinkRe.exec(rawContent);
        if (match) {
          const thinking = match[1].trim();
          const text = rawContent.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
          return { content: [{ type: 'thinking', thinking }, { type: 'text', text }] };
        }
        return { content: rawContent };
      };
      const formatMsg = (msg: any) => ({
        role: msg.role,
        ...parseContent(msg.content || ''),
        timestamp: msg.created_at ? new Date(msg.created_at).getTime() : Date.now(),
      });
      if (!sessionKey) {
        return reply.code(400).send({ error: 'sessionKey parameter is required' });
      }
      const msgs = await chatDatabaseService.getMessages(sessionKey, limit);
      return reply.send({ messages: msgs.map(formatMsg) });
    } catch (error: any) {
      reply.code(500).send({ error: '获取聊天历史失败：' + error.message });
    }
  });

  // ========== Agent List API (DirectAdapter) ==========
  fastify.get('/api/agents', { preHandler: [verifyToken] }, async (_request, reply) => {
    reply.send({
      defaultId: 'slide-db-ops',
      mainKey: 'main',
      scope: 'default',
      agents: [
        { id: 'slide-db-ops', name: 'Slide', identity: { name: 'Slide', avatarUrl: '' } },
      ],
    });
  });

  // ========== Chat Sessions List API (DirectAdapter) ==========
  fastify.get('/api/sessions', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { activeMinutes } = request.query as { activeMinutes?: string };
      const chatDb = (await import('./src/chat-database-service.js')).chatDatabaseService;
      const sessions = await chatDb.getSessions();
      const now = Date.now();
      const filtered = activeMinutes
        ? (sessions || []).filter((s: any) => {
            const lastMsg = s.last_message_at ? new Date(s.last_message_at).getTime() : 0;
            return (now - lastMsg) < parseInt(activeMinutes, 10) * 60 * 1000;
          })
        : (sessions || []);
      reply.send({
        ok: true,
        sessions: filtered.map((s: any) => ({
          key: s.session_id,
          kind: 'direct',
          label: s.title || s.session_id,
          updatedAt: s.last_message_at ? new Date(s.last_message_at).getTime() : null,
        })),
        defaults: {},
      });
    } catch (error: any) {
      reply.code(500).send({ error: '获取会话列表失败：' + error.message });
    }
  });

  // PATCH /api/sessions/:key — 更新会话设置（model、thinkingLevel）
  fastify.patch('/api/sessions/:key', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const { key } = request.params as { key: string };
      const body = request.body as { model?: string | null; thinkingLevel?: string | null };
      await chatDatabaseService.updateSessionSettings(key, {
        model: body.model,
        thinkingLevel: body.thinkingLevel,
      });
      reply.send({ ok: true });
    } catch (error: any) {
      reply.code(500).send({ error: '更新会话设置失败：' + error.message });
    }
  });

  // ========== 数据库实例管理 API ==========

  // 创建实例
  fastify.post('/api/database/instances', { preHandler: [verifyToken, requirePermission('instance:create')] }, async (request, reply) => {
    try {
      const data = request.body as any;
      const result = await instanceDatabaseService.createInstance(data)
      warnUnknown(data, ['name','environment','db_type','host','port','username','password','database_name','max_connections','connection_timeout_ms','description','tags','created_by'], 'POST /api/database/instances');;
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
      reply.send(instance);
    } catch (error: any) {
      reply.code(500).send({ error: '获取实例详情失败：' + error.message });
    }
  });

  // 更新实例
  fastify.put('/api/database/instances/:id', { preHandler: [verifyToken, requirePermission('instance:update'), requireInstanceAccess('read-write')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const data = request.body as any;
      const result = await instanceDatabaseService.updateInstance(Number(id), data)
      warnUnknown(data, ['name','environment','db_type','host','port','username','password','database_name','max_connections','connection_timeout_ms','description','tags'], 'PUT /api/database/instances/:id');;
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
        const { host, port, username, password, database_name, db_type } = check.body;
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

  // SQL 执行
  fastify.post('/api/database/instances/:id/execute', { preHandler: [verifyToken, requirePermission('instance:query'), requireInstanceAccess('read-write')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const check = strictBody(request.body as Record<string, unknown>,
          ['sql', 'database'], 'POST /api/database/instances/:id/execute');
        if (check.error) return reply.code(400).send(check.error);
        const { sql, database } = check.body;
      if (!sql) return reply.code(400).send({ error: '缺少参数：sql' });

      const user = (request as any).user;
      const result = await sqlExecutor.executeSql(Number(id), sql, {
        userId: String(user?.userId || ''),
        username: user?.username || 'unknown',
        ipAddress: request.ip,
        database,
      });
      if (!result.success) {
        return reply.code(400).send(result);
      }
      reply.send(result);
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
      const result = await approvalService.submitForApproval({
        instance_id: Number(instance_id),
        sql_text,
        submitted_by: user?.userId,
        target_database: database_name,
      });
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/approval/batch-review', { preHandler: [verifyToken, requirePermission('approval:approve')] }, async (request, reply) => {
    try {
      const check = strictBody(request.body as Record<string, unknown>,
          ['ids', 'action', 'notes', 'execute_ids'], 'POST /api/approval/batch-review');
        if (check.error) return reply.code(400).send(check.error);
        const { ids, action, notes, execute_ids } = check.body;
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i: any) => Number.isInteger(i) && i > 0)) {
        return reply.code(400).send({ error: 'ids 必须是非空的正整数数组' });
      }
      if (!action || !['approve', 'reject'].includes(action)) {
        return reply.code(400).send({ error: 'action 必须是 approve 或 reject' });
      }
      const user = (request as any).user;
      const items = (ids as number[]).map(id => ({
        id,
        action: action as 'approve' | 'reject',
        execute_after_approve: execute_ids ? execute_ids.includes(id) : true,
      }));
      const results = await approvalService.batchReview({ items, reviewed_by: user?.userId, notes: notes || '' });

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
                  action: action as 'approve' | 'reject',
                  notes: notes,
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
        const { action, notes, execute_after_approve } = check.body;
      if (!action || !['approve', 'reject'].includes(action)) {
        return reply.code(400).send({ error: 'action 必须是 approve 或 reject' });
      }
      const user = (request as any).user;
      const result = await approvalService.reviewRequest(Number(id), {
        action,
        reviewed_by: user?.userId,
        notes,
        execute_after_approve: execute_after_approve !== false,
      });

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
                action,
                notes,
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

      // Current total — use database_instances (single source of truth) instead of capacity_history
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
           FROM database_instances
           WHERE status = 'active'`,
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
        const { type, instance_id, status, page = '1', limit = '20' } = request.query as any;
        const filters = {
          type: type as any,
          instance_id: instance_id ? Number(instance_id) : undefined,
          status: status as any,
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
        const configs = await reportConfigService.getConfigs();
        // Compute next_run for each config
        const result = configs.map((config: any) => {
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
        const { name, cron, type, instance_id, format, enabled } = body;

        // Validate required fields
        if (!name || !cron || !type || instance_id === undefined) {
          return reply.code(400).send({ error: '缺少必要参数：name, cron, type, instance_id' });
        }

        const validTypes = ['health', 'performance', 'slow_query', 'capacity'];
        if (!validTypes.includes(type)) {
          return reply.code(400).send({ error: `无效的报表类型：${type}，有效值：${validTypes.join(', ')}` });
        }

        const validFormats = ['html', 'pdf', 'md', 'json'];
        if (format && !validFormats.includes(format)) {
          return reply.code(400).send({ error: `无效的输出格式：${format}，有效值：${validFormats.join(', ')}` });
        }

        const result = await reportConfigService.createConfig({
          name,
          cron,
          type,
          instance_id: Number(instance_id),
          format: format || 'html',
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

        const updated = await reportConfigService.updateConfig(Number(id), {
          name: body.name,
          cron: body.cron,
          type: body.type,
          instance_id: body.instance_id !== undefined ? Number(body.instance_id) : undefined,
          format: body.format,
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

        const validFormats = ['html', 'pdf', 'json', 'md'];
        const safeFormat = validFormats.includes(format) ? format : 'html';

        const report = await reportService.generateReport(type as 'health' | 'performance' | 'slow_query' | 'capacity', instanceId, { format: safeFormat });
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

  // ─── 指标模板 (Metric Templates) ───────────────────────
  const { templateDatabaseService } = await import('./src/template-database-service.js');

  // 列出模板
  fastify.get('/api/metric-templates', {
    preHandler: [verifyToken, requirePermission('metric:view')],
    handler: async (request, reply) => {
      try {
        const { db_type, enabled } = request.query as any;
        const templates = await templateDatabaseService.listTemplates({
          db_type: db_type || undefined,
          enabled: enabled !== undefined ? enabled === 'true' : undefined,
        });
        reply.send(templates);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 获取单个模板
  fastify.get('/api/metric-templates/:id', {
    preHandler: [verifyToken, requirePermission('metric:view')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const template = await templateDatabaseService.getTemplate(Number(id));
        if (!template) return reply.code(404).send({ error: '模板未找到' });
        reply.send(template);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 创建模板
  fastify.post('/api/metric-templates', {
    preHandler: [verifyToken, requirePermission('metric:manage')],
    handler: async (request, reply) => {
      try {
        const body = request.body as any;
        const result = await templateDatabaseService.createTemplate({
          name: body.name,
          description: body.description,
          db_type: body.db_type,
          macro_defaults: body.macro_defaults,
          created_by: (request as any).user?.userId,
        });
        if (result.success) {
          reply.code(201).send({ id: result.id, message: '创建成功' });
        } else {
          reply.code(400).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 更新模板
  fastify.put('/api/metric-templates/:id', {
    preHandler: [verifyToken, requirePermission('metric:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const body = request.body as any;
        const result = await templateDatabaseService.updateTemplate(Number(id), body);
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

  // 删除模板
  fastify.delete('/api/metric-templates/:id', {
    preHandler: [verifyToken, requirePermission('metric:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const result = await templateDatabaseService.deleteTemplate(Number(id));
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

  // ─── 实例-模板关联 ────────────────────────────────────

  // 获取实例的关联模板
  fastify.get('/api/instances/:id/templates', {
    preHandler: [verifyToken, requirePermission('metric:view')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const links = await templateDatabaseService.getInstanceTemplates(Number(id));
        reply.send(links);
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 关联模板到实例
  fastify.post('/api/instances/:id/templates', {
    preHandler: [verifyToken, requirePermission('instance:manage')],
    handler: async (request, reply) => {
      try {
        const { id } = request.params as any;
        const check = strictBody(request.body as Record<string, unknown>,
          ['template_id', 'macro_overrides'], 'POST /api/instances/:id/templates');
        if (check.error) return reply.code(400).send(check.error);
        const { template_id, macro_overrides } = check.body;
        const result = await templateDatabaseService.linkTemplate(Number(id), template_id, macro_overrides);
        if (result.success) {
          reply.send({ message: '关联成功' });
        } else {
          reply.code(400).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 解除实例模板关联
  fastify.delete('/api/instances/:id/templates/:templateId', {
    preHandler: [verifyToken, requirePermission('instance:manage')],
    handler: async (request, reply) => {
      try {
        const { id, templateId } = request.params as any;
        const result = await templateDatabaseService.unlinkTemplate(Number(id), Number(templateId));
        if (result.success) {
          reply.send({ message: '已解除关联' });
        } else {
          reply.code(400).send({ error: result.error });
        }
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 更新实例的宏覆盖
  fastify.put('/api/instances/:id/templates/:templateId/overrides', {
    preHandler: [verifyToken, requirePermission('instance:manage')],
    handler: async (request, reply) => {
      try {
        const { id, templateId } = request.params as any;
        const check = strictBody(request.body as Record<string, unknown>,
          ['macro_overrides'], 'PUT /api/instances/:id/templates/:templateId/overrides');
        if (check.error) return reply.code(400).send(check.error);
        const { macro_overrides } = check.body;
        const result = await templateDatabaseService.updateInstanceOverrides(Number(id), Number(templateId), macro_overrides);
        if (result.success) {
          reply.send({ message: '覆盖已更新' });
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
        reply.send(channels);
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

  // ========== AI 分析 API ==========

  // 提交 AI 分析请求
  fastify.post('/api/ai/analysis', {
    preHandler: [verifyToken, requirePermission('ai:manage')],
    handler: async (request, reply) => {
      try {
        const { analysis_type, instance_id, related_id, trigger_type = 'manual' } = request.body as {
          analysis_type: 'topsql_analysis' | 'alert_rca' | 'fault_diagnosis' | 'capacity_prediction';
          instance_id: number;
          related_id?: number;
          trigger_type?: 'manual' | 'auto';
        };

        if (!analysis_type || !instance_id) {
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
      const metrics = metricRegistry.getAll();
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
        const { db_type, description, instance_id } = check.body;
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
        const { new_level } = check.body;
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
        const { instance_id, metric_name, duration_minutes } = check.body;
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
        const { user_id } = check.body;
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
        const { note } = check.body;
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
        const { resolution_notes } = check.body;
      const result = await alertEventService.resolveEvent(Number(id), resolution_notes);
      reply.send(result);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/alerts/events/:id/close', { preHandler: [verifyToken, requirePermission('alert:manage')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const result = await alertEventService.closeEvent(Number(id));
      reply.send(result);
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

  // 初始化 Agent Engine 并启动 WS 传输层
  console.log('🚀 正在启动 Agent Engine...');
  const engine = await getAgentEngine();
  await engine.start();
  console.log('🔌 Agent Engine 已启动: DirectAdapter');

  // 从数据库加载指标定义（含 collection_sqls 和 compute_expr）
  await metricRegistry.initialize();

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
  const cronManager = new CronManager(cronJobService, cronExecutor);
  await cronManager.start();

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
          timezone: body.timezone,
          description: body.description,
          timeout_seconds: body.timeout_seconds,
        });

        await cronManager.reload();
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
          timezone: body.timezone,
          description: body.description,
          timeout_seconds: body.timeout_seconds,
          retry_count: body.retry_count,
        });

        if (!updated) {
          return reply.code(400).send({ error: '没有可更新的字段' });
        }

        // Reload CronManager to apply changes
        await cronManager.reload();

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
        await cronManager.reload();

        reply.send({ message: body.enabled ? '已启用' : '已停用' });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    }
  });

  // 手动触发定时任务（通过 CronExecutor 执行）
  fastify.post('/api/cron/jobs/:id/run', {
    preHandler: [verifyToken, requirePermission('cron:manage')],
    handler: async (request, reply) => {
      let logId: number | null = null;
      const startTime = Date.now();
      try {
        const { id } = request.params as any;
        const config = await cronJobService.getJobById(Number(id));
        if (!config) return reply.code(404).send({ error: '定时任务不存在' });

        logId = await cronJobService.startLog(config.id);

        const result = await cronExecutor.execute(
          config.id,
          config.task_description,
          config.timeout_seconds || 300,
          config.output_schema,
        );

        const status = result.error ? 'error' : result.stopReason === 'max_iterations' ? 'partial' : 'success';
        await cronJobService.completeLog(logId, status,
          result.finalContent || '手动触发执行成功',
          result.error || undefined,
          result.structuredResult || null,
          {
            tools_used: result.toolsUsed,
            tool_events: result.toolEvents,
            usage: result.usage,
            stop_reason: result.stopReason,
            duration_ms: Date.now() - startTime,
          },
        );
        reply.send({ logId, status });
      } catch (error: any) {
        if (logId !== null) {
          await cronJobService.completeLog(logId, 'error', `执行失败`, error.message, {
            error_trace: error.stack,
          }).catch(() => {});
        }
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
        await cronManager.reload();
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

  // 启动 HTTP API 服务器
  const port = process.env.BACKEND_PORT || process.env.API_PORT || 3000;
  await fastify.listen({ port: Number(port), host: '0.0.0.0' });
  console.log(`🚀 服务器已启动：http://localhost:${port}`);
}

start().catch((err) => {
  console.error('服务器启动失败:', err);
  process.exit(1);
});
