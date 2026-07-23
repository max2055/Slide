import { promises as dns } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { securityEventService } from './security-event-service.js';

export type DatabaseTargetReason =
  | 'DB_TARGET_INVALID_HOST'
  | 'DB_TARGET_INVALID_PORT'
  | 'DB_TARGET_PORT_DENIED'
  | 'DB_TARGET_DNS_FAILED'
  | 'DB_TARGET_ADDRESS_DENIED'
  | 'DB_TARGET_POLICY_NOT_CONFIGURED';

export class DatabaseTargetPolicyError extends Error {
  constructor(readonly reasonCode: DatabaseTargetReason) {
    super(reasonCode);
    this.name = 'DatabaseTargetPolicyError';
  }
}

export type DatabaseDnsLookup = (hostname: string) => Promise<Array<{ address: string }>>;

export interface AuthorizedDatabaseTarget {
  hostname: string;
  address: string;
  port: number;
}

function denyTarget(reasonCode: DatabaseTargetReason): DatabaseTargetPolicyError {
  void securityEventService.record({ eventType: 'database_target_denied', reasonCode }).catch(() => undefined);
  return new DatabaseTargetPolicyError(reasonCode);
}

const DEFAULT_PORTS: Record<string, readonly number[]> = {
  mysql: [3306],
  postgresql: [5432],
  oracle: [1521],
  dameng: [5236],
};

const NON_PRODUCTION_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
const ALWAYS_DENIED_CIDRS = [
  '0.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '240.0.0.0/4',
  '::/128', 'fe80::/10', 'ff00::/8',
];
const LOOPBACK_CIDRS = ['127.0.0.0/8', '::1/128'];

function parseCidrs(raw: string | undefined, production: boolean): string[] {
  if (!raw?.trim()) {
    if (production) throw denyTarget('DB_TARGET_POLICY_NOT_CONFIGURED');
    return NON_PRODUCTION_CIDRS;
  }
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function addCidr(list: BlockList, cidr: string): void {
  const slash = cidr.lastIndexOf('/');
  const address = slash === -1 ? cidr : cidr.slice(0, slash);
  const version = isIP(address);
  if (!version) throw denyTarget('DB_TARGET_POLICY_NOT_CONFIGURED');
  const prefix = slash === -1 ? (version === 4 ? 32 : 128) : Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (version === 4 ? 32 : 128)) {
    throw denyTarget('DB_TARGET_POLICY_NOT_CONFIGURED');
  }
  list.addSubnet(address, prefix, version === 4 ? 'ipv4' : 'ipv6');
}

function allowedPorts(dbType: string, raw = process.env.DB_ALLOWED_PORTS): readonly number[] {
  if (!raw?.trim()) return DEFAULT_PORTS[dbType] ?? [];
  const configured = raw.split(',').map(Number).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  return configured.length > 0 ? configured : DEFAULT_PORTS[dbType] ?? [];
}

export async function authorizeDatabaseTarget(
  input: { host: string; port: number; dbType: string },
  options: {
    allowedCidrs?: string;
    allowedPorts?: readonly number[];
    production?: boolean;
    allowManagedLoopback?: boolean;
    allowManagedPort?: boolean;
    lookup?: DatabaseDnsLookup;
  } = {},
): Promise<AuthorizedDatabaseTarget> {
  const hostname = input.host?.trim().toLowerCase();
  if (!hostname || (hostname === 'localhost' && !options.allowManagedLoopback) || /[\s/\\\[\]]/.test(hostname)) {
    throw denyTarget('DB_TARGET_INVALID_HOST');
  }
  const port = Number(input.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw denyTarget('DB_TARGET_INVALID_PORT');
  }
  const ports = options.allowedPorts ?? allowedPorts(input.dbType);
  const production = options.production ?? process.env.NODE_ENV === 'production';
  if (!ports.includes(port) && !(options.allowManagedPort && !production)) {
    throw denyTarget('DB_TARGET_PORT_DENIED');
  }

  const allowed = new BlockList();
  for (const cidr of parseCidrs(options.allowedCidrs ?? process.env.DB_ALLOWED_CIDRS, production)) addCidr(allowed, cidr);
  const denied = new BlockList();
  for (const cidr of ALWAYS_DENIED_CIDRS) addCidr(denied, cidr);
  const loopback = new BlockList();
  for (const cidr of LOOPBACK_CIDRS) addCidr(loopback, cidr);

  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await (options.lookup ?? ((host) => dns.lookup(host, { all: true, verbatim: true })))(hostname)
      .catch(() => { throw denyTarget('DB_TARGET_DNS_FAILED'); });
  if (addresses.length === 0) throw denyTarget('DB_TARGET_DNS_FAILED');

  const authorized = addresses.filter(({ address }) => {
    const version = isIP(address);
    const family = version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : undefined;
    if (!family) return false;
    const isLoopback = loopback.check(address, family);
    const managedLoopback = Boolean(options.allowManagedLoopback && !production && isLoopback);
    if (isLoopback) return managedLoopback;
    return family && !denied.check(address, family) && (managedLoopback || allowed.check(address, family));
  });
  if (authorized.length !== addresses.length) throw denyTarget('DB_TARGET_ADDRESS_DENIED');

  authorized.sort((a, b) => (isIP(a.address) === 4 ? -1 : 1) - (isIP(b.address) === 4 ? -1 : 1));
  return { hostname, address: authorized[0].address, port };
}
