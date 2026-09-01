export const SNMP_ERROR_CODES = [
  'SNMP_TIMEOUT',
  'SNMP_AUTH_FAILED',
  'SNMP_UNSUPPORTED_SECURITY',
  'SNMP_RESPONSE_INVALID',
  'SNMP_RESPONSE_LIMIT',
  'SNMP_TARGET_DENIED',
  'SNMP_OID_DENIED',
  'SNMP_UNAVAILABLE',
] as const;

export type SnmpErrorCode = typeof SNMP_ERROR_CODES[number];
export type SnmpVersion = 2 | 3;
export type SnmpSecurityLevel = 'authPriv' | 'authNoPriv' | 'noAuthNoPriv';
/** Algorithms supported by the current net-snmp adapter. */
export const SNMP_AUTH_PROTOCOLS = ['SHA', 'MD5'] as const;
export const SNMP_PRIVACY_PROTOCOLS = ['AES', 'DES'] as const;
export type SnmpAuthProtocol = typeof SNMP_AUTH_PROTOCOLS[number];
export type SnmpPrivacyProtocol = typeof SNMP_PRIVACY_PROTOCOLS[number];

export interface SnmpV3Config {
  host: string;
  port: number;
  username: string;
  securityLevel: SnmpSecurityLevel;
  authProtocol?: SnmpAuthProtocol;
  authSecret?: string;
  privacyProtocol?: SnmpPrivacyProtocol;
  privacySecret?: string;
  timeoutMs?: number;
  retries?: number;
  maxRepetitions?: number;
  /** Kept for defensive validation when a caller forwards an untyped payload. */
  version?: 3;
}

export interface SnmpV2Config {
  version: 2;
  host: string;
  port: number;
  community: string;
  timeoutMs?: number;
  retries?: number;
  maxRepetitions?: number;
}

export type SnmpConfig = SnmpV2Config | SnmpV3Config;

export interface SnmpVarbind {
  oid: string;
  type?: string | number;
  value: unknown;
}

export interface SnmpTableRow {
  index: string;
  values: Record<string, unknown>;
}

export interface SnmpProbeResult {
  reachable: boolean;
  securityLevel: SnmpSecurityLevel;
  observedAt: Date;
  errorCode?: SnmpErrorCode;
}
