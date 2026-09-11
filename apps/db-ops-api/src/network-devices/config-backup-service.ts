import { createHash } from 'node:crypto';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';

import { decryptData, dbConnection, encryptData } from '../db-connection.js';
import { auditLogManager } from '../audit/audit-log.js';
import { authorizeNetworkDeviceTarget, type AuthorizedNetworkDeviceTarget } from '../security/network-device-target-policy.js';
import { createOptionalSshHostVerifier, normalizeOptionalSshHostKeyFingerprint } from '../security/ssh-host-key.js';
import type { ConfigBackupSummary } from '../resources/network-device-types.js';
import { networkDeviceDatabaseService, type NetworkDeviceCredentials, type NetworkDeviceDatabaseService } from './network-device-database-service.js';

export const CONFIG_BACKUP_MAX_BYTES = 2 * 1024 * 1024;
export const CONFIG_BACKUP_DIFF_MAX_BYTES = 512 * 1024;
export const CONFIG_BACKUP_COMMANDS = Object.freeze([
  'screen-length 0 temporary',
  'display current-configuration',
] as const);

const CISCO_CONFIG_BACKUP_COMMANDS = Object.freeze(['terminal length 0', 'show running-config'] as const);

function backupCommands(vendor?: string): readonly string[] {
  if (vendor === 'cisco') return CISCO_CONFIG_BACKUP_COMMANDS;
  if (!vendor || vendor === 'huawei') return CONFIG_BACKUP_COMMANDS;
  throw new ConfigBackupError('CONFIG_BACKUP_VENDOR_UNSUPPORTED');
}

export type ConfigBackupErrorCode =
  | 'NETWORK_DEVICE_NOT_FOUND'
  | 'SSH_CREDENTIAL_READ_FAILED'
  | 'CONFIG_BACKUP_VENDOR_UNSUPPORTED'
  | 'SSH_CREDENTIAL_REQUIRED'
  | 'SSH_HOST_KEY_FINGERPRINT_REQUIRED'
  | 'SSH_TARGET_DENIED'
  | 'SSH_CONNECT_FAILED'
  | 'SSH_COMMAND_FAILED'
  | 'SSH_COMMAND_TIMEOUT'
  | 'CONFIG_OUTPUT_LIMIT'
  | 'CONFIG_EMPTY'
  | 'CONFIG_BACKUP_NOT_FOUND'
  | 'CONFIG_BACKUP_DIFF_LIMIT'
  | 'CONFIG_BACKUP_STORE_UNAVAILABLE';

export class ConfigBackupError extends Error {
  readonly code: ConfigBackupErrorCode;

  constructor(code: ConfigBackupErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = 'ConfigBackupError';
    this.code = code;
  }
}

export interface ConfigBackupTarget {
  id: number;
  host: string;
  sshPort: number;
  vendor?: string;
  name?: string;
}

export interface ConfigBackupConnection {
  exec(command: string): Promise<{ stdout: string; stderr?: string; exitCode?: number | null }>;
  end(): void | Promise<void>;
}

export interface ConfigBackupSshTransport {
  connect(input: {
    target: AuthorizedNetworkDeviceTarget;
    username: string;
    credentialType: 'password' | 'key';
    credentialValue: string;
    hostKeyFingerprint?: string;
    readyTimeoutMs: number;
  }): Promise<ConfigBackupConnection>;
}

export interface SshHostKeyProbeInput {
  host: string;
  port: number;
  username: string;
  credentialType: 'password' | 'key';
  credentialValue: string;
  hostKeyFingerprint?: string;
}

export interface SshHostKeyProbeOptions {
  authorizeTarget?: typeof authorizeNetworkDeviceTarget;
  transport?: ConfigBackupSshTransport;
  targetPolicy?: { allowedCidrs?: string; allowedPorts?: readonly number[]; production?: boolean };
  readyTimeoutMs?: number;
}

