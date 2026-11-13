import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { loadSecurityConfig } from '../../apps/db-ops-api/src/config/security-config.js';

const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const dmdb = require('dmdb');
const jwt = require('jsonwebtoken');
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
if (![7, 9].includes(args.length) || args[0] !== '--real' || !['--output', '--mysql-image', '--dameng-image'].every(x => args.includes(x)) || (args.length === 9 && (!args.includes('--database') || !['mysql', 'dameng'].includes(option('--database'))))) {
  console.error('Usage: --real --output <directory> --mysql-image <cached-image> --dameng-image <cached-image> [--database mysql|dameng]');
  process.exit(1);
}
const output = path.resolve(option('--output'));
if (existsSync(path.join(output, 'rotation-drill.json'))) {
  console.error('EVIDENCE_DIRECTORY_IN_USE: preserve existing checkpoints and use a new directory');
  process.exit(1);
}
if ((!args.includes('--database') || option('--database') === 'dameng') && !path.isAbsolute(process.env.MAX681_DM_INSTALL_DIR ?? '')) {
  console.error('MAX681_DM_INSTALL_DIR_REQUIRED: inject the cached image installation directory');
  process.exit(1);
}
mkdirSync(output, { recursive: true, mode: 0o700 });
// db-connection imports dotenv/config. Point that import at a task-owned empty
// file so this isolated drill cannot load a checkout's real .env as a side effect.
const emptyEnv = path.join(output, `isolated-empty-${randomBytes(6).toString('hex')}.env`);
writeFileSync(emptyEnv, '', { mode: 0o600, flag: 'wx' });
const previousEnvPath = process.env.DOTENV_CONFIG_PATH;
const previousVaultKey = process.env.DOTENV_KEY;
process.env.DOTENV_CONFIG_PATH = emptyEnv;
delete process.env.DOTENV_KEY;
const { encryptData, decryptData } = await import('../../apps/db-ops-api/src/db-connection.js');
if (previousEnvPath === undefined) delete process.env.DOTENV_CONFIG_PATH;
else process.env.DOTENV_CONFIG_PATH = previousEnvPath;
if (previousVaultKey !== undefined) process.env.DOTENV_KEY = previousVaultKey;
const report: any = { version: 1, head: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), diffHash: createHash('sha256').update(spawnSync('git', ['diff'], { encoding: 'utf8' }).stdout).digest('hex'), scope: 'isolated containers; no shared credentials or manifest read', databases: {}, checkpoints: [], cleanup: {} };
const password = () => `Aa1_${randomBytes(16).toString('hex')}`;
const run = randomBytes(6).toString('hex');
const record = () => {
  const temporary = path.join(output, `rotation-drill.${run}.tmp`);
  writeFileSync(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
  renameSync(temporary, path.join(output, 'rotation-drill.json'));
};
const owned: string[] = [];
function docker(command: string[], extraEnv = {}) {
  const result = spawnSync('docker', command, { encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...extraEnv }, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error('DOCKER_OPERATION_FAILED');
  return result.stdout.trim();
}
function check(value: unknown) { if (!value) throw new Error('DRILL_ASSERTION_FAILED'); }
async function rejectsAuthentication(connect: () => Promise<any>) {
  let client;
  try { client = await connect(); return false; }
  catch (error: any) { return error.code === 'ER_ACCESS_DENIED_ERROR' || error.errno === 1045 || error.errCode === -2501 || error.errorNum === -2501 || error.code === -2501; }
  finally { if (client) await client.close(); }
}

try {
  const key = randomBytes(32).toString('hex');
  const oldKey = password();
  const newKey = password();
  const config = loadSecurityConfig({ NODE_ENV: 'production', JWT_SECRET_KEY: newKey, ENCRYPTION_KEY: key, INITIAL_ADMIN_USERNAME: 'isolated-fixture', INITIAL_ADMIN_PASSWORD: password() });
  check(config.jwtSecret === newKey);
  const oldToken = jwt.sign({ sub: 'isolated-fixture', role: 'operator' }, oldKey, { algorithm: 'HS256', expiresIn: '5m' });
  const newToken = jwt.sign({ sub: 'isolated-fixture', role: 'operator' }, newKey, { algorithm: 'HS256', expiresIn: '5m' });
  let rejected = false;
  try { jwt.verify(oldToken, newKey, { algorithms: ['HS256'] }); } catch { rejected = true; }
  check(rejected && jwt.verify(newToken, newKey, { algorithms: ['HS256'] }).role === 'operator');
  report.jwt = { productionConfiguration: 'passed', oldSignatureRejected: true, newSignatureAccepted: true, limitation: 'sign/verify primitives; actual login, RBAC and WebSocket sessions not exercised' };
  record();

  for (const kind of ['mysql', 'dameng']) {
    if (args.includes('--database') && option('--database') !== kind) continue;
    let stage = 'container-create';
    const result: any = { checkpoints: [] };
    report.databases[kind] = result;
    const rootPassword = password();
    const oldPassword = password();
    const newPassword = password();
    const recoveryPassword = password();
    let root: any;
    let prior: any;
    const opened: any[] = [];
    try {
      let cid;
      if (kind === 'mysql') {
        cid = docker(['create', '--pull=never', '--label', `slide.max681.run=${run}`, '--name', `slide-max681-mysql-${run}`, '--publish', '127.0.0.1::3306', '--env', 'MYSQL_ROOT_PASSWORD', '--env', 'MYSQL_ROOT_HOST=%', '--entrypoint', '/usr/local/bin/docker-entrypoint.sh', option('--mysql-image'), 'mysqld'], { MYSQL_ROOT_PASSWORD: rootPassword });
      } else {
        const dmInstall = process.env.MAX681_DM_INSTALL_DIR;
        check(dmInstall && path.isAbsolute(dmInstall));
        const init = path.join(output, 'dm-init.sh');
        writeFileSync(init, `#!/bin/bash\nset -euo pipefail\nmkdir -p /var/lib/max681-dm\nchown dmdba /var/lib/max681-dm\ngosu dmdba env LD_LIBRARY_PATH=$MAX681_DM_INSTALL_DIR/bin $MAX681_DM_INSTALL_DIR/bin/dminit PATH=/var/lib/max681-dm PAGE_SIZE=16 CHARSET=1 SYSDBA_PWD="$MAX681_DM_ROOT_PASSWORD" SYSAUDITOR_PWD="$MAX681_DM_AUDITOR_PASSWORD" >/dev/null\nexec gosu dmdba env LD_LIBRARY_PATH=$MAX681_DM_INSTALL_DIR/bin $MAX681_DM_INSTALL_DIR/bin/dmserver /var/lib/max681-dm/DAMENG/dm.ini\n`, { mode: 0o600 });
        cid = docker(['create', '--pull=never', '--label', `slide.max681.run=${run}`, '--name', `slide-max681-dameng-${run}`, '--publish', '127.0.0.1::5236', '--env', 'MAX681_DM_ROOT_PASSWORD', '--env', 'MAX681_DM_AUDITOR_PASSWORD', '--env', 'MAX681_DM_INSTALL_DIR', '--mount', `type=bind,src=${init},dst=/max681-init.sh,readonly`, '--entrypoint', '/bin/bash', option('--dameng-image'), '/max681-init.sh'], { MAX681_DM_ROOT_PASSWORD: rootPassword, MAX681_DM_AUDITOR_PASSWORD: password(), MAX681_DM_INSTALL_DIR: dmInstall });
      }
      owned.push(cid);
      result.containerId = cid; record();
      docker(['start', cid]);
      const inspect = JSON.parse(docker(['inspect', cid]))[0];
      check(inspect.Config.Labels['slide.max681.run'] === run);
      const port = Number(inspect.NetworkSettings.Ports[kind === 'mysql' ? '3306/tcp' : '5236/tcp'][0].HostPort);
      async function connect(user: string, secret: string) {
        const raw = kind === 'mysql'
          ? await mysql.createConnection({ host: '127.0.0.1', port, user, password: secret, connectTimeout: 2000 })
          : await dmdb.getConnection({ user, password: secret, connectString: `127.0.0.1:${port}`, connectTimeout: 2000, socketTimeout: 3000, loginEncrypt: false });
        let closed = false;
        const client = { query: (sql: string) => kind === 'mysql' ? raw.query({ sql, timeout: 5000 }) : raw.execute(sql), close: async () => { if (!closed) { closed = true; await (kind === 'mysql' ? raw.end() : raw.close()); } } };
        opened.push(client);
        return client;
      }
      stage = 'readiness';
      const until = Date.now() + 120_000;
      while (Date.now() < until) {
        try { root = await connect(kind === 'mysql' ? 'root' : 'SYSDBA', rootPassword); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
      }
      check(root);
      result.checkpoints.push('isolated-root-authenticated'); record();
      const account = kind === 'mysql' ? "'MAX681_ROTATE'@'%'" : 'MAX681_ROTATE';
      const table = kind === 'mysql' ? 'max681_probe.probe' : 'SYSDBA.MAX681_PROBE';
      const encrypted = encryptData('isolated-credential-fixture', key);
      stage = 'fixture-create';
      if (kind === 'mysql') await root.query('CREATE DATABASE max681_probe');
      await root.query(`CREATE TABLE ${table} (payload VARCHAR(2000))`);
      await root.query(`INSERT INTO ${table} (payload) VALUES ('${encrypted}')`);
      const quote = kind === 'mysql' ? String.fromCharCode(39) : String.fromCharCode(34);
      await root.query(`CREATE USER ${account} IDENTIFIED BY ${quote}${oldPassword}${quote}`);
      await root.query(`GRANT SELECT ON ${table} TO ${account}`);
      prior = await connect('MAX681_ROTATE', oldPassword);
      await prior.query(`SELECT payload FROM ${table}`);
      result.checkpoints.push('old-consumer-authenticated'); record();
      stage = 'account-rotation';
      await root.query(`ALTER USER ${account} IDENTIFIED BY ${quote}${newPassword}${quote}`);
      result.checkpoints.push('alter-user-acknowledged'); record();
      check(await rejectsAuthentication(() => connect('MAX681_ROTATE', oldPassword)));
      const fresh = await connect('MAX681_ROTATE', newPassword);
      await fresh.query(`SELECT payload FROM ${table}`);
      let surviving = false;
      try { await prior.query(`SELECT payload FROM ${table}`); surviving = true; } catch { /* Record whether native sessions survive. */ }
      result.existingSessionSurvives = surviving;
      result.checkpoints.push('old-fresh-login-rejected-new-login-and-grant-passed'); record();
      stage = 'forward-recovery';
      // Model interruption after the DB acknowledgement but before a consumer
      // config update. Recover using the acknowledged new value, never old DDL.
      await fresh.close();
      await root.query(`ALTER USER ${account} IDENTIFIED BY ${quote}${recoveryPassword}${quote}`);
      check(await rejectsAuthentication(() => connect('MAX681_ROTATE', newPassword)));
      const repaired = await connect('MAX681_ROTATE', recoveryPassword);
      const rows = await repaired.query(`SELECT payload FROM ${table}`);
      const ciphertext = kind === 'mysql' ? rows[0][0].payload : rows.rows[0][0];
      check(ciphertext === encrypted && decryptData(ciphertext, key) === 'isolated-credential-fixture');
      result.checkpoints.push('forward-recovery-and-ciphertext-preservation-passed');
      result.status = 'passed'; record();
    } catch {
      result.status = 'failed'; result.failedStage = stage; process.exitCode = 1; record();
    } finally {
      for (const client of opened) { try { await client.close(); } catch { result.connectionCleanupFailed = true; process.exitCode = 1; } }
    }
  }
} catch {
  report.failure = 'ISOLATED_DRILL_FAILED'; process.exitCode = 1;
} finally {
  for (const cid of owned.reverse()) {
    try {
      const inspect = JSON.parse(docker(['inspect', cid]))[0];
      check(inspect.Id === cid && inspect.Config.Labels['slide.max681.run'] === run);
      docker(['rm', '--force', '--volumes', cid]);
      report.cleanup[cid] = 'removed-owned-container-and-anonymous-volumes';
    } catch { report.cleanup[cid] = 'failed'; process.exitCode = 1; }
  }
  record();
  console.log(JSON.stringify({ jwt: report.jwt, databases: Object.fromEntries(Object.entries(report.databases).map(([k, v]: [string, any]) => [k, { status: v.status, failedStage: v.failedStage }])), cleanup: Object.values(report.cleanup) }));
}
