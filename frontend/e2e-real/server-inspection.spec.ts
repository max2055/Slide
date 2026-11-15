import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'vite';
import { MigrationRunner } from '../../apps/db-ops-api/src/migrations/runner.ts';

const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const mysql = require('mysql2/promise'), bcrypt = require('bcrypt');
const output = process.env.SERVER_INSPECTION_REAL_OUTPUT_DIR ?? 'test-results-server-inspection-real';
const schema = `max558_${randomUUID().replaceAll('-', '')}`;
const password = randomUUID();
let admin: any, pool: any, lock: any, backend: ChildProcess;
let vite: Awaited<ReturnType<typeof createServer>>, origin: string, workspace: string;
let modelGuard: ReturnType<typeof createHttpServer>, modelCalls = 0, backendLog = '';
const evidence: Record<string, unknown> = {};
async function freePort() {
  const server = createNetServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done()));
  return port;
}
test.beforeAll(async () => {
  test.setTimeout(90_000); // Own-schema migrations, then bounded 60s API startup.
  await mkdir(output, { recursive: true });
  const port = Number(process.env.SLIDE_TEST_MYSQL_PORT);
  if (!Number.isInteger(port) || port <= 0 || !process.env.SLIDE_TEST_MYSQL_HOST || !process.env.SLIDE_TEST_MYSQL_USER) {
    throw new Error('Explicit SLIDE_TEST_MYSQL_HOST/PORT/USER required for isolated real acceptance');
  }
  workspace = await mkdtemp(join(tmpdir(), 'slide-max558-'));
  const options = { host: process.env.SLIDE_TEST_MYSQL_HOST, port, user: process.env.SLIDE_TEST_MYSQL_USER,
    password: process.env.SLIDE_TEST_MYSQL_PASSWORD ?? '' };
  admin = mysql.createPool(options);
  await admin.query(`CREATE DATABASE \`${schema}\``);
  pool = mysql.createPool({ ...options, database: schema });
  const migrationStarted = Date.now();
  await new MigrationRunner(pool).run();
  evidence.migrationMs = Date.now() - migrationStarted;
  await pool.execute("INSERT INTO users (id,username,password_hash) VALUES (558,'inspection-owner',?)", [await bcrypt.hash(password, 10)]);
  await pool.query("INSERT INTO roles (id,name) VALUES (558,'inspection-admin')");
  await pool.query("INSERT IGNORE INTO permissions (code,name,resource,action) VALUES ('*','Fixture admin','admin','all')");
  await pool.query('INSERT INTO role_permissions (role_id,permission_id) SELECT 558,id FROM permissions');
  await pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (558,558)');
  // Reports read stored observations; this disabled collector has no SSH target.
  await pool.query(`INSERT INTO servers
    (id,host,port,label,os_type,credential_type,credential_encrypted,status,collection_enabled)
    VALUES (558,'127.0.0.1',9,'真实接口巡检验收','Linux','password','unused','offline',0)`);
  modelGuard = createHttpServer((_req, res) => { modelCalls++; res.writeHead(503); res.end('MODEL_CALL_FORBIDDEN'); });
  await new Promise<void>(done => modelGuard.listen(0, '127.0.0.1', done));
  await pool.query('UPDATE llm_providers SET enabled=0,is_default=0');
  await pool.execute("UPDATE llm_providers SET enabled=1,is_default=1,api_base_url=?,deployment_type='local',api_format=NULL WHERE name='ollama'",
    [`http://127.0.0.1:${(modelGuard.address() as { port: number }).port}`]);
  const apiPort = await freePort(), wsPort = await freePort();
  const cwd = resolve('../apps/db-ops-api');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  backend = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development',
      DB_HOST: options.host, DB_PORT: String(port), DB_USER: options.user, DB_PASSWORD: options.password, DB_NAME: schema,
      PORT: String(apiPort), AGENT_WS_HOST: '127.0.0.1', AGENT_WS_PORT: String(wsPort), AGENT_WORKSPACE: workspace,
      JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      SLIDE_MEMORY_PIPELINE_ENABLED: 'false', PROMPT_HOT_RELOAD: 'false' },
  });
  backend.stdout!.on('data', data => { backendLog += data; });
  backend.stderr!.on('data', data => { backendLog += data; });
  evidence.environment = { commit, schema, database: { host: options.host, port }, backend: { pid: backend.pid, apiPort, wsPort, cwd, command: 'node --import tsx server.ts', log: 'backend.log' } };
  const startupStarted = Date.now();
  await expect.poll(async () => {
    if (backend.exitCode !== null) throw new Error(`Backend exited: ${backendLog.slice(-2000)}`);
    try { return (await fetch(`http://127.0.0.1:${apiPort}/api/health/ready`)).status; } catch { return 0; }
  }, { timeout: 60_000 }).toBe(200);
  evidence.startupMs = Date.now() - startupStarted;
  vite = await createServer({ configFile: resolve('vite.config.js'),
    define: { 'import.meta.env.VITE_AGENT_WS_URL': '""' },
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true, proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      '/__slide': { target: `http://127.0.0.1:${wsPort}` },
      '/agent-ws': { target: `http://127.0.0.1:${wsPort}`, ws: true },
    } },
  });
  await vite.listen();
  origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  evidence.origin = origin;
});
test.afterAll(async () => {
  test.setTimeout(20_000);
  // Playwright disposes page fixtures before this hook; release SQL delay before stopping services.
  const errors: string[] = [];
  const cleanup = async (name: string, action: () => Promise<unknown>) => {
    try { await action(); } catch (error) { errors.push(`${name}: ${String(error)}`); }
  };
  await cleanup('unlock', async () => { if (lock) { await lock.query('UNLOCK TABLES'); lock.release(); lock = null; } });
  await cleanup('vite', async () => { await vite?.close(); });
  await cleanup('backend', async () => {
    if (backend && backend.exitCode === null) {
      if (backend.pid === Number(process.env.SLIDE_TEST_DAEMON_PID)) throw new Error('Refusing to signal daemon');
      const exited = new Promise<void>(done => backend.once('exit', () => done()));
      backend.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout>;
      try { await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Backend did not stop in 10s')), 10_000); })]); }
      finally { clearTimeout(timer!); }
    }
  });
  await cleanup('pool', async () => { await pool?.end(); });
  await cleanup('schema', async () => { if (admin) { await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``); await admin.end(); } });
  await cleanup('model-guard', async () => { if (modelGuard) await new Promise<void>(done => modelGuard.close(() => done())); });
  await cleanup('workspace', async () => { if (workspace) await rm(workspace, { recursive: true, force: true }); });
  evidence.cleanup = { errors, schemaDropped: errors.every(e => !e.startsWith('schema:')), modelCalls };
  await writeFile(join(output, 'backend.log'), backendLog);
  await writeFile(join(output, 'real-evidence.json'), JSON.stringify(evidence, null, 2));
  expect(errors).toEqual([]); expect(modelCalls).toBe(0);
});