export interface ConfigBackupStore {
  /** Current persistence seam. Optional to retain compatibility with the
   * smaller capture seam used by integrations and unit tests. */
  list?(deviceId: number, limit: number): Promise<ConfigBackupSummary[]>;
  find?(deviceId: number, backupId: number): Promise<StoredConfigBackup | null>;
  insert?(input: {
    deviceId: number;
    contentEncrypted: string;
    contentSha256: string;
    sourceProtocol: 'ssh';
    collectedAt: Date;
    sizeBytes: number;
    redactionStatus: ConfigBackupSummary['redactionStatus'];
    createdBy: number | null;
  }): Promise<ConfigBackupSummary>;
  /** Legacy capture seam (all methods are normalized by the constructor). */
  getTarget?(deviceId: number): Promise<ConfigBackupTarget | null>;
  getCredentials?(deviceId: number): Promise<NetworkDeviceCredentials | null>;
  findByHash?(deviceId: number, contentSha256: string): Promise<ConfigBackupSummary | null>;
  nextVersion?(deviceId: number): Promise<number>;
  save?(record: Record<string, unknown>): Promise<Record<string, unknown>>;
  getById?(deviceId: number, backupId: number): Promise<Record<string, unknown> | null>;
}

export interface ConfigBackupTransport {
  collect(input: {
    host: string;
    port: number;
    username: string;
    credentialType: 'password' | 'key';
    credentialValue: string;
    hostKeyFingerprint?: string;
    commands: readonly string[];
    timeoutMs: number;
    maxOutputBytes: number;
  }): Promise<{ stdout: string; truncated?: boolean }>;
}

