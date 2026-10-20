/** Synthetic signing/identity and socket routing; real SSH2, production adapter,
 * and source helper disk/lock protocol. No VM/systemd or external target. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { Server, Client, utils } = createRequire(import.meta.url)('ssh2') as typeof import('ssh2');
import { operationsContentHash } from '../contracts.js';
import { RestartDemoServiceAdapter, type DemoTargetRegistration } from './adapters/restart-demo-service.js';

export async function startHelperSshFixture(serverId: number) {
  const host = utils.generateKeyPairSync('ed25519'), login = utils.generateKeyPairSync('ed25519');
  const parsed = utils.parseKey(host.private);
  if (parsed instanceof Error) throw parsed;
  const signing = generateKeyPairSync('ed25519');
  const target: DemoTargetRegistration = { protocol: 1, serverId, host: '192.168.49.130', port: 22, username: 'slide-action',
    unit: 'slide-action-demo.service', helper: '/usr/local/libexec/slide-action-demo-helper', helperHash: 'a'.repeat(64),
    unitHash: 'e'.repeat(64), hostFingerprint: 'SHA256:' + createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, ''), toolVersion: '1', eligible: true };
  const configHash = operationsContentHash(target), commands: string[] = [];
  const directories: string[] = [];
  let directory = await mkdtemp(join(tmpdir(), 'max204-helper-')); directories.push(directory);
  let loseReceipt = false;
  const helper = new URL('../../../../../scripts/qualification/action-demo-helper-fixture.py', import.meta.url).pathname;
  const connections = new Set<any>();
  const server = new Server({ hostKeys: [host.private] }, connection => {
    connections.add(connection); connection.once('close', () => connections.delete(connection)); connection.on('error', () => {});
    connection.on('authentication', ctx => {
      const key = utils.parseKey(login.private);
      if (key instanceof Error || ctx.method !== 'publickey' || ctx.username !== 'slide-action'
        || !ctx.key.data.equals(key.getPublicSSH()) || (ctx.signature && !key.verify(ctx.blob!, ctx.signature, ctx.hashAlgo))) ctx.reject();
      else ctx.accept();
    });
    connection.on('ready', () => connection.on('session', accept => {
      const session = accept();
      session.on('exec', (accept, reject, info) => {
        const prefix = 'sudo -n -- /usr/local/libexec/slide-action-demo-helper ';
        if (!info.command.startsWith(prefix)) { reject(); return; }
        const args = info.command.slice(prefix.length).split(' '), mode = args[0];
        if (!(mode === 'inspect' && args.length === 1) && !( ['execute', 'receipt'].includes(mode) && args.length === 5
          && /^[a-f0-9-]{36}$/.test(args[1]) && args.slice(2).every(v => /^[a-f0-9]{64}$/.test(v)))) { reject(); return; }
        commands.push(info.command);
        const channel = accept();
        const child = spawn('python3', ['-I', helper, 'child', directory, mode, args[1] ?? 'unused', args[2] ?? 'b'.repeat(64), configHash, target.helperHash, String(serverId)], { stdio: ['ignore', 'pipe', 'pipe'] });
        const drop = mode === 'execute' && loseReceipt;
        child.stdout.on('data', chunk => { if (!drop) channel.write(chunk); });
        child.stderr.on('data', chunk => { if (!drop) channel.stderr.write(chunk); });
        child.on('error', () => { channel.exit(1); channel.end(); });
        child.on('close', code => { if (drop) { connection.end(); return; } channel.exit(code ?? 1); channel.end(); });
      });
    }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const localPort = (server.address() as { port: number }).port;
  const adapter = new RestartDemoServiceAdapter(target, sign(null, Buffer.from(configHash), signing.privateKey), signing.publicKey,
    async () => ({ privateKey: login.private }), () => {
      const client = new Client(), connect = client.connect.bind(client);
      // Explicit test-only socket mapping; keep production account/key verification.
      client.connect = config => connect({ ...config, host: '127.0.0.1', port: localPort }); return client as never;
    });
  return { target, configHash, adapter, commands,
    loseReceipt: (value: boolean) => { loseReceipt = value; },
    reset: async () => { directory = await mkdtemp(join(tmpdir(), 'max204-helper-')); directories.push(directory); },
    restartCount: async () => Number(await readFile(join(directory, 'actual-restarts'), 'utf8').catch(() => '0')),
    close: async () => { for (const connection of connections) connection.end(); await new Promise<void>(r => server.close(() => r()));
      for (const path of directories) await rm(path, { recursive: true, force: true }); },
  };
}
