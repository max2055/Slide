/**
 * SSH Session Pool
 *
 * Singleton connection pool for SSH sessions with keepalive,
 * connection reuse, batch command execution, and stale cleanup.
 *
 * Requirements: COL-04 (15s command timeout, 10s readyTimeout),
 *               COL-08 (batch commands on single connection)
 */

import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import crypto from 'crypto';

// ── Types ──────────────────────────────────────────────────────────────────────

interface SshSession {
  client: Client;
  host: string;
  port: number;
  lastUsed: number;
  inUse: boolean;
}

interface PoolStats {
  total: number;
  idle: number;
  active: number;
}

interface SshPoolConfig {
  maxSessionsPerServer: number;
  readyTimeoutMs: number;
  keepaliveIntervalMs: number;
  keepaliveCountMax: number;
  commandTimeoutMs: number;
}

type CredentialPayload =
  | { type: 'password'; password: string }
  | { type: 'key'; privateKey: string };

// ── Pool implementation ────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SshPoolConfig = {
  maxSessionsPerServer: 3,
  readyTimeoutMs: 10000,
  keepaliveIntervalMs: 60000,
  keepaliveCountMax: 3,
  commandTimeoutMs: 15000,
};

class SshSessionPool {
  private sessions: SshSession[] = [];
  private config: SshPoolConfig;

