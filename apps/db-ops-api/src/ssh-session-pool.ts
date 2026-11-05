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
import { createCredentialSshHostVerifier, normalizeOptionalSshHostKeyFingerprint } from './security/ssh-host-key.js';

// ── Types ──────────────────────────────────────────────────────────────────────

interface SshIdentity {
  sshTrustMode?: string | null;
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
  ticket: number;
}

/** One getConnection call from before authorization until it is pooled or dropped. */
interface InflightAcquisition {
  ticket: number;
  host: string;
  port: number;
  username: string;
  credentialType: string;
  hostKeyFingerprint?: string;
  hostKeyComparable: boolean;
  credentialFingerprint: string;
  cancelled: boolean;
  /** Capacity is reserved only after target authorization, before connecting. */
  capacityReserved: boolean;
  client?: Client;
  /** Rejects the in-flight connect promise at most once. */
  fail?: (error: Error) => void;
}

interface RevocationScope {
  host: string;
  port: number;
  hasUsername: boolean;
  username?: string;
  hasType: boolean;
  credentialType?: string;
  hasHostKey: boolean;
  hostKeyFingerprint?: string;
  credentialFingerprint?: string;
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
  private inflight: InflightAcquisition[] = [];
  private nextTicket = 0;
  private config: SshPoolConfig;

