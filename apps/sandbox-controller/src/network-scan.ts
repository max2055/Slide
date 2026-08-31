import type { SandboxJob } from './sandbox-policy.js';

export const DATABASE_SCAN_PORTS = Object.freeze({
  common_databases: Object.freeze([1433, 1521, 27017, 3306, 5236, 5432, 6379, 9200]),
});

export type DatabaseScanProfile = keyof typeof DATABASE_SCAN_PORTS;
export interface DatabaseScanRequest { cidr: string; profile: string }

function parseIpv4(value: string): number | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return (((octets[0] * 256) + octets[1]) * 256 + octets[2]) * 256 + octets[3];
}

export function parseDatabaseScanRequest(value: unknown): { cidr: string; profile: DatabaseScanProfile } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SCAN_INPUT_INVALID');
  const input = value as Record<string, unknown>;
  if (typeof input.cidr !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}\/(?:\d|[12]\d|3[0-2])$/.test(input.cidr)) throw new Error('CIDR_INVALID');
  const [address, prefixText] = input.cidr.split('/');
  const ip = parseIpv4(address);
  const prefix = Number(prefixText);
  if (ip === undefined) throw new Error('CIDR_INVALID');
  if (prefix < 24) throw new Error('CIDR_TOO_LARGE');
  const blockSize = 2 ** (32 - prefix);
  if (ip - (ip % blockSize) !== ip) throw new Error('CIDR_NOT_NETWORK');
  if (typeof input.profile !== 'string' || !Object.hasOwn(DATABASE_SCAN_PORTS, input.profile)) throw new Error('SCAN_PROFILE_INVALID');
  return { cidr: input.cidr, profile: input.profile as DatabaseScanProfile };
}

export function buildDatabaseScanJob(input: DatabaseScanRequest): SandboxJob {
  const request = parseDatabaseScanRequest(input);
  return {
    runtime: 'shell',
    executionProfile: 'database-network-scan',
    networkMode: 'restricted',
    command: [
      'nmap', '-n', '-Pn', '-sT', '--open', '--max-retries', '1', '--host-timeout', '15s',
      '-p', DATABASE_SCAN_PORTS[request.profile].join(','), request.cidr, '-oG', '-',
    ],
  };
}
