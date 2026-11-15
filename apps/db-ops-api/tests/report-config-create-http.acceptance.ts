/** MAX-615 / #361: full production server, TCP HTTP, real MySQL and live JWT/RBAC.
 * Explicit MAX615_MYSQL_HOST/PORT/USER/PASSWORD and MAX615_OUTPUT_DIR required.
 * Run from slide-api: pnpm exec tsx tests/report-config-create-http.acceptance.ts
 * Never loads credentials from a private file. Only the generated schema is changed.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { createOwnedDatabase } from '../src/testing/owned-fixture.js';
import { MigrationRunner } from '../src/migrations/runner.js';

for (const key of ['MAX615_MYSQL_HOST', 'MAX615_MYSQL_PORT', 'MAX615_MYSQL_USER', 'MAX615_MYSQL_PASSWORD', 'MAX615_OUTPUT_DIR']) {
  assert(process.env[key] !== undefined, `${key} required`);
}
const config = { host: process.env.MAX615_MYSQL_HOST!, port: Number(process.env.MAX615_MYSQL_PORT),
  user: process.env.MAX615_MYSQL_USER!, password: process.env.MAX615_MYSQL_PASSWORD! };
assert(Number.isInteger(config.port) && config.port > 0);
const output = resolve(process.env.MAX615_OUTPUT_DIR!);
mkdirSync(output, { recursive: true });
let schema: string;
let owned: Awaited<ReturnType<typeof createOwnedDatabase>> | undefined;
const admin = mysql.createPool(config);
let pool: mysql.Pool;
const username = 'max615_operator';
const password = randomBytes(24).toString('hex');
const jwtSecret = randomBytes(32).toString('hex');
const encryptionKey = randomBytes(32).toString('hex');
const observations: unknown[] = [];
const clientObservations: unknown[] = [];
let active: ReturnType<typeof spawn> | undefined;
let closed: Promise<unknown> | undefined;
let logs = '';

// Controlled MySQL protocol fault boundary, with all writes forwarded to real MySQL.
// No INSERT is replayed. Dropping the server OK packet models committed/unknown acknowledgement.
let readMode: 'healthy' | 'error' | 'empty' = 'healthy';
let loseNextInsertReceipt = false;
let insertExecutions = 0;
let droppedReceipts = 0;
const sockets = new Set<Socket>();
function frames(onFrame: (frame: Buffer) => void) {
  let buffered = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4 && buffered.length >= buffered.readUIntLE(0, 3) + 4) {
      const size = buffered.readUIntLE(0, 3) + 4;
      const frame = buffered.subarray(0, size); buffered = buffered.subarray(size); onFrame(frame);
    }
  };
}
const proxy = createServer(client => {
  const upstream = connect({ host: config.host, port: config.port });
  sockets.add(client); sockets.add(upstream);
  for (const socket of [client, upstream]) {
    socket.on('error', () => { client.destroy(); upstream.destroy(); });
    socket.on('close', () => sockets.delete(socket));
  }
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
  const inserts = new Set<number>();
  let pendingInsertPrepare = false, dropReceipt = false;
  client.on('data', frames(frame => {
    const command = frame[4];
    if (command === 0x16) {
      let sql = frame.subarray(5).toString();
      pendingInsertPrepare = /^INSERT INTO report_configs/.test(sql);
      if (/^SELECT[\s\S]*FROM report_configs/.test(sql)) {
        if (readMode === 'error') {
          const payload = Buffer.concat([Buffer.from([0xff, 0x76, 0x04, 0x23]), Buffer.from('42000MAX615 controlled SELECT outage')]);
          const header = Buffer.alloc(4); header.writeUIntLE(payload.length, 0, 3); header[3] = 1;
          client.write(Buffer.concat([header, payload])); return;
        }
        if (readMode === 'empty') {
          sql = sql.replace('FROM report_configs', 'FROM (SELECT * FROM report_configs WHERE FALSE) report_configs');
          const payload = Buffer.concat([Buffer.from([0x16]), Buffer.from(sql)]);
          const header = Buffer.alloc(4); header.writeUIntLE(payload.length, 0, 3);
          upstream.write(Buffer.concat([header, payload])); return;
        }
      }
    }
    if (command === 0x17 && inserts.has(frame.readUInt32LE(5))) {
      insertExecutions++;
      if (loseNextInsertReceipt) { dropReceipt = true; loseNextInsertReceipt = false; }
    }
    upstream.write(frame);
  }));
  upstream.on('data', frames(frame => {
    if (pendingInsertPrepare && frame[4] === 0x00) {
      inserts.add(frame.readUInt32LE(5)); pendingInsertPrepare = false;
    }
    if (dropReceipt) {
      dropReceipt = false;
      assert.equal(frame[4], 0x00, 'drop only a confirmed INSERT OK packet');
      droppedReceipts++; client.destroy(); upstream.destroy(); return;
    }
    client.write(frame);
  }));
});
proxy.listen(0, '127.0.0.1');
await once(proxy, 'listening');
const proxyPort = (proxy.address() as { port: number }).port;
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
    ...process.env, NODE_ENV: 'production', DB_HOST: '127.0.0.1', DB_PORT: String(proxyPort), DB_USER: config.user,
    DB_PASSWORD: config.password, DB_NAME: schema, INITIAL_ADMIN_USERNAME: username, INITIAL_ADMIN_PASSWORD: password,
    JWT_SECRET_KEY: jwtSecret, ENCRYPTION_KEY: encryptionKey, PORT: String(port), AGENT_WS_PORT: String(wsPort),
    METRICS_COLLECTION_ENABLED: 'false', PROMPT_HOT_RELOAD: 'false', CORS_ORIGINS: `http://127.0.0.1:${port}`,
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
try {
  assert.notEqual(config.port, 3306, 'shared platform database forbidden');
  owned = await createOwnedDatabase(admin as any, { nonce: randomBytes(8).toString('hex'), purpose: 'reportcreate', handleDir: output });
  schema = owned.database;
  pool = mysql.createPool({ ...config, database: schema, timezone: 'Z' });
  await new MigrationRunner(pool as any).run();
  await pool.execute('UPDATE llm_providers SET enabled=FALSE,is_default=FALSE');
  await pool.query("INSERT INTO database_instances(id,name,host,port,username,password_encrypted) VALUES (701,'allowed','fixture.invalid',3307,'fixture','unused')");
  const value = { name: 'MAX615 normal', cron: '@daily', type: 'health', instance_id: 701, enabled: false };
  let base = await start();
  let token = (await request(base, '/api/auth/login', { username, password }, 200)).token;
  const post = (body: unknown, status = 200, actor: string | undefined = token) => request(base, '/api/reports/configs', body, status, actor);
  const list = () => request(base, '/api/reports/configs', undefined, 200, token, 'GET', false);
  const count = async (name: string) => {
    const [rows] = await pool.execute<any[]>('SELECT COUNT(*) AS n FROM report_configs WHERE name=?', [name]); return rows[0].n;
  };
  await request(base, '/api/reports/configs', value, 401);
  const normal = await post(value);
  assert(Number.isSafeInteger(normal.id));
  assert((await list()).some((row: any) => row.id === normal.id && row.name === value.name));
  observations.push({ check: 'normal receipt and recovery by list ID', id: normal.id, passed: true });
  for (const payload of [{ ...value, cron: 'bad' }, { ...value, type: 'server_health' }, { ...value, server_id: 701 }]) await post(payload, 400);

  // A real server-side SQL rejection, with zero durable rows. Conservative unknown outcome
  // is intentional: API callers must not infer rollback from an unclassified SQL failure.
  await pool.query("CREATE TRIGGER max615_reject BEFORE INSERT ON report_configs FOR EACH ROW BEGIN IF NEW.name='MAX615 reject' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MAX615 controlled write rejection'; END IF; END");
  let before = insertExecutions;
  const rejected = await post({ ...value, name: 'MAX615 reject' }, 409);
  assert.equal(rejected.code, 'REPORT_CONFIG_CREATE_OUTCOME_UNKNOWN'); assert.equal(rejected.retryable, false);
  assert.equal(await count('MAX615 reject'), 0); assert.equal(insertExecutions - before, 1);
  await pool.query('DROP TRIGGER max615_reject');
  observations.push({ check: 'real SQL write rejection, no replay', count: 0, insertAttempts: 1, passed: true });

  // Parallel receipts must correspond to distinct persisted rows, never connection-global last ID.
  before = insertExecutions;
  const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) => post({ ...value, name: `MAX615 concurrent ${i}` })));
  assert.equal(new Set(concurrent.map(row => row.id)).size, 8);
  assert.equal(insertExecutions - before, 8);
  for (const [index, receipt] of concurrent.entries()) {
    const [rows] = await pool.execute<any[]>('SELECT name FROM report_configs WHERE id=?', [receipt.id]);
    assert.equal(rows[0].name, `MAX615 concurrent ${index}`);
  }
  observations.push({ check: '8 concurrent POSTs have distinct matching IDs', ids: concurrent.map(row => row.id), passed: true });

  // Forward and commit the actual INSERT; suppress only its real OK packet.
  before = insertExecutions; loseNextInsertReceipt = true;
  const uncertain = await post({ ...value, name: 'MAX615 unknown' }, 409);
  assert.equal(droppedReceipts, 1); assert.equal(insertExecutions - before, 1);
  assert.equal(uncertain.retryable, false); assert.equal(uncertain.code, 'REPORT_CONFIG_CREATE_OUTCOME_UNKNOWN');
  assert.equal(await count('MAX615 unknown'), 1);
  const recovered = (await list()).filter((row: any) => row.name === 'MAX615 unknown');
  assert.equal(recovered.length, 1);
  await request(base, `/api/reports/configs/${recovered[0].id}`, { name: 'MAX615 reconciled' }, 200, token, 'PUT');
  assert.equal(await count('MAX615 reconciled'), 1);
  observations.push({ check: 'commit OK packet lost; 409 no-replay; recover by GET and PUT', id: recovered[0].id, durableRows: 1, insertAttempts: 1, passed: true });
  await stop();

  // Fresh connections ensure no prepared SELECT cache masks the controlled read boundary.
  for (const mode of ['error', 'empty'] as const) {
    readMode = mode; base = await start();
    token = (await request(base, '/api/auth/login', { username, password }, 200)).token;
    before = insertExecutions;
    const created = await post({ ...value, name: `MAX615 ${mode}` });
    assert.equal(insertExecutions - before, 1);
    assert.equal(await count(`MAX615 ${mode}`), 1);
    if (mode === 'error') {
      const unavailable = await request(base, '/api/reports/configs', undefined, 503, token, 'GET', false);
      assert.deepEqual(unavailable, { error: 'REPORT_CONFIG_LIST_UNAVAILABLE' });
    } else assert.deepEqual(await list(), []);
    observations.push({ check: `creation while SELECT ${mode}`, id: created.id, durableRows: 1, insertAttempts: 1, passed: true });
    if (mode === 'error') {
      // MAX-615 R1 regression: real Lit client -> production HTTP/JWT -> committed INSERT,
      // lost OK acknowledgement AND unavailable recovery SELECT on fresh connections.
      const { createServer: createViteServer } = await import(resolve(process.cwd(), '../../frontend/node_modules/vite/dist/node/index.js'));
      const { chromium } = await import('@playwright/test');
      const vite = await createViteServer({ configFile: false, root: resolve(process.cwd(), '../../frontend'), server: { host: '127.0.0.1', port: 0, proxy: { '/api': base } } });
      vite.middlewares.use('/__independent', (_req: any, res: any) => { res.setHeader('Content-Type','text/html'); res.end('<html><body></body></html>'); });
      let browser;
      try {
        await vite.listen();
        const address = vite.httpServer!.address() as {port:number};
        browser = await chromium.launch({headless:true});
        const page = await browser.newPage({viewport:{width:1440,height:900}});
        await page.goto(`http://127.0.0.1:${address.port}/__independent`);
        await page.evaluate(async ({token, value}: any) => {
          localStorage.setItem('token',token);
          await import('/src/app/ui/views/reports.ts');
          const element = document.createElement('reports-page') as any;
          // Suppress unrelated startup requests; retain production render/save/list methods.
          element.firstUpdated = () => {};
          document.body.innerHTML = '<app-toast-container></app-toast-container>';
          document.body.append(element);
          (window as any).reviewElement=element;
          element.loading=false; element.configsLoading=false; element.configForm={...value,name:'MAX615 UI unknown with unavailable list'};
          element.showConfigDialog=true;
          await element.updateComplete;
        },{token,value});
        before=insertExecutions; loseNextInsertReceipt=true;
        await page.evaluate(async()=> { await (window as any).reviewElement._saveConfig(); });
        const message = await page.locator('app-toast-container .toast__msg').first().innerText();
        assert.match(message,/创建结果未确认/); assert.match(message,/勿重复提交/);
        assert.equal(await count('MAX615 UI unknown with unavailable list'),1);
        assert.equal(insertExecutions-before,1);
        await page.evaluate(async()=>{ const e=(window as any).reviewElement; e.showConfigDialog=false; await e.loadConfigs(); await e.updateComplete; });
        await page.getByText('定时报表读取失败', { exact: true }).waitFor();
        assert.equal(await page.getByText('暂无定时报表', { exact: true }).count(), 0);
        assert(await page.getByRole('button', { name: '新建计划', exact: true }).isDisabled());
        const retry = page.getByRole('button', { name: '重新读取', exact: true });
        for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
          await page.setViewportSize(viewport);
          const box = await retry.boundingBox();
          assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
          await retry.focus(); assert(await retry.evaluate(button => button.matches(':focus')));
          await page.screenshot({ path: resolve(output, `client-read-failure-${viewport.width}.png`), fullPage: true });
        }
        // Failed SELECT was never cached, so restoring the read boundary is enough.
        readMode = 'healthy';
        await retry.press('Enter');
        await page.getByRole('cell', { name: 'MAX615 UI unknown with unavailable list', exact: true }).waitFor();
        assert.equal(insertExecutions - before, 1);
        assert.equal(await count('MAX615 UI unknown with unavailable list'), 1);
        assert(await page.getByRole('button', { name: '新建计划', exact: true }).isEnabled());
        const found = (await list()).filter((row: any) => row.name === 'MAX615 UI unknown with unavailable list');
        assert.equal(found.length, 1);
        await request(base, `/api/reports/configs/${found[0].id}`, { name: 'MAX615 UI reconciled' }, 200, token, 'PUT');
        assert.equal(await count('MAX615 UI reconciled'), 1);
        await page.evaluate(async () => { const e = (window as any).reviewElement; await e.loadConfigs(); await e.updateComplete; });
        await page.getByRole('cell', { name: 'MAX615 UI reconciled', exact: true }).waitFor();
        await page.screenshot({ path: resolve(output, 'client-recovered.png'), fullPage: true });
        // A genuinely healthy empty list remains a normal empty state.
        await pool.query('DELETE FROM report_configs');
        await page.evaluate(async () => { const e = (window as any).reviewElement; await e.loadConfigs(); await e.updateComplete; });
        await page.getByText('暂无定时报表', { exact: true }).waitFor();
        assert.equal(await page.getByText('定时报表读取失败', { exact: true }).count(), 0);
        assert(await page.getByRole('button', { name: '新建计划', exact: true }).isEnabled());
        clientObservations.push({ check: 'R1 committed INSERT lost OK then failed reconciliation GET503, explicit UI unknown, keyboard retry recovers unique row, PUT succeeds, healthy empty preserved', message, id: found[0].id, insertAttempts: 1, durableRows: 1, passed: true, scope: 'actual Lit methods/render; unrelated initial reads suppressed; controlled MySQL SELECT fault' });
        writeFileSync(resolve(output, 'client-observations.json'), JSON.stringify(clientObservations, null, 2));
      } finally { await browser?.close(); await vite.close(); }
    }
    await stop();
  }
  readMode = 'healthy'; base = await start();
  token = (await request(base, '/api/auth/login', { username, password }, 200)).token;
  const restored = await list();
  for (const name of ['MAX615 empty']) assert.equal(restored.filter((row: any) => row.name === name).length, 1);
  observations.push({ check: 'read recovery exposes confirmed config without another POST', passed: true });
  console.log('PASS full TCP HTTP/JWT, real MySQL, normal/write failure/read error/empty/concurrency/lost commit receipt; LLM requests=0');
} catch (error) { failure = error; }
finally {
  const cleanup: unknown[] = [];
  for (const step of [stop, async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => proxy.close(() => done())); }, () => pool?.end(), async () => { await owned?.drop(); }, () => admin.end()]) {
    try { await step(); } catch (error) { cleanup.push(error); }
  }
  writeFileSync(resolve(output, 'http-results.json'), JSON.stringify({ schema: schema!, observations, droppedReceipts, insertExecutions, cleanupErrors: cleanup.map(String), failure: failure ? String(failure) : null, passed: !failure && !cleanup.length }, null, 2));
  if (failure || cleanup.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanup], 'MAX-615 acceptance failed; business and cleanup errors retained');
  console.log('PASS exact child stopped; proxy sockets closed; owned schema dropped');
}
