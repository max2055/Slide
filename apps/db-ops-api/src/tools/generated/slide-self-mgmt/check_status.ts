/**
 * Slide 状态检查工具
 *
 * 检查 Slide 前后端服务状态、数据库连接、LLM 连接等
 */

import type { AnyAgentTool, ToolResult } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { databaseService } from '../../../database-service.js';
import { instanceDatabaseService } from '../../../instance-database-service.js';
import { getAllProviders } from '../../../llm/provider-catalog.js';

/**
 * 服务状态检查结果
 */
interface ServiceStatus {
  name: string;
  status: 'running' | 'stopped' | 'error' | 'unknown';
  port?: number;
  responseTimeMs?: number;
  error?: string;
}

/**
 * Slide 整体状态
 */
interface SlideStatus {
  overall: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  services: ServiceStatus[];
  timestamp: string;
  version?: string;
}

export const checkStatusTool: AnyAgentTool = {
  name: 'slide_check_status',
  description: '检查 Slide 平台整体状态，包括前后端服务、数据库连接、LLM 连接等',
  parameters: {
    type: 'object',
    properties: {
      /** 是否检查详细状态 */
      include_details: {
        type: 'boolean',
        description: '是否返回详细状态信息',
        default: false,
      },
      /** 是否测试数据库连接 */
      test_db_connections: {
        type: 'boolean',
        description: '是否测试所有数据库连接',
        default: false,
      },
      /** 是否测试 LLM 连接 */
      test_llm: {
        type: 'boolean',
        description: '是否测试 LLM 连接',
        default: false,
      },
    },
  },
  group: 'slide_self_mgmt',
  handler: async (args) => {
    const includeDetails = args.include_details as boolean;
    const testDbConnections = args.test_db_connections as boolean;
    const testLlm = args.test_llm as boolean;

    try {
      const status: SlideStatus = {
        overall: 'unknown',
        services: [],
        timestamp: new Date().toISOString(),
      };

      // 1. 检查后端 API 服务
      const backendStatus = await checkBackendService();
      status.services.push(backendStatus);
      status.version = backendStatus.status !== 'unknown' ? getBackendVersion() : undefined;

      // 2. 检查前端服务
      const frontendStatus = await checkFrontendService();
      status.services.push(frontendStatus);

      // 3. 检查数据库连接（可选）
      if (testDbConnections) {
        const dbStatus = await checkDatabaseConnections();
        status.services.push(...dbStatus);
      }

      // 4. 检查 LLM 连接（可选）
      if (testLlm) {
        const llmStatus = await checkLlmConnection();
        status.services.push(llmStatus);
      }

      // 计算整体状态
      status.overall = calculateOverallStatus(status.services);

      // 构建响应内容
      const content = buildStatusReport(status, includeDetails);

      return {
        success: true,
        data: status,
        summary: `Slide 状态：${translateStatus(status.overall)}，${status.services.length} 个服务组件`,
        details: {
          status,
          includeDetails,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `状态检查失败：${errorMessage}`,
        errorCode: 'STATUS_CHECK_FAILED',
      };
    }
  },
};

// ============== 状态检查实现 ==============

/**
 * 检查后端服务状态
 */
async function checkBackendService(): Promise<ServiceStatus> {
  const startTime = Date.now();

  try {
    // 尝试访问健康检查端点
    const response = await fetch('http://localhost:3000/api/health', {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    const responseTimeMs = Date.now() - startTime;

    if (response.ok) {
      return {
        name: '后端 API 服务',
        status: 'running',
        port: 3000,
        responseTimeMs,
      };
    } else {
      return {
        name: '后端 API 服务',
        status: 'error',
        port: 3000,
        responseTimeMs,
        error: `HTTP ${response.status}`,
      };
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: '后端 API 服务',
      status: 'stopped',
      port: 3000,
      error: errorMessage.includes('ECONNREFUSED')
        ? '服务未启动或端口不可达'
        : errorMessage,
    };
  }
}

/**
 * 检查前端服务状态
 */
async function checkFrontendService(): Promise<ServiceStatus> {
  const startTime = Date.now();

  try {
    const response = await fetch('http://localhost:5173', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    });

    const responseTimeMs = Date.now() - startTime;

    if (response.ok || response.status === 304) {
      return {
        name: '前端服务',
        status: 'running',
        port: 5173,
        responseTimeMs,
      };
    } else {
      return {
        name: '前端服务',
        status: 'error',
        port: 5173,
        responseTimeMs,
        error: `HTTP ${response.status}`,
      };
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: '前端服务',
      status: 'stopped',
      port: 5173,
      error: errorMessage.includes('ECONNREFUSED')
        ? '服务未启动或端口不可达'
        : errorMessage,
    };
  }
}

/**
 * 检查数据库连接状态
 */
async function checkDatabaseConnections(): Promise<ServiceStatus[]> {
  const statuses: ServiceStatus[] = [];

  try {
    const instances = await instanceDatabaseService.getAllInstances();
    const conns = databaseService.getAllConnections();

    for (const inst of instances) {
      if (inst.status !== 'active') continue;
      const conn = conns.find(c => c.id === inst.id);
      const alive = conn ? await databaseService.checkConnectionAlive(inst.id) : false;

      statuses.push({
        name: `${inst.name} (${inst.db_type?.toUpperCase()})`,
        status: alive ? 'running' : 'error',
        port: inst.port,
        error: conn && !alive
          ? '连接已断开'
          : !conn
            ? '未建立连接'
            : undefined,
      });
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    statuses.push({
      name: '数据库连接检查',
      status: 'error',
      error: errorMessage,
    });
  }

  return statuses;
}

/**
 * 检查 LLM 连接状态
 */
async function checkLlmConnection(): Promise<ServiceStatus> {
  const startTime = Date.now();

  try {
    const providers = getAllProviders();
    const enabled = providers.filter(p => p.apiKey && p.apiKey !== 'your-api-key');

    if (enabled.length === 0) {
      return {
        name: 'LLM 服务',
        status: 'unknown',
        error: '没有启用的 LLM 提供商',
      };
    }

    // 检查第一个启用的提供商是否已配置 API key
    const primary = enabled[0];
    if (!primary.apiKey || primary.apiKey === 'your-api-key') {
      return {
        name: `LLM 服务 (${primary.id})`,
        status: 'unknown',
        error: 'API Key 未配置',
      };
    }

    return {
      name: `LLM 服务 (${primary.id})`,
      status: 'running',
      responseTimeMs: Date.now() - startTime,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      name: 'LLM 服务',
      status: 'error',
      error: errorMessage,
    };
  }
}

// ============== 辅助函数 ==============

/**
 * 获取后端版本号
 */
function getBackendVersion(): string | undefined {
  // 从 package.json 或环境变量读取版本
  return process.env.npm_package_version || 'unknown';
}

/**
 * 计算整体状态
 */
function calculateOverallStatus(services: ServiceStatus[]): 'healthy' | 'degraded' | 'unhealthy' | 'unknown' {
  if (services.length === 0) return 'unknown';

  const statusCounts = {
    running: services.filter(s => s.status === 'running').length,
    stopped: services.filter(s => s.status === 'stopped').length,
    error: services.filter(s => s.status === 'error').length,
    unknown: services.filter(s => s.status === 'unknown').length,
  };

  // 所有服务都正常运行
  if (statusCounts.running === services.length) {
    return 'healthy';
  }

  // 有关键服务停止或错误
  if (statusCounts.stopped > 0 || statusCounts.error > 0) {
    // 检查是否是核心服务
    const coreServices = ['后端 API 服务', '系统数据库 (MySQL)'];
    const coreServiceIssues = services.some(
      s => coreServices.includes(s.name) && (s.status === 'stopped' || s.status === 'error')
    );

    if (coreServiceIssues) {
      return 'unhealthy';
    }
    return 'degraded';
  }

  // 大部分是 unknown
  if (statusCounts.unknown > services.length / 2) {
    return 'unknown';
  }

  return 'degraded';
}

/**
 * 翻译状态文本
 */
function translateStatus(status: string): string {
  const map: Record<string, string> = {
    healthy: '健康',
    degraded: '降级',
    unhealthy: '不健康',
    unknown: '未知',
  };
  return map[status] || status;
}

/**
 * 构建状态报告文本
 */
function buildStatusReport(status: SlideStatus, includeDetails: boolean): string {
  const lines: string[] = [];

  lines.push(`📊 Slide 平台状态报告`);
  lines.push('');
  lines.push(`整体状态：${translateStatus(status.overall)}`);
  lines.push(`检查时间：${new Date(status.timestamp).toLocaleString('zh-CN')}`);
  if (status.version) {
    lines.push(`版本：${status.version}`);
  }
  lines.push('');
  lines.push('服务组件状态:');
  lines.push('');

  for (const service of status.services) {
    const icon = service.status === 'running' ? '✅' : service.status === 'error' ? '❌' : '⚠️';
    lines.push(`${icon} ${service.name}: ${translateStatus(service.status)}`);

    if (includeDetails || service.error) {
      if (service.port) {
        lines.push(`   端口：${service.port}`);
      }
      if (service.responseTimeMs) {
        lines.push(`   响应时间：${service.responseTimeMs}ms`);
      }
      if (service.error) {
        lines.push(`   错误：${service.error}`);
      }
    }
    lines.push('');
  }

  if (!includeDetails) {
    lines.push('💡 提示：使用 include_details=true 获取详细信息');
  }

  return lines.join('\n');
}

/**
 * 翻译服务状态
 */
function translateServiceStatus(status: string): string {
  const map: Record<string, string> = {
    running: '运行中',
    stopped: '已停止',
    error: '错误',
    unknown: '未知',
  };
  return map[status] || status;
}

// 注册工具到全局目录
toolCatalog.register(checkStatusTool);