  constructor(config?: Partial<SshPoolConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get an SSH connection for one authenticated identity.
   * Reuse requires the same authorized host, port, username, credential type,
   * host-key fingerprint, and credential fingerprint. After a new login succeeds,
   * a changed secret, credential type, or host key ends that account's older sessions.
   * An acquisition revoked while authorization or authentication is still in flight
   * is not returned and is not pooled. Cancellation settles that waiter itself;
   * it does not wait for a later ready or error event. A later call with the same secret is allowed.
   * Pending handshakes count toward the host:port limit across all identities.
   * At capacity, evict the oldest idle session or reject immediately; no queue.
   */
  async getConnection(
    host: string,
    port: number,
    username: string,
    credentialType: string,
    credentialValue: string,
    hostKeyFingerprint?: string | null,
    sshTrustMode?: string | null
  ): Promise<Client> {
    const verifier = createCredentialSshHostVerifier(credentialType, hostKeyFingerprint, sshTrustMode);
    const acquisition = this._trackInflight(
      host,
      port,
      username,
      credentialType,
      credentialValue,
      hostKeyFingerprint,
    );
    try {
      const target = await authorizeServerTarget({ host, port });
      this._rejectIfRevoked(acquisition);
      const identity = this._identity(
        target.hostname,
        target.port,
        username,
        credentialType,
        credentialValue,
        hostKeyFingerprint,
      );
      identity.sshTrustMode = credentialType === 'key' ? sshTrustMode : undefined;
      acquisition.host = identity.host;
      acquisition.port = identity.port;
      acquisition.username = identity.username;
      acquisition.credentialType = identity.credentialType;
      acquisition.hostKeyFingerprint = identity.hostKeyFingerprint;
      acquisition.hostKeyComparable = true;
      acquisition.credentialFingerprint = identity.credentialFingerprint;
      this._rejectIfRevoked(acquisition);

      const existing = this._findIdle(identity);
      if (existing) {
        existing.inUse = true;
        existing.lastUsed = Date.now();
        return existing.client;
      }

      // Check and reserve capacity without yielding between the two operations.
      const serverSessions = this.sessions.filter(
        (s) => s.identity.host === target.hostname && s.identity.port === target.port
      );
      const pendingCount = this.inflight.filter((item) => (
        item.capacityReserved && item.host === target.hostname && item.port === target.port
      )).length;
      if (serverSessions.length + pendingCount >= this.config.maxSessionsPerServer) {
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

      acquisition.capacityReserved = true;
      // Create new connection
      const client = await this._connect(
        target.address,
        target.port,
        username,
        credentialType,
        credentialValue,
        identity.hostKeyFingerprint,
        acquisition,
        verifier,
      );
      this._rejectIfRevoked(acquisition, client);
      // A newer, different identity that already authenticated wins. This older
      // socket is closed and does not evict that newer session.
      this._abandonIfSuperseded(acquisition.ticket, identity, client);
      // Drop the account's previous sessions only after the new identity authenticates.
      this._evictSuperseded(identity);

      const session: SshSession = {
        client,
        lastUsed: Date.now(),
        inUse: true,
        identity,
        ticket: acquisition.ticket,
      };

      this.sessions.push(session);
      acquisition.capacityReserved = false;
      return client;
    } finally {
      this.inflight = this.inflight.filter((item) => item !== acquisition);
    }
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
    for (const acquisition of this.inflight) {
      acquisition.cancelled = true;
      this._endClient(acquisition.client);
      this._failAcquisition(acquisition, new Error('SSH_SESSION_REVOKED'));
    }
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
   * End pooled sessions for a host and cancel matching acquisitions that have
   * not pooled yet. Optional fields narrow the match. credentialValue is hashed
   * for comparison and is not retained or logged. This does not ban a later
   * getConnection that presents the same secret. Returns the number of pooled
   * sessions ended plus in-flight acquisitions cancelled.
   */
  revokeSessions(criteria: SshSessionRevocation): number {
    const scope = this._revocationScope(criteria);
    let cancelled = 0;
    for (const acquisition of this.inflight) {
      if (!this._inflightMatches(acquisition, scope)) continue;
      acquisition.cancelled = true;
      this._endClient(acquisition.client);
      this._failAcquisition(acquisition, new Error('SSH_SESSION_REVOKED'));
      cancelled += 1;
    }
    const matched = this.sessions.filter((session) => this._identityMatches(session.identity, scope));
    for (const session of matched) this._remove(session);
    return cancelled + matched.length;
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
      && session.identity.sshTrustMode === identity.sshTrustMode
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

  private _trackInflight(
    host: string,
    port: number,
    username: string,
    credentialType: string,
    credentialValue: string,
    hostKeyFingerprint?: string | null,
  ): InflightAcquisition {
    let normalizedHostKey: string | undefined;
    let hostKeyComparable = false;
    try {
      normalizedHostKey = normalizeOptionalSshHostKeyFingerprint(hostKeyFingerprint);
      hostKeyComparable = true;
    } catch {
      hostKeyComparable = false;
    }
    const acquisition: InflightAcquisition = {
      ticket: ++this.nextTicket,
      host: typeof host === 'string' ? host.trim().toLowerCase() : '',
      port: Number(port),
      username,
      credentialType,
      hostKeyFingerprint: normalizedHostKey,
      hostKeyComparable,
      credentialFingerprint: typeof credentialType === 'string' && typeof credentialValue === 'string'
        ? fingerprintCredential(credentialType, credentialValue)
        : '',
      cancelled: false,
      capacityReserved: false,
    };
    this.inflight.push(acquisition);
    return acquisition;
  }

  private _revocationScope(criteria: SshSessionRevocation): RevocationScope {
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

    return {
      host: criteria.host.trim().toLowerCase(),
      port,
      hasUsername,
      username: criteria.username,
      hasType,
      credentialType: criteria.credentialType,
      hasHostKey,
      hostKeyFingerprint: hasHostKey
        ? normalizeOptionalSshHostKeyFingerprint(criteria.hostKeyFingerprint)
        : undefined,
      credentialFingerprint: hasSecret
        ? fingerprintCredential(criteria.credentialType as string, criteria.credentialValue as string)
        : undefined,
    };
  }

  private _identityMatches(identity: SshIdentity, scope: RevocationScope): boolean {
    if (identity.host !== scope.host || identity.port !== scope.port) return false;
    if (scope.hasUsername && identity.username !== scope.username) return false;
    if (scope.hasType && identity.credentialType !== scope.credentialType) return false;
    if (scope.hasHostKey && identity.hostKeyFingerprint !== scope.hostKeyFingerprint) return false;
    if (scope.credentialFingerprint && !sameFingerprint(identity.credentialFingerprint, scope.credentialFingerprint)) {
      return false;
    }
    return true;
  }

  private _inflightMatches(acquisition: InflightAcquisition, scope: RevocationScope): boolean {
    if (acquisition.cancelled) return false;
    if (acquisition.host !== scope.host || acquisition.port !== scope.port) return false;
    if (scope.hasUsername && acquisition.username !== scope.username) return false;
    if (scope.hasType && acquisition.credentialType !== scope.credentialType) return false;
    if (scope.hasHostKey) {
      if (!acquisition.hostKeyComparable || acquisition.hostKeyFingerprint !== scope.hostKeyFingerprint) return false;
    }
    if (scope.credentialFingerprint && !sameFingerprint(acquisition.credentialFingerprint, scope.credentialFingerprint)) {
      return false;
    }
    return true;
  }

  private _rejectIfRevoked(acquisition: InflightAcquisition, client?: Client): void {
    if (!acquisition.cancelled) return;
    this._endClient(client ?? acquisition.client);
    throw new Error('SSH_SESSION_REVOKED');
  }

  /** Settle a connect waiter once. Later ready, error, or close events do not settle it again. */
  private _failAcquisition(acquisition: InflightAcquisition, error: Error): void {
    const fail = acquisition.fail;
    acquisition.fail = undefined;
    fail?.(error);
  }

  /**
   * The completing request is older than a pooled session for the same account
   * with a different identity. Close it and leave the newer session in place.
   * A request that starts later still authenticates and then replaces older sessions.
   */
  private _abandonIfSuperseded(ticket: number, identity: SshIdentity, client: Client): void {
    const lost = this.sessions.some((session) => (
      session.ticket > ticket
      && session.identity.host === identity.host
      && session.identity.port === identity.port
      && session.identity.username === identity.username
      && !this._sameIdentity(session, identity)
    ));
    if (!lost) return;
    this._endClient(client);
    throw new Error('SSH_SESSION_SUPERSEDED');
  }

  private _endClient(client: Client | undefined): void {
    if (!client) return;
    try {
      client.end();
    } catch {
      // Ignore
    }
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
    hostKeyFingerprint: string | undefined,
    acquisition: InflightAcquisition,
    hostVerifier: ReturnType<typeof createCredentialSshHostVerifier>,
  ): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      acquisition.client = client;
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        action();
      };

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

      const fail = (error: Error) => finish(() => reject(error));
      acquisition.fail = fail;

      client.on('ready', () => {
        if (acquisition.cancelled) {
          this._endClient(client);
          fail(new Error('SSH_SESSION_REVOKED'));
          return;
        }
        finish(() => resolve(client));
      });

      client.on('error', (err: Error) => {
        if (acquisition.cancelled) {
          fail(new Error('SSH_SESSION_REVOKED'));
          return;
        }
        finish(() => reject(err));
      });

      client.on('close', () => {
        // A close-only handshake must release its pending capacity as well.
        fail(new Error(acquisition.cancelled ? 'SSH_SESSION_REVOKED' : 'SSH_CONNECTION_CLOSED'));
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