export interface ConfigBackupCrypto {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export interface StoredConfigBackup extends ConfigBackupSummary {
  contentEncrypted: string;
}

export interface ConfigBackupResult {
  summary: ConfigBackupSummary;
  preview: string;
  deduplicated: boolean;
}

export interface ConfigBackupAuditEvent {
  action: 'collect' | 'read_raw' | 'read_denied' | 'failed';
  deviceId: number;
  backupId?: number;
  reason?: string;
  contentSha256?: string;
  sizeBytes?: number;
  actorId?: number | null;
}

export interface ConfigBackupServiceOptions {
  deviceService: Pick<NetworkDeviceDatabaseService, 'getDeviceById' | 'getCredentials'> | {
    getDeviceById(id: number): Promise<ConfigBackupTarget | null>;
    getCredentials(id: number, protocol?: 'ssh'): Promise<NetworkDeviceCredentials | null>;
  };
  store?: ConfigBackupStore;
  transport?: ConfigBackupSshTransport;
  authorizeTarget?: typeof authorizeNetworkDeviceTarget;
  clock?: () => Date;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
  audit?: (event: ConfigBackupAuditEvent) => Promise<void> | void;
  targetPolicy?: { allowedCidrs?: string; allowedPorts?: readonly number[]; production?: boolean };
}

/**
 * Default production audit sink. Only stable identifiers, hashes, sizes, and
 * reason codes are forwarded; raw configuration and credentials stay out of
 * the audit trail.
 */
export async function defaultConfigBackupAudit(event: ConfigBackupAuditEvent): Promise<void> {
  await auditLogManager.logConfigBackupAccess({
    userId: event.actorId == null ? undefined : String(event.actorId),
    action: event.action,
    deviceId: event.deviceId,
    backupId: event.backupId,
    reason: event.reason,
    contentSha256: event.contentSha256,
    sizeBytes: event.sizeBytes,
  });
}

function pool(): any {
  const value = dbConnection.getPool();
  if (!value) throw new ConfigBackupError('CONFIG_BACKUP_STORE_UNAVAILABLE');
  return value;
}

function asSummary(row: any): ConfigBackupSummary {
  return {
    id: Number(row.id), deviceId: Number(row.deviceId ?? row.device_id), versionNo: Number(row.versionNo ?? row.version_no),
    contentSha256: String(row.contentSha256 ?? row.content_sha256), sourceProtocol: row.sourceProtocol ?? row.source_protocol,
    collectedAt: new Date(row.collectedAt ?? row.collected_at).toISOString(), sizeBytes: Number(row.sizeBytes ?? row.size_bytes),
    redactionStatus: row.redactionStatus ?? row.redaction_status,
  };
}

function createSqlStore(): ConfigBackupStore {
  return {
    async list(deviceId, limit) {
      const [rows] = await pool().execute(
        `SELECT id, device_id AS deviceId, version_no AS versionNo, content_sha256 AS contentSha256,
                source_protocol AS sourceProtocol, collected_at AS collectedAt, size_bytes AS sizeBytes,
                redaction_status AS redactionStatus
         FROM network_device_config_backups WHERE device_id = ? ORDER BY version_no DESC LIMIT ${limit}`,
        [deviceId],
      );
      return (rows as any[]).map(asSummary);
    },
    async find(deviceId, backupId) {
      const [rows] = await pool().execute(
        `SELECT id, device_id AS deviceId, version_no AS versionNo, content_encrypted AS contentEncrypted,
                content_sha256 AS contentSha256, source_protocol AS sourceProtocol, collected_at AS collectedAt,
                size_bytes AS sizeBytes, redaction_status AS redactionStatus
         FROM network_device_config_backups WHERE device_id = ? AND id = ? LIMIT 1`,
        [deviceId, backupId],
      );
      const row = (rows as any[])[0];
      return row ? { ...asSummary(row), contentEncrypted: String(row.contentEncrypted) } : null;
    },
    async insert(input) {
      // A single connection/transaction prevents two simultaneous collectors
      // from allocating the same version number or saving duplicate content.
      const db = pool();
      if (typeof db.getConnection !== 'function') {
        const [existing] = await db.execute('SELECT id, device_id AS deviceId, version_no AS versionNo, content_sha256 AS contentSha256, source_protocol AS sourceProtocol, collected_at AS collectedAt, size_bytes AS sizeBytes, redaction_status AS redactionStatus FROM network_device_config_backups WHERE device_id = ? AND content_sha256 = ? LIMIT 1', [input.deviceId, input.contentSha256]);
        if ((existing as any[])[0]) return asSummary((existing as any[])[0]);
        const [versionRows] = await db.execute('SELECT COALESCE(MAX(version_no), 0) + 1 AS nextVersion FROM network_device_config_backups WHERE device_id = ?', [input.deviceId]);
        const versionNo = Number((versionRows as any[])[0]?.nextVersion ?? 1);
        const [result] = await db.execute(
          `INSERT INTO network_device_config_backups
           (device_id, version_no, content_encrypted, content_sha256, source_protocol, collected_at, size_bytes, redaction_status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [input.deviceId, versionNo, input.contentEncrypted, input.contentSha256, input.sourceProtocol, input.collectedAt, input.sizeBytes, input.redactionStatus, input.createdBy],
        );
        return { id: Number((result as any).insertId), deviceId: input.deviceId, versionNo, contentSha256: input.contentSha256, sourceProtocol: input.sourceProtocol, collectedAt: input.collectedAt.toISOString(), sizeBytes: input.sizeBytes, redactionStatus: input.redactionStatus };
      }
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const [existing] = await connection.execute('SELECT id, device_id AS deviceId, version_no AS versionNo, content_sha256 AS contentSha256, source_protocol AS sourceProtocol, collected_at AS collectedAt, size_bytes AS sizeBytes, redaction_status AS redactionStatus FROM network_device_config_backups WHERE device_id = ? AND content_sha256 = ? LIMIT 1 FOR UPDATE', [input.deviceId, input.contentSha256]);
        if ((existing as any[])[0]) {
          await connection.commit();
          return asSummary((existing as any[])[0]);
        }
        const [versionRows] = await connection.execute('SELECT COALESCE(MAX(version_no), 0) + 1 AS nextVersion FROM network_device_config_backups WHERE device_id = ? FOR UPDATE', [input.deviceId]);
        const versionNo = Number((versionRows as any[])[0]?.nextVersion ?? 1);
        const [result] = await connection.execute(
          `INSERT INTO network_device_config_backups
           (device_id, version_no, content_encrypted, content_sha256, source_protocol, collected_at, size_bytes, redaction_status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [input.deviceId, versionNo, input.contentEncrypted, input.contentSha256, input.sourceProtocol, input.collectedAt, input.sizeBytes, input.redactionStatus, input.createdBy],
        );
        await connection.commit();
        return { id: Number((result as any).insertId), deviceId: input.deviceId, versionNo, contentSha256: input.contentSha256, sourceProtocol: input.sourceProtocol, collectedAt: input.collectedAt.toISOString(), sizeBytes: input.sizeBytes, redactionStatus: input.redactionStatus };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        // A concurrent insert can win the unique hash/version race. Resolve it
        // as a deduplicated result instead of exposing a raw SQL error.
        if ((error as any)?.code === 'ER_DUP_ENTRY') {
          const [rows] = await db.execute('SELECT id, device_id AS deviceId, version_no AS versionNo, content_sha256 AS contentSha256, source_protocol AS sourceProtocol, collected_at AS collectedAt, size_bytes AS sizeBytes, redaction_status AS redactionStatus FROM network_device_config_backups WHERE device_id = ? AND content_sha256 = ? LIMIT 1', [input.deviceId, input.contentSha256]);
          if ((rows as any[])[0]) return asSummary((rows as any[])[0]);
        }
        throw error;
      } finally { connection.release(); }
    },
  };
}

function redactConfiguration(content: string): { preview: string; status: ConfigBackupSummary['redactionStatus'] } {
  try {
    let changed = false;
    const preview = content.split(/(\r?\n)/).map((part) => {
      if (/^(\r?\n)$/.test(part)) return part;
      // Huawei emits secrets in several forms (cipher/simple, community and
      // key material). Preserve the directive but discard the complete tail
      // after the first sensitive keyword so chained forms cannot leak a
      // second token (for example "password irreversible-cipher secret").
      const match = /\b(password|passwd|secret|community|cipher|simple|authentication-key|privacy-key|private-key)\b/i.exec(part);
      if (!match) return part;
      changed = true;
      const end = match.index + match[0].length;
      return `${part.slice(0, end)} <redacted>`;
    }).join('');
    return { preview, status: changed ? 'redacted' : 'unredacted' };
  } catch {
    return { preview: '', status: 'failed' };
  }
}

function stableFailure(error: unknown, fallback: ConfigBackupErrorCode = 'SSH_COMMAND_FAILED'): ConfigBackupError {
  if (error instanceof ConfigBackupError) return error;
  if (fallback !== 'SSH_COMMAND_FAILED') return new ConfigBackupError(fallback);
  const code = error && typeof error === 'object' && 'code' in error ? String((error as any).code) : '';
  if (code === 'SSH_COMMAND_TIMEOUT') return new ConfigBackupError('SSH_COMMAND_TIMEOUT');
  if (/timeout/i.test(error instanceof Error ? error.message : '')) return new ConfigBackupError('SSH_COMMAND_TIMEOUT');
  return new ConfigBackupError(fallback);
}

function normalizeBackupTarget(value: unknown): ConfigBackupTarget | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = Number(row.id);
  const host = typeof row.host === 'string' ? row.host : '';
  const sshPort = Number(row.sshPort ?? row.ssh_port);
  if (!Number.isSafeInteger(id) || id < 1 || !host || !Number.isInteger(sshPort)) return null;
  return { id, host, sshPort, vendor: typeof row.vendor === 'string' ? row.vendor : undefined, name: typeof row.name === 'string' ? row.name : undefined };
}

class DefaultSshTransport implements ConfigBackupSshTransport {
  async connect(input: Parameters<ConfigBackupSshTransport['connect']>[0]): Promise<ConfigBackupConnection> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      const rejectOnce = (error: unknown) => { if (!settled) { settled = true; reject(new ConfigBackupError('SSH_CONNECT_FAILED', { cause: error })); } };
      client.once('ready', () => {
        if (settled) return;
        settled = true;
        resolve({ exec: (command) => execOnClient(client, command), end: () => { client.end(); } });
      });
      client.once('error', rejectOnce);
      const hostVerifier = createOptionalSshHostVerifier(input.hostKeyFingerprint);
      const connectConfig: ConnectConfig = {
        host: input.target.address, port: input.target.port, username: input.username,
        readyTimeout: input.readyTimeoutMs, ...(hostVerifier ? { hostVerifier } : {}),
      };
      if (input.credentialType === 'password') connectConfig.password = input.credentialValue;
      else connectConfig.privateKey = input.credentialValue;
      try { client.connect(connectConfig); } catch (error) { rejectOnce(error); }
    });
  }
}

