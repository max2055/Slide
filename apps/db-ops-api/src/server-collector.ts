/**
 * Bounded SSH server metrics collector.
 *
 * Commands come exclusively from server-metric-provider. A host can return
 * partial evidence, but an empty/failed collection is never promoted to
 * healthy and all SSH sessions are released (or closed after fatal errors).
 */

import type { Client } from 'ssh2';
import sshSessionPool, { type ExecCommandResult } from './ssh-session-pool';
import serverMetricProvider, {
  canonicalDimensions,
} from './server-metric-provider';
import { serverDatabaseService, type ServerRow } from './server-database-service';
import { dbConnection } from './db-connection';
import { isFatalSshCommandError, parseFilesystemEvidence } from './linux-host-evidence-service.js';
import { isSupportedServerOs, normalizeServerOs } from './server-os-profile.js';
import { metricRegistry, type MetricDefinition as RegistryMetricDefinition } from './metric-registry.js';
import { dueStoredMetricIds, MysqlCollectionScheduleStore, type CollectionScheduleStore } from './collection-scheduler.js';

const SERVER_COLLECTION_HEARTBEAT_MS = 10_000;
const SERVER_PROVIDER_ID = 'ssh';
const FILESYSTEM_METRIC_IDS = new Set([
  'disk_usage',
  'filesystem_size_bytes',
  'filesystem_used_bytes',
  'filesystem_available_bytes',
  'filesystem_inode_usage',
]);

export interface FilesystemMetricRow {
  metricName: 'disk_usage' | 'filesystem_size_bytes' | 'filesystem_used_bytes'
    | 'filesystem_available_bytes' | 'filesystem_inode_usage';
  dimensions: { mount: string; device: string; fs_type: string };
  value: number;
}

export function buildFilesystemMetricRows(
  bytesOutput: string,
  inodeOutput: string,
  findmntOutput: string,
): FilesystemMetricRow[] {
  return parseFilesystemEvidence(bytesOutput, inodeOutput, findmntOutput).flatMap((filesystem) => {
    const dimensions = {
      mount: filesystem.mount,
      device: filesystem.device,
      fs_type: filesystem.fsType ?? 'unknown',
    };
    const rows: FilesystemMetricRow[] = [
      { metricName: 'disk_usage', dimensions, value: filesystem.usagePercent },
      { metricName: 'filesystem_size_bytes', dimensions, value: filesystem.sizeBytes },
      { metricName: 'filesystem_used_bytes', dimensions, value: filesystem.usedBytes },
      { metricName: 'filesystem_available_bytes', dimensions, value: filesystem.availableBytes },
    ];
    if (filesystem.inodeUsagePercent !== null) {
      rows.push({ metricName: 'filesystem_inode_usage', dimensions, value: filesystem.inodeUsagePercent });
    }
    return rows;
  });
}

export type CollectionFailureCategory = 'network' | 'authentication' | 'command' | 'unsupported_os';

export interface ServerCollectionResult {
  success: boolean;
  metricsCount?: number;
  succeededMetricIds?: string[];
  error?: string;
  category?: CollectionFailureCategory;
  collectedAt?: string;
}

export interface CollectorConfig {
  heartbeatMs: number;
  commandTimeoutMs: number;
  maxFailuresBeforeUnreachable: number;
  maxOutputBytes: number;
}

const DEFAULT_CONFIG: CollectorConfig = {
  heartbeatMs: SERVER_COLLECTION_HEARTBEAT_MS,
  commandTimeoutMs: 15000,
  maxFailuresBeforeUnreachable: 3,
  maxOutputBytes: 512 * 1024,
};

function stableErrorCode(error: unknown): string {
  const value = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(value) ? value : 'SSH_COMMAND_FAILED';
}

export function classifyCollectionFailure(error: unknown): CollectionFailureCategory {
  const code = stableErrorCode(error);
  const raw = error instanceof Error ? error.message : String(error);
  if (code === 'HOST_OS_UNSUPPORTED') return 'unsupported_os';
  if (/^(SSH_COMMAND_TIMEOUT|SSH_COMMAND_OUTPUT_LIMIT|SSH_COMMAND_PROTOCOL_ERROR)$/.test(code)
    || code === 'NO_METRICS_DEFINED' || code === 'DATABASE_UNAVAILABLE') return 'command';
  if (/AUTH|PERMISSION|CREDENTIAL|HOST_KEY|FINGERPRINT|USERAUTH/i.test(`${code} ${raw}`)) return 'authentication';
  if (/ECONN|ENET|EHOST|ENOTFOUND|EAI_|NETWORK|UNREACHABLE|DNS|TIMED?\s*OUT/i.test(`${code} ${raw}`)) return 'network';
  return 'command';
}

