/**
 * Server Collector
 *
 * Cron-based collection loop for SSH server metrics.
 * Runs on configurable interval (default 5 min), collects all enabled servers,
 * stores results in server_metrics KV table, and auto-transitions server status.
 *
 * Requirements: COL-05 (auto-transition to UNREACHABLE after 3 consecutive failures),
 *               COL-06 (configurable interval, default 5 min),
 *               COL-07 (collection_enabled=true collected; false skipped)
 */

import sshSessionPool from './ssh-session-pool';
import serverMetricProvider from './server-metric-provider';
import { serverDatabaseService, ServerRow } from './server-database-service';
import { dbConnection } from './db-connection';
import { isFatalSshCommandError, parseFilesystemEvidence } from './linux-host-evidence-service.js';

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

// ── Config ─────────────────────────────────────────────────────────────────────

interface CollectorConfig {
  collectionIntervalMs: number;
  commandTimeoutMs: number;
  maxFailuresBeforeUnreachable: number;
}

const DEFAULT_CONFIG: CollectorConfig = {
  collectionIntervalMs: Number(process.env.SERVER_COLLECTION_INTERVAL_MS) || 300000,
  commandTimeoutMs: 15000,
  maxFailuresBeforeUnreachable: 3,
};

// ── Collector implementation ───────────────────────────────────────────────────

class ServerCollector {
  private collectionTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private failureCounts: Map<number, number> = new Map();
  private config: CollectorConfig;

  constructor(config?: Partial<CollectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the collection loop.
   */
  start(): void {
    if (this.running) {
      console.log('[ServerCollector] already running');
      return;
    }

    this.running = true;
    this.collectionTimer = setInterval(() => {
      this._tick().catch((err) =>
        console.error('[ServerCollector] tick error:', err)
      );
    }, this.config.collectionIntervalMs);

    console.log(`[ServerCollector] started (interval: ${this.config.collectionIntervalMs / 1000}s)`);

    // Run first tick immediately
    this._tick().catch((err) =>
      console.error('[ServerCollector] initial tick error:', err)
    );
  }

  /**
   * Stop the collection loop and close all SSH connections.
   */
  stop(): void {
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
      this.collectionTimer = null;
    }
    this.running = false;
    sshSessionPool.closeAll();
    this.failureCounts.clear();
    console.log('[ServerCollector] stopped');
  }

