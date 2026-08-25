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
export type SnmpSecurityLevel = 'authPriv' | 'authNoPriv' | 'noAuthNoPriv';
export type SnmpAuthProtocol = 'SHA' | 'MD5';
export type SnmpPrivacyProtocol = 'AES' | 'DES';

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
