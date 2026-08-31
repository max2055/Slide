import * as netSnmp from 'net-snmp';

import {
  SNMP_ERROR_CODES,
  type SnmpAuthProtocol,
  type SnmpErrorCode,
  type SnmpPrivacyProtocol,
  type SnmpSecurityLevel,
  type SnmpTableRow,
  type SnmpV3Config,
  type SnmpVarbind,
} from './snmp-types.js';

export interface SnmpSession {
  get(oids: string[]): Promise<unknown>;
  table(rootOid: string, maxRepetitions: number): Promise<unknown>;
  close(): void | Promise<void>;
}

export type SnmpSessionFactory = (config: SnmpV3Config) => SnmpSession | Promise<SnmpSession>;

export interface SnmpClientOptions {
  allowedOidRoots?: string[];
  maxResponseBytes?: number;
  minSecretLength?: number;
  allowAuthNoPriv?: boolean;
  allowNoAuthNoPriv?: boolean;
  allowLegacyAlgorithms?: boolean;
}

export class SnmpClientError extends Error {
  readonly code: SnmpErrorCode;

  constructor(code: SnmpErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SnmpClientError';
    this.code = code;
  }
}

const OID_PATTERN = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/;
const DEFAULT_ROOTS = ['1.3.6.1.2.1', '1.3.6.1.4.1.2011'];
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_MIN_SECRET_LENGTH = 8;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRIES = 1;
const DEFAULT_MAX_REPETITIONS = 25;

function isOid(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && OID_PATTERN.test(value);
}

function isOidUnderRoot(oid: string, root: string): boolean {
  return oid === root || oid.startsWith(`${root}.`);
}

function mapSecurityLevel(level: SnmpSecurityLevel): netSnmp.SecurityLevel {
  switch (level) {
    case 'authPriv': return netSnmp.SecurityLevel.authPriv;
    case 'authNoPriv': return netSnmp.SecurityLevel.authNoPriv;
    case 'noAuthNoPriv': return netSnmp.SecurityLevel.noAuthNoPriv;
  }
}

function mapAuthProtocol(protocol: SnmpAuthProtocol): netSnmp.AuthProtocols {
  return protocol === 'SHA' ? netSnmp.AuthProtocols.sha : netSnmp.AuthProtocols.md5;
}

function mapPrivacyProtocol(protocol: SnmpPrivacyProtocol): netSnmp.PrivProtocols {
  return protocol === 'AES' ? netSnmp.PrivProtocols.aes : netSnmp.PrivProtocols.des;
}

function normalizeError(error: unknown): SnmpClientError {
  if (error instanceof SnmpClientError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return new SnmpClientError('SNMP_TIMEOUT', 'SNMP request timed out', { cause: error });
  }
  if (lower.includes('auth') || lower.includes('usm') || lower.includes('security')) {
    return new SnmpClientError('SNMP_AUTH_FAILED', 'SNMPv3 authentication failed', { cause: error });
  }
  return new SnmpClientError('SNMP_RESPONSE_INVALID', 'Invalid SNMP response', { cause: error });
}

function responseBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function validateVarbinds(value: unknown, maxResponseBytes: number): SnmpVarbind[] {
  if (!Array.isArray(value)) {
    throw new SnmpClientError('SNMP_RESPONSE_INVALID', 'SNMP response is not a varbind array');
  }
  if (responseBytes(value) > maxResponseBytes) {
    throw new SnmpClientError('SNMP_RESPONSE_LIMIT', 'SNMP response exceeded the configured size limit');
  }
  const varbinds: SnmpVarbind[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || !isOid((raw as any).oid) || !('value' in raw)) {
      throw new SnmpClientError('SNMP_RESPONSE_INVALID', 'SNMP response contains a malformed varbind');
    }
    varbinds.push({ oid: (raw as any).oid, type: (raw as any).type, value: (raw as any).value });
  }
  return varbinds;
}

