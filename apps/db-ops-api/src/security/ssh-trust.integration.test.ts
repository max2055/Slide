import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server, utils, type Connection } from 'ssh2';
import { SshSessionPool } from '../ssh-session-pool.js';
import { serverDatabaseService, type ServerRow } from '../server-database-service.js';
import { ServerDiagnosticService } from '../server-diagnostic-service.js';
import { LinuxHostEvidenceService } from '../linux-host-evidence-service.js';
import { ConfigBackupService, verifySshHostKey } from '../network-devices/config-backup-service.js';
import { fingerprintSshHostKey } from './ssh-host-key.js';

const host = Object.values(networkInterfaces()).flat().find(i => i?.family === 'IPv4' && !i.internal)?.address;
describe.skipIf(!host)('MAX-308 real SSH trust across production entry points', () => {
  const clients = new Set<Connection>();
  let service: Server;
  const pool = new SshSessionPool({ readyTimeoutMs: 2000 });
  afterEach(async () => {
    pool.closeAll();
    vi.unstubAllEnvs();
    for (const client of clients) client.end();
    if (service) await new Promise<void>(resolve => service.close(() => resolve()));
    clients.clear();
  });
  it('rejects unconfirmed and mismatched key hosts before authentication; preserves password behavior', async () => {
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const parsed = utils.parseKey(pem);
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('FIXTURE_KEY_INVALID');
    const pin = fingerprintSshHostKey(parsed.getPublicSSH());
    let authentications = 0;
    service = new Server({ hostKeys: [pem] }, client => {
      clients.add(client);
      client.on('error', () => {});
      client.on('close', () => clients.delete(client));
      client.on('authentication', context => {
        if (context.method === 'none') return context.reject(['publickey', 'password']);
        authentications++;
        context.accept();
      });
      client.on('session', accept => {
        accept().on('exec', (acceptExec, _reject, request) => {
          const stream = acceptExec();
          stream.write(request.command.includes('uname') ? 'Linux\n' : 'synthetic fixed-command output\n');
          stream.exit(0);
          stream.end();
        });
      });
    });
    await new Promise<void>(resolve => service.listen(0, host!, resolve));
    const port = (service.address() as { port: number }).port;
    const calls = [
      async (type: string, fingerprint?: string, mode?: string) => {
        const client = await pool.getConnection(host!, port, 'fixture', type, type === 'key' ? pem : 'synthetic-secret', fingerprint, mode);
        pool.releaseConnection(client);
      },
      async (type: string, fingerprint?: string, mode?: string) => {
        const result = await serverDatabaseService.testConnection(host!, port, type, type === 'key' ? pem : 'synthetic-secret', 'fixture', fingerprint, mode);
        if (!result.success) throw new Error('PROBE_REJECTED');
      },
      async (type: string, fingerprint?: string, mode?: string) => verifySshHostKey({ host: host!, port, username: 'fixture', credentialType: type as 'key' | 'password', credentialValue: type === 'key' ? pem : 'synthetic-secret', hostKeyFingerprint: fingerprint, sshTrustMode: mode }),
      async (type: string, fingerprint?: string, mode?: string) => {
        const service = new ServerDiagnosticService({
          serverDatabaseService: {
            getServerById: async () => ({ id: 1, host: host!, port, os_type: 'centos', credential_type: type,
              host_key_fingerprint: fingerprint, ssh_trust_mode: mode } as ServerRow),
            getDecryptedCredentials: async () => ({ username: 'fixture', password: 'synthetic-secret', privateKey: pem }),
          }, sshSessionPool: pool,
        });
        await service.collectDiagnostics(1);
      },
      async (type: string, fingerprint?: string, mode?: string) => {
        const service = new ConfigBackupService({
          deviceService: {
            getDeviceById: async () => ({ id: 1, host: host!, sshPort: port, vendor: 'huawei' }),
            getCredentials: async () => ({ protocol: 'ssh' as const, username: 'fixture', credentialType: type as 'key' | 'password',
              credentialValue: type === 'key' ? pem : 'synthetic-secret', hostKeyFingerprint: fingerprint, sshTrustMode: mode }),
          },
          store: { insert: async input => ({ ...input, id: 1, versionNo: 1, collectedAt: input.collectedAt.toISOString() }) },
          audit: () => {},
        });
        await service.collect(1);
      },
      async (type: string, fingerprint?: string, mode?: string) => {
        const service = new LinuxHostEvidenceService({
          serverDatabaseService: {
            getServerById: async () => ({ id: 1, host: host!, port, os_type: 'centos', credential_type: type,
              host_key_fingerprint: fingerprint, ssh_trust_mode: mode } as ServerRow),
            getDecryptedCredentials: async () => ({ username: 'fixture', password: 'synthetic-secret', privateKey: pem }),
          }, sshSessionPool: pool,
        });
        await service.collectHostEvidence(1, { databaseType: 'mysql', services: [], paths: [] });
      },
    ];
    for (const call of calls) {
      const before = authentications;
      await expect(call('key')).rejects.toThrow();
      await expect(call('key', '   ')).rejects.toThrow();
      await expect(call('key', '')).rejects.toThrow();
      await expect(call('key', fingerprintSshHostKey(Buffer.from('wrong')))).rejects.toThrow();
      expect(authentications).toBe(before);
      await call('key', pin);
      await call('key', undefined, 'insecure');
      await call('password');
      await call('password', '   ');
      await call('password', '');
      await call('password', pin);
      await expect(call('password', fingerprintSshHostKey(Buffer.from('wrong')))).rejects.toThrow();
    }
    expect(authentications).toBeGreaterThanOrEqual(12);
  }, 20000);
});