/**
 * Verify an SSH endpoint without running a device command. When an operator
 * supplies a host-key fingerprint, the handshake also verifies that pin.
 */
export async function verifySshHostKey(
  input: SshHostKeyProbeInput,
  options: SshHostKeyProbeOptions = {},
): Promise<void> {
  const authorizeTarget = options.authorizeTarget ?? authorizeNetworkDeviceTarget;
  const target = await authorizeTarget(
    { host: input.host, port: input.port },
    {
      allowedCidrs: options.targetPolicy?.allowedCidrs,
      allowedPorts: options.targetPolicy?.allowedPorts,
      production: options.targetPolicy?.production,
    },
  );
  const fingerprint = normalizeOptionalSshHostKeyFingerprint(input.hostKeyFingerprint);
  const transport = options.transport ?? new DefaultSshTransport();
  let connection: ConfigBackupConnection | null = null;
  try {
    connection = await transport.connect({
      target,
      username: input.username,
      credentialType: input.credentialType,
      credentialValue: input.credentialValue,
      hostKeyFingerprint: fingerprint,
      readyTimeoutMs: options.readyTimeoutMs ?? 30_000,
    });
  } catch (error) {
    if (error instanceof ConfigBackupError) throw error;
    throw new ConfigBackupError('SSH_CONNECT_FAILED', { cause: error });
  } finally {
    try { await connection?.end(); } catch { /* best effort */ }
  }
}

