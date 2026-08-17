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
import { authorizeServerTarget } from './security/server-target-policy.js';
import { createSshHostVerifier, normalizeSshHostKeyFingerprint } from './security/ssh-host-key.js';

// ── Types ──────────────────────────────────────────────────────────────────────

interface SshSession {
  client: Client;
  host: string;
  port: number;
  lastUsed: number;
  inUse: boolean;
  hostKeyFingerprint: string;
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

interface ExecCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface ExecCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  truncated: boolean;
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
    const target = await authorizeServerTarget({ host, port });
    const normalizedFingerprint = normalizeSshHostKeyFingerprint(hostKeyFingerprint);
    // Look for an existing idle connection to this host
    const existing = this._findIdle(target.hostname, target.port, normalizedFingerprint);
    if (existing) {
      existing.inUse = true;
      existing.lastUsed = Date.now();
      return existing.client;
    }

    // Check per-server session limit
    const serverSessions = this.sessions.filter(
      (s) => s.host === target.hostname && s.port === target.port
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
    const client = await this._connect(
      target.address,
      target.port,
      username,
      credentialType,
      credentialValue,
      normalizedFingerprint,
    );

    const session: SshSession = {
      client,
      host: target.hostname,
      port: target.port,
      lastUsed: Date.now(),
      inUse: true,
      hostKeyFingerprint: normalizedFingerprint,
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
    commands: string[],
    options: ExecCommandOptions = {},
  ): Promise<ExecCommandResult[]> {
    const results: ExecCommandResult[] = [];

    for (const command of commands) {
      const result = await this._execCommand(client, command, options);
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

  private _findIdle(host: string, port: number, hostKeyFingerprint: string): SshSession | undefined {
    return this.sessions.find(
      (s) => s.host === host && s.port === port && s.hostKeyFingerprint === hostKeyFingerprint && !s.inUse
    );
  }

  private _remove(session: SshSession): void {
    try {
      session.client.end();
    } catch {
      // Ignore
    }
    this.sessions = this.sessions.filter((s) => s !== session);
  }

  private _connect(
    address: string,
    port: number,
    username: string,
    credentialType: string,
    credentialValue: string,
    hostKeyFingerprint: string,
  ): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();

      const connectConfig: ConnectConfig = {
        host: address,
        port,
        username,
        readyTimeout: this.config.readyTimeoutMs,
        keepaliveInterval: this.config.keepaliveIntervalMs,
        keepaliveCountMax: this.config.keepaliveCountMax,
        hostVerifier: createSshHostVerifier(hostKeyFingerprint),
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
    command: string,
    options: ExecCommandOptions,
  ): Promise<ExecCommandResult> {
    return new Promise((resolve, reject) => {
      let commandChannel: ClientChannel | undefined;
      let settled = false;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let outputBytes = 0;
      const timeoutMs = options.timeoutMs ?? this.config.commandTimeoutMs;
      const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;

      const finishReject = (code: string, closeChannel = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(code));
        if (closeChannel && commandChannel) {
          try { commandChannel.close(); } catch { /* ignore */ }
        }
      };

      const append = (target: 'stdout' | 'stderr', data: Buffer | string) => {
        if (settled) return;
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (outputBytes + chunk.byteLength > maxOutputBytes) {
          finishReject('SSH_COMMAND_OUTPUT_LIMIT', true);
          return;
        }
        outputBytes += chunk.byteLength;
        if (target === 'stdout') stdout = Buffer.concat([stdout, chunk]);
        else stderr = Buffer.concat([stderr, chunk]);
      };

      const timeout = setTimeout(() => {
        finishReject('SSH_COMMAND_TIMEOUT', true);
      }, timeoutMs);

      try {
        client.exec(command, (err: Error | undefined, channel?: ClientChannel) => {
          if (settled) {
            if (channel) try { channel.close(); } catch { /* ignore */ }
            return;
          }
          if (err) {
            finishReject('SSH_COMMAND_FAILED');
            return;
          }

          if (!channel) {
            finishReject('SSH_COMMAND_PROTOCOL_ERROR');
            return;
          }

          commandChannel = channel;

          channel.on('data', (data: Buffer | string) => {
            append('stdout', data);
          });

          channel.stderr.on('data', (data: Buffer | string) => {
            append('stderr', data);
          });

          channel.on('close', (exitCode?: number, signal?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve({
              stdout: stdout.toString('utf8'),
              stderr: stderr.toString('utf8'),
              exitCode: typeof exitCode === 'number' ? exitCode : null,
              signal: typeof signal === 'string' ? signal : null,
              truncated: false,
            });
          });

          channel.on('error', () => {
            finishReject('SSH_COMMAND_PROTOCOL_ERROR');
          });
        });
      } catch {
        finishReject('SSH_COMMAND_FAILED');
      }
    });
  }
}

// Singleton instance
const sshSessionPool = new SshSessionPool();
export default sshSessionPool;
export { SshSessionPool, SshPoolConfig, ExecCommandOptions, ExecCommandResult };