test('MAX-558 real page → generate endpoint → one persisted report and one navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const login = await page.request.post(origin + '/api/auth/login', { data: { username: 'inspection-owner', password } });
  expect(login.status()).toBe(200);
  const session = await login.json();
  await page.addInitScript(token => {
    localStorage.setItem('token', token);
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
    (window as any).permissionsReady = false;
    window.addEventListener('slide-permissions-loaded', () => { (window as any).permissionsReady = true; });
    (window as any).reportNavigations = 0;
    window.addEventListener('slide-navigate', (e: any) => {
      if (e.detail.tab === 'reports') (window as any).reportNavigations++;
    });
  }, session.token);
  const requests: unknown[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/servers/reports/generate' && request.method() === 'POST') {
      requests.push({ method: request.method(), path: '/api/servers/reports/generate', body: request.postDataJSON() });
    }
  });
  // Let real authentication/bootstrap finish before opening the target from its
  // ordinary list entry. No cached permissions or synthetic navigation.
  await page.goto(origin + '/servers');
  await page.waitForFunction(() => (window as any).permissionsReady === true);
  await page.locator('servers-page [data-resource-detail-id="558"]').click();
  await expect(page).toHaveURL(/server-detail/);
  const button = page.locator('server-detail').getByRole('button', { name: /一键巡检|巡检中/ });
  await expect(button).toHaveAccessibleName('一键巡检');
  const [before] = await pool.query('SELECT COUNT(*) AS count FROM reports WHERE server_id=558');
  expect(Number(before[0].count)).toBe(0);
  // Real SQL lock holds the production INSERT in flight; no intercepted response.
  lock = await pool.getConnection();
  await lock.query('LOCK TABLES reports WRITE');
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/servers/reports/generate' && r.request().method() === 'POST');
  await button.evaluate((el: HTMLButtonElement) => { el.click(); el.click(); el.click(); });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => requests.length).toBe(1);
  await page.screenshot({ path: join(output, 'real-pending.png'), animations: 'disabled' });
  await lock.query('UNLOCK TABLES'); lock.release(); lock = null;
  const generated = await response;
  expect(generated.status()).toBe(200);
  const body = await generated.json();
  expect(Number.isInteger(body.reportId)).toBe(true);
  await expect(page).toHaveURL(/\/reports/);
  expect(await page.evaluate(() => (window as any).reportNavigations)).toBe(1);
  expect(requests).toHaveLength(1);
  const sql = "SELECT id,server_id,type,status,JSON_EXTRACT(data,'$.server_count') AS server_count,CHAR_LENGTH(content) AS html_length FROM reports WHERE server_id=558 ORDER BY id";
  const [rows] = await pool.query(sql);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: body.reportId, server_id: 558, type: 'server_health', status: 'completed' });
  expect(Number(rows[0].server_count)).toBe(1); expect(rows[0].html_length).toBeGreaterThan(100);
  // Also read through the production report API.
  const stored = await page.request.get(origin + `/api/reports/${body.reportId}`, { headers: { Authorization: `Bearer ${session.token}` } });
  expect(stored.status()).toBe(200);
  expect((await stored.json()).id).toBe(body.reportId);
  evidence.acceptance = { requests, response: { status: generated.status(), requestId: generated.headers()['x-request-id'] ?? null, reportId: body.reportId },
    sql, before: before[0], rows, navigationCount: 1, reportApiStatus: stored.status() };
  await page.screenshot({ path: join(output, 'real-report-page.png'), animations: 'disabled' });
});