/**
 * Execute one fixed SSH command while enforcing the hard 2 MiB wire-output
 * ceiling. The limit is applied to stdout and stderr together, before chunks
 * are buffered, so a noisy device cannot exhaust process memory.
 */
export function execOnClient(client: Client, command: string): Promise<{ stdout: string; stderr?: string; exitCode?: number | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    let outputBytes = 0;
    const abortForLimit = (channel: ClientChannel) => {
      // Mark the promise rejected before teardown can synchronously emit close.
      finish(() => reject(new ConfigBackupError('CONFIG_OUTPUT_LIMIT')));
      try { (channel as any).destroy?.(); } catch { /* best effort */ }
      try { (channel as any).close?.(); } catch { /* best effort */ }
      try { client.end(); } catch { /* best effort */ }
    };
    const appendChunk = (channel: ClientChannel, current: Buffer<ArrayBufferLike>, chunk: Buffer | string): Buffer<ArrayBufferLike> | null => {
      if (settled) return null;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextBytes = outputBytes + buffer.byteLength;
      if (nextBytes > CONFIG_BACKUP_MAX_BYTES) {
        abortForLimit(channel);
        return null;
      }
      outputBytes = nextBytes;
      return Buffer.concat([current, buffer]);
    };
    try {
      client.exec(command, (error: Error | undefined, channel?: ClientChannel) => {
        if (error || !channel) return finish(() => reject(new ConfigBackupError('SSH_COMMAND_FAILED', { cause: error })));
        let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        channel.on('data', (chunk: Buffer | string) => {
          const next = appendChunk(channel, stdout, chunk);
          if (next) stdout = next;
        });
        channel.stderr?.on('data', (chunk: Buffer | string) => {
          const next = appendChunk(channel, stderr, chunk);
          if (next) stderr = next;
        });
        channel.on('close', (exitCode?: number) => finish(() => resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), exitCode: exitCode ?? null })));
        channel.on('error', (channelError: Error) => finish(() => reject(new ConfigBackupError('SSH_COMMAND_FAILED', { cause: channelError }))));
      });
    } catch (error) { finish(() => reject(new ConfigBackupError('SSH_COMMAND_FAILED', { cause: error }))); }
  });
}

export class ConfigBackupService {
  private readonly deviceService: ConfigBackupServiceOptions['deviceService'];
  private readonly store: ConfigBackupStore;
  private readonly transport: ConfigBackupSshTransport | ConfigBackupTransport;
  private readonly legacyMode: boolean;
  private readonly crypto: ConfigBackupCrypto;
  private readonly authorizeTarget: typeof authorizeNetworkDeviceTarget;
  private readonly clock: () => Date;
  private readonly commandTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly audit?: ConfigBackupServiceOptions['audit'];
  private readonly targetPolicy: ConfigBackupServiceOptions['targetPolicy'];
  private readonly inFlight = new Set<number>();

