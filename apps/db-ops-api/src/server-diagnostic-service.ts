/** Fixed-profile, read-only server diagnostics. */

import type { Client } from 'ssh2';
import { serverDatabaseService, type ServerRow } from './server-database-service.js';
import sshSessionPool, { type ExecCommandResult } from './ssh-session-pool.js';
import { isFatalSshCommandError } from './linux-host-evidence-service.js';
import { parseJournalJson } from './linux-host-evidence-service.js';
import {
  parseProcNetDev,
  parseTopProcesses,
  type ProcessSample,
} from './server-metric-provider.js';
import { isSupportedServerOs, normalizeServerOs } from './server-os-profile.js';
import { redactSensitiveText } from './security/log-redaction.js';
import { dbConnection } from './db-connection.js';
import { alertDatabaseService } from './alert-database-service.js';

export const SERVER_DIAGNOSTIC_TTL_MS = 5 * 60 * 1000;
export const SERVER_DIAGNOSTIC_MAX_OUTPUT_BYTES = 512 * 1024;
export const SERVER_DIAGNOSTIC_COMMAND_TIMEOUT_MS = 15_000;
const MAX_SECTION_OUTPUT_BYTES = 128 * 1024;
const MAX_SERVICE_ROWS = 256;
const MAX_PORT_ROWS = 256;
const MAX_PROCESS_ROWS = 20;
const MAX_INTERFACE_ROWS = 128;
const MAX_LOG_ROWS = 200;

export type DiagnosticQuality = 'good' | 'partial' | 'unknown' | 'unsupported';

export interface DiagnosticSection<T> {
  source: string[];
  collectedAt: string;
  expiresAt: string;
  validForMs: number;
  quality: DiagnosticQuality;
  reason?: string;
  truncated: boolean;
  items: T[];
}

export interface ServiceStatus {
  name: string;
  loadState: string;
  activeState: string;
  subState: string;
  description: string | null;
}

export interface ListeningPort {
  protocol: 'tcp' | 'udp' | 'unknown';
  address: string;
  port: number;
  process: string | null;
}

export interface InterfaceErrorSummary {
  interface: string;
  rxBytes: number;
  txBytes: number;
  rxErrors: number;
  txErrors: number;
  rxDrops: number;
  txDrops: number;
}

export interface DiagnosticLogEntry {
  timestamp: string | null;
  severity: string;
  unit: string | null;
  identifier: string | null;
  message: string;
}

export interface ServerDiagnostics {
  schemaVersion: 1;
  serverId: number;
  osType: string;
  collectedAt: string;
  expiresAt: string;
  validForMs: number;
  quality: DiagnosticQuality;
  truncated: boolean;
  sections: {
    services: DiagnosticSection<ServiceStatus>;
    listeningPorts: DiagnosticSection<ListeningPort>;
    topProcesses: DiagnosticSection<ProcessSample>;
    systemLogs: DiagnosticSection<DiagnosticLogEntry>;
    interfaceErrors: DiagnosticSection<InterfaceErrorSummary>;
  };
  // Named aliases keep the public API ergonomic and make older consumers
  // resilient to the section-container addition.
  serviceStatus: DiagnosticSection<ServiceStatus>;
  listeningPorts: DiagnosticSection<ListeningPort>;
  topProcesses: DiagnosticSection<ProcessSample>;
  recentSystemLogs: DiagnosticSection<DiagnosticLogEntry>;
  interfaceErrors: DiagnosticSection<InterfaceErrorSummary>;
  gaps: Array<{ section: string; reason: string }>;
}

export interface ServerMetricPoint {
  metric_name: string;
  metric_value: number;
  dimensions: Record<string, unknown> | null;
  recorded_at: string;
}

export interface ServerDiagnosticDependencies {
  serverDatabaseService: Pick<typeof serverDatabaseService, 'getServerById' | 'getDecryptedCredentials'>;
  sshSessionPool: {
    getConnection: typeof sshSessionPool.getConnection;
    execCommands: typeof sshSessionPool.execCommands;
    releaseConnection: typeof sshSessionPool.releaseConnection;
    closeConnection: typeof sshSessionPool.closeConnection;
  };
  now?: () => Date;
}