function resultBytes(result: Pick<ExecCommandResult, 'stdout' | 'stderr'>): number {
  return Buffer.byteLength(result.stdout ?? '', 'utf8') + Buffer.byteLength(result.stderr ?? '', 'utf8');
}

function isFiniteMetric(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function failedResult(error: unknown): ServerCollectionResult {
  const result: ServerCollectionResult = {
    success: false,
    error: stableErrorCode(error),
  };
  // Keep the historical JSON contract (`success` + `error`) while exposing
  // the stable category to typed callers and diagnostics.
  Object.defineProperty(result, 'category', {
    value: classifyCollectionFailure(error),
    enumerable: false,
    configurable: true,
  });
  return result;
}

class ServerCollector {
  private collectionTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private tickInFlight = false;
  private readonly lastProbeAttempt = new Map<number, number>();
  private failureCounts: Map<number, number> = new Map();
  private inFlight = new Set<number>();
  private config: CollectorConfig;

  constructor(
    config?: Partial<CollectorConfig>,
    private readonly scheduleStore: CollectionScheduleStore = new MysqlCollectionScheduleStore(() => dbConnection.getPool() as any),
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    if (this.running) {
      console.log('[ServerCollector] already running');
      return;
    }
    this.running = true;
    this.collectionTimer = setInterval(() => {
      this._tick().catch((err) => console.error('[ServerCollector] tick error:', err));
    }, this.config.heartbeatMs);
    console.log(`[ServerCollector] started (scheduler heartbeat: ${this.config.heartbeatMs / 1000}s)`);
    this._tick().catch((err) => console.error('[ServerCollector] initial tick error:', err));
  }

  stop(): void {
    if (this.collectionTimer) clearInterval(this.collectionTimer);
    this.collectionTimer = null;
    this.running = false;
    sshSessionPool.closeAll();
    this.failureCounts.clear();
    this.lastProbeAttempt.clear();
    console.log('[ServerCollector] stopped');
  }

  async collectServer(serverId: number, requestedMetricIds?: readonly string[]): Promise<ServerCollectionResult> {
    if (!Number.isSafeInteger(serverId) || serverId <= 0) {
      return failedResult(new Error('SERVER_ID_INVALID'));
    }
    if (this.inFlight.has(serverId)) return failedResult(new Error('COLLECTION_IN_PROGRESS'));
    this.inFlight.add(serverId);
    try {
      const server = await serverDatabaseService.getServerById(serverId);
      if (!server) return failedResult(new Error('SERVER_NOT_FOUND'));
      if (!isSupportedServerOs(server.os_type)) return failedResult(new Error('HOST_OS_UNSUPPORTED'));
      const metricIds = requestedMetricIds ?? this.getSchedulableDefinitions(server.os_type).map((definition) => definition.id);
      this.lastProbeAttempt.set(serverId, Date.now());
      const result = await this._collectOneServer(server, metricIds);
      this.failureCounts.delete(server.id);
      return result;
    } catch (error) {
      const code = stableErrorCode(error);
      return failedResult(new Error(code));
    } finally {
      this.inFlight.delete(serverId);
    }
  }

  /** Exposed for diagnostic routes/tests without starting the interval timer. */
  async collectServerWithFailureState(serverId: number): Promise<ServerCollectionResult> {
    const result = await this.collectServer(serverId);
    if (!result.success && result.error !== 'COLLECTION_IN_PROGRESS') await this.recordFailure(serverId, result);
    return result;
  }

  async tick(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const servers = await serverDatabaseService.getCollectionEnabledServers();
      const activeIds = new Set(servers.map(server => server.id));
      for (const id of this.lastProbeAttempt.keys()) if (!activeIds.has(id)) this.lastProbeAttempt.delete(id);
      for (const server of servers) {
        try {
          const now = Date.now();
          const lastProbe = this.lastProbeAttempt.get(server.id);
          if (lastProbe === undefined || now - lastProbe >= 60_000) {
            const probe = await this.collectServer(server.id, []);
            if (!probe.success && probe.error !== 'COLLECTION_IN_PROGRESS') await this.recordFailure(server.id, probe);
          }
          const definitions = this.getSchedulableDefinitions(server.os_type);
          const dueMetricIds = await dueStoredMetricIds(this.scheduleStore, 'server', server.id, SERVER_PROVIDER_ID, definitions, now);
          if (dueMetricIds.length === 0) continue;
          const result = await this.collectServer(server.id, dueMetricIds);
          const succeeded = new Set(result.succeededMetricIds ?? []);
          for (const definition of definitions.filter(candidate => dueMetricIds.includes(candidate.id))) {
            await this.scheduleStore.record('server', server.id, SERVER_PROVIDER_ID, definition, now, succeeded.has(definition.id));
          }
          if (!result.success && result.error !== 'COLLECTION_IN_PROGRESS') await this.recordFailure(server.id, result);
        } catch (error) {
          console.error(`[ServerCollector] server #${server.id} tick failed:`, stableErrorCode(error));
        }
      }
    } finally { this.tickInFlight = false; }
  }

  private async _tick(): Promise<void> {
    return this.tick();
  }

  private async recordFailure(serverId: number, _result: ServerCollectionResult): Promise<void> {
    const failures = (this.failureCounts.get(serverId) || 0) + 1;
    this.failureCounts.set(serverId, failures);
    if (failures >= this.config.maxFailuresBeforeUnreachable) {
      await serverDatabaseService.updateServerStatus(serverId, 'unreachable');
    }
  }

  private getSchedulableDefinitions(osType: string): RegistryMetricDefinition[] {
    const canonicalOs = normalizeServerOs(osType);
    if (!canonicalOs) return [];
    const supported = new Set(
      serverMetricProvider.getDefinitions(canonicalOs)
        .filter((definition) => definition.name !== 'disk_detail')
        .map((definition) => definition.name),
    );
    for (const metricId of FILESYSTEM_METRIC_IDS) supported.add(metricId);
    return metricRegistry.getByTargetType('server')
      .filter((definition) => definition.is_collected && supported.has(definition.id));
  }

  private async _collectOneServer(server: ServerRow, requestedMetricIds: readonly string[]): Promise<ServerCollectionResult> {
    // Validate the configured profile before decrypting credentials or opening
    // a network connection. Unknown labels never fall through to generic Linux.
    if (!isSupportedServerOs(server.os_type)) {
      throw new Error('HOST_OS_UNSUPPORTED');
    }
    const canonicalOs = normalizeServerOs(server.os_type)!;
    const credentials = await serverDatabaseService.getDecryptedCredentials(server.id);
    if (!credentials) throw new Error('SERVER_CREDENTIALS_UNAVAILABLE');
    const credentialValue = server.credential_type === 'password'
      ? credentials.password
      : credentials.privateKey;
    if (!credentialValue) throw new Error('SERVER_CREDENTIALS_UNAVAILABLE');

    let client: Client | null = null;
    let fatal = false;
    let outputBytes = 0;
    const execute = async (commands: string[], maxOutputBytes = this.config.maxOutputBytes): Promise<ExecCommandResult[]> => {
      if (commands.length === 0) return [];
      const remaining = this.config.maxOutputBytes - outputBytes;
      if (remaining <= 0) throw new Error('SSH_COMMAND_OUTPUT_LIMIT');
      const results = await sshSessionPool.execCommands(client!, commands, {
        timeoutMs: this.config.commandTimeoutMs,
        maxOutputBytes: Math.min(maxOutputBytes, remaining),
      });
      for (const result of results) {
        if (result.truncated) throw new Error('SSH_COMMAND_OUTPUT_LIMIT');
        outputBytes += resultBytes(result);
        if (outputBytes > this.config.maxOutputBytes) throw new Error('SSH_COMMAND_OUTPUT_LIMIT');
      }
      return results;
    };

    try {
      client = await sshSessionPool.getConnection(
        server.host,
        server.port,
        credentials.username,
        server.credential_type,
        credentialValue,
        server.host_key_fingerprint,
      );

      const osResult = (await execute(['LC_ALL=C LANG=C uname -s']))[0];
      if (!osResult || osResult.exitCode !== 0 || osResult.stdout.trim() !== 'Linux') {
        throw new Error('HOST_OS_UNSUPPORTED');
      }

      if (requestedMetricIds.length === 0) {
        await serverDatabaseService.updateServerStatus(server.id, 'online');
        return { success: true, metricsCount: 0, succeededMetricIds: [], collectedAt: new Date().toISOString() };
      }
      const requested = new Set(requestedMetricIds);
      const collectFilesystem = requestedMetricIds.some((metricId) => FILESYSTEM_METRIC_IDS.has(metricId));
      const batches = serverMetricProvider.getCollectionBatches(canonicalOs)
        .map((batch) => ({
          command: batch.command,
          definitions: batch.definitions.filter((definition) => {
            if (definition.name === 'disk_usage') return false;
            if (definition.name === 'disk_detail') return collectFilesystem;
            return requested.has(definition.name);
          }),
        }))
        .filter((batch) => batch.definitions.length > 0);
      if (batches.length === 0) throw new Error('NO_METRICS_DEFINED');
      const values: Array<{ name: string; value: number; dimensions: Record<string, string> | null }> = [];
      let successfulCommands = 0;
      let commandFailures = 0;
      let filesystemRows: FilesystemMetricRow[] = [];

      for (const batch of batches) {
        const activeDefinitions = batch.definitions.filter((definition) => definition.name !== 'disk_usage');
        try {
          const result = (await execute([batch.command]))[0];
          if (!result || result.exitCode !== 0) {
            commandFailures++;
            continue;
          }
          successfulCommands++;
          const rowSamples = activeDefinitions[0]?.parseRows?.(result.stdout) ?? [];
          if (rowSamples.length > 0) {
            const names = new Set(activeDefinitions.map((definition) => definition.name));
            for (const sample of rowSamples) {
              if (names.has(sample.name) && isFiniteMetric(sample.value)) {
                values.push({ name: sample.name, value: sample.value, dimensions: canonicalDimensions(sample.dimensions) });
              }
            }
          }
          for (const definition of activeDefinitions) {
            // Network/disk rows are fully represented by parseRows. Process
            // definitions additionally expose a bounded scalar max for the
            // metric table, so retain their scalar parser.
            if (definition.parseRows && !definition.parseProcesses) continue;
            const value = definition.parse(result.stdout.trim());
            if (isFiniteMetric(value)) values.push({ name: definition.name, value, dimensions: null });
          }

          if (activeDefinitions.some((definition) => definition.name === 'disk_detail')) {
            const [inodeResult, findmntResult] = await execute([
              'LC_ALL=C LANG=C df -Pi',
              'LC_ALL=C LANG=C findmnt -rn -o SOURCE,TARGET,FSTYPE',
            ]);
            filesystemRows = buildFilesystemMetricRows(
              result.stdout,
              inodeResult?.exitCode === 0 ? inodeResult.stdout : '',
              findmntResult?.exitCode === 0 ? findmntResult.stdout : '',
            );
          }
        } catch (error) {
          if (isFatalSshCommandError(error)) fatal = true;
          throw error;
        }
      }

      // Filesystem evidence is dimensioned separately because df emits one
      // row per mount and inode/findmnt are optional enrichments.
      for (const filesystem of filesystemRows) {
        if (!requested.has(filesystem.metricName)) continue;
        values.push({
          name: filesystem.metricName,
          value: filesystem.value,
          // Filesystem rows retain the historical fs_type field. Network and
          // diskstats samples above are canonicalized to the bounded schema.
          dimensions: filesystem.dimensions,
        });
      }
      if (successfulCommands === 0 || (values.length === 0 && commandFailures > 0)) {
        throw new Error('SSH_COMMAND_FAILED');
      }

      const pool = dbConnection.getPool();
      if (!pool) throw new Error('DATABASE_UNAVAILABLE');
      const now = new Date();
      const rows = values.filter((value) => isFiniteMetric(value.value)).map((value) => [
        server.id,
        value.name,
        value.dimensions ? JSON.stringify(value.dimensions) : null,
        value.value,
        now,
      ] as const);
      if (rows.length > 0) {
        const placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
        const params = rows.flatMap((row) => [...row]);
        await pool.execute(
          `INSERT INTO server_metrics (server_id, metric_name, dimensions, metric_value, recorded_at) VALUES ${placeholders}`,
          params,
        );
      }
      await serverDatabaseService.updateServerStatus(server.id, 'online');
      const succeededMetricIds = [...new Set(values.map((value) => value.name))]
        .filter((metricId) => requested.has(metricId));
      return { success: true, metricsCount: rows.length, succeededMetricIds, collectedAt: now.toISOString() };
    } catch (error) {
      if (isFatalSshCommandError(error)) fatal = true;
      throw error;
    } finally {
      if (client) {
        try {
          if (fatal) sshSessionPool.closeConnection(client);
          else sshSessionPool.releaseConnection(client);
        } catch {
          // Cleanup is best effort; the original collection error is retained.
        }
      }
    }
  }
}

const serverCollector = new ServerCollector();
export default serverCollector;
export { ServerCollector };
