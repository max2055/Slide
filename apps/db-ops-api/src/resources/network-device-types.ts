import { isIP } from 'node:net';
import { SNMP_AUTH_PROTOCOLS, SNMP_PRIVACY_PROTOCOLS } from '../network-devices/snmp-types.js';

export type NetworkDeviceVendor = 'huawei';
export type NetworkDeviceStatus = 'unknown' | 'online' | 'offline' | 'error' | 'unreachable';
export type SnmpV3SecurityLevel = 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';
export type InterfaceStatus = 'up' | 'down' | 'testing' | 'unknown';
export type NetworkDeviceCredentialProtocol = 'snmpv3' | 'ssh';

export interface SnmpV3CredentialInput {
  protocol?: 'snmpv3';
  username: string;
  securityLevel: SnmpV3SecurityLevel;
  /** Matches the algorithms exposed by the net-snmp adapter. */
  authProtocol?: 'MD5' | 'SHA';
  authSecret?: string;
  privacyProtocol?: 'DES' | 'AES';
  privacySecret?: string;
}

export interface SshCredentialInput {
  protocol?: 'ssh';
  credentialType: 'password' | 'key';
  username: string;
  credentialValue: string;
  hostKeyFingerprint: string;
}

export interface NetworkDeviceCreateInput {
  name: string;
  label?: string | null;
  host: string;
  site?: string | null;
  vendor: NetworkDeviceVendor;
  model?: string | null;
  osVersion?: string | null;
  serialNumber?: string | null;
  snmpPort?: number;
  sshPort?: number;
  collectionEnabled?: boolean;
  snmpv3: SnmpV3CredentialInput;
  ssh?: SshCredentialInput;
  createdBy?: number | null;
}

export interface NetworkDeviceUpdateInput {
  name?: string;
  label?: string | null;
  host?: string;
  site?: string | null;
  vendor?: NetworkDeviceVendor;
  model?: string | null;
  osVersion?: string | null;
  serialNumber?: string | null;
  snmpPort?: number;
  sshPort?: number;
  collectionEnabled?: boolean;
  snmpv3?: SnmpV3CredentialInput;
  ssh?: SshCredentialInput;
}

export interface NetworkDeviceRow {
  id: number;
  name: string;
  label: string | null;
  host: string;
  site: string | null;
  vendor: NetworkDeviceVendor;
  model: string | null;
  os_version: string | null;
  serial_number: string | null;
  snmp_port: number;
  ssh_port: number;
  status: NetworkDeviceStatus;
  last_check_at: Date | null;
  collection_enabled: number;
  created_at: Date;
  updated_at: Date;
}

export interface NetworkDevicePublicDto extends Omit<NetworkDeviceRow, 'collection_enabled'> {
  collection_enabled: boolean;
  hasSnmpCredential: boolean;
  hasSshCredential: boolean;
}

export interface ConfigBackupSummary {
  id: number;
  deviceId: number;
  versionNo: number;
  contentSha256: string;
  sourceProtocol: 'ssh';
  collectedAt: string;
  sizeBytes: number;
  redactionStatus: 'redacted' | 'unredacted' | 'failed';
}

const MAX_TEXT = 255;
const MAX_SECRET = 512;

function text(value: unknown, field: string, required = false): string | undefined {
  if (value == null || value === '') {
    if (required) throw new Error(`${field.toUpperCase()}_REQUIRED`);
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_TEXT) {
    throw new Error(`${field.toUpperCase()}_INVALID`);
  }
  return value.trim();
}

function nullableText(value: unknown, field: string): string | null | undefined {
  if (value === null) return null;
  return text(value, field);
}

export function validateNetworkHost(value: unknown): string {
  const host = text(value, 'host', true)!;
  const normalized = host.toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || /[\s/\\[\]():]/.test(normalized) && !isIP(normalized)) {
    throw new Error('NETWORK_DEVICE_HOST_INVALID');
  }
  if (!isIP(normalized) && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)) {
    throw new Error('NETWORK_DEVICE_HOST_INVALID');
  }
  return normalized;
}