  constructor(options: ConfigBackupServiceOptions);
  constructor(store: ConfigBackupStore, transport: ConfigBackupTransport, crypto?: Partial<ConfigBackupCrypto>);
  constructor(
    optionsOrStore: ConfigBackupServiceOptions | ConfigBackupStore,
    legacyTransport?: ConfigBackupTransport,
    legacyCrypto: Partial<ConfigBackupCrypto> = {},
  ) {
    this.legacyMode = !('deviceService' in optionsOrStore);
    const options: ConfigBackupServiceOptions = this.legacyMode
      ? {
        deviceService: {
          getDeviceById: async (id) => (optionsOrStore as ConfigBackupStore).getTarget?.(id) ?? null,
          getCredentials: async (id) => (optionsOrStore as ConfigBackupStore).getCredentials?.(id) ?? null,
        },
        store: optionsOrStore as ConfigBackupStore,
        transport: undefined,
      }
      : optionsOrStore as ConfigBackupServiceOptions;
    this.store = options.store ?? createSqlStore();
    this.deviceService = options.deviceService;
    this.transport = this.legacyMode ? legacyTransport! : (options.transport ?? new DefaultSshTransport());
    this.crypto = {
      encrypt: legacyCrypto.encrypt ?? encryptData,
      decrypt: legacyCrypto.decrypt ?? decryptData,
    };
    this.authorizeTarget = options.authorizeTarget ?? authorizeNetworkDeviceTarget;
    this.clock = options.clock ?? (() => new Date());
    this.commandTimeoutMs = Number.isInteger(options.commandTimeoutMs) && (options.commandTimeoutMs as number) >= 1_000 ? options.commandTimeoutMs as number : 30_000;
    this.maxOutputBytes = Number.isInteger(options.maxOutputBytes) && (options.maxOutputBytes as number) > 0 && (options.maxOutputBytes as number) <= CONFIG_BACKUP_MAX_BYTES ? options.maxOutputBytes as number : CONFIG_BACKUP_MAX_BYTES;
    this.audit = options.audit ?? (this.legacyMode ? undefined : defaultConfigBackupAudit);
    this.targetPolicy = options.targetPolicy;
  }

  /** Allow route authorization failures to use the same redacted audit sink. */
  async recordAudit(event: ConfigBackupAuditEvent): Promise<void> {
    await this.audit?.(event);
  }

  /** Compatibility wrapper used by the bounded capture integration seam. */
  async capture(deviceId: number, actorId: number | null = null): Promise<any> {
    if (!this.legacyMode) {
      try {
        const result = await this.collect(deviceId, actorId);
        return { success: true, backup: { ...result.summary, preview: result.preview }, duplicate: result.deduplicated };
      } catch (error) {
        return { success: false, error: error instanceof ConfigBackupError ? error.code : 'CONFIG_BACKUP_FAILED' };
      }
    }
    const store = this.store;
    try {
      const target = normalizeBackupTarget(await store.getTarget?.(deviceId));
      if (!target) return { success: false, error: 'NETWORK_DEVICE_NOT_FOUND' };
      let authorizedTarget: AuthorizedNetworkDeviceTarget;
      try {
        authorizedTarget = await this.authorizeTarget({ host: target.host, port: target.sshPort }, {
          allowedCidrs: this.targetPolicy?.allowedCidrs,
          allowedPorts: this.targetPolicy?.allowedPorts,
          production: this.targetPolicy?.production,
        });
      } catch { return { success: false, error: 'SSH_TARGET_DENIED' }; }
      const credentials = await store.getCredentials?.(deviceId);
      if (!credentials || credentials.protocol !== 'ssh' || !credentials.credentialValue || !credentials.credentialType) {
        return { success: false, error: 'SSH_CREDENTIAL_REQUIRED' };
      }
      let fingerprint: string | undefined;
      try { fingerprint = normalizeOptionalSshHostKeyFingerprint(credentials.hostKeyFingerprint); }
      catch { return { success: false, error: 'SSH_HOST_KEY_FINGERPRINT_REQUIRED' }; }
      const request = {
        host: authorizedTarget.address, port: authorizedTarget.port, username: credentials.username,
        credentialType: credentials.credentialType, credentialValue: credentials.credentialValue,
        hostKeyFingerprint: fingerprint, commands: backupCommands(target.vendor),
        timeoutMs: this.commandTimeoutMs, maxOutputBytes: this.maxOutputBytes,
      };
      const result = await (this.transport as ConfigBackupTransport).collect(request);
      const content = result.stdout ?? '';
      if (result.truncated || Buffer.byteLength(content, 'utf8') > this.maxOutputBytes) return { success: false, error: 'CONFIG_OUTPUT_LIMIT' };
      if (!content) return { success: false, error: 'CONFIG_EMPTY' };
      const hash = createHash('sha256').update(content).digest('hex');
      const duplicate = await store.findByHash?.(deviceId, hash);
      if (duplicate) {
        const redacted = redactConfiguration(content).preview.slice(0, 64 * 1024);
        return { success: true, duplicate: true, backup: { ...duplicate, preview: redacted } };
      }
      const redacted = redactConfiguration(content);
      const versionNo = await store.nextVersion?.(deviceId) ?? 1;
      const record = {
        deviceId, versionNo, contentEncrypted: this.crypto.encrypt(content), contentSha256: hash,
        sourceProtocol: 'ssh' as const, collectedAt: this.clock().toISOString(), sizeBytes: Buffer.byteLength(content),
        redactionStatus: redacted.status, createdBy: actorId ?? null,
      };
      const saved = await store.save?.(record) ?? record;
      return { success: true, backup: { ...saved, preview: redacted.preview.slice(0, 64 * 1024) } };
    } catch (error) {
      const code = error instanceof ConfigBackupError ? error.code : (error && typeof error === 'object' && 'code' in error ? String((error as any).code) : 'CONFIG_BACKUP_FAILED');
      return { success: false, error: code };
    }
  }

