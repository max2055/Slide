import { BlockList, isIP } from 'node:net';

export function resolveApiProxyTrust(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.API_TRUSTED_PROXY_IPS?.trim();
  if (!configured) return false as const;

  // Each position grants trust to one proxy, starting at the API's TCP peer.
  const proxies = configured.split(',').map((entry) => {
    const address = entry.trim();
    const family = isIP(address);
    if (!family || address.includes('%')) {
      throw new Error('API_TRUSTED_PROXY_IPS must contain individual IPv4 or IPv6 proxy addresses');
    }
    const proxy = new BlockList();
    proxy.addAddress(address, family === 4 ? 'ipv4' : 'ipv6');
    if (proxy.check('0.0.0.0') || proxy.check('::', 'ipv6')) {
      throw new Error('API_TRUSTED_PROXY_IPS must not contain unspecified addresses');
    }
    return proxy;
  });

  return (address: string, hop: number): boolean => {
    const family = isIP(address);
    return family !== 0 && (proxies[hop]?.check(address, family === 4 ? 'ipv4' : 'ipv6') ?? false);
  };
}