  constructor(config?: Partial<SshPoolConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get an SSH connection for the given host:port.
   * Reuses idle connections if available; creates new ones up to maxSessionsPerServer.
   * Stale/disconnected connections are removed and replaced.
   */
  async getConnection(
    host: string,
    port: number,
    username: string,
    credentialType: string,
    credentialValue: string,
    hostKeyFingerprint?: string | null
  ): Promise<Client> {
    // Clean stale connections first
    this._cleanStale();

    // Look for an existing idle connection to this host
    const existing = this._findIdle(host, port);
    if (existing) {
      try {
        // Quick check if still connected — ssh2's _sock is internal but the
        // only reliable indicator without issuing a command
        if (this._isConnected(existing.client)) {
          existing.inUse = true;
          existing.lastUsed = Date.now();
          return existing.client;
        }
        // Connection is dead — remove from pool
        this._remove(existing);
      } catch {
        this._remove(existing);
      }
    }

    // Check per-server session limit
    const serverSessions = this.sessions.filter(
      (s) => s.host === host && s.port === port
    );
    if (serverSessions.length >= this.config.maxSessionsPerServer) {
      // Try to close the oldest idle session to make room
      const oldestIdle = serverSessions
        .filter((s) => !s.inUse)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (oldestIdle) {
        this._remove(oldestIdle);
      } else {
        throw new Error(
          `Max SSH sessions (${this.config.maxSessionsPerServer}) reached for ${host}:${port}`
        );
      }
    }

    // Create new connection
    const client = await this._connect(host, port, username, credentialType, credentialValue, hostKeyFingerprint);

    const session: SshSession = {
      client,
      host,
      port,
      lastUsed: Date.now(),
      inUse: true,
    };

    this.sessions.push(session);
    return client;
  }

  /**
   * Mark a connection as idle for reuse.
   */
  releaseConnection(client: Client): void {
    const session = this.sessions.find((s) => s.client === client);
    if (session) {
      session.inUse = false;
      session.lastUsed = Date.now();
    }
  }

  /**
   * Close a specific connection and remove it from the pool.
   */
  closeConnection(client: Client): void {
    const session = this.sessions.find((s) => s.client === client);
    if (session) {
      this._remove(session);
    }
  }

  /**
   * End all connections and clear the pool.
   */
  closeAll(): void {
    for (const session of this.sessions) {
      try {
        session.client.end();
      } catch {
        // Ignore end errors
      }
    }
    this.sessions = [];
  }

  /**
   * Execute multiple commands sequentially on a single connection.
   * Returns array of { stdout, stderr } results.
   */
  async execCommands(
    client: Client,
    commands: string[]
  ): Promise<{ stdout: string; stderr: string }[]> {
    const results: { stdout: string; stderr: string }[] = [];

    for (const command of commands) {
      const result = await this._execCommand(client, command);
      results.push(result);
    }

    return results;
  }

  /**
   * Get pool statistics.
   */
  getPoolStats(): PoolStats {
    const total = this.sessions.length;
    const active = this.sessions.filter((s) => s.inUse).length;
    const idle = total - active;

    return { total, idle, active };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _findIdle(host: string, port: number): SshSession | undefined {
    return this.sessions.find(
      (s) => s.host === host && s.port === port && !s.inUse
    );
  }

  private _isConnected(client: Client): boolean {
    return (client as any)._sock?.writable === true;
  }

  private _remove(session: SshSession): void {
    try {
      session.client.end();
    } catch {
      // Ignore
    }
    this.sessions = this.sessions.filter((s) => s !== session);
  }

  private _cleanStale(): void {
    const stale = this.sessions.filter((s) => {
      if (s.inUse) return false;
      try {
        return !this._isConnected(s.client);
      } catch {
        return true;
      }
    });

    for (const s of stale) {
      this._remove(s);
    }

    if (stale.length > 0) {
      const stats = this.getPoolStats();
      console.log(`[SshSessionPool] cleaned ${stale.length} stale connections (pool: ${stats.total})`);
    }
  }

  private _connect(
    host: string,
    port: number,
    username: string,
    credentialType: string,
    credentialValue: string,
    hostKeyFingerprint?: string | null
  ): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();

      const connectConfig: ConnectConfig = {
        host,
        port,
        username,
        readyTimeout: this.config.readyTimeoutMs,
        keepaliveInterval: this.config.keepaliveIntervalMs,
        keepaliveCountMax: this.config.keepaliveCountMax,
        hostVerifier: (key: Buffer, callback: (verified: boolean) => void) => {
          if (!hostKeyFingerprint) {
            // No stored fingerprint — accept any key (first connection).
            callback(true);
            return;
          }
          // Hash received host key with SHA256 and compare against stored fingerprint
          const hash = crypto.createHash('sha256').update(key).digest('base64');
          const received = `SHA256:${hash}`;
          if (received === hostKeyFingerprint) {
            callback(true);
          } else {
            console.error(
              `[SshSessionPool] Host key mismatch for ${host}:${port}. ` +
              `Stored: ${hostKeyFingerprint}, received: ${received}`
            );
            callback(false);
          }
        },
      };

      // Build credential payload based on credential type
      if (credentialType === 'password') {
        connectConfig.password = credentialValue;
      } else {
        connectConfig.privateKey = credentialValue;
      }

      client.on('ready', () => {
        resolve(client);
      });

      client.on('error', (err: Error) => {
        reject(err);
      });

      client.on('close', () => {
        // Connection closed — remove from pool if tracked
        const session = this.sessions.find((s) => s.client === client);
        if (session) {
          this._remove(session);
        }
      });

      client.connect(connectConfig);
    });
  }

  private _execCommand(
    client: Client,
    command: string
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`SSH command timed out after ${this.config.commandTimeoutMs}ms: ${command.substring(0, 80)}`));
      }, this.config.commandTimeoutMs);

      client.exec(command, (err: Error | undefined, channel?: ClientChannel) => {
        if (err) {
          clearTimeout(timeout);
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        channel!.on('data', (data: Buffer | string) => {
          stdout += data.toString();
        });

        channel!.stderr.on('data', (data: Buffer | string) => {
          stderr += data.toString();
        });

        channel!.on('close', () => {
          clearTimeout(timeout);
          resolve({ stdout, stderr });
        });

        channel!.on('error', (channelErr: Error) => {
          clearTimeout(timeout);
          reject(channelErr);
        });
      });
    });
  }
}

// Singleton instance
const sshSessionPool = new SshSessionPool();
export default sshSessionPool;
export { SshSessionPool, SshPoolConfig };
