/** Read-only server operations tools backed by ServerDiagnosticService. */

import type { AnyAgentTool, ToolExecutionContext } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
import { serverDiagnosticService } from '../../../server-diagnostic-service.js';

const GROUP = 'slide_self_mgmt';
const RANGES = ['1h', '6h', '24h', '7d', '30d'] as const;
const SECTIONS = ['services', 'listeningPorts', 'topProcesses', 'systemLogs', 'interfaceErrors'] as const;

function actorCanView(context?: ToolExecutionContext): boolean {
  const permissions = context?.actor?.permissions ?? [];
  return permissions.includes('*') || permissions.includes('servers:view') || permissions.includes('servers:*');
}

function serverId(args: Record<string, unknown>): number | null {
  const value = args.serverId;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function limit(args: Record<string, unknown>, fallback = 100): number | null {
  if (args.maxRows === undefined && args.limit === undefined) return fallback;
  const value = args.maxRows ?? args.limit;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 100 ? value : null;
}

function denied() {
  return { success: false, error: '权限不足或缺少 actor 上下文', errorCode: 'RESOURCE_FORBIDDEN' };
}

function capDiagnosticRows(diagnostics: any, sectionName: string | undefined, maxRows: number): any {
  const names = sectionName ? [sectionName] : [...SECTIONS];
  const copy: any = { ...diagnostics, sections: {} };
  for (const name of names) {
    const source = diagnostics.sections?.[name];
    if (source) copy.sections[name] = { ...source, items: Array.isArray(source.items) ? source.items.slice(0, maxRows) : [] };
  }
  // Do not leak unbounded alias arrays when returning a filtered payload.
  copy.serviceStatus = copy.sections.services ?? { ...diagnostics.serviceStatus, items: [] };
  copy.listeningPorts = copy.sections.listeningPorts ?? { ...diagnostics.listeningPorts, items: [] };
  copy.topProcesses = copy.sections.topProcesses ?? { ...diagnostics.topProcesses, items: [] };
  copy.recentSystemLogs = copy.sections.systemLogs ?? { ...diagnostics.recentSystemLogs, items: [] };
  copy.interfaceErrors = copy.sections.interfaceErrors ?? { ...diagnostics.interfaceErrors, items: [] };
  return copy;
}

export const listServerInstancesTool: AnyAgentTool = {
  name: 'list_server_instances',
  description: '列出已纳管服务器及其状态。结果仅来自已登记服务器，最多返回 100 条。',
  parameters: { type: 'object', properties: { maxRows: { type: 'number', default: 100 } } },
  group: GROUP,
  readOnly: true,
  requiredPermissions: ['servers:view'],
  handler: async (args, context) => {
    if (!actorCanView(context)) return denied();
    const maxRows = limit(args);
    if (maxRows === null) return { success: false, error: 'maxRows 必须是 1-100 的整数', errorCode: 'INVALID_PARAMETER' };
    try {
      const data = await serverDiagnosticService.listServerSummaries(maxRows);
      return { success: true, data, summary: `找到 ${data.length} 台服务器`, details: { count: data.length } };
    } catch (error: any) {
      return { success: false, error: error.message, errorCode: 'LIST_SERVERS_FAILED' };
    }
  },
};

export const getServerMetricsTool: AnyAgentTool = {
  name: 'get_server_metrics',
  description: '查询服务器最新指标或有限时间范围内的历史指标，并返回新鲜度与数据缺口。',
  parameters: {
    type: 'object',
    properties: {
      serverId: { type: 'number' },
      metricName: { type: 'string' },
      range: { type: 'string', enum: [...RANGES] },
      maxRows: { type: 'number', default: 100 },
    },
    required: ['serverId'],
  },
  group: GROUP,
  readOnly: true,
  requiredPermissions: ['servers:view'],
  handler: async (args, context) => {
    if (!actorCanView(context)) return denied();
    const id = serverId(args);
    const maxRows = limit(args);
    const range = args.range === undefined ? undefined : args.range as string;
    if (id === null) return { success: false, error: 'serverId 必须为正整数', errorCode: 'INVALID_PARAMETER' };
    if (maxRows === null) return { success: false, error: 'maxRows 必须是 1-100 的整数', errorCode: 'INVALID_PARAMETER' };
    if (range !== undefined && !(RANGES as readonly string[]).includes(range)) return { success: false, error: 'range 无效', errorCode: 'TIME_RANGE_INVALID' };
    if (args.metricName !== undefined && (typeof args.metricName !== 'string' || !/^[a-z][a-z0-9_]{1,80}$/.test(args.metricName))) return { success: false, error: 'metricName 无效', errorCode: 'METRIC_NAME_INVALID' };
    try {
      const result = await serverDiagnosticService.getMetricData(id, { metricName: args.metricName as string | undefined, range: range as any, maxRows: maxRows! });
      return { success: true, data: result, summary: `服务器 #${id} 指标数据`, details: { server_id: id, freshness: result.freshness, gaps: result.gaps } };
    } catch (error: any) {
      return { success: false, error: error.message, errorCode: error.message === 'SERVER_NOT_FOUND' ? 'SERVER_NOT_FOUND' : 'GET_METRICS_FAILED' };
    }
  },
};

export const getServerAlertsTool: AnyAgentTool = {
  name: 'get_server_alerts',
  description: '查询服务器告警，默认只返回未解决告警，最多返回 100 条。',
  parameters: {
    type: 'object',
    properties: {
      serverId: { type: 'number' },
      activeOnly: { type: 'boolean', default: true },
      maxRows: { type: 'number', default: 100 },
      limit: { type: 'number' },
    },
    required: ['serverId'],
  },
  group: GROUP,
  readOnly: true,
  requiredPermissions: ['servers:view'],
  handler: async (args, context) => {
    if (!actorCanView(context)) return denied();
    const id = serverId(args);
    const maxRows = limit(args);
    if (id === null) return { success: false, error: 'serverId 必须为正整数', errorCode: 'INVALID_PARAMETER' };
    if (maxRows === null) return { success: false, error: 'maxRows 必须是 1-100 的整数', errorCode: 'INVALID_PARAMETER' };
    try {
      const data = await serverDiagnosticService.getServerAlerts(id, { activeOnly: args.activeOnly !== false, maxRows });
      return { success: true, data: { alerts: data, total: data.length }, summary: `服务器 #${id} 告警 ${data.length} 条`, details: { server_id: id } };
    } catch (error: any) {
      return { success: false, error: error.message, errorCode: error.message === 'SERVER_NOT_FOUND' ? 'SERVER_NOT_FOUND' : 'GET_ALERTS_FAILED' };
    }
  },
};

export const analyzeServerHealthTool: AnyAgentTool = {
  name: 'analyze_server_health',
  description: '基于新鲜服务器指标生成只读健康分析；缺失或过期指标返回 unknown，不视为健康。',
  parameters: { type: 'object', properties: { serverId: { type: 'number' } }, required: ['serverId'] },
  group: GROUP,
  readOnly: true,
  requiredPermissions: ['servers:view'],
  handler: async (args, context) => {
    if (!actorCanView(context)) return denied();
    const id = serverId(args);
    if (id === null) return { success: false, error: 'serverId 必须为正整数', errorCode: 'INVALID_PARAMETER' };
    try {
      const data = await serverDiagnosticService.analyzeHealth(id);
      return { success: true, data, summary: `服务器 #${id} 健康状态：${String(data.overall_health)}`, details: { server_id: id, freshness: data.freshness, gaps: data.gaps } };
    } catch (error: any) {
      return { success: false, error: error.message, errorCode: error.message === 'SERVER_NOT_FOUND' ? 'SERVER_NOT_FOUND' : 'HEALTH_ANALYSIS_FAILED' };
    }
  },
};

export const getServerDiagnosticsTool: AnyAgentTool = {
  name: 'get_server_diagnostics',
  description: '读取固定 profile 服务器诊断证据，可按 section 过滤；不会执行用户提供的命令。',
  parameters: {
    type: 'object',
    properties: {
      serverId: { type: 'number' },
      section: { type: 'string', enum: [...SECTIONS] },
      maxRows: { type: 'number', default: 100 },
      refresh: { type: 'boolean', default: false },
    },
    required: ['serverId'],
  },
  group: GROUP,
  readOnly: true,
  requiredPermissions: ['servers:view'],
  handler: async (args, context) => {
    if (!actorCanView(context)) return denied();
    const id = serverId(args);
    const maxRows = limit(args);
    if (id === null) return { success: false, error: 'serverId 必须为正整数', errorCode: 'INVALID_PARAMETER' };
    if (maxRows === null) return { success: false, error: 'maxRows 必须是 1-100 的整数', errorCode: 'INVALID_PARAMETER' };
    if (args.section !== undefined && !(SECTIONS as readonly string[]).includes(String(args.section))) return { success: false, error: 'section 无效', errorCode: 'SECTION_INVALID' };
    try {
      const diagnostics = await serverDiagnosticService.getDiagnostics(id, { refresh: args.refresh === true });
      const sectionName = args.section as string | undefined;
      const data = capDiagnosticRows(diagnostics, sectionName, maxRows!);
      return { success: true, data, summary: `服务器 #${id} 诊断证据`, details: { server_id: id, freshness: diagnostics.expiresAt, gaps: diagnostics.gaps } };
    } catch (error: any) {
      return { success: false, error: error.message, errorCode: error.message === 'SERVER_NOT_FOUND' ? 'SERVER_NOT_FOUND' : 'GET_DIAGNOSTICS_FAILED' };
    }
  },
};

toolCatalog.register(listServerInstancesTool);
toolCatalog.register(getServerMetricsTool);
toolCatalog.register(getServerAlertsTool);
toolCatalog.register(analyzeServerHealthTool);
toolCatalog.register(getServerDiagnosticsTool);
