/** MAX-569 / #416/#417. Explicit MAX569_MYSQL_HOST/PORT/USER/PASSWORD,
 * MAX569_OUTPUT_DIR required; run from slide-api with tsx.
 * Production server + JWT/RBAC + formal migrations; browser uses a component
 * host with real registry/API calls. Controlled metric metadata and SQL faults
 * exist only in the exclusive schema; no managed collector or LLM is invoked.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { createRequire } from 'node:module';
import { MigrationRunner } from '../src/migrations/runner.js';

for (const key of ['MAX569_MYSQL_HOST', 'MAX569_MYSQL_PORT', 'MAX569_MYSQL_USER', 'MAX569_MYSQL_PASSWORD', 'MAX569_OUTPUT_DIR']) {
  assert(process.env[key] !== undefined, `${key} required`);
}
const config = { host: process.env.MAX569_MYSQL_HOST!, port: Number(process.env.MAX569_MYSQL_PORT),
  user: process.env.MAX569_MYSQL_USER!, password: process.env.MAX569_MYSQL_PASSWORD! };
assert(Number.isInteger(config.port) && config.port > 0);
const output = resolve(process.env.MAX569_OUTPUT_DIR!);
mkdirSync(output, { recursive: true });
const schema = `max569_${randomBytes(6).toString('hex')}`;
const admin = mysql.createPool(config);
const pool = mysql.createPool({ ...config, database: schema });
const username = 'max569_operator';
const password = randomBytes(24).toString('hex');
const jwtSecret = randomBytes(32).toString('hex');
const encryptionKey = randomBytes(32).toString('hex');
const observations: unknown[] = [];
let active: ReturnType<typeof spawn> | undefined;
let closed: Promise<unknown> | undefined;
let logs = '';
let created = false;
let failure: unknown;
let round = 0;
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}
async function stop() {
  if (!active) return;
  // Only signal the exact server child started here, never a name or port owner.
  const daemon = JSON.parse(execFileSync(process.env.MULTICA_CLI_PATH!, ['daemon', 'status', '--output', 'json'], { encoding: 'utf8' }));
  assert.notEqual(active.pid, daemon.pid, 'child must not be the workspace daemon');
  if (active.exitCode === null && active.signalCode === null) active.kill('SIGTERM');
  const timer = setTimeout(() => { if (active?.exitCode === null && active.signalCode === null) active.kill('SIGKILL'); }, 15000);
  try { await closed; } finally { clearTimeout(timer); }
  for (const secret of [password, jwtSecret, encryptionKey, config.password].filter(Boolean)) assert(!logs.includes(secret), 'process log secret scan');
  writeFileSync(resolve(output, `server-${round}.log`), logs, { mode: 0o600 });
  active = undefined;
}
async function start() {
  round++;
  logs = '';
  const port = await freePort(), wsPort = await freePort();
  active = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, NODE_ENV: 'production', DB_HOST: config.host, DB_PORT: String(config.port), DB_USER: config.user,
    DB_PASSWORD: config.password, DB_NAME: schema, INITIAL_ADMIN_USERNAME: username, INITIAL_ADMIN_PASSWORD: password,
    JWT_SECRET_KEY: jwtSecret, ENCRYPTION_KEY: encryptionKey, PORT: String(port), AGENT_WS_PORT: String(wsPort),
    PROMPT_HOT_RELOAD: 'false', CORS_ORIGINS: `http://127.0.0.1:${port}`,
  } });
  closed = once(active, 'close');
  active.stdout!.on('data', chunk => { logs += chunk; });
  active.stderr!.on('data', chunk => { logs += chunk; });
  console.log(JSON.stringify({ pid: active.pid, port, wsPort, cwd: process.cwd(), command: 'node --import tsx server.ts',
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), log: `server-${round}.log`, schema, mysql: `${config.host}:${config.port}`, nodeEnv: 'production' }));
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 600; attempt++) {
    assert(active.exitCode === null && active.signalCode === null, 'server exited during startup');
    try { if ((await fetch(`${base}/api/health/ready`)).ok) return base; } catch {}
    await delay(100);
  }
  throw new Error('server readiness deadline 60s exceeded');
}
async function request(base: string, path: string, body: unknown, status: number, token?: string, method = 'POST', json = true) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(json ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json() as any;
  observations.push({ round, path, method, input: body === undefined ? (json ? 'empty-json-body' : 'absent-body') :
    body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body, expected: status, actual: response.status,
    ...(response.status === 400 ? { error: result.error, message: result.message } : {}) });
  assert.equal(response.status, status, `${method} ${path} input ${body === null ? 'null' : typeof body}`);
  return result;
}
let browser: any;
let vite: ReturnType<typeof spawn> | undefined;
let viteClosed: Promise<unknown> | undefined;
let viteLog = '';
try {
  await admin.query(`CREATE DATABASE ${schema}`); created = true;
  await new MigrationRunner(pool as any).run();
  await pool.execute('UPDATE llm_providers SET enabled=FALSE,is_default=FALSE');
  // Controlled registry metadata in this exclusive schema: no actual metric collector is claimed.
  await pool.execute("INSERT INTO metric_definitions(id,name,unit,db_types,is_collected,target_type) VALUES ('max569_all','验收不限指标','count','[]',TRUE,'instance'), ('max569_pg','验收PG指标','count','[\"postgresql\"]',TRUE,'instance')");
  const base = await start();
  const login = await request(base, '/api/auth/login', { username, password }, 200);
  const token = login.token;
  const vitePort = await freePort();
  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: resolve('../../frontend'), env: { ...process.env, VITE_API_PROXY_TARGET: base }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  viteClosed = once(vite, 'close'); vite.stdout!.on('data', chunk => { viteLog += chunk; }); vite.stderr!.on('data', chunk => { viteLog += chunk; });
  const url = `http://127.0.0.1:${vitePort}/e2e/fixtures/alert-rule-editor.html`;
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) { ready = true; break; } } catch {} await delay(100); }
  assert(ready, 'Vite deadline');
  const { chromium, expect } = createRequire(resolve('../../frontend/package.json'))('@playwright/test');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  observations.push({ browser: browser.version(), engine: 'installed Microsoft Edge stable', api: base, vite: url });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url);
  await page.evaluate(async token => { sessionStorage.token = token; await (window as any).ready(); }, token);
  const editor = page.locator('alert-rule-editor');
  const field = (label: string) => editor.getByRole('spinbutton', { name: label, exact: true });
  const metric = editor.getByRole('combobox', { name: '指标', exact: true });
  const clickSave = async () => { await editor.getByRole('button', { name: '保存', exact: true }).click(); await expect(page.getByRole('status')).toHaveText('保存成功'); };
  const saved = () => page.evaluate(() => (window as any).saved);
  const openCreate = async () => { await page.locator('#create').click(); await editor.getByRole('textbox', { name: '规则名称', exact: true }).fill('MAX569验收'); };
  const openEdit = () => page.locator('#edit').click();
  const checkDB = async () => { const row = await saved(); const [rows] = await pool.query<any[]>('SELECT duration_seconds,silence_minutes,db_types FROM alert_rules WHERE id=?', [row.id]); assert.equal(rows[0].duration_seconds, row.duration_seconds); assert.equal(rows[0].silence_minutes, row.silence_minutes); return rows[0]; };
  await openCreate();
  await metric.selectOption('buffer_pool_hit_rate'); await expect(editor.getByRole('checkbox', { name: 'mysql', exact: true })).toBeChecked();
  await metric.selectOption('max569_pg'); await expect(editor.getByRole('checkbox', { name: 'postgresql', exact: true })).toBeChecked(); await expect(editor.getByRole('checkbox', { name: 'mysql', exact: true })).not.toBeChecked();
  await metric.selectOption('max569_all'); await expect(editor.getByRole('checkbox', { name: 'postgresql', exact: true })).not.toBeChecked();
  await field('持续时间（秒）').fill('0'); await field('沉默期（分钟）').fill('0'); await clickSave();
  assert.equal((await saved()).duration_seconds, 0); assert.equal((await saved()).silence_minutes, 0); assert.equal((await checkDB()).db_types, null);
  observations.push({ case: 'create limited→changed→unrestricted with zero; HTTP+SQL readback', passed: true });
  await openEdit();
  await expect(field('持续时间（秒）')).toHaveValue('0'); await expect(field('沉默期（分钟）')).toHaveValue('0');
  await editor.getByRole('checkbox', { name: 'oracle', exact: true }).check(); await clickSave(); assert.deepEqual((await saved()).db_types, ['oracle']);
  await openEdit(); await metric.selectOption('max569_pg'); await clickSave(); assert.deepEqual((await saved()).db_types, ['postgresql']);
  await openEdit(); await metric.selectOption('max569_all'); await clickSave(); assert.equal((await saved()).db_types, null);
  await openEdit(); await field('持续时间（秒）').fill('12'); await field('沉默期（分钟）').fill('3'); await clickSave();
  await openEdit(); await field('持续时间（秒）').fill('0'); await field('沉默期（分钟）').fill('0'); await clickSave();
  assert.equal((await checkDB()).duration_seconds, 0); assert.equal((await checkDB()).silence_minutes, 0);
  observations.push({ case: 'edit manual filter, range change, unrestricted and zero round trip', passed: true });
  await openCreate(); await metric.selectOption('buffer_pool_hit_rate'); await editor.getByRole('checkbox', { name: 'mysql', exact: true }).uncheck(); await clickSave();
  assert.equal((await checkDB()).db_types, null);
  await openEdit(); await metric.selectOption('max569_all'); await field('持续时间（秒）').fill('0'); await field('沉默期（分钟）').fill('0'); await clickSave();
  observations.push({ case: 'manual empty filter on limited metric stays unrestricted on creation', passed: true });

  // Both create and edit: invalid form values must never send a request or mutate SQL.
  let writes = 0; page.on('request', req => { if (req.url().includes('/api/alert-rules') && ['POST','PUT'].includes(req.method())) writes++; });
  for (const editing of [false, true]) {
    if (editing) await openEdit(); else { await openCreate(); await metric.selectOption('max569_all'); }
    for (const label of ['持续时间（秒）', '沉默期（分钟）']) {
      for (const value of ['', '-1', '0.5', '2147483648']) {
        const before = writes; await field(label).fill(value); await editor.getByRole('button', { name: '保存', exact: true }).click();
        await expect(editor).toContainText(value === '' ? '不能为空' : '必须为'); assert.equal(writes, before);
      }
      await field(label).fill('0');
    }
    await editor.getByRole('button', { name: '取消', exact: true }).click();
  }
  observations.push({ case: 'create/edit empty negative fractional overflow blocked before HTTP', passed: true });
  // Backend contract adversaries must be rejected even when bypassing the UI.
  const body = { name: 'API零值', metric_name: 'max569_all', operator: '>', threshold: 1, severity: 'warning', duration_seconds: 0, silence_minutes: 0, db_types: null };
  const id = (await request(base, '/api/alert-rules', body, 200, token)).id;
  for (const timing of ['duration_seconds', 'silence_minutes']) for (const value of [null, '', 'abc', '0', -1, 0.5, 2147483648]) {
    await request(base, '/api/alert-rules', { ...body, [timing]: value }, 400, token);
    await request(base, '/api/alert-rules/' + id, { [timing]: value }, 400, token, 'PUT');
  }
  await request(base, '/api/alert-rules/' + id, { duration_seconds: 0, silence_minutes: 0 }, 200, token, 'PUT');
  const omitted = (await request(base, '/api/alert-rules', { name: '默认值', metric_name: 'max569_all', operator: '>', threshold: 1, severity: 'warning' }, 200, token)).id;
  const rules = await request(base, '/api/alert-rules', undefined, 200, token, 'GET', false);
  assert.equal(rules.find((r: any) => r.id === omitted).duration_seconds, 60); assert.equal(rules.find((r: any) => r.id === omitted).silence_minutes, 5);
  await request(base, '/api/alert-rules', body, 401);
  await request(base, '/api/users', { username: 'max569_reader', password: 'synthetic-password' }, 201, token);
  const reader = await request(base, '/api/auth/login', { username: 'max569_reader', password: 'synthetic-password' }, 200);
  await request(base, '/api/alert-rules', body, 403, reader.token);
  await request(base, '/api/alert-rules/' + id, { duration_seconds: 0 }, 403, reader.token, 'PUT');
  // Inject only this schema's UPDATE failure; verify old row and retained form, then recover.
  await openEdit(); const old = await saved(); await field('持续时间（秒）').fill('9');
  await pool.query("CREATE TRIGGER max569_fail BEFORE UPDATE ON alert_rules FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='max569 isolated write fault'");
  await editor.getByRole('button', { name: '保存', exact: true }).click(); await expect(page.getByRole('status')).toHaveText('保存失败'); await expect(field('持续时间（秒）')).toHaveValue('9');
  const [preserved] = await pool.query<any[]>('SELECT duration_seconds FROM alert_rules WHERE id=?', [old.id]); assert.equal(preserved[0].duration_seconds, old.duration_seconds);
  await pool.query('DROP TRIGGER max569_fail'); await field('持续时间（秒）').fill('0'); await clickSave(); await checkDB();
  observations.push({ case: 'schema-local SQL write fault keeps prior data and draft; recovery saves zero', passed: true });
  // Server target sends no database/instance filters.
  await openCreate(); await editor.getByRole('button', { name: '服务器', exact: true }).click(); await metric.selectOption('cpu_usage');
  const pending = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith('/api/alert-rules'));
  await field('持续时间（秒）').fill('0'); await field('沉默期（分钟）').fill('0'); await clickSave();
  const payload = (await pending).postDataJSON(); assert(!('db_types' in payload)); assert(!('instance_ids' in payload)); assert.equal((await saved()).target_type, 'server'); await checkDB();
  observations.push({ case: 'server create excludes database scope; zero SQL readback', passed: true });
  await openEdit(); await editor.getByRole('button', { name: '保存', exact: true }).focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('status')).toHaveText('保存成功'); await checkDB();

  for (const [width, height] of [[1440,900], [1366,768], [1920,1080]]) {
    await page.setViewportSize({ width, height }); await openEdit();
    const save = editor.getByRole('button', { name: '保存', exact: true }); await expect(save).toBeInViewport();
    await expect(field('持续时间（秒）')).toHaveAccessibleName('持续时间（秒）'); await expect(field('沉默期（分钟）')).toHaveAccessibleName('沉默期（分钟）');
    const problems = await editor.evaluate(root => [...root.shadowRoot!.querySelectorAll('input,select,button')].filter((el: any) => !el.disabled && !el.labels?.length && !el.getAttribute('aria-label') && !el.textContent?.trim()).map(el => el.outerHTML));
    assert.deepEqual(problems, [], 'all active controls have names');
    await save.focus(); await page.keyboard.press('Tab'); await expect(editor.locator('app-dialog').getByRole('button', { name: 'Close dialog', exact: true })).toBeFocused();
    await expect(metric).toHaveValue('cpu_usage');
    await field('持续时间（秒）').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, `editor-${width}x${height}.png`) });
    await page.keyboard.press('Escape'); await expect(page.locator('#edit')).toBeFocused();
    observations.push({ case: `desktop ${width}x${height}, names, focus trap and Escape restore`, passed: true });
  }
  console.log('PASS browser UI + production server/JWT/HTTP + MySQL round trips; LLM=0');
} catch (error) { failure = error; }
finally {
  const cleanup: unknown[] = [];
  for (const step of [async () => { await browser?.close(); }, async () => { if (vite) { vite.kill('SIGTERM'); await viteClosed; } writeFileSync(resolve(output, 'vite.log'), viteLog); }, stop, () => pool.end(), async () => { if (created) await admin.query(`DROP DATABASE ${schema}`); }, () => admin.end()]) {
    try { await step(); } catch (error) { cleanup.push(error); }
  }
  writeFileSync(resolve(output, 'http-results.json'), JSON.stringify({ schema, observations, failure: failure ? String(failure) : null, cleanupErrors: cleanup.map(String), passed: !failure && !cleanup.length }, null, 2));
  if (failure || cleanup.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanup], 'MAX-569 acceptance failed; business and cleanup failures retained');
  console.log('PASS browser and child stopped; exclusive schema dropped');
}
