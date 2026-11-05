/**
 * SSH Session Pool
 *
 * Singleton connection pool for SSH sessions with keepalive,
 * connection reuse, batch command execution, and stale cleanup.
 *
 * Requirements: COL-04 (15s command timeout, 10s readyTimeout),
 *               COL-08 (batch commands on single connection)
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { authorizeServerTarget } from './security/server-target-policy.js';
import { createOptionalSshHostVerifier, normalizeOptionalSshHostKeyFingerprint } from './security/ssh-host-key.js';

// ── Types ──────────────────────────────────────────────────────────────────────

interface SshIdentity {
  host: string;
  port: number;
  username: string;
  credentialType: string;
  hostKeyFingerprint?: string;
  credentialFingerprint: string;
}

interface SshSession {
  client: Client;
  lastUsed: number;
  inUse: boolean;
  identity: SshIdentity;
}

/** Filters for immediate pool cleanup. Omitted fields match every session on the host. */
interface SshSessionRevocation {
  host: string;
  port: number;
  username?: string;
  credentialType?: string;
  hostKeyFingerprint?: string | null;
  credentialValue?: string;
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

function fingerprintCredential(credentialType: string, credentialValue: string): string {
  return createHash('sha256')
    .update('slide-ssh-session-credential-v1')
    .update('\0')
    .update(credentialType)
    .update('\0')
    .update(credentialValue)
    .digest('hex');
}

function sameFingerprint(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

class SshSessionPool {
  private sessions: SshSession[] = [];
  private config: SshPoolConfig;

  constructor(config?: Partial<SshPoolConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get an SSH connection for one authenticated identity.
   * Reuse requires the same authorized host, port, username, credential type,
   * host-key fingerprint, and credential fingerprint. After a new login succeeds,
   * a changed secret, credential type, or host key ends that account's older sessions.
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
    const identity = this._identity(
      target.hostname,
      target.port,
      username,
      credentialType,
      credentialValue,
      hostKeyFingerprint,
    );
    const existing = this._findIdle(identity);
    if (existing) {
      existing.inUse = true;
      existing.lastUsed = Date.now();
      return existing.client;
    }

    // Check per-server session limit
    const serverSessions = this.sessions.filter(
      (s) => s.identity.host === target.hostname && s.identity.port === target.port
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
      identity.hostKeyFingerprint,
    );
    // Drop the account's previous sessions only after the new identity authenticates.
    this._evictSuperseded(identity);

    const session: SshSession = {
      client,
      lastUsed: Date.now(),
      inUse: true,
      identity,
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
   * End pooled sessions for a host. Optional fields narrow the match.
   * credentialValue is hashed for comparison and is not retained or logged.
   * Returns the number of sessions ended.
   */
  revokeSessions(criteria: SshSessionRevocation): number {
    if (!criteria || typeof criteria.host !== 'string' || criteria.host.trim() === '') {
      throw new Error('SSH_REVOCATION_TARGET_INVALID');
    }
    const port = Number(criteria.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('SSH_REVOCATION_TARGET_INVALID');
    }
    const hasUsername = Object.prototype.hasOwnProperty.call(criteria, 'username');
    const hasType = Object.prototype.hasOwnProperty.call(criteria, 'credentialType');
    const hasHostKey = Object.prototype.hasOwnProperty.call(criteria, 'hostKeyFingerprint');
    const hasSecret = Object.prototype.hasOwnProperty.call(criteria, 'credentialValue');
    if (hasUsername && typeof criteria.username !== 'string') throw new Error('SSH_REVOCATION_TARGET_INVALID');
    if (hasType && typeof criteria.credentialType !== 'string') throw new Error('SSH_REVOCATION_TARGET_INVALID');
    if (hasSecret && typeof criteria.credentialValue !== 'string') throw new Error('SSH_REVOCATION_TARGET_INVALID');
    if (hasSecret && !hasType) throw new Error('SSH_REVOCATION_CREDENTIAL_TYPE_REQUIRED');

    const host = criteria.host.trim().toLowerCase();
    const hostKeyFingerprint = hasHostKey
      ? normalizeOptionalSshHostKeyFingerprint(criteria.hostKeyFingerprint)
      : undefined;
    const credentialFingerprint = hasSecret
      ? fingerprintCredential(criteria.credentialType as string, criteria.credentialValue as string)
      : undefined;
    const matched = this.sessions.filter((session) => {
      if (session.identity.host !== host || session.identity.port !== port) return false;
      if (hasUsername && session.identity.username !== criteria.username) return false;
      if (hasType && session.identity.credentialType !== criteria.credentialType) return false;
      if (hasHostKey && session.identity.hostKeyFingerprint !== hostKeyFingerprint) return false;
      if (credentialFingerprint && !sameFingerprint(session.identity.credentialFingerprint, credentialFingerprint)) {
        return false;
      }
      return true;
    });
    for (const session of matched) this._remove(session);
    return matched.length;
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

  private _identity(
    host: string,
    port: number,
    username: string,
    credentialType: string,
    credentialValue: string,
    hostKeyFingerprint?: string | null,
  ): SshIdentity {
    if (typeof username !== 'string' || typeof credentialType !== 'string' || typeof credentialValue !== 'string') {
      throw new Error('SSH_CREDENTIAL_IDENTITY_INVALID');
    }
    return {
      host,
      port,
      username,
      credentialType,
      hostKeyFingerprint: normalizeOptionalSshHostKeyFingerprint(hostKeyFingerprint),
      credentialFingerprint: fingerprintCredential(credentialType, credentialValue),
    };
  }

  private _sameIdentity(session: SshSession, identity: SshIdentity): boolean {
    return session.identity.host === identity.host
      && session.identity.port === identity.port
      && session.identity.username === identity.username
      && session.identity.credentialType === identity.credentialType
      && session.identity.hostKeyFingerprint === identity.hostKeyFingerprint
      && sameFingerprint(session.identity.credentialFingerprint, identity.credentialFingerprint);
  }

  private _findIdle(identity: SshIdentity): SshSession | undefined {
    return this.sessions.find((session) => this._sameIdentity(session, identity) && !session.inUse);
  }

  private _evictSuperseded(identity: SshIdentity): void {
    const stale = this.sessions.filter((session) => (
      session.identity.host === identity.host
      && session.identity.port === identity.port
      && session.identity.username === identity.username
      && !this._sameIdentity(session, identity)
    ));
    for (const session of stale) this._remove(session);
  }

  private _remove(session: SshSession): void {
    if (!this.sessions.includes(session)) return;
    this.sessions = this.sessions.filter((s) => s !== session);
    try {
      session.client.end();
    } catch {
      // Ignore
    }
  }

  private _connect(
    address: string,
    port: number,
    username: string,
    credentialType: string,
    credentialValue: string,
    hostKeyFingerprint?: string,
  ): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();

      const hostVerifier = createOptionalSshHostVerifier(hostKeyFingerprint);
      const connectConfig: ConnectConfig = {
        host: address,
        port,
        username,
        readyTimeout: this.config.readyTimeoutMs,
        keepaliveInterval: this.config.keepaliveIntervalMs,
        keepaliveCountMax: this.config.keepaliveCountMax,
        ...(hostVerifier ? { hostVerifier } : {}),
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
export { SshSessionPool, SshPoolConfig, ExecCommandOptions, ExecCommandResult, SshSessionRevocation };
