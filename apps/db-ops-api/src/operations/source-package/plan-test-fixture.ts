/** Test-only SSH endpoint + signed registration. Runs the actual operator CLI,
 * which owns the actual API child. No production target or shared DB is used. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Server, utils } from 'ssh2';
import type { Pool } from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import { syntheticPilot } from '../action-environment.fixture.js';
import { fingerprintSshHostKey } from '../../security/ssh-host-key.js';
import { encryptData } from '../../db-connection.js';
import { bytesHash, sourceDefinitions, type SourcePackage } from './config.js';

export async function planFromStandalone(pool: Pool, config: SourcePackage, directory: string) {
  const pilot = await syntheticPilot(), clients = new Set<any>(), commands: string[] = [];
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const parsed = utils.parseKey(key); if (parsed instanceof Error || Array.isArray(parsed)) throw Error('test host key');
  const hostFingerprint = fingerprintSshHostKey(parsed.getPublicSSH());
  pilot.manifest.target = { ...config.target, hostFingerprint };
  const definitions = sourceDefinitions();
  pilot.manifest.policyVersion = `${definitions.policy.policyVersion}:${definitions.policyHash}`;
  pilot.manifest.verifier = definitions.verifier;
  await pilot.save();
  const ssh = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    client.on('authentication', ctx => ctx.method === 'password' || ctx.method === 'publickey' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', accept => accept().on('exec', (acceptExec, reject, info) => {
      commands.push(info.command);
      if (!['date -u +%s%3N', 'sudo -n -- /usr/local/libexec/slide-action-demo-helper inspect'].includes(info.command)) return reject();
      const stream = acceptExec(); stream.write(info.command.startsWith('date') ? String(Date.now()) + '\n' : JSON.stringify(pilot.inspection()));
      stream.exit(0); stream.end();
    })));
  });
  let child: ReturnType<typeof spawn> | undefined, log = '';
  try {
    await new Promise<void>(done => ssh.listen(0, '127.0.0.1', done));
    const sshPort = (ssh.address() as { port: number }).port;
    const preload = resolve(directory, 'synthetic-ssh.mjs');
    await writeFile(preload, `import ssh2 from 'ssh2';
const original=ssh2.Client.prototype.connect;
ssh2.Client.prototype.connect=function(c){
 if(c.host!=='192.168.49.130'||c.port!==22)throw Error('UNEXPECTED_TEST_SSH_TARGET');
 return original.call(this,{...c,host:'127.0.0.1',port:${sshPort}});
};\n`);
    await pool.execute('UPDATE servers SET host_key_fingerprint=?,credential_encrypted=? WHERE id=3',
      [hostFingerprint, encryptData(JSON.stringify({ username: 'source-synthetic', password: 'synthetic-no-secret' }))]);
    let apiPort = 0;
    for (let i = 0; i < 20 && !apiPort; i++) {
      const candidate = 19000 + Math.floor(Math.random() * 1000), listener = createServer();
      try {
        await new Promise<void>((done, reject) => { listener.once('error', reject); listener.listen(candidate, '127.0.0.1', done); });
        await new Promise<void>(done => listener.close(() => done())); apiPort = candidate;
      } catch { /* another task owns this candidate; never stop it */ }
    }
    if (!apiPort) throw Error('test API port unavailable');
    const operationId = crypto.randomUUID(), next = { ...config, operationId, phase: 'plan', api: `http://127.0.0.1:${apiPort}`,
      target: pilot.manifest.target, deadline: new Date(Date.now() + 90_000).toISOString() };
    const file = join(directory, 'plan-config.json'), lock = join(directory, 'synthetic-lock.json'), token = join(directory, 'synthetic-jwt');
    const bytes = JSON.stringify(next), head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await writeFile(file, bytes, { mode: 0o600 });
    await writeFile(lock, JSON.stringify({ issue: 'MAX-203', head, target: '192.168.49.130:22/mysql:3308', operationId,
      configHash: bytesHash(bytes), expiresAt: next.deadline }), { mode: 0o600 });
    await writeFile(token, jwt.sign({ userId: config.actorId, sessionVersion: config.sessionVersion }, process.env.JWT_SECRET_KEY!, { expiresIn: '5m' }), { mode: 0o600 });
    const env = { ...process.env, ...Object.fromEntries(Object.entries(pilot.env).map(([k,v]) => [k,resolve(v)])),
      NODE_OPTIONS: `--import ${preload}`, V23_SOURCE_TARGET_LOCK_FILE: lock, V23_SOURCE_JWT_FILE: token,
      METRICS_COLLECTION_ENABLED: 'false', INVESTIGATION_OPS_AUTO_ENABLED: 'false',
      INVESTIGATION_SYSTEM_EVENTS_ENABLED: 'false', INVESTIGATION_SYSTEM_AUTO_ENABLED: 'false',
      OPERATIONS_ACTION_PLANS_ENABLED: 'true', OPERATIONS_ACTION_DISPATCH_ENABLED: 'false', OPERATIONS_STOP_NEW_DISPATCH: 'true',
      OPERATIONS_CONTEXT_ENABLED: 'false', OPERATIONS_CASES_ENABLED: 'false', OPERATIONS_BASELINES_ENABLED: 'false', OPERATIONS_ATTENTION_ENABLED: 'false' };
    child = spawn(process.execPath, ['--import', 'tsx', '../../scripts/qualification/v23-source-package.ts', '--config', file],
      { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', b => { log += b; }); child.stderr!.on('data', b => { log += b; });
    const timer = setTimeout(() => child?.kill('SIGTERM'), 100_000);
    const [exit] = await once(child, 'exit'); clearTimeout(timer);
    const output = join('/Users/max/Coding/40-Slide/outputs/2026-10-18-v23-source', operationId);
    const audit = await readFile(join(output, 'result.jsonl'), 'utf8');
    const apiLog = await readFile(join(output, 'api.log'), 'utf8').catch(() => '');
    await writeFile(join(directory, 'plan-cli.log'), log); await writeFile(join(directory, 'plan-api.log'), apiLog);
    await writeFile(join(directory, 'plan-audit.jsonl'), audit);
    if (exit !== 0) throw Error(`source CLI failed: ${audit}\n${log}\n${apiLog}`);
    const entries = audit.trim().split('\n').map(row => JSON.parse(row));
    return { entries, commands, apiPort, apiLog, operationId };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
    for (const client of clients) client.end();
    if (ssh.listening) await new Promise<void>(done => ssh.close(() => done()));
    await pilot.close();
  }
}
