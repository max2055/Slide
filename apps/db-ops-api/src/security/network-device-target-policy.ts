import { promises as dns } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { securityEventService } from './security-event-service.js';

/** Stable denial reasons deliberately contain no target or credential data. */
export type NetworkDeviceTargetReason =
  | 'SNMP_TARGET_INVALID_HOST'
  | 'SNMP_TARGET_INVALID_PORT'
  | 'SNMP_TARGET_PORT_DENIED'
  | 'SNMP_TARGET_DNS_FAILED'
  | 'SNMP_TARGET_ADDRESS_DENIED'
  | 'SNMP_TARGET_POLICY_NOT_CONFIGURED';

export class NetworkDeviceTargetPolicyError extends Error {
  constructor(readonly reasonCode: NetworkDeviceTargetReason) {
    super(reasonCode);
    this.name = 'NetworkDeviceTargetPolicyError';
  }
}

export type NetworkDeviceDnsLookup = (hostname: string) => Promise<Array<{ address: string }>>;

export interface AuthorizedNetworkDeviceTarget {
  hostname: string;
  /** A resolved address is returned so transports cannot perform a second DNS lookup. */
  address: string;
  port: number;
}

const ALWAYS_DENIED_CIDRS = [
  '0.0.0.0/8',
  '100.100.100.200/32',
  '127.0.0.0/8',
  '168.63.129.16/32',
  '169.254.0.0/16',
  '192.0.0.192/32',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  'fe80::/10',
  'ff00::/8',
  'fd00:ec2::254/128',
];

function deny(reasonCode: NetworkDeviceTargetReason): NetworkDeviceTargetPolicyError {
  void securityEventService.record({ eventType: 'network_device_target_denied', reasonCode }).catch(() => undefined);
  return new NetworkDeviceTargetPolicyError(reasonCode);
}

function addCidr(list: BlockList, cidr: string): void {
  const slash = cidr.lastIndexOf('/');
  const address = slash === -1 ? cidr : cidr.slice(0, slash);
  const version = isIP(address);
  if (!version) throw deny('SNMP_TARGET_POLICY_NOT_CONFIGURED');
  const prefix = slash === -1 ? (version === 4 ? 32 : 128) : Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (version === 4 ? 32 : 128)) {
    throw deny('SNMP_TARGET_POLICY_NOT_CONFIGURED');
  }
  list.addSubnet(address, prefix, version === 4 ? 'ipv4' : 'ipv6');
}

function normalizeHost(value: unknown): string {
  const hostname = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!hostname || hostname === 'localhost' || /[\s/\\[\]\u0000-\u001f\u007f]/.test(hostname) || hostname.length > 253) {
    throw deny('SNMP_TARGET_INVALID_HOST');
  }
  // IPv6 literals may be passed without brackets at this policy boundary.
  if (hostname.includes(':') && isIP(hostname) !== 6) throw deny('SNMP_TARGET_INVALID_HOST');
  if (hostname.includes(':') === false && !/^[a-z0-9._-]+$/.test(hostname)) throw deny('SNMP_TARGET_INVALID_HOST');
  return hostname;
}

function isIpv4MappedAddress(address: string): boolean {
  if (!address.includes(':')) return false;
  const [head, tail] = address.toLowerCase().split('::');
  if (address.toLowerCase().split('::').length > 2) return false;
  const left = head ? head.split(':').filter(Boolean) : [];
  const right = tail ? tail.split(':').filter(Boolean) : [];
  const groups = [...left, ...right];
  const expanded: number[] = [];
  for (const group of groups) {
    if (group.includes('.')) {
      const octets = group.split('.').map(Number);
      if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
      expanded.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(group)) return false;
    expanded.push(Number.parseInt(group, 16));
  }
  const missing = 8 - expanded.length;
  if (missing < 0 || (address.includes('::') === false && missing !== 0)) return false;
  const normalized = address.includes('::')
    ? [...expanded.slice(0, left.length), ...Array<number>(missing).fill(0), ...expanded.slice(left.length)]
    : expanded;
  return normalized.length === 8 && normalized.slice(0, 5).every((group) => group === 0) && normalized[5] === 0xffff;
}

export async function authorizeNetworkDeviceTarget(
  input: { host: string; port: number } | null | undefined,
  options: {
    allowedCidrs?: string;
    allowedPorts?: readonly number[];
    production?: boolean;
    lookup?: NetworkDeviceDnsLookup;
  } = {},
): Promise<AuthorizedNetworkDeviceTarget> {
  const hostname = normalizeHost(input?.host);
  const port = Number(input?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw deny('SNMP_TARGET_INVALID_PORT');

  // Ports are deliberately unrestricted after numeric validation. Keep the
  // legacy allowedPorts and allowedCidrs options in the API for compatibility.

  const denied = new BlockList();
  for (const cidr of ALWAYS_DENIED_CIDRS) addCidr(denied, cidr);

  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await (options.lookup ?? ((host) => dns.lookup(host, { all: true, verbatim: true })))(hostname)
      .catch(() => { throw deny('SNMP_TARGET_DNS_FAILED'); });
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((entry) => !entry || typeof entry.address !== 'string')) {
    throw deny('SNMP_TARGET_DNS_FAILED');
  }

  const authorized = addresses.filter(({ address }) => {
    if (isIpv4MappedAddress(address)) return false;
    const version = isIP(address);
    if (!version) return false;
    const family = version === 4 ? 'ipv4' : 'ipv6';
    return !denied.check(address, family);
  });
  // Require every DNS answer to be authorized. Otherwise an attacker can add
  // a denied answer alongside an allowed one and rely on resolver ordering.
  if (authorized.length !== addresses.length) throw deny('SNMP_TARGET_ADDRESS_DENIED');
  authorized.sort((a, b) => Number(isIP(b.address) === 4) - Number(isIP(a.address) === 4));
  return { hostname, address: authorized[0].address, port };
}
