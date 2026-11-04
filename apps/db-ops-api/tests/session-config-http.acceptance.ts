/** Run from slide-api: SESSION_CONFIG_TEST_MYSQL_URL=... pnpm exec tsx tests/session-config-http.acceptance.ts
 * Uses an isolated database, full migrations, actual server.ts and TCP HTTP.
 * Only the configuration SELECT failure is injected. No JWT/authentication stubs.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import { MigrationRunner } from '../src/migrations/runner.js';

assert(process.env.SESSION_CONFIG_TEST_MYSQL_URL, 'SESSION_CONFIG_TEST_MYSQL_URL required');
const url = new URL(process.env.SESSION_CONFIG_TEST_MYSQL_URL);
const schema = `max270_${randomBytes(6).toString('hex')}`;
const admin = mysql.createPool(url.toString());
mkdirSync('.qualification', { recursive: true });
const scratch = mkdtempSync(resolve('.qualification/max270-'));
await admin.query(`CREATE DATABASE ${schema}`);
url.pathname = `/${schema}`;
const pool = mysql.createPool({ uri: url.toString(), timezone: 'Z' });
const username = 'max270_session_acceptance';
const password = randomBytes(24).toString('hex');
const configKey = 'auth.session_idle_timeout_minutes';
const fault = resolve(scratch, 'select-failure');
// The existing HTTP security hook normalizes all non-health 5xx response bodies.
const unavailable = { error: 'INTERNAL_ERROR' };
const tokenRows = async () => (await pool.query<any[]>('SELECT id, token_hash, revoked, expires_at FROM refresh_tokens ORDER BY id'))[0];
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function scenario(name: string, value: string | null, failSelect: boolean) {
  await pool.execute('DELETE FROM refresh_tokens');
  await pool.execute('DELETE FROM system_config WHERE config_key=?', [configKey]);
  // Seed a real token before enabling the failure/invalid policy. The first-deployment
  // scenario starts with no policy row and leaves it absent throughout HTTP issuance.
  if (value !== null) {
    await pool.execute("INSERT INTO system_config (config_key,config_value,value_type) VALUES (?, '5', 'number')", [configKey]);
  }
  const port = await freePort();
  const wsPort = await freePort();
  let logs = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/session-config-server.fixture.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', DB_HOST: url.hostname, DB_PORT: url.port || '3306',
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password), DB_NAME: schema,
      JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      PORT: String(port), AGENT_WS_PORT: String(wsPort), PROMPT_HOT_RELOAD: 'false',
      SESSION_CONFIG_FAULT_FILE: fault },
  });
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const exited = once(child, 'exit');
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const waitReady = async () => {
    let ready = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('server exited before readiness');
      try { ready = (await fetch(`http://127.0.0.1:${port}/api/health/ready`)).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, 'full server readiness timeout');
  };
  try {
    await waitReady();
    const seed = await post('login', { username, password });
    assert.equal(seed.status, 200);
    const before = await tokenRows();
    if (value === null) await pool.execute('DELETE FROM system_config WHERE config_key=?', [configKey]);
    else await pool.execute('UPDATE system_config SET config_value=? WHERE config_key=?', [value, configKey]);
    if (failSelect) writeFileSync(fault, 'enabled');
    const start = Date.now();
    const login = await post('login', { username, password });
    // Ensure refresh exercises its own config read, rather than a readiness failure.
    if (login.status === 503) await waitReady();
    const refresh = await post('refresh', { refreshToken: seed.body.refreshToken });
    if (failSelect || value === 'invalid-private-value') {
      assert.deepEqual(login, { status: 503, body: unavailable });
      assert.deepEqual(refresh, { status: 503, body: unavailable });
      assert.deepEqual(await tokenRows(), before, 'no issuance, revocation or rotation on failure');
      // Explicitly prove token storage is healthy while the config SELECT fails.
      await pool.execute('UPDATE refresh_tokens SET expires_at=expires_at WHERE id=?', [before[0].id]);
      const code = failSelect ? 'SESSION_CONFIG_READ_FAILED' : 'SESSION_CONFIG_INVALID';
      assert(logs.split(code).length >= 3, 'both login and refresh must reach the failed policy read');
      rmSync(fault, { force: true });
      await pool.execute('UPDATE system_config SET config_value=? WHERE config_key=?', ['5', configKey]);
      await waitReady();
      assert.equal((await post('refresh', { refreshToken: seed.body.refreshToken })).status, 200,
        'original token remains usable after config recovery');
    } else {
      assert.equal(login.status, 200);
      assert.equal(refresh.status, 200);
      const rows = await tokenRows();
      assert.equal(rows.length, 3);
      assert.equal(Number(rows[0].revoked), 1);
      for (const token of [login.body.refreshToken, refresh.body.refreshToken]) {
        const row = rows.find(row => row.token_hash === createHash('sha256').update(token).digest('hex'));
        assert(row);
        assert.equal(Number(row.revoked), 0);
        const expiry = new Date(row.expires_at).getTime();
        const ttl = (value === null ? 10080 : 5) * 60_000;
        assert(expiry >= start + ttl - 2000 && expiry <= Date.now() + ttl, 'DB expiry matches configured TTL');
      }
    }
    for (const secret of [password, seed.body.refreshToken, seed.body.token, 'MAX270_PRIVATE_DRIVER_SENTINEL', 'invalid-private-value']) {
      assert(!logs.includes(secret), 'logs must not include credentials, tokens, SQL errors or stored values');
    }
    console.log(`PASS ${name}: HTTP login/refresh ${login.status}/${refresh.status}; MySQL expiry/rotation and sanitized logs verified`);
  } finally {
    rmSync(fault, { force: true });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timeout = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 15000);
    await exited;
    clearTimeout(timeout);
    writeFileSync(resolve(scratch, `${name}.log`), logs, { mode: 0o600 });
  }
}
try {
  await new MigrationRunner(pool as any).run();
  // The isolated schema has no model credentials. Disable seeded providers so startup
  // uses its existing unconfigured-provider path; this test makes no model requests.
  await pool.execute('UPDATE llm_providers SET enabled=FALSE, is_default=FALSE');
  await pool.execute('INSERT INTO users (username,password_hash,status) VALUES (?,?,?)', [username, await bcrypt.hash(password, 10), 'active']);
  await scenario('five-minute', '5', false);
  await scenario('select-failure', '5', true);
  await scenario('invalid-value', 'invalid-private-value', false);
  await scenario('first-deployment', null, false);
  console.log('PASS isolated schema dropped; all server children stopped; no LLM calls');
} finally {
  await pool.end();
  await admin.query(`DROP DATABASE ${schema}`);
  await admin.end();
}
