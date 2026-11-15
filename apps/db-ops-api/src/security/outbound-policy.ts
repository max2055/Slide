import { BlockList, isIP } from 'node:net';
import { promises as dns } from 'node:dns';

export type OutboundReasonCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_SCHEME'
  | 'PORT_DENIED'
  | 'HOST_DENIED'
  | 'DNS_FAILED'
  | 'PRIVATE_ADDRESS';

export class OutboundPolicyError extends Error {
  constructor(readonly reasonCode: OutboundReasonCode) {
    super(reasonCode);
    this.name = 'OutboundPolicyError';
  }
}

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string }>>;

export interface AuthorizedOutboundTarget {
  url: URL;
  addresses: string[];
}

const nonPublicAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8],
  ['100.64.0.0', 10], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) nonPublicAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fe80::', 10], ['fc00::', 7], ['ff00::', 8],
] as const) nonPublicAddresses.addSubnet(address, prefix, 'ipv6');

export function isPublicIp(address: string): boolean {
  const version = isIP(address);
  if (!version) return false;
  // Node parses all IPv6 spellings and applies IPv4 subnets to IPv4-mapped
  // addresses too, including hexadecimal and fully expanded representations.
  return !nonPublicAddresses.check(address, version === 4 ? 'ipv4' : 'ipv6');
}

function isFeishuMihomoFakeIp(hostname: string, address: string): boolean {
  if (hostname !== 'open.feishu.cn' || isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 198 && second === 18;
}

function configuredHosts(raw = process.env.OUTBOUND_ALLOWED_HOSTS): string[] {
  return [
    'open.feishu.cn',
    ...(raw ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
  ];
}

function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

export async function authorizeOutboundUrl(
  value: string,
  options: { allowedHosts?: readonly string[]; lookup?: DnsLookup } = {},
): Promise<URL> {
  return (await resolveOutboundTarget(value, options)).url;
}

export async function resolveOutboundTarget(
  value: string,
  options: { allowedHosts?: readonly string[]; lookup?: DnsLookup } = {},
): Promise<AuthorizedOutboundTarget> {
  let url: URL;
  try { url = new URL(value); } catch { throw new OutboundPolicyError('INVALID_URL'); }
  if (url.protocol !== 'https:') throw new OutboundPolicyError('UNSUPPORTED_SCHEME');
  if (url.port && url.port !== '443') throw new OutboundPolicyError('PORT_DENIED');
  const hostname = url.hostname.toLowerCase();
  const allowedHosts = options.allowedHosts ?? configuredHosts();
  if (!hostAllowed(hostname, allowedHosts)) throw new OutboundPolicyError('HOST_DENIED');

  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await (options.lookup ?? ((host) => dns.lookup(host, { all: true, verbatim: true })))(hostname)
      .catch(() => { throw new OutboundPolicyError('DNS_FAILED'); });
  if (addresses.length === 0) throw new OutboundPolicyError('DNS_FAILED');
  if (addresses.some(({ address }) => !isPublicIp(address) && !isFeishuMihomoFakeIp(hostname, address))) {
    throw new OutboundPolicyError('PRIVATE_ADDRESS');
  }
  return { url, addresses: addresses.map(({ address }) => address) };
}
