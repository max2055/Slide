import { isIP } from 'node:net';
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

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fe80:') ||
    normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('ff');
}

export function isPublicIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !isPrivateIpv4(address);
  if (version === 6) return !isPrivateIpv6(address);
  return false;
}

function configuredHosts(raw = process.env.OUTBOUND_ALLOWED_HOSTS): string[] {
  return (raw ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
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
  if (addresses.some(({ address }) => !isPublicIp(address))) throw new OutboundPolicyError('PRIVATE_ADDRESS');
  return { url, addresses: addresses.map(({ address }) => address) };
}