const COMMANDS = Object.freeze({
  uname: 'LC_ALL=C LANG=C uname -s',
  services: 'LC_ALL=C LANG=C systemctl list-units --type=service --state=running --no-legend --no-pager',
  ports: 'LC_ALL=C LANG=C ss -lntupH',
  processes: 'LC_ALL=C LANG=C ps -eo pid=,comm=,pcpu=,pmem= --sort=-pcpu | head -n 20',
  logs: 'LC_ALL=C LANG=C journalctl --no-pager --quiet --output=json --since=-5 minutes --priority=warning --lines=200',
  interfaces: 'LC_ALL=C LANG=C cat /proc/net/dev',
  logFallback: 'LC_ALL=C LANG=C tail -n 200 -- /var/log/messages',
});

export function diagnosticCommands(): readonly string[] {
  return Object.values(COMMANDS);
}

function stableErrorCode(error: unknown): string {
  const value = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(value) ? value : 'DIAGNOSTIC_COLLECTION_FAILED';
}

function boundedText(value: unknown, max = 256): string | null {
  if (typeof value !== 'string') return null;
  const text = redactSensitiveText(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function section<T>(source: string[], now: Date, items: T[], quality: DiagnosticQuality, reason?: string, truncated = false): DiagnosticSection<T> {
  return {
    source,
    collectedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SERVER_DIAGNOSTIC_TTL_MS).toISOString(),
    validForMs: SERVER_DIAGNOSTIC_TTL_MS,
    quality,
    ...(reason ? { reason } : {}),
    truncated,
    items,
  };
}

function parseServices(stdout: string): ServiceStatus[] {
  const rows: ServiceStatus[] = [];
  for (const line of stdout.split(/\r?\n/).slice(0, MAX_SERVICE_ROWS)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const [nameField, loadState, activeState, subState, ...description] = fields;
    const name = boundedText(nameField, 128);
    if (!name || !/^[A-Za-z0-9_.@:-]+(?:\.service)?$/.test(name)) continue;
    rows.push({
      name,
      loadState: boundedText(loadState, 32) ?? 'unknown',
      activeState: boundedText(activeState, 32) ?? 'unknown',
      subState: boundedText(subState, 32) ?? 'unknown',
      description: boundedText(description.join(' '), 256),
    });
  }
  return rows;
}

function parsePorts(stdout: string): ListeningPort[] {
  const rows: ListeningPort[] = [];
  for (const line of stdout.split(/\r?\n/).slice(0, MAX_PORT_ROWS)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const protocol = fields[0]?.toLowerCase();
    const local = fields.slice(3, 6).find((field) => /:\d+$/.test(field));
    if (!local) continue;
    const match = /^(.*):(\d+)$/.exec(local.replace(/^\[|\]$/g, ''));
    if (!match) continue;
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const address = boundedText(match[1], 128);
    if (!address) continue;
    const processField = fields.find((field) => field.startsWith('users:')) ?? null;
    rows.push({
      protocol: protocol === 'tcp' || protocol === 'udp' ? protocol : 'unknown',
      address,
      port,
      process: processField ? boundedText(processField, 256) : null,
    });
  }
  return rows;
}

function parseInterfaceErrors(stdout: string): InterfaceErrorSummary[] {
  const rows = parseProcNetDev(stdout);
  const grouped = new Map<string, InterfaceErrorSummary>();
  for (const row of rows) {
    const iface = row.dimensions?.interface;
    if (!iface) continue;
    const current = grouped.get(iface) ?? {
      interface: iface, rxBytes: 0, txBytes: 0, rxErrors: 0, txErrors: 0,
      rxDrops: 0, txDrops: 0,
    };
    switch (row.name) {
      case 'network_rx_bytes': current.rxBytes = row.value; break;
      case 'network_tx_bytes': current.txBytes = row.value; break;
      case 'network_rx_errors': current.rxErrors = row.value; break;
      case 'network_tx_errors': current.txErrors = row.value; break;
      case 'network_rx_drops': current.rxDrops = row.value; break;
      case 'network_tx_drops': current.txDrops = row.value; break;
    }
    grouped.set(iface, current);
  }
  return [...grouped.values()].slice(0, MAX_INTERFACE_ROWS);
}

function parseFallbackLogs(stdout: string): DiagnosticLogEntry[] {
  return stdout.split(/\r?\n/).filter(Boolean).slice(-MAX_LOG_ROWS).map((line) => ({
    timestamp: null,
    severity: 'unknown',
    unit: null,
    identifier: null,
    message: boundedText(line, 4096) ?? '',
  }));
}

function commandFailed(result: ExecCommandResult | undefined): boolean {
  return !result || result.exitCode !== 0;
}

class ServerDiagnosticService {
  private readonly dependencies: Required<ServerDiagnosticDependencies>;
  private readonly cache = new Map<number, ServerDiagnostics>();

  constructor(dependencies: ServerDiagnosticDependencies = {
    serverDatabaseService,
    sshSessionPool,
  }) {
    this.dependencies = {
      ...dependencies,
      now: dependencies.now ?? (() => new Date()),
    };
  }

  async getDiagnostics(serverId: number, options: { refresh?: boolean } = {}): Promise<ServerDiagnostics> {
    if (!Number.isSafeInteger(serverId) || serverId <= 0) throw new Error('SERVER_ID_INVALID');
    const cached = this.cache.get(serverId);
    const now = this.dependencies.now();
    if (!options.refresh && cached && new Date(cached.expiresAt).getTime() > now.getTime()) return cached;
    try {
      return await this.collectDiagnostics(serverId);
    } catch (error) {
      if (cached && !isFatalSshCommandError(error)) {
        return this.markStale(cached, stableErrorCode(error));
      }
      throw error;
    }
  }

  async collectDiagnostics(serverId: number): Promise<ServerDiagnostics> {
    if (!Number.isSafeInteger(serverId) || serverId <= 0) throw new Error('SERVER_ID_INVALID');
    const server = await this.dependencies.serverDatabaseService.getServerById(serverId);
    if (!server) throw new Error('SERVER_NOT_FOUND');
    if (!isSupportedServerOs(server.os_type)) throw new Error('HOST_OS_UNSUPPORTED');
    const credentials = await this.dependencies.serverDatabaseService.getDecryptedCredentials(serverId);
    if (!credentials) throw new Error('SERVER_CREDENTIALS_UNAVAILABLE');
    const value = server.credential_type === 'password' ? credentials.password : credentials.privateKey;
    if (!value) throw new Error('SERVER_CREDENTIALS_UNAVAILABLE');

    let client: Client | null = null;
    let fatal = false;
    let outputBytes = 0;
    const now = this.dependencies.now();
    const gaps: Array<{ section: string; reason: string }> = [];
    try {
      client = await this.dependencies.sshSessionPool.getConnection(
        server.host, server.port, credentials.username, server.credential_type,
        value, server.host_key_fingerprint,
      );
      const execute = async (command: string, maxOutputBytes = MAX_SECTION_OUTPUT_BYTES): Promise<ExecCommandResult | undefined> => {
        const remaining = SERVER_DIAGNOSTIC_MAX_OUTPUT_BYTES - outputBytes;
        if (remaining <= 0) throw new Error('SSH_COMMAND_OUTPUT_LIMIT');
        const results = await this.dependencies.sshSessionPool.execCommands(client!, [command], {
          timeoutMs: SERVER_DIAGNOSTIC_COMMAND_TIMEOUT_MS,
          maxOutputBytes: Math.min(maxOutputBytes, remaining),
        });
        const result = results[0];
        if (result?.truncated) throw new Error('SSH_COMMAND_OUTPUT_LIMIT');
        outputBytes += result ? Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) : 0;
        if (outputBytes > SERVER_DIAGNOSTIC_MAX_OUTPUT_BYTES) throw new Error('SSH_COMMAND_OUTPUT_LIMIT');
        return result;
      };
      const executeOptional = async (command: string, sectionName: string): Promise<ExecCommandResult | undefined> => {
        try {
          return await execute(command);
        } catch (error) {
          if (isFatalSshCommandError(error)) throw error;
          gaps.push({ section: sectionName, reason: stableErrorCode(error) });
          return undefined;
        }
      };
      const uname = await execute(COMMANDS.uname);
      if (commandFailed(uname) || uname!.stdout.trim() !== 'Linux') throw new Error('HOST_OS_UNSUPPORTED');

      const serviceResult = await executeOptional(COMMANDS.services, 'services');
      const portsResult = await executeOptional(COMMANDS.ports, 'listeningPorts');
      const processResult = await executeOptional(COMMANDS.processes, 'topProcesses');
      const logResult = await executeOptional(COMMANDS.logs, 'systemLogs');
      const interfaceResult = await executeOptional(COMMANDS.interfaces, 'interfaceErrors');

      const serviceItems = serviceResult && !commandFailed(serviceResult) ? parseServices(serviceResult.stdout) : [];
      const portItems = portsResult && !commandFailed(portsResult) ? parsePorts(portsResult.stdout) : [];
      const processItems = processResult && !commandFailed(processResult) ? parseTopProcesses(processResult.stdout) : [];
      let logs: DiagnosticLogEntry[] = [];
      let logsQuality: DiagnosticQuality = 'good';
      let logsReason: string | undefined;
      let logsTruncated = Boolean(logResult?.truncated);
      if (logResult && !commandFailed(logResult)) {
        const parsed = parseJournalJson(logResult.stdout);
        logs = parsed.entries.slice(0, MAX_LOG_ROWS).map((entry) => ({
          ...entry,
          message: boundedText(entry.message, 4096) ?? '',
        }));
        logsTruncated ||= parsed.truncated;
        if (parsed.malformedLines > 0) {
          logsQuality = 'partial';
          logsReason = 'JOURNAL_JSON_MALFORMED';
        }
        if (logs.length === 0 && !logsReason) {
          logsQuality = 'partial';
          logsReason = 'SYSTEM_LOGS_EMPTY';
        }
      } else {
        const fallback = await executeOptional(COMMANDS.logFallback, 'systemLogs');
        if (fallback && !commandFailed(fallback)) {
          logs = parseFallbackLogs(fallback.stdout);
          logsQuality = 'partial';
          logsReason = 'JOURNAL_UNAVAILABLE_FALLBACK_MESSAGES';
        } else {
          logsQuality = 'unknown';
          logsReason = 'SYSTEM_LOGS_UNAVAILABLE';
          gaps.push({ section: 'systemLogs', reason: logsReason });
        }
      }
      const interfaceItems = interfaceResult && !commandFailed(interfaceResult) ? parseInterfaceErrors(interfaceResult.stdout) : [];

      const serviceSection = serviceResult && !commandFailed(serviceResult)
        ? section(['systemctl'], now, serviceItems, serviceItems.length ? 'good' : 'partial', serviceItems.length ? undefined : 'SERVICE_LIST_EMPTY', Boolean(serviceResult.truncated))
        : section(['systemctl'], now, [], 'unknown', 'SERVICE_STATUS_UNAVAILABLE', Boolean(serviceResult?.truncated));
      const portSection = portsResult && !commandFailed(portsResult)
        ? section(['ss'], now, portItems, portItems.length ? 'good' : 'partial', portItems.length ? undefined : 'LISTENING_PORTS_EMPTY', Boolean(portsResult.truncated))
        : section(['ss'], now, [], 'unknown', 'LISTENING_PORTS_UNAVAILABLE', Boolean(portsResult?.truncated));
      const processSection = processResult && !commandFailed(processResult)
        ? section(['ps'], now, processItems, processItems.length ? 'good' : 'partial', processItems.length ? undefined : 'TOP_PROCESSES_EMPTY', Boolean(processResult.truncated))
        : section(['ps'], now, [], 'unknown', 'TOP_PROCESSES_UNAVAILABLE', Boolean(processResult?.truncated));
      const logSection = section(['journald', 'messages'], now, logs, logsQuality, logsReason, logsTruncated);
      const interfaceSection = interfaceResult && !commandFailed(interfaceResult)
        ? section(['/proc/net/dev'], now, interfaceItems, interfaceItems.length ? 'good' : 'partial', interfaceItems.length ? undefined : 'INTERFACE_STATS_EMPTY', Boolean(interfaceResult.truncated))
        : section(['/proc/net/dev'], now, [], 'unknown', 'INTERFACE_STATS_UNAVAILABLE', Boolean(interfaceResult?.truncated));

      const sections = {
        services: serviceSection,
        listeningPorts: portSection,
        topProcesses: processSection,
        systemLogs: logSection,
        interfaceErrors: interfaceSection,
      };
      const allSections = Object.values(sections);
      const quality: DiagnosticQuality = allSections.every((item) => item.quality === 'good')
        ? 'good'
        : allSections.some((item) => item.quality === 'good' || item.quality === 'partial') ? 'partial' : 'unknown';
      for (const [name, item] of Object.entries(sections)) {
        if (item.quality === 'unknown' && item.reason) gaps.push({ section: name, reason: item.reason });
      }
      const diagnostics: ServerDiagnostics = {
        schemaVersion: 1,
        serverId,
        osType: normalizeServerOs(server.os_type)!,
        collectedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SERVER_DIAGNOSTIC_TTL_MS).toISOString(),
        validForMs: SERVER_DIAGNOSTIC_TTL_MS,
        quality,
        truncated: allSections.some((item) => item.truncated),
        sections,
        serviceStatus: serviceSection,
        listeningPorts: portSection,
        topProcesses: processSection,
        recentSystemLogs: logSection,
        interfaceErrors: interfaceSection,
        gaps,
      };
      this.cache.set(serverId, diagnostics);
      return diagnostics;
    } catch (error) {
      if (isFatalSshCommandError(error)) fatal = true;
      throw error;
    } finally {
      if (client) {
        if (fatal) this.dependencies.sshSessionPool.closeConnection(client);
        else this.dependencies.sshSessionPool.releaseConnection(client);
      }
    }
  }

  getCachedDiagnostics(serverId: number, now = this.dependencies.now()): ServerDiagnostics | null {
    const value = this.cache.get(serverId);
    if (!value) return null;
    if (new Date(value.expiresAt).getTime() <= now.getTime()) return this.markStale(value, 'EVIDENCE_STALE');
    return value;
  }

  private markStale(value: ServerDiagnostics, reason: string): ServerDiagnostics {
    return {
      ...value,
      quality: 'unknown',
      sections: Object.fromEntries(Object.entries(value.sections).map(([name, item]) => [name, {
        ...item,
        quality: 'unknown',
        reason: 'EVIDENCE_STALE',
      }])) as ServerDiagnostics['sections'],
      serviceStatus: { ...value.serviceStatus, quality: 'unknown', reason: 'EVIDENCE_STALE' },
      listeningPorts: { ...value.listeningPorts, quality: 'unknown', reason: 'EVIDENCE_STALE' },
      topProcesses: { ...value.topProcesses, quality: 'unknown', reason: 'EVIDENCE_STALE' },
      recentSystemLogs: { ...value.recentSystemLogs, quality: 'unknown', reason: 'EVIDENCE_STALE' },
      interfaceErrors: { ...value.interfaceErrors, quality: 'unknown', reason: 'EVIDENCE_STALE' },
      gaps: [...value.gaps, { section: 'all', reason }],
    };
  }

  /** Public bounded metric read used by Agent tools and API adapters. */
  async getMetricData(serverId: number, options: {
    metricName?: string;
    range?: '1h' | '6h' | '24h' | '7d' | '30d';
    maxRows?: number;
  } = {}): Promise<{ latest: ServerMetricPoint[]; history: ServerMetricPoint[]; freshness: string | null; gaps: string[] }> {
    if (!Number.isSafeInteger(serverId) || serverId <= 0) throw new Error('SERVER_ID_INVALID');
    if (!['1h', '6h', '24h', '7d', '30d', undefined].includes(options.range)) throw new Error('TIME_RANGE_INVALID');
    if (options.metricName !== undefined && !/^[a-z][a-z0-9_]{1,80}$/.test(options.metricName)) throw new Error('METRIC_NAME_INVALID');
    const limit = Math.min(Math.max(Number.isSafeInteger(options.maxRows) ? options.maxRows! : 100, 1), 100);
    const server = await this.dependencies.serverDatabaseService.getServerById(serverId);
    if (!server) throw new Error('SERVER_NOT_FOUND');
    const pool = dbConnection.getPool();
    if (!pool) return { latest: [], history: [], freshness: null, gaps: ['METRICS_UNAVAILABLE'] };
    const hours = options.range ? ({ '1h': 1, '6h': 6, '24h': 24, '7d': 168, '30d': 720 } as Record<string, number>)[options.range] : null;
    const params: unknown[] = [serverId];
    let where = 'WHERE server_id = ?';
    if (options.metricName) { where += ' AND metric_name = ?'; params.push(options.metricName); }
    if (hours) { where += ' AND recorded_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)'; params.push(hours); }
    const [rows] = await (pool as any).execute(
      `SELECT metric_name, metric_value, dimensions, recorded_at FROM server_metrics ${where} ORDER BY recorded_at DESC, id DESC LIMIT ?`,
      [...params, limit],
    ) as any;
    const history = (rows ?? []).map((row: any) => ({
      metric_name: String(row.metric_name),
      metric_value: Number(row.metric_value),
      dimensions: typeof row.dimensions === 'string' ? (() => { try { return JSON.parse(row.dimensions); } catch { return null; } })() : row.dimensions ?? null,
      recorded_at: new Date(row.recorded_at).toISOString(),
    })) as ServerMetricPoint[];
    const latestMap = new Map<string, ServerMetricPoint>();
    for (const row of history) if (!latestMap.has(row.metric_name)) latestMap.set(row.metric_name, row);
    const latest = [...latestMap.values()];
    const freshness = latest.length ? latest.reduce((max, row) => row.recorded_at > max ? row.recorded_at : max, latest[0].recorded_at) : null;
    return { latest, history, freshness, gaps: latest.length ? [] : ['METRICS_UNAVAILABLE'] };
  }

  async getServerAlerts(serverId: number, options: { activeOnly?: boolean; maxRows?: number } = {}): Promise<Record<string, unknown>[]> {
    if (!Number.isSafeInteger(serverId) || serverId <= 0) throw new Error('SERVER_ID_INVALID');
    const server = await this.dependencies.serverDatabaseService.getServerById(serverId);
    if (!server) throw new Error('SERVER_NOT_FOUND');
    const limit = Math.min(Math.max(Number.isSafeInteger(options.maxRows) ? options.maxRows! : 100, 1), 100);
    const result = await alertDatabaseService.getAlerts({
      server_id: serverId,
      status: options.activeOnly === false ? undefined : 'unread,read,acknowledged',
      limit,
    } as any);
    return (result.items ?? []).slice(0, limit).map((alert: any) => ({
      id: alert.id, level: alert.severity ?? alert.level, title: alert.title,
      message: redactSensitiveText(String(alert.message ?? '')),
      status: alert.status, created_at: alert.created_at,
      instance_id: alert.instance_id ?? null,
    }));
  }

  async listServerSummaries(maxRows = 100): Promise<Record<string, unknown>[]> {
    const servers = (await this.dependencies.serverDatabaseService.getServerById)
      ? await (async () => {
        const pool = dbConnection.getPool();
        if (!pool) return [] as any[];
        const [rows] = await (pool as any).execute('SELECT id, host, port, label, os_type, status, last_check_at, collection_enabled FROM servers ORDER BY host LIMIT ?', [Math.min(Math.max(maxRows, 1), 100)]);
        return rows as any[];
      })()
      : [];
    return servers.map((server: any) => ({
      id: server.id, host: server.host, port: server.port, label: server.label,
      os_type: normalizeServerOs(server.os_type) ?? 'unsupported', status: server.status,
      last_check_at: server.last_check_at ? new Date(server.last_check_at).toISOString() : null,
      collection_enabled: Boolean(server.collection_enabled),
    }));
  }

  async analyzeHealth(serverId: number): Promise<Record<string, unknown>> {
    const server = await this.dependencies.serverDatabaseService.getServerById(serverId);
    if (!server) throw new Error('SERVER_NOT_FOUND');
    const metrics = await this.getMetricData(serverId, { maxRows: 100 });
    const byName = new Map(metrics.latest.map((row) => [row.metric_name, row.metric_value]));
    const ageMs = metrics.freshness ? this.dependencies.now().getTime() - new Date(metrics.freshness).getTime() : null;
    const fresh = ageMs !== null && ageMs <= SERVER_DIAGNOSTIC_TTL_MS;
    const value = (name: string) => fresh && byName.has(name) ? byName.get(name)! : null;
    const analyze = (name: string, warning: number, critical: number) => {
      const current = value(name);
      return { status: current === null ? 'unknown' : current >= critical ? 'critical' : current >= warning ? 'warning' : 'healthy', current_value: current, warning, critical };
    };
    const cpu = analyze('cpu_usage', 70, 85);
    const memory = analyze('memory_usage', 70, 85);
    const disk = analyze('disk_usage', 80, 90);
    const statuses = [cpu.status, memory.status, disk.status];
    const overall = !fresh || statuses.every((status) => status === 'unknown') ? 'unknown' : statuses.includes('critical') ? 'critical' : statuses.includes('warning') ? 'warning' : 'healthy';
    const recommendations: string[] = [];
    if (!fresh) recommendations.push('指标已过期或缺失，不能判定主机健康');
    if (cpu.status === 'critical') recommendations.push('检查高 CPU 进程并评估扩容');
    if (memory.status === 'critical') recommendations.push('检查内存泄漏、交换和进程占用');
    if (disk.status === 'critical') recommendations.push('清理或扩容高使用率挂载点');
    if (server.status !== 'online') recommendations.push(`服务器状态为 ${server.status}`);
    return {
      overall_health: overall,
      cpu_analysis: cpu,
      memory_analysis: memory,
      disk_analysis: disk,
      freshness: metrics.freshness,
      gaps: metrics.gaps,
      recommendations,
    };
  }
}

export const serverDiagnosticService = new ServerDiagnosticService();
export { ServerDiagnosticService, COMMANDS as SERVER_DIAGNOSTIC_COMMANDS };
export default serverDiagnosticService;
