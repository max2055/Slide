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
        await this._collectOneServer(server);
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

      // Build metric row inserts
      const pool = dbConnection.getPool();
      if (!pool) {
        sshSessionPool.releaseConnection(client);
        return { success: false, error: '数据库未连接' };
      }

      const now = new Date();
      const rows: Array<[number, string, number, Date]> = [];
      let metricsCount = 0;

      for (let i = 0; i < metricsToCollect.length; i++) {
        const def = metricsToCollect[i];
        const result = results[i];
        const stdout = result.stdout.trim();

        // Handle disk_detail specially — parse per-mount-point rows
        if (def.name === 'disk_detail') {
          const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 5) continue;

            const mountPoint = parts[0];
            const usagePct = parseInt(parts[4], 10);

            if (isNaN(usagePct)) continue;

            const sanitizedMount = this._sanitizeMountName(mountPoint);
            rows.push([server.id, `disk_usage_${sanitizedMount}`, usagePct, now]);
            metricsCount++;
          }
          continue;
        }

        // Normal parse
        const value = def.parse(stdout);
        if (value === null) continue;

        rows.push([server.id, def.name, value, now]);
        metricsCount++;
      }

      if (rows.length > 0) {
        // Batch insert
        const placeholders = rows.map(() => '(?, ?, ?, ?)').join(', ');
        const values: any[] = [];
        for (const row of rows) {
          values.push(row[0], row[1], row[2], row[3]);
        }

        await pool.execute(
          `INSERT INTO server_metrics (server_id, metric_name, metric_value, recorded_at) VALUES ${placeholders}`,
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
      // Release the connection on error so it can be reused/reconnected
      try {
        sshSessionPool.releaseConnection(client);
      } catch {
        // Ignore
      }
      throw error;
    }
  }

  /**
   * Sanitize a mount point path for use as a metric name suffix.
   * Examples: '/' → 'root', '/boot' → 'boot', '/var/log' → 'var_log'
   */
  private _sanitizeMountName(mount: string): string {
    let sanitized = mount.replace(/^\/+/, '').replace(/\/+$/, '');
    if (sanitized.length === 0) return 'root';
    return sanitized.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  }
}

// Singleton
const serverCollector = new ServerCollector();
export default serverCollector;
export { ServerCollector };