  /**
   * One-shot collection for a specific server.
   * Returns the number of metrics collected, or null on failure.
   */
  async collectServer(serverId: number): Promise<{ success: boolean; metricsCount?: number; error?: string }> {
    const server = await serverDatabaseService.getServerById(serverId);
    if (!server) {
      return { success: false, error: '服务器不存在' };
    }

    try {
      return await this._collectOneServer(server);
    } catch (error: any) {
      console.error(`[ServerCollector] collectServer #${serverId} failed:`, error.message);
      return { success: false, error: error.message };
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async _tick(): Promise<void> {
    const servers = await serverDatabaseService.getCollectionEnabledServers();
    if (servers.length === 0) return;

    console.log(`[ServerCollector] tick: collecting ${servers.length} servers`);

    for (const server of servers) {
      try {
        const result = await this._collectOneServer(server);
        if (!result.success) throw new Error(result.error || '服务器指标采集失败');
      } catch (error: any) {
        console.error(`[ServerCollector] collection failed for #${server.id} (${server.host}):`, error.message);

        // Increment failure count
        const failures = (this.failureCounts.get(server.id) || 0) + 1;
        this.failureCounts.set(server.id, failures);

        // Transition to unreachable after threshold
        if (failures >= this.config.maxFailuresBeforeUnreachable) {
          await serverDatabaseService.updateServerStatus(server.id, 'unreachable');
          console.log(`[ServerCollector] server #${server.id} (${server.host}) marked unreachable after ${failures} failures`);
        }
      }
    }
  }

  private async _collectOneServer(
    server: ServerRow
  ): Promise<{ success: boolean; metricsCount?: number; error?: string }> {
    // Get decrypted credentials
    const creds = await serverDatabaseService.getDecryptedCredentials(server.id);
    if (!creds) {
      return { success: false, error: '无法解密凭据' };
    }

    // Determine credential value based on type
    const credentialValue = server.credential_type === 'password'
      ? (creds.password || '')
      : (creds.privateKey || '');

    if (!credentialValue) {
      return { success: false, error: '凭据值为空' };
    }

    // Get SSH connection from pool
    const client = await sshSessionPool.getConnection(
      server.host,
      server.port,
      creds.username,
      server.credential_type,
      credentialValue,
      server.host_key_fingerprint
    );

    try {
      const osResult = (await sshSessionPool.execCommands(
        client,
        ['LC_ALL=C LANG=C uname -s'],
      ))[0];
      if (osResult.exitCode !== 0 || osResult.stdout.trim() !== 'Linux') {
        throw new Error('HOST_OS_UNSUPPORTED');
      }

      // Determine which commands to execute based on OS type
      const definitions = serverMetricProvider.getDefinitions(server.os_type);
      if (definitions.length === 0) {
        sshSessionPool.releaseConnection(client);
        return { success: false, error: `不支持的操作系统: ${server.os_type}` };
      }

      // Filter commands: skip disk_usage (use disk_detail instead)
      const metricsToCollect = definitions.filter(
        (def) => def.name !== 'disk_usage'
      );

      if (metricsToCollect.length === 0) {
        sshSessionPool.releaseConnection(client);
        return { success: false, error: '无可采集的指标' };
      }

      const commands = metricsToCollect.map((def) => def.command);
      const results = await sshSessionPool.execCommands(client, commands);

      const diskDetailIndex = metricsToCollect.findIndex((definition) => definition.name === 'disk_detail');
      let filesystemRows: FilesystemMetricRow[] = [];
      if (diskDetailIndex >= 0 && results[diskDetailIndex]?.exitCode === 0) {
        const [inodeResult, findmntResult] = await sshSessionPool.execCommands(client, [
          'LC_ALL=C LANG=C df -Pi',
          'LC_ALL=C LANG=C findmnt -rn -o SOURCE,TARGET,FSTYPE',
        ]);
        filesystemRows = buildFilesystemMetricRows(
          results[diskDetailIndex].stdout,
          inodeResult.exitCode === 0 ? inodeResult.stdout : '',
          findmntResult.exitCode === 0 ? findmntResult.stdout : '',
        );
      }

      // Build metric row inserts
      const pool = dbConnection.getPool();
      if (!pool) {
        sshSessionPool.releaseConnection(client);
        return { success: false, error: '数据库未连接' };
      }

      const now = new Date();
      const rows: Array<[number, string, Record<string, string> | null, number, Date]> = [];
      let metricsCount = 0;

      for (let i = 0; i < metricsToCollect.length; i++) {
        const def = metricsToCollect[i];
        const result = results[i];
        const stdout = result.stdout.trim();

        // Handle disk_detail specially — parse per-mount-point rows
        if (def.name === 'disk_detail') {
          for (const filesystemRow of filesystemRows) {
            rows.push([
              server.id,
              filesystemRow.metricName,
              filesystemRow.dimensions,
              filesystemRow.value,
              now,
            ]);
            metricsCount++;
          }
          continue;
        }

        // Normal parse
        const value = def.parse(stdout);
        if (value === null) continue;

        rows.push([server.id, def.name, null, value, now]);
        metricsCount++;
      }

      if (rows.length > 0) {
        // Batch insert
        const placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
        const values: any[] = [];
        for (const row of rows) {
          values.push(row[0], row[1], row[2] ? JSON.stringify(row[2]) : null, row[3], row[4]);
        }

        await pool.execute(
          `INSERT INTO server_metrics (server_id, metric_name, dimensions, metric_value, recorded_at) VALUES ${placeholders}`,
          values
        );
      }

      // Mark server online on success; also reset concurrent failures
      await serverDatabaseService.updateServerStatus(server.id, 'online');
      this.failureCounts.delete(server.id);

      sshSessionPool.releaseConnection(client);

      console.log(`[ServerCollector] collected ${metricsCount} metrics for #${server.id} (${server.host})`);
      return { success: true, metricsCount };
    } catch (error: any) {
      try {
        if (isFatalSshCommandError(error)) sshSessionPool.closeConnection(client);
        else sshSessionPool.releaseConnection(client);
      } catch {
        // Ignore
      }
      throw error;
    }
  }

}

// Singleton
const serverCollector = new ServerCollector();
export default serverCollector;
export { ServerCollector };