export function validatePort(value: unknown, field: string, defaultValue: number): number {
  const port = value == null ? defaultValue : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${field.toUpperCase()}_INVALID`);
  return port;
}

export function validateSnmpV3Credential(input: unknown): SnmpV3CredentialInput {
  if (!input || typeof input !== 'object') throw new Error('SNMPV3_CREDENTIAL_REQUIRED');
  const value = input as Record<string, unknown>;
  const username = text(value.username, 'snmp_username', true)!;
  if (username.length > 64 || !/^[\x21-\x7e]+$/.test(username)) throw new Error('SNMPV3_USERNAME_INVALID');
  const securityLevel = value.securityLevel;
  if (securityLevel !== 'noAuthNoPriv' && securityLevel !== 'authNoPriv' && securityLevel !== 'authPriv') {
    throw new Error('SNMPV3_SECURITY_LEVEL_INVALID');
  }
  const authProtocol = value.authProtocol as SnmpV3CredentialInput['authProtocol'];
  const privacyProtocol = value.privacyProtocol as SnmpV3CredentialInput['privacyProtocol'];
  if (securityLevel !== 'noAuthNoPriv') {
    if (!(SNMP_AUTH_PROTOCOLS as readonly unknown[]).includes(authProtocol ?? '')) throw new Error('SNMPV3_AUTH_PROTOCOL_INVALID');
    if (typeof value.authSecret !== 'string' || value.authSecret.length < 8 || value.authSecret.length > MAX_SECRET) throw new Error('SNMPV3_AUTH_SECRET_INVALID');
  }
  if (securityLevel === 'authPriv') {
    if (!(SNMP_PRIVACY_PROTOCOLS as readonly unknown[]).includes(privacyProtocol ?? '')) throw new Error('SNMPV3_PRIVACY_PROTOCOL_INVALID');
    if (typeof value.privacySecret !== 'string' || value.privacySecret.length < 8 || value.privacySecret.length > MAX_SECRET) throw new Error('SNMPV3_PRIVACY_SECRET_INVALID');
  }
  return {
    protocol: 'snmpv3', username, securityLevel,
    authProtocol: securityLevel === 'noAuthNoPriv' ? undefined : authProtocol,
    authSecret: securityLevel === 'noAuthNoPriv' ? undefined : value.authSecret as string,
    privacyProtocol: securityLevel === 'authPriv' ? privacyProtocol : undefined,
    privacySecret: securityLevel === 'authPriv' ? value.privacySecret as string : undefined,
  };
}

export function validateSshCredential(input: unknown): SshCredentialInput {
  if (!input || typeof input !== 'object') throw new Error('SSH_CREDENTIAL_REQUIRED');
  const value = input as Record<string, unknown>;
  if (value.credentialType !== 'password' && value.credentialType !== 'key') throw new Error('SSH_CREDENTIAL_TYPE_INVALID');
  const username = text(value.username, 'ssh_username', true)!;
  if (typeof value.credentialValue !== 'string' || value.credentialValue.length === 0 || value.credentialValue.length > MAX_SECRET) throw new Error('SSH_CREDENTIAL_VALUE_INVALID');
  const fingerprint = text(value.hostKeyFingerprint, 'ssh_host_key_fingerprint', true)!;
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint.replace(/=+$/, ''))) throw new Error('SSH_HOST_KEY_FINGERPRINT_REQUIRED');
  return { protocol: 'ssh', credentialType: value.credentialType, username, credentialValue: value.credentialValue, hostKeyFingerprint: fingerprint };
}

export function parseNetworkDeviceCreateInput(input: unknown): NetworkDeviceCreateInput {
  if (!input || typeof input !== 'object') throw new Error('NETWORK_DEVICE_INPUT_INVALID');
  const value = input as Record<string, unknown>;
  const vendor = value.vendor ?? 'huawei';
  if (vendor !== 'huawei') throw new Error('NETWORK_DEVICE_VENDOR_UNSUPPORTED');
  const snmpv3 = validateSnmpV3Credential(value.snmpv3 ?? value.snmp);
  const ssh = value.ssh == null ? undefined : validateSshCredential(value.ssh);
  return {
    name: text(value.name, 'name', true)!, label: nullableText(value.label, 'label'), host: validateNetworkHost(value.host),
    site: nullableText(value.site, 'site'), vendor: 'huawei', model: nullableText(value.model, 'model'),
    osVersion: nullableText(value.osVersion ?? value.os_version, 'os_version'), serialNumber: nullableText(value.serialNumber ?? value.serial_number, 'serial_number'),
    snmpPort: validatePort(value.snmpPort ?? value.snmp_port, 'snmp_port', 161), sshPort: validatePort(value.sshPort ?? value.ssh_port, 'ssh_port', 22),
    collectionEnabled: value.collectionEnabled == null ? true : (() => {
      if (typeof value.collectionEnabled !== 'boolean') throw new Error('COLLECTION_ENABLED_INVALID');
      return value.collectionEnabled;
    })(), snmpv3, ssh,
    createdBy: value.createdBy == null ? null : Number(value.createdBy),
  };
}

export function parseNetworkDeviceUpdateInput(input: unknown): NetworkDeviceUpdateInput {
  if (!input || typeof input !== 'object') throw new Error('NETWORK_DEVICE_INPUT_INVALID');
  const value = input as Record<string, unknown>;
  const result: NetworkDeviceUpdateInput = {};
  if (value.name !== undefined) result.name = text(value.name, 'name', true)!;
  for (const [key, field] of [['label', 'label'], ['site', 'site'], ['model', 'model'], ['osVersion', 'os_version'], ['serialNumber', 'serial_number']] as const) {
    if (value[key] !== undefined || value[field] !== undefined) (result as any)[key] = nullableText(value[key] ?? value[field], field);
  }
  if (value.host !== undefined) result.host = validateNetworkHost(value.host);
  if (value.vendor !== undefined) { if (value.vendor !== 'huawei') throw new Error('NETWORK_DEVICE_VENDOR_UNSUPPORTED'); result.vendor = 'huawei'; }
  if (value.snmpPort !== undefined || value.snmp_port !== undefined) result.snmpPort = validatePort(value.snmpPort ?? value.snmp_port, 'snmp_port', 161);
  if (value.sshPort !== undefined || value.ssh_port !== undefined) result.sshPort = validatePort(value.sshPort ?? value.ssh_port, 'ssh_port', 22);
  if (value.collectionEnabled !== undefined) { if (typeof value.collectionEnabled !== 'boolean') throw new Error('COLLECTION_ENABLED_INVALID'); result.collectionEnabled = value.collectionEnabled; }
  if (value.snmpv3 !== undefined || value.snmp !== undefined) result.snmpv3 = validateSnmpV3Credential(value.snmpv3 ?? value.snmp);
  if (value.ssh !== undefined) result.ssh = validateSshCredential(value.ssh);
  return result;
}

export function validateConfigBackupSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > 2 * 1024 * 1024) throw new Error('CONFIG_BACKUP_TOO_LARGE');
}
