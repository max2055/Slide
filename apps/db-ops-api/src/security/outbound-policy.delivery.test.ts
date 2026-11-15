import { promises as dns } from 'node:dns';
import { createServer } from 'node:http';
import * as https from 'node:https';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { NotificationService } from '../notification-service.js';

const endpoint = vi.hoisted(() => ({ port: 0 }));

// Exercise the real sender and policy, but route every transport attempt to a
// task-owned local HTTP endpoint. No test can contact a protected destination.
// This verifies pre-connection blocking, not production TLS compatibility.
vi.mock('node:https', async () => {
  const http = await import('node:http');
  return { request: vi.fn((options, callback) => http.request({
    ...options, protocol: 'http:', hostname: '127.0.0.1', port: endpoint.port,
    lookup: undefined, agent: false,
  }, callback)) };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('GitHub #295 blocks unsafe DNS before connection and preserves pinning/redirect gates', async () => {
  let requests = 0;
  let connections = 0;
  let redirect = false;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(redirect ? 302 : 204, redirect ? { location: 'https://127.0.0.1/' } : {});
    response.end();
  });
  server.on('connection', () => { connections++; });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  endpoint.port = (server.address() as { port: number }).port;
  vi.stubEnv('OUTBOUND_ALLOWED_HOSTS', 'example.invalid');
  let addresses = ['8.8.8.8'];
  const lookup = vi.spyOn(dns, 'lookup').mockImplementation(async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) as any);
  const channel = {
    id: 1, name: 'controlled endpoint', type: 'webhook' as const, enabled: true,
    config: { webhook_url: 'https://hooks.example.invalid/report' },
    created_at: new Date(), updated_at: new Date(),
  };
  const service = new NotificationService();
  const request = vi.mocked(https.request);
  request.mockClear();
  try {
    // Positive control proves that the endpoint observes actual connections.
    await expect(service.send(channel, { text: 'control' })).resolves.toEqual({ success: true });
    expect(requests).toBe(1);
    expect(connections).toBe(1);
    const options = request.mock.calls[0][0] as https.RequestOptions;
    expect(options).toMatchObject({ protocol: 'https:', port: 443, rejectUnauthorized: true, servername: 'hooks.example.invalid' });
    const callback = vi.fn();
    (options.lookup as Function)('hooks.example.invalid', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);

    for (const address of ['127.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'fe90::1', 'febf::1']) {
      for (const answers of [[address], ['8.8.8.8', address]]) {
        addresses = answers;
        await expect(service.send(channel, { text: 'blocked' })).resolves.toMatchObject({ success: false, error: 'PRIVATE_ADDRESS' });
      }
    }
    expect(request).toHaveBeenCalledTimes(1);
    expect(requests).toBe(1);
    expect(connections).toBe(1);

    addresses = ['8.8.8.8'];
    redirect = true;
    await expect(service.send(channel, { text: 'redirect' })).resolves.toMatchObject({ success: false, error: 'OUTBOUND_REDIRECT_DENIED' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(requests).toBe(2);
    expect(lookup).toHaveBeenCalledTimes(14);
  } finally {
    // All sends have settled before closing the task-owned endpoint.
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
