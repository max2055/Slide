import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import { MySqlNonceStore } from './nonce-store.js';
import { signRequest } from './request-auth.js';

// Explicit opt-in: creates/removes only its uniquely named disposable MySQL container.
describe.skipIf(process.env.SANDBOX_MYSQL_INTEGRATION !== '1')('shared nonce real controllers', () => {
  const container = `slide-nonce-test-${randomUUID()}`;
  const password = randomUUID();
  const secret = 'integration-only-secret-'.repeat(3);
  const children: ChildProcess[] = [];
  let directory: string, pool: Pool, store: MySqlNonceStore, dbPort: number;
  let first: { child: ChildProcess; url: string }, second: { child: ChildProcess; url: string };
  let created = false;
  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  async function waitFor(check: () => Promise<unknown>) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      try { await check(); return; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    throw new Error('test readiness timeout');
  }
  async function availablePort() {
    const socket = net.createServer().listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = (socket.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => socket.close(() => resolve()));
    return port;
  }
  async function startController() {
    const port = await availablePort();
    const workspace = path.join(directory, `workspace-${port}`);
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, SANDBOX_CONTROLLER_SECRET: secret,
        SANDBOX_CONTROLLER_PORT: String(port), SANDBOX_WORKSPACE_ROOT: workspace,
        SANDBOX_IMAGES: JSON.stringify({ node: `node@sha256:${'a'.repeat(64)}` }),
        SANDBOX_EXECUTION_PROFILES: '{}', SANDBOX_RESTRICTED_NETWORK: '',
        SANDBOX_NONCE_DB_HOST: '127.0.0.1', SANDBOX_NONCE_DB_PORT: String(dbPort),
        SANDBOX_NONCE_DB_NAME: 'nonce_test', SANDBOX_NONCE_DB_USER: 'root', SANDBOX_NONCE_DB_PASSWORD: password },
    });
    children.push(child);
    let logs = '';
    child.stdout?.on('data', data => { logs += data; });
    child.stderr?.on('data', data => { logs += data; });
    const url = `http://127.0.0.1:${port}`;
    try { await waitFor(async () => { if (!(await fetch(`${url}/health`)).ok) throw new Error(); }); }
    catch { throw new Error(`controller failed: ${logs}`); }
    return { child, url };
  }
  async function stop(child: ChildProcess) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  }
  function signed(body = Buffer.from('{"runtime":"node","command":["node","-e","console.log(1)"]}'), offset = 0) {
    const timestamp = String(Date.now() + offset), nonce = randomUUID();
    return { body, headers: { 'x-slide-timestamp': timestamp, 'x-slide-nonce': nonce,
      'x-slide-signature': signRequest(secret, timestamp, nonce, body) } };
  }
  async function post(url: string, request = signed(), route = '/v1/jobs') {
    return (await fetch(url + route, { method: 'POST', ...request, signal: AbortSignal.timeout(10000) })).status;
  }
  async function executions() { return (await readFile(path.join(directory, 'executions'), 'utf8')).trim().split('\n').filter(Boolean).length; }

  beforeAll(async () => {
    directory = await realpath(await mkdtemp(path.join(tmpdir(), 'slide-nonce-')));
    await writeFile(path.join(directory, 'executions'), '');
    await writeFile(path.join(directory, 'docker'), `#!/bin/sh\nif [ "$1" = run ]; then\n  echo run >> '${directory}/executions'\n  echo harmless\nfi\n`, { mode: 0o755 });
    dbPort = await availablePort();
    docker('run', '-d', '--name', container, '-e', `MYSQL_ROOT_PASSWORD=${password}`, '-e', 'MYSQL_DATABASE=nonce_test', '-p', `127.0.0.1:${dbPort}:3306`, 'mysql:8.4');
    created = true;
    dbPort = Number(docker('port', container, '3306/tcp').split(':').pop());
    pool = createPool({ host: '127.0.0.1', port: dbPort, user: 'root', password, database: 'nonce_test', connectTimeout: 1000 });
    store = new MySqlNonceStore(pool);
    await waitFor(async () => { await pool.query('SELECT 1'); });
    await pool.query(await readFile('../db-ops-api/sql/migrations/096_sandbox_request_nonces.sql', 'utf8'));
    first = await startController(); second = await startController();
  }, 90000);
  afterAll(async () => {
    await Promise.all(children.map(stop));
    if (pool) await pool.end();
    if (created) docker('rm', '-f', '-v', container);
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 90000);

  it('executes once under concurrent replicas, sequential replay and process restart', async () => {
    const request = signed(), before = await executions();
    expect((await Promise.all([post(first.url, request), post(second.url, request)])).sort()).toEqual([200, 401]);
    expect(await post(second.url, request)).toBe(401);
    await stop(first.child); first = await startController();
    expect(await post(first.url, request)).toBe(401);
    expect(await executions()).toBe(before + 1);
    expect(await post(first.url)).toBe(200);
  }, 30000);
  it('rejects stale/tampered requests and shares status/network-scan authentication', async () => {
    expect(await post(first.url, signed(undefined, -31000))).toBe(401);
    const tampered = signed(); tampered.body = Buffer.from('tampered');
    expect(await post(first.url, tampered)).toBe(401);
    const request = signed(Buffer.alloc(0));
    expect((await fetch(first.url + '/v1/status', { headers: request.headers })).status).toBe(200);
    expect(await post(second.url, request, '/v1/network-scans')).toBe(401);
  });
  it('uses database time, never deletes live claims, and cleans only expired records', async () => {
    expect(await store.claim(randomUUID(), Date.now() + 31000)).toBe(false);
    expect(await store.claim(randomUUID(), Date.now() - 31000)).toBe(false);
    expect(await store.claim(randomUUID(), Date.now() + 20000)).toBe(true);
    const nonce = randomUUID(); expect(await store.claim(nonce, Date.now())).toBe(true);
    await pool.query("INSERT INTO sandbox_request_nonces VALUES ('sandbox-controller', ?, 1)", [randomUUID()]);
    await store.cleanup();
    const [old] = await pool.query<RowDataPacket[]>('SELECT * FROM sandbox_request_nonces WHERE expires_at_ms = 1');
    expect(old).toHaveLength(0);
    expect(await store.claim(nonce, Date.now())).toBe(false);
  });
  it('fails closed during outage, recovers, and retains claims across database restart', async () => {
    const request = signed(undefined, 20000);
    expect(await post(first.url, request)).toBe(200);
    docker('stop', '-t', '1', container);
    for (const route of ['/v1/jobs', '/v1/network-scans']) expect(await post(second.url, signed(), route)).toBe(503);
    const status = signed(Buffer.alloc(0));
    expect((await fetch(second.url + '/v1/status', { headers: status.headers })).status).toBe(503);
    docker('start', container);
    await waitFor(async () => { await pool.query('SELECT 1'); });
    expect(Date.now() - Number(request.headers['x-slide-timestamp'])).toBeLessThan(30000);
    expect(await post(second.url, request)).toBe(401);
    expect(await post(second.url)).toBe(200);
  }, 60000);
});
