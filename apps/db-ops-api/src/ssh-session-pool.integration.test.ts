import { generateKeyPairSync } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Server, utils, type Connection, type PasswordAuthContext } from 'ssh2';
import { SshSessionPool } from './ssh-session-pool.js';
import { fingerprintSshHostKey } from './security/ssh-host-key.js';

// Exercise the real target policy and SSH transport on an ephemeral local service.
// Loopback is deliberately denied by the production policy; use a local IPv4 NIC.
const address = Object.values(networkInterfaces()).flat()
  .find((item) => item?.family === 'IPv4' && !item.internal)?.address;

describe.skipIf(!address)('MAX-310 real SSH handshake capacity', () => {
  const pools: SshSessionPool[] = [];
  const services: Array<{ server: Server; clients: Set<Connection> }> = [];

  afterEach(async () => {
    for (const pool of pools.splice(0)) pool.closeAll();
    await Promise.all(services.splice(0).map(async ({ server, clients }) => {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }));
  });

  async function service() {
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      .export({ format: 'pem', type: 'pkcs1' });
    const key = utils.parseKey(privateKey);
    if (key instanceof Error || Array.isArray(key)) throw new Error('TEST_HOST_KEY_INVALID');
    const fingerprint = fingerprintSshHostKey(key.getPublicSSH());
    const clients = new Set<Connection>();
    const held: PasswordAuthContext[] = [];
    let connections = 0;
    const server = new Server({ hostKeys: [privateKey] }, (client) => {
      connections += 1;
      clients.add(client);
      client.on('error', () => undefined);
      client.on('close', () => clients.delete(client));
      client.on('authentication', (context) => {
        if (context.method !== 'password') return context.reject(['password']);
        if (context.password === 'hold') held.push(context);
        else if (context.password === 'valid') context.accept();
        else context.reject(['password']);
      });
      client.on('ready', () => client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec) => {
          const stream = acceptExec();
          stream.exit(0);
          stream.end('max310-controlled-command\n');
        });
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, address!, resolve);
    });
    services.push({ server, clients });
    const socketAddress = server.address();
    if (typeof socketAddress === 'string') throw new Error('TEST_PORT_INVALID');
    return { port: socketAddress.port, fingerprint, held, connections: () => connections };
  }

  function pool(limit = 1) {
    const instance = new SshSessionPool({ maxSessionsPerServer: limit, readyTimeoutMs: 2000 });
    pools.push(instance);
    return instance;
  }

  it('bounds 40 simultaneous real handshakes, transfers reservations, reuses and executes', async () => {
    const target = await service();
    const instance = pool(2);
    const calls = Array.from({ length: 40 }, () => instance.getConnection(
      address!, target.port, 'max310', 'password', 'hold', target.fingerprint,
    ).then((client) => ({ client }), (error: Error) => ({ error: error.message })));
    await expect.poll(() => target.held.length).toBe(2);
    expect(target.connections()).toBe(2);
    target.held.forEach((context) => context.accept());
    const results = await Promise.all(calls);
    const accepted = results.flatMap((result) => 'client' in result ? [result.client] : []);
    expect(accepted).toHaveLength(2);
    expect(results.filter((result) => 'error' in result && result.error.includes('Max SSH sessions (2) reached')))
      .toHaveLength(38);
    expect(instance.getPoolStats()).toEqual({ total: 2, active: 2, idle: 0 });
    instance.releaseConnection(accepted[0]);
    const reused = await instance.getConnection(address!, target.port, 'max310', 'password', 'hold', target.fingerprint);
    expect(reused).toBe(accepted[0]);
    expect((await instance.execCommands(reused, ['max310-test']))[0]).toMatchObject({
      stdout: 'max310-controlled-command\n', exitCode: 0,
    });
    expect(target.connections()).toBe(2);
  });

  it('releases a real failed login and revoked pending handshake without blocking another port', async () => {
    const target = await service();
    const other = await service();
    const instance = pool();
    await expect(instance.getConnection(address!, target.port, 'max310', 'password', 'invalid', target.fingerprint))
      .rejects.toThrow();
    const pending = instance.getConnection(address!, target.port, 'max310', 'password', 'hold', target.fingerprint)
      .then(() => 'unexpected success', (error: Error) => error.message);
    await expect.poll(() => target.held.length).toBe(1);
    await instance.getConnection(address!, other.port, 'max310', 'password', 'valid', other.fingerprint);
    expect(instance.revokeSessions({ host: address!, port: target.port })).toBe(1);
    expect(await pending).toBe('SSH_SESSION_REVOKED');
    await instance.getConnection(address!, target.port, 'max310', 'password', 'valid', target.fingerprint);
    expect(instance.getPoolStats()).toEqual({ total: 2, active: 2, idle: 0 });
  });
});
