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
  type MetricDefinition,
  type MetricDimensions,
  type MetricSample,
} from './server-metric-provider';
import { serverDatabaseService, type ServerRow } from './server-database-service';
import { dbConnection } from './db-connection';
import { isFatalSshCommandError, parseFilesystemEvidence } from './linux-host-evidence-service.js';
import { isSupportedServerOs, normalizeServerOs } from './server-os-profile.js';

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
  error?: string;
  category?: CollectionFailureCategory;
  collectedAt?: string;
}

export interface CollectorConfig {
  collectionIntervalMs: number;
  commandTimeoutMs: number;
  maxFailuresBeforeUnreachable: number;
  maxOutputBytes: number;
}

const DEFAULT_CONFIG: CollectorConfig = {
  collectionIntervalMs: Number(process.env.SERVER_COLLECTION_INTERVAL_MS) || 300000,
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
  private failureCounts: Map<number, number> = new Map();
  private inFlight = new Set<number>();
  private config: CollectorConfig;

  constructor(config?: Partial<CollectorConfig>) {
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
    }, this.config.collectionIntervalMs);
    console.log(`[ServerCollector] started (interval: ${this.config.collectionIntervalMs / 1000}s)`);
    this._tick().catch((err) => console.error('[ServerCollector] initial tick error:', err));
  }

  stop(): void {
    if (this.collectionTimer) clearInterval(this.collectionTimer);
    this.collectionTimer = null;
    this.running = false;
    sshSessionPool.closeAll();
    this.failureCounts.clear();
    console.log('[ServerCollector] stopped');
  }

  async collectServer(serverId: number): Promise<ServerCollectionResult> {
    if (!Number.isSafeInteger(serverId) || serverId <= 0) {
      return failedResult(new Error('SERVER_ID_INVALID'));
    }
    if (this.inFlight.has(serverId)) return failedResult(new Error('COLLECTION_IN_PROGRESS'));
    this.inFlight.add(serverId);
    try {
      const server = await serverDatabaseService.getServerById(serverId);
      if (!server) return failedResult(new Error('SERVER_NOT_FOUND'));
      const result = await this._collectOneServer(server);
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

  private async _tick(): Promise<void> {
    const servers = await serverDatabaseService.getCollectionEnabledServers();
    for (const server of servers) {
      const result = await this.collectServer(server.id);
      if (!result.success && result.error !== 'COLLECTION_IN_PROGRESS') await this.recordFailure(server.id, result);
    }
  }

  private async recordFailure(serverId: number, result: ServerCollectionResult): Promise<void> {
    const failures = (this.failureCounts.get(serverId) || 0) + 1;
    this.failureCounts.set(serverId, failures);
    if (failures >= this.config.maxFailuresBeforeUnreachable) {
      await serverDatabaseService.updateServerStatus(serverId, 'unreachable');
    }
  }

  private async _collectOneServer(server: ServerRow): Promise<ServerCollectionResult> {
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

      const definitions = serverMetricProvider.getDefinitions(canonicalOs)
        .filter((definition) => definition.name !== 'disk_usage');
      if (definitions.length === 0) throw new Error('NO_METRICS_DEFINED');

      const batches = serverMetricProvider.getCollectionBatches(canonicalOs)
        .filter((batch) => batch.definitions.some((definition) => definition.name !== 'disk_usage'));
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
      return { success: true, metricsCount: rows.length, collectedAt: now.toISOString() };
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
