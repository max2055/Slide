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

const ALWAYS_DENIED_CIDRS = [
  '0.0.0.0/8', '100.100.100.200/32', '168.63.129.16/32', '169.254.0.0/16',
  '192.0.0.192/32', '224.0.0.0/4', '240.0.0.0/4',
  '::/128', 'fe80::/10', 'ff00::/8', 'fd00:ec2::254/128',
];
const LOOPBACK_CIDRS = ['127.0.0.0/8', '::1/128'];

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
  const production = options.production ?? process.env.NODE_ENV === 'production';
  // Port and CIDR allowlists are intentionally not environment-configured.
  // Database instances may use vendor-specific or operator-defined ports; the
  // numeric range and special-address checks below remain enforced. Keep the
  // legacy options in the type for caller compatibility.

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
    if (/^::ffff:/i.test(address)) return false;
    const version = isIP(address);
    const family = version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : undefined;
    if (!family) return false;
    const isLoopback = loopback.check(address, family);
    const managedLoopback = Boolean(options.allowManagedLoopback && !production && isLoopback);
    if (isLoopback) return managedLoopback;
    return family && !denied.check(address, family);
  });
  if (authorized.length !== addresses.length) throw denyTarget('DB_TARGET_ADDRESS_DENIED');

  authorized.sort((a, b) => (isIP(a.address) === 4 ? -1 : 1) - (isIP(b.address) === 4 ? -1 : 1));
  return { hostname, address: authorized[0].address, port };
}
