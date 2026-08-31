export const databaseScanProfiles = Object.freeze({
  common_databases: Object.freeze([1433, 1521, 27017, 3306, 5236, 5432, 6379, 9200]),
});

export type DatabaseScanProfile = keyof typeof databaseScanProfiles;
export interface DatabaseScanRequest {
  cidr: string;
  profile: string;
}
export interface AuthorizedDatabaseScanRequest {
  cidr: string;
  profile: DatabaseScanProfile;
  ports: readonly number[];
}

interface Cidr { value: number; prefix: number; start: number; end: number }

function invalid(reasonCode: string): Error {
  return new Error(reasonCode);
}

function parseIpv4(value: string): number | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return (((octets[0] * 256) + octets[1]) * 256 + octets[2]) * 256 + octets[3];
}

function parseCidr(value: unknown): Cidr {
  if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}\/(?:\d|[12]\d|3[0-2])$/.test(value)) {
    throw invalid('CIDR_INVALID');
  }
  const [address, prefixText] = value.split('/');
  const parsed = parseIpv4(address);
  const prefix = Number(prefixText);
  if (parsed === undefined) throw invalid('CIDR_INVALID');
  if (prefix < 24) throw invalid('CIDR_TOO_LARGE');
  const blockSize = 2 ** (32 - prefix);
  const start = parsed - (parsed % blockSize);
  if (start !== parsed) throw invalid('CIDR_NOT_NETWORK');
  return { value: parsed, prefix, start, end: start + blockSize - 1 };
}

function normalizeCidr(cidr: Cidr): string {
  const octets = [
    Math.floor(cidr.start / 2 ** 24) % 256,
    Math.floor(cidr.start / 2 ** 16) % 256,
    Math.floor(cidr.start / 2 ** 8) % 256,
    cidr.start % 256,
  ];
  return `${octets.join('.')}/${cidr.prefix}`;
}

export function authorizeDatabaseScanTarget(
  input: DatabaseScanRequest,
  options: { allowedCidrs?: readonly string[]; production?: boolean } = {},
): AuthorizedDatabaseScanRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('SCAN_INPUT_INVALID');
  const target = parseCidr(input.cidr);
  if (!Object.hasOwn(databaseScanProfiles, input.profile)) throw invalid('SCAN_PROFILE_INVALID');
  const profile = input.profile as DatabaseScanProfile;
  return { cidr: normalizeCidr(target), profile, ports: databaseScanProfiles[profile] };
}