function validateConfig(config: SnmpV3Config, options: Required<Pick<SnmpClientOptions, 'minSecretLength' | 'allowAuthNoPriv' | 'allowNoAuthNoPriv' | 'allowLegacyAlgorithms'>>): void {
  if (!config || config.version !== undefined && config.version !== 3) {
    throw new SnmpClientError('SNMP_UNSUPPORTED_SECURITY', 'Only SNMPv3 is supported');
  }
  if (typeof config.host !== 'string' || !config.host.trim() || /[\u0000-\u001f\u007f]/.test(config.host)) {
    throw new SnmpClientError('SNMP_TARGET_DENIED', 'SNMP target host is invalid');
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new SnmpClientError('SNMP_TARGET_DENIED', 'SNMP target port is invalid');
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(config.username)) {
    throw new SnmpClientError('SNMP_UNSUPPORTED_SECURITY', 'SNMPv3 username is invalid');
  }
  if (!['authPriv', 'authNoPriv', 'noAuthNoPriv'].includes(config.securityLevel)) {
    throw new SnmpClientError('SNMP_UNSUPPORTED_SECURITY', 'SNMPv3 security level is unsupported');
  }
  if (config.securityLevel === 'noAuthNoPriv' && !options.allowNoAuthNoPriv) {
    throw new SnmpClientError('SNMP_UNSUPPORTED_SECURITY', 'Unauthenticated SNMPv3 is disabled');
  }
  if (config.securityLevel === 'authNoPriv' && !options.allowAuthNoPriv) {
    throw new SnmpClientError('SNMP_UNSUPPORTED_SECURITY', 'SNMPv3 authNoPriv is disabled');
  }
  if (config.securityLevel !== 'noAuthNoPriv') {
    if (!config.authProtocol || !config.authSecret || config.authSecret.length < options.minSecretLength) {
      throw new SnmpClientError('SNMP_UNSUPPORTED_SECURITY', 'SNMPv3 authentication material is incomplete');
    }
    if (!options.allowLegacyAlgorithms && config.authProtocol !== 'SHA') {
      throw new SnmpClientError('SNMP_UNSUPPORTED_SECURITY', 'Legacy SNMP authentication is disabled');
    }
  }
  if (config.securityLevel === 'authPriv') {
    if (!config.privacyProtocol || !config.privacySecret || config.privacySecret.length < options.minSecretLength) {
      throw new SnmpClientError('SNMP_UNSUPPORTED_SECURITY', 'SNMPv3 privacy material is incomplete');
    }
    if (!options.allowLegacyAlgorithms && config.privacyProtocol !== 'AES') {
      throw new SnmpClientError('SNMP_UNSUPPORTED_SECURITY', 'Legacy SNMP privacy is disabled');
    }
  }
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 250 || config.timeoutMs > 30_000)) {
    throw new SnmpClientError('SNMP_UNSUPPORTED_SECURITY', 'SNMP timeout is outside the permitted range');
  }
  if (config.retries !== undefined && (!Number.isInteger(config.retries) || config.retries < 0 || config.retries > 3)) {
    throw new SnmpClientError('SNMP_UNSUPPORTED_SECURITY', 'SNMP retries are outside the permitted range');
  }
  if (config.maxRepetitions !== undefined && (!Number.isInteger(config.maxRepetitions) || config.maxRepetitions < 1 || config.maxRepetitions > 50)) {
    throw new SnmpClientError('SNMP_UNSUPPORTED_SECURITY', 'SNMP max repetitions are outside the permitted range');
  }
}

function validateOids(oids: string[], roots: string[]): void {
  if (!Array.isArray(oids) || oids.length === 0 || oids.length > 64 || oids.some((oid) => !isOid(oid))) {
    throw new SnmpClientError('SNMP_OID_DENIED', 'SNMP OID list is invalid');
  }
  if (oids.some((oid) => !roots.some((root) => isOidUnderRoot(oid, root)))) {
    throw new SnmpClientError('SNMP_OID_DENIED', 'SNMP OID is outside the read allowlist');
  }
}

export class SnmpClient {
  private readonly options: Required<Pick<SnmpClientOptions, 'allowedOidRoots' | 'maxResponseBytes' | 'minSecretLength' | 'allowAuthNoPriv' | 'allowNoAuthNoPriv' | 'allowLegacyAlgorithms'>>;