  async collect(deviceId: number, actorId: number | null = null): Promise<ConfigBackupResult> {
    if (this.inFlight.has(deviceId)) throw new ConfigBackupError('SSH_COMMAND_FAILED');
    this.inFlight.add(deviceId);
    let connection: ConfigBackupConnection | null = null;
    let failureStage: ConfigBackupErrorCode = 'CONFIG_BACKUP_STORE_UNAVAILABLE';
    try {
      const device = normalizeBackupTarget(await this.deviceService.getDeviceById(deviceId));
      if (!device) throw new ConfigBackupError('NETWORK_DEVICE_NOT_FOUND');
      const commands = backupCommands(device.vendor);
      let target: AuthorizedNetworkDeviceTarget;
      try {
        target = await this.authorizeTarget({ host: device.host, port: device.sshPort }, {
          allowedCidrs: this.targetPolicy?.allowedCidrs,
          allowedPorts: this.targetPolicy?.allowedPorts,
          production: this.targetPolicy?.production,
        });
      } catch (error) { throw new ConfigBackupError('SSH_TARGET_DENIED', { cause: error }); }
      failureStage = 'SSH_CREDENTIAL_READ_FAILED';
      const credentials = await this.deviceService.getCredentials(deviceId, 'ssh');
      if (!credentials || credentials.protocol !== 'ssh' || !credentials.credentialValue || !credentials.credentialType) {
        throw new ConfigBackupError('SSH_CREDENTIAL_REQUIRED');
      }
      let fingerprint: string | undefined;
      try { fingerprint = normalizeOptionalSshHostKeyFingerprint(credentials.hostKeyFingerprint); }
      catch { throw new ConfigBackupError('SSH_HOST_KEY_FINGERPRINT_REQUIRED'); }
      failureStage = 'SSH_CONNECT_FAILED';
      connection = await (this.transport as ConfigBackupSshTransport).connect({ target, username: credentials.username, credentialType: credentials.credentialType, credentialValue: credentials.credentialValue, hostKeyFingerprint: fingerprint, readyTimeoutMs: this.commandTimeoutMs });
      failureStage = 'SSH_COMMAND_FAILED';
      const output = await this.runFixedCommands(connection, commands);
      const content = output;
      const sizeBytes = Buffer.byteLength(content, 'utf8');
      if (sizeBytes === 0) throw new ConfigBackupError('CONFIG_EMPTY');
      const digest = createHash('sha256').update(content, 'utf8').digest('hex');
      const redaction = redactConfiguration(content);
      failureStage = 'CONFIG_BACKUP_STORE_UNAVAILABLE';
      const summary = await this.store.insert!({ deviceId, contentEncrypted: this.crypto.encrypt(content), contentSha256: digest, sourceProtocol: 'ssh', collectedAt: this.clock(), sizeBytes, redactionStatus: redaction.status, createdBy: actorId });
      const result = { summary, preview: redaction.preview.slice(0, 64 * 1024), deduplicated: summary.contentSha256 === digest };
      await this.recordAudit({ action: 'collect', deviceId, backupId: summary.id, contentSha256: digest, sizeBytes, actorId });
      return result;
    } catch (error) {
      const stable = stableFailure(error, failureStage);
      const auditResult = this.recordAudit({ action: 'failed', deviceId, reason: stable.code, actorId });
      if (auditResult && typeof (auditResult as Promise<void>).catch === 'function') await (auditResult as Promise<void>).catch(() => undefined);
      throw stable;
    } finally {
      this.inFlight.delete(deviceId);
      try { await connection?.end(); } catch { /* best effort */ }
    }
  }

