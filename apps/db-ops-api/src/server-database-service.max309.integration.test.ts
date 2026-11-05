import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server as TcpServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, Server, utils } from 'ssh2';
import { fingerprintSshHostKey } from './security/ssh-host-key.js';

// Transport is actual ssh2. Only storage and policy resolution are isolated:
// production denies loopback; this fixture explicitly pins it, never a remote host.
vi.mock('./db-connection', () => ({ dbConnection: {}, encryptData: vi.fn(), decryptData: vi.fn(), needsEncryptionMigration: vi.fn() }));
vi.mock('./security/server-target-policy.js', () => ({
  authorizeServerTarget: async ({ port }: { port: number }) => ({ address: '127.0.0.1', port }),
}));
import { serverDatabaseService } from './server-database-service.js';

describe('MAX-309 / #379 actual ssh2 connection completion', () => {
  const servers: TcpServer[] = [];
  const sockets = new Set<Socket>();
  const clients: Client[] = [];
  let closedClients = 0;

  afterEach(async () => {
    // Runs even on RED; no orphan clients or listening fixtures.
    for (const client of clients.splice(0)) client.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.splice(0).map(async (server) => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      expect(server.listening).toBe(false);
    }));
    expect(sockets.size).toBe(0);
    vi.restoreAllMocks();
    closedClients = 0;
  });

  async function listen(server: TcpServer) {
    servers.push(server);
    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected ephemeral TCP port');
    return address.port;
  }

  async function connect(port: number, fingerprint?: string) {
    const original = Client.prototype.connect;
    vi.spyOn(Client.prototype, 'connect').mockImplementation(function (config) {
      clients.push(this);
      this.once('close', () => closedClients++);
      return original.call(this, config);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = performance.now();
    try {
      const result = await Promise.race([
        serverDatabaseService.testConnection('max309.local.test', port, 'password', 'synthetic', 'max309', fingerprint),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('testConnection still pending')), 12000); }),
      ]);
      await expect.poll(() => closedClients, { timeout: 1000 }).toBe(1);
      await expect.poll(() => sockets.size, { timeout: 1000 }).toBe(0);
      console.info(JSON.stringify({ fixture: 'MAX-309', port, success: result.success, elapsedMs: Math.round(performance.now() - start), closedClients, openSockets: sockets.size }));
      return result;
    } finally { clearTimeout(timer); }
  }

  it.each([false, true])('completes peer close (SSH identification sent: %s)', async (banner) => {
    const port = await listen(createServer((socket) => {
      socket.resume();
      socket.end(banner ? 'SSH-2.0-fictional-fixture\r\n' : undefined);
    }));
    const result = await connect(port);
    expect(result.success).toBe(false);
    expect(result.error).toContain('握手阶段断开');
  }, 15000);

  it('times out a silent real TCP peer and releases the socket', async () => {
    const port = await listen(createServer((socket) => socket.resume()));
    const result = await connect(port);
    expect(result.success).toBe(false);
    expect(result.error).toContain('超时');
  }, 15000);

  it('keeps success after ready and subsequent end/close', async () => {
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
    const server = new Server({ hostKeys: [privateKey] }, (client) => {
      client.on('error', () => {});
      client.on('authentication', (ctx) => ctx.accept());
    });
    // Verify the actual generated host key using the existing verifier.
    const parsed = utils.parseKey(privateKey);
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid fixture key');
    const hostKey = parsed.getPublicSSH();
    const port = await listen(createServer((socket) => server.injectSocket(socket)));
    expect(await connect(port, fingerprintSshHostKey(hostKey))).toEqual({ success: true, message: `连接成功：max309.local.test:${port}` });
  }, 15000);
});