  constructor(
    private readonly factory: SnmpSessionFactory = createNetSnmpSessionFactory(),
    options: SnmpClientOptions = {},
  ) {
    const roots = options.allowedOidRoots ?? DEFAULT_ROOTS;
    if (roots.some((root) => !isOid(root))) {
      throw new Error('Invalid SNMP OID allowlist');
    }
    this.options = {
      allowedOidRoots: [...roots],
      maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      minSecretLength: options.minSecretLength ?? DEFAULT_MIN_SECRET_LENGTH,
      allowAuthNoPriv: options.allowAuthNoPriv ?? false,
      allowNoAuthNoPriv: options.allowNoAuthNoPriv ?? false,
      allowLegacyAlgorithms: options.allowLegacyAlgorithms ?? false,
    };
    if (!Number.isInteger(this.options.maxResponseBytes) || this.options.maxResponseBytes < 1 || this.options.maxResponseBytes > 1_048_576) {
      throw new Error('Invalid SNMP response limit');
    }
  }

  async get(config: SnmpV3Config, oids: string[]): Promise<SnmpVarbind[]> {
    validateConfig(config, this.options);
    validateOids(oids, this.options.allowedOidRoots);
    return this.withSession(config, async (active) => {
      const result = await active.get(oids);
      return validateVarbinds(result, this.options.maxResponseBytes);
    });
  }

  async table(config: SnmpV3Config, rootOid: string): Promise<SnmpTableRow[]> {
    validateConfig(config, this.options);
    validateOids([rootOid], this.options.allowedOidRoots);
    const maxRepetitions = config.maxRepetitions ?? DEFAULT_MAX_REPETITIONS;
    return this.withSession(config, async (active) => {
      const result = await active.table(rootOid, maxRepetitions);
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new SnmpClientError('SNMP_RESPONSE_INVALID', 'SNMP table response is malformed');
      }
      if (responseBytes(result) > this.options.maxResponseBytes) {
        throw new SnmpClientError('SNMP_RESPONSE_LIMIT', 'SNMP table response exceeded the configured size limit');
      }
      return Object.entries(result as Record<string, unknown>).map(([index, values]) => {
        if (!values || typeof values !== 'object' || Array.isArray(values)) {
          throw new SnmpClientError('SNMP_RESPONSE_INVALID', 'SNMP table row is malformed');
        }
        return { index, values: values as Record<string, unknown> };
      });
    });
  }

  private async withSession<T>(config: SnmpV3Config, operation: (session: SnmpSession) => Promise<T>): Promise<T> {
    let active: SnmpSession | null = null;
    try {
      active = await this.factory(config);
      if (!active || typeof active.get !== 'function' || typeof active.table !== 'function' || typeof active.close !== 'function') {
        throw new SnmpClientError('SNMP_UNAVAILABLE', 'SNMP session factory returned an invalid session');
      }
      return await operation(active);
    } catch (error) {
      throw normalizeError(error);
    } finally {
      if (active) {
        try { await active.close(); } catch { /* close is best effort after request completion */ }
      }
    }
  }
}

/** Build the production session seam around net-snmp's callback API. */
export function createNetSnmpSessionFactory(): SnmpSessionFactory {
  return (config) => {
    try {
      const user: netSnmp.User = {
        name: config.username,
        level: mapSecurityLevel(config.securityLevel),
        authProtocol: config.authProtocol ? mapAuthProtocol(config.authProtocol) : undefined,
        authKey: config.authSecret,
        privProtocol: config.privacyProtocol ? mapPrivacyProtocol(config.privacyProtocol) : undefined,
        privKey: config.privacySecret,
      };
      const raw = netSnmp.createV3Session(config.host, user, {
        version: netSnmp.Version3,
        port: config.port,
        timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        retries: config.retries ?? DEFAULT_RETRIES,
      });
      return {
        get: (oids: string[]) => new Promise((resolve, reject) => {
          raw.get(oids, (error, varbinds) => error ? reject(error) : resolve(varbinds));
        }),
        table: (rootOid: string, maxRepetitions: number) => new Promise((resolve, reject) => {
          raw.table(rootOid, maxRepetitions, (error, table) => error ? reject(error) : resolve(table));
        }),
        close: () => { raw.close(); },
      } satisfies SnmpSession;
    } catch (error) {
      throw new SnmpClientError('SNMP_UNAVAILABLE', 'Unable to create SNMPv3 session', { cause: error });
    }
  };
}

export { SNMP_ERROR_CODES };