  async list(deviceId: number, limit = 100): Promise<ConfigBackupSummary[]> {
    if (!Number.isSafeInteger(deviceId) || deviceId < 1) throw new ConfigBackupError('NETWORK_DEVICE_NOT_FOUND');
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.store.list!(deviceId, bounded);
  }

  async get(deviceId: number, backupId: number, includeContent = false, actorId: number | null = null): Promise<(ConfigBackupSummary & { preview?: string; content?: string }) | null> {
    const backup = await this.store.find!(deviceId, backupId);
    if (!backup) return null;
    const content = this.crypto.decrypt(backup.contentEncrypted);
    const redaction = redactConfiguration(content);
    if (!includeContent) return { ...backup, preview: redaction.preview.slice(0, 64 * 1024) };
    await this.recordAudit({ action: 'read_raw', deviceId, backupId, contentSha256: backup.contentSha256, sizeBytes: backup.sizeBytes, actorId });
    return { ...backup, content };
  }

  async diff(deviceId: number, fromId: number, toId?: number): Promise<any> {
    // The legacy endpoint accepts a single backup id as the "to" side and
    // returns a stable result object. The full API supplies both ids and gets
    // a structured diff below.
    if (toId === undefined) toId = fromId;
    const [from, to] = await Promise.all([this.get(deviceId, fromId, false), this.get(deviceId, toId, false)]);
    if (!from || !to) {
      if (this.legacyMode) return { success: false, error: 'CONFIG_BACKUP_NOT_FOUND' };
      throw new ConfigBackupError('CONFIG_BACKUP_NOT_FOUND');
    }
    const left = String(from.preview ?? '');
    const right = String(to.preview ?? '');
    if (Buffer.byteLength(left, 'utf8') > CONFIG_BACKUP_DIFF_MAX_BYTES || Buffer.byteLength(right, 'utf8') > CONFIG_BACKUP_DIFF_MAX_BYTES) {
      if (this.legacyMode) return { success: false, error: 'CONFIG_BACKUP_DIFF_LIMIT' };
      throw new ConfigBackupError('CONFIG_BACKUP_DIFF_LIMIT');
    }
    const leftLines = left.split(/\r?\n/);
    const rightLines = right.split(/\r?\n/);
    const rightSet = new Set(rightLines);
    const leftSet = new Set(leftLines);
    const removed = leftLines.filter((line) => !rightSet.has(line)).map((line) => `-${line}`);
    const added = rightLines.filter((line) => !leftSet.has(line)).map((line) => `+${line}`);
    return this.legacyMode ? { success: true, fromId, toId, diff: [...removed, ...added].join('\n') } : { fromId, toId, diff: [...removed, ...added].join('\n') };
  }

  private async runFixedCommands(connection: ConfigBackupConnection, commands: readonly string[]): Promise<string> {
    let output = '';
    for (const command of commands) {
      // Commands are constants above; no request/user supplied command reaches
      // the SSH transport.
      const result = await this.withTimeout(connection.exec(command), this.commandTimeoutMs);
      if (result.exitCode != null && result.exitCode !== 0) throw new ConfigBackupError('SSH_COMMAND_FAILED');
      const chunk = result.stdout ?? '';
      output += command === commands[1] ? chunk : '';
      if (Buffer.byteLength(output, 'utf8') > this.maxOutputBytes) throw new ConfigBackupError('CONFIG_OUTPUT_LIMIT');
    }
    return output;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new ConfigBackupError('SSH_COMMAND_TIMEOUT')), timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
}

export const configBackupService = new ConfigBackupService({
  deviceService: networkDeviceDatabaseService,
});
