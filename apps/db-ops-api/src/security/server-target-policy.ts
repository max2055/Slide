import { promises as dns } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { securityEventService } from './security-event-service.js';

export type ServerTargetReason =
  | 'SERVER_TARGET_INVALID_HOST'
  | 'SERVER_TARGET_INVALID_PORT'
  | 'SERVER_TARGET_PORT_DENIED'
  | 'SERVER_TARGET_DNS_FAILED'
  | 'SERVER_TARGET_ADDRESS_DENIED'
  | 'SERVER_TARGET_POLICY_NOT_CONFIGURED';

export class ServerTargetPolicyError extends Error {
  constructor(readonly reasonCode: ServerTargetReason) {
    super(reasonCode);
    this.name = 'ServerTargetPolicyError';
  }
}

export type ServerDnsLookup = (hostname: string) => Promise<Array<{ address: string }>>;

export interface AuthorizedServerTarget {
  hostname: string;
  address: string;
  port: number;
}

const NON_PRODUCTION_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
const ALWAYS_DENIED_CIDRS = [
  '0.0.0.0/8', '100.100.100.200/32', '127.0.0.0/8', '168.63.129.16/32',
  '169.254.0.0/16', '192.0.0.192/32', '224.0.0.0/4', '240.0.0.0/4',
  '::/128', '::1/128', 'fe80::/10', 'ff00::/8',
  'fd00:ec2::254/128',
];

function denyTarget(reasonCode: ServerTargetReason): ServerTargetPolicyError {
  void securityEventService.record({ eventType: 'server_target_denied', reasonCode }).catch(() => undefined);
  return new ServerTargetPolicyError(reasonCode);
}

function addCidr(list: BlockList, cidr: string): void {
  const slash = cidr.lastIndexOf('/');
  const address = slash === -1 ? cidr : cidr.slice(0, slash);
  const version = isIP(address);
  if (!version) throw denyTarget('SERVER_TARGET_POLICY_NOT_CONFIGURED');
  const prefix = slash === -1 ? (version === 4 ? 32 : 128) : Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (version === 4 ? 32 : 128)) {
    throw denyTarget('SERVER_TARGET_POLICY_NOT_CONFIGURED');
  }
  list.addSubnet(address, prefix, version === 4 ? 'ipv4' : 'ipv6');
}

function parseCidrs(raw: string | undefined, production: boolean): string[] {
  if (!raw?.trim()) {
    if (production) throw denyTarget('SERVER_TARGET_POLICY_NOT_CONFIGURED');
    return NON_PRODUCTION_CIDRS;
  }
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function parsePorts(raw: string | undefined, production: boolean): number[] {
  if (!raw?.trim()) {
    if (production) throw denyTarget('SERVER_TARGET_POLICY_NOT_CONFIGURED');
    return [22];
  }
  const ports = raw.split(',').map(Number).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  if (ports.length === 0) throw denyTarget('SERVER_TARGET_POLICY_NOT_CONFIGURED');
  return ports;
}

export async function authorizeServerTarget(
  input: { host: string; port: number },
  options: {
    allowedCidrs?: string;
    allowedPorts?: readonly number[];
    production?: boolean;
    lookup?: ServerDnsLookup;
  } = {},
): Promise<AuthorizedServerTarget> {
  const hostname = input.host?.trim().toLowerCase();
  if (!hostname || hostname === 'localhost' || /[\s/\\\[\]]/.test(hostname)) {
    throw denyTarget('SERVER_TARGET_INVALID_HOST');
  }
  const port = Number(input.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw denyTarget('SERVER_TARGET_INVALID_PORT');
  }
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const ports = options.allowedPorts ?? parsePorts(process.env.SERVER_ALLOWED_PORTS, production);
  if (production && ports.length === 0) throw denyTarget('SERVER_TARGET_POLICY_NOT_CONFIGURED');
  if (!ports.includes(port)) throw denyTarget('SERVER_TARGET_PORT_DENIED');

  const allowed = new BlockList();
  for (const cidr of parseCidrs(options.allowedCidrs ?? process.env.SERVER_ALLOWED_CIDRS, production)) addCidr(allowed, cidr);
  const denied = new BlockList();
  for (const cidr of ALWAYS_DENIED_CIDRS) addCidr(denied, cidr);

  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await (options.lookup ?? ((host) => dns.lookup(host, { all: true, verbatim: true })))(hostname)
      .catch(() => { throw denyTarget('SERVER_TARGET_DNS_FAILED'); });
  if (addresses.length === 0) throw denyTarget('SERVER_TARGET_DNS_FAILED');

  const authorized = addresses.filter(({ address }) => {
    if (/^::ffff:/i.test(address)) return false;
    const version = isIP(address);
    if (!version) return false;
    const family = version === 4 ? 'ipv4' : 'ipv6';
    return !denied.check(address, family) && allowed.check(address, family);
  });
  if (authorized.length !== addresses.length) throw denyTarget('SERVER_TARGET_ADDRESS_DENIED');

  authorized.sort((a, b) => Number(isIP(b.address) === 4) - Number(isIP(a.address) === 4));
  return { hostname, address: authorized[0].address, port };
}
