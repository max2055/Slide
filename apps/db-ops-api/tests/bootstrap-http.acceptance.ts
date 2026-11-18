/** MAX-267 / MAX-266: formal init/start entrypoints against a disposable, real MySQL schema. */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { trackBootstrapProcess } from './bootstrap-process.js';
const port = Number(process.env.BOOTSTRAP_TEST_MYSQL_PORT);
assert(port, 'Dedicated BOOTSTRAP_TEST_MYSQL_PORT required');
const root = resolve('../..');
const output = resolve(root, 'outputs/max267-http');
mkdirSync(output, { recursive: true });
const config = { host: '127.0.0.1', port, user: 'root', password: process.env.BOOTSTRAP_TEST_MYSQL_PASSWORD ?? '' };
const admin = mysql.createPool(config);
const database = `max267_http_${randomUUID().replaceAll('-', '')}`;
const freePort = () => new Promise<number>(done => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => done(p)); }); });
const httpPort = await freePort(), wsPort = await freePort();
const env = { ...process.env, NODE_ENV: 'production', DB_HOST: config.host, DB_PORT: String(port), DB_USER: 'root', DB_PASSWORD: config.password, DB_NAME: database,
 JWT_SECRET_KEY: '\n' + randomBytes(32).toString('hex') + '\n', ENCRYPTION_KEY: randomBytes(32).toString('base64'), INITIAL_ADMIN_USERNAME: 'operator', INITIAL_ADMIN_PASSWORD: 'synthetic-operator-password', PORT: String(httpPort), AGENT_WS_HOST: '127.0.0.1', AGENT_WS_PORT: String(wsPort), PROMPT_HOT_RELOAD: 'false', CORS_ORIGINS: `http://127.0.0.1:${httpPort}` };
let sequence = 0;
let applicationReady = false;
let processOutput = '';
let active: ReturnType<typeof spawn> | undefined;
const processes = new WeakMap<ReturnType<typeof spawn>, ReturnType<typeof trackBootstrapProcess>>();
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
function launch(command: string[], overrides = {}) {
  applicationReady = false;
  processOutput = '';
  const log = createWriteStream(resolve(output, `${++sequence}-process.log`));
  const child = spawn('pnpm', ['--filter', 'slide-api', ...command], { cwd: root, env: { ...env, ...overrides }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.set(child, trackBootstrapProcess(child));
  child.stdout!.on('data', chunk => { processOutput += String(chunk); if (String(chunk).includes('WORKER_READY')) applicationReady = true; });
  child.stderr!.on('data', chunk => { processOutput += String(chunk); });
  child.stdout!.pipe(log); child.stderr!.pipe(log);
  child.once('close', () => log.end());
  console.log(JSON.stringify({ pid: child.pid, httpPort, wsPort, cwd: root, command: ['pnpm', '--filter', 'slide-api', ...command], log: `${sequence}-process.log`, head: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim() }));
  active = child; return child;
}
async function stop() {
  if (!active) return;
  await processes.get(active)!.stop();
  for (const port of [httpPort, wsPort]) {
    await new Promise<void>((done, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : done()));
    });
  }
  active = undefined;
}
async function completed(child: ReturnType<typeof spawn>) {
  const result = await processes.get(child)!.closed;
  await stop(); return result.code;
}
const base = `http://127.0.0.1:${httpPort}`;
async function start(overrides = {}) {
  const child = launch(['start'], overrides);
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`start exited ${child.exitCode ?? child.signalCode}; inspect process log`);
    try { const res = await fetch(`${base}/api/health`); if (res.ok && applicationReady) return; } catch {}
    await delay(250);
  }
  throw new Error('HTTP startup deadline exceeded');
}
async function login(username: string, password: string, expected: number) {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(r.status, expected, `login ${username}`);
  console.log(`HTTP login ${username}: ${r.status}`);
  return r.json() as Promise<any>;
}
async function permissions(token: string, expected: number) {
  const r = await fetch(`${base}/api/auth/permissions`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, expected, 'JWT with live actor checks');
  console.log(`HTTP JWT/live permissions: ${r.status}`);
}
await admin.query(`CREATE DATABASE ${database}`);
let pool = mysql.createPool({ ...config, database });
const originDirectory = mkdtempSync(join(tmpdir(), 'slide-bootstrap-origins-'));
let businessError: unknown;
try {
  assert.equal(await completed(launch(['init-db'])), 0);
  for (const [name, value] of [
    ['missing', undefined], ['empty', ''], ['spaces', ' '.repeat(32)],
    ['tabs/newlines', '\t\r\n '.repeat(8)], ['Unicode whitespace', '\u00a0\u2003\u2028\u3000'.repeat(8)],
    ['31 characters', 'j'.repeat(31)], ['known default', 'change-this-to-a-random-32-char-key'],
  ] as const) {
    let listenerSeen = false;
    const invalid = launch(['start'], { JWT_SECRET_KEY: value });
    for (let attempt = 0; invalid.exitCode === null && invalid.signalCode === null && attempt < 1200; attempt++) {
      try { await fetch(`${base}/api/health`); listenerSeen = true; } catch {}
      await delay(50);
    }
    assert.notEqual(invalid.exitCode, null, 'invalid JWT startup must terminate');
    assert.notEqual(invalid.exitCode, 0); assert.equal(listenerSeen, false);
    // The installed fatal handler intentionally suppresses exception details.
    assert.match(processOutput, /FATAL_UNCAUGHT_EXCEPTION/);
    for (const secret of [env.ENCRYPTION_KEY, env.INITIAL_ADMIN_PASSWORD]) assert.equal(processOutput.includes(secret), false, 'startup log must not disclose secrets');
    await stop();
    console.log(`MAX-266 JWT ${name}: nonzero exit, no HTTP listener, no secret disclosure: PASS`);
  }
  // Startup constructs a provider but this test never invokes it. Keep all endpoints local.
  await pool.query("UPDATE llm_providers SET enabled=0,is_default=0");
  await pool.query("UPDATE llm_providers SET enabled=1,is_default=1,supports_function_call=1,api_format='openai-completions',api_base_url='http://127.0.0.1:9' WHERE name='ollama'");
  await start();
  const operator = await login('operator', env.INITIAL_ADMIN_PASSWORD, 200);
  assert.doesNotThrow(() => jwt.verify(operator.token, env.JWT_SECRET_KEY));
  assert.throws(() => jwt.verify(operator.token, env.JWT_SECRET_KEY.trim()));
  for (const secret of [env.JWT_SECRET_KEY.trim(), env.ENCRYPTION_KEY, env.INITIAL_ADMIN_PASSWORD, operator.token]) assert.equal(processOutput.includes(secret), false, 'successful startup log must not disclose secrets');
  console.log('MAX-266 legitimate production startup: HTTP-issued JWT uses exact untrimmed key; logs omit credentials/token: PASS');
  await permissions(operator.token, 200);
  await login('admin', 'SlideQa42', 401); await login('user', 'SlideQa42', 401);
  await stop();
  const [ledger] = await pool.query('SELECT migration_id,checksum,status FROM app_schema_migrations ORDER BY migration_id');
  await start(); await login('operator', env.INITIAL_ADMIN_PASSWORD, 200); await stop();
  assert.deepEqual((await pool.query('SELECT migration_id,checksum,status FROM app_schema_migrations ORDER BY migration_id'))[0], ledger);
  console.log('Production init-db, start, restart and ledger preservation: PASS');
  for (const takeover of [false, true]) {
    await pool.end();
    await admin.query(`DROP DATABASE ${database}`);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...config, database });
    assert.equal(await completed(launch(['init-db'], { NODE_ENV: 'development' })), 0);
    await pool.query("UPDATE llm_providers SET enabled=0,is_default=0");
    await pool.query("UPDATE llm_providers SET enabled=1,is_default=1,supports_function_call=1,api_format='openai-completions',api_base_url='http://127.0.0.1:9' WHERE name='ollama'");
    await pool.query("UPDATE users u JOIN development_account_seeds s ON s.user_id=u.id SET u.username=CONCAT('fixture-',u.username)");
    const existingPassword = 'SlideQa42';
    const shaHash = createHash('sha256').update(existingPassword).digest('hex');
    const bcryptHash = await bcrypt.hash(existingPassword, 10);
    await pool.query("INSERT INTO users(username,password_hash,status,session_version,role_backup) VALUES ('admin',?,'active',4,'admin'),('user',?,'active',7,'viewer')", [shaHash, bcryptHash]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT u.id,r.id FROM users u JOIN roles r ON r.name=u.role_backup WHERE u.username IN ('admin','user')");
    const accounts = async () => (await pool.query<mysql.RowDataPacket[]>(
      "SELECT u.id,u.username,u.status,u.session_version,u.password_hash,r.name AS role FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE u.username IN ('admin','user') ORDER BY u.id,r.name",
    ))[0];
    await start({ NODE_ENV: 'development' });
    const seedSession = await login('fixture-admin', existingPassword, 200);
    const seedViewerSession = await login('fixture-user', existingPassword, 200);
    await permissions(seedSession.token, 200);
    await permissions(seedViewerSession.token, 200);
    const readUsers = async (token: string) => fetch(`${base}/api/users`, { headers: { authorization: `Bearer ${token}` } });
    const seedAdminRead = await readUsers(seedSession.token);
    assert.equal(seedAdminRead.status, 200);
    await seedAdminRead.body?.cancel();
    const existingSession = await login('user', existingPassword, 200);
    await stop();
    const [[target]] = await pool.query<mysql.RowDataPacket[]>('SELECT @@server_uuid AS serverUuid, DATABASE() AS schemaName');
    const [origins] = await pool.query<mysql.RowDataPacket[]>("SELECT u.id, IF(seed.user_id IS NULL,'existing-account','development-seed') AS source FROM users u LEFT JOIN development_account_seeds seed ON seed.user_id=u.id");
    await pool.query('DROP TABLE development_account_seeds');
    if (takeover) {
      const fixtureSession = await mysql.createConnection({ ...config, database });
      try {
        await fixtureSession.query("SET SESSION time_zone='+14:00'");
        await fixtureSession.query("UPDATE users SET created_at=NOW() WHERE username IN ('fixture-admin','fixture-user')");
      } finally {
        await fixtureSession.end();
      }
      await pool.query('DELETE FROM app_schema_migrations');
      assert.equal(await completed(launch(['init-db', '--baseline'], {
        MIGRATION_ACTOR: 'qualification', MIGRATION_REASON: 'Verify explicit takeover of a legacy development schema',
      })), 0);
    } else {
      await pool.query("UPDATE app_schema_migrations SET checksum=? WHERE migration_id='000_schema_baseline.sql'", ['729ec2cce91657443417503a6cf0a1852cb6002885fc6f9f9af5755560cdc2b9']);
      await pool.query("UPDATE users u JOIN app_schema_migrations m ON m.migration_id='000_schema_baseline.sql' SET u.created_at=m.finished_at WHERE u.username IN ('admin','user')");
    }
    const readLegacyLedger = async () => (await pool.query<mysql.RowDataPacket[]>('SELECT migration_id,checksum,status,started_at,finished_at FROM app_schema_migrations ORDER BY migration_id'))[0];
    const oldLedger = await readLegacyLedger();
    const baseline = oldLedger.find(row => row.migration_id === '000_schema_baseline.sql');
    assert.ok(baseline);
    assert.equal(baseline.status, takeover ? 'baselined' : 'completed');
    if (takeover) assert.equal(baseline.started_at, null);
    const [[originTable]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS present FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='development_account_seeds'");
    assert.equal(Number(originTable.present), 0);
    const beforeUpgrade = await accounts();
    const readSeeds = async () => (await pool.query<mysql.RowDataPacket[]>(
      "SELECT id,status,session_version,password_hash FROM users WHERE username IN ('fixture-admin','fixture-user') ORDER BY id",
    ))[0];
    const beforeSeeds = await readSeeds();
    async function assertReconciliationBlocked(originPath: string) {
      const blocked = launch(['start'], { SLIDE_LEGACY_ACCOUNT_ORIGINS_FILE: originPath });
      let listenerDuringReconciliation = false;
      for (let attempt = 0; blocked.exitCode === null && blocked.signalCode === null && attempt < 1200; attempt++) {
        try {
          const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(250) });
          await response.body?.cancel();
          listenerDuringReconciliation = true;
          break;
        } catch {}
        await delay(50);
      }
      assert.equal(listenerDuringReconciliation, false);
      assert.notEqual(blocked.exitCode, null);
      assert.notEqual(blocked.exitCode, 0);
      assert.match(processOutput, /LEGACY_DEVELOPMENT_ACCOUNTS_RECONCILIATION_REQUIRED/);
      await stop();
      assert.deepEqual(await accounts(), beforeUpgrade);
      assert.deepEqual(await readSeeds(), beforeSeeds);
      assert.deepEqual(await readLegacyLedger(), oldLedger);
      if (takeover) assert.deepEqual((await pool.query('SELECT account_ids FROM baseline_account_reconciliation'))[0], []);
    }
    await assertReconciliationBlocked('');
    const originFile = join(originDirectory, takeover ? 'takeover.json' : 'origins.json');
    const writeOrigins = (classified: mysql.RowDataPacket[]) => writeFileSync(originFile, JSON.stringify({
      serverUuid: target.serverUuid, schema: target.schemaName, baselineChecksum: baseline.checksum, accounts: classified,
    }), { mode: 0o600 });
    if (takeover) {
      const [oldCandidates] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT u.id FROM users u JOIN app_schema_migrations m ON m.migration_id='000_schema_baseline.sql' WHERE u.created_at <= m.finished_at",
      );
      const oldIds = new Set(oldCandidates.map(account => account.id));
      const incomplete = origins.filter(account => oldIds.has(account.id));
      assert.equal(incomplete.filter(account => account.source === 'development-seed').length, 0);
      assert.ok(incomplete.length > 0);
      assert.equal(origins.length - incomplete.length, 2);
      writeOrigins(incomplete);
      await assertReconciliationBlocked(originFile);
    }
    writeOrigins(origins);
    await start({ SLIDE_LEGACY_ACCOUNT_ORIGINS_FILE: originFile });
    assert.deepEqual(await readLegacyLedger(), oldLedger);
    assert.deepEqual(await accounts(), beforeUpgrade);
    assert.deepEqual(await readSeeds(), beforeSeeds.map(seed => ({
      ...seed, status: 'inactive', session_version: Number(seed.session_version) + 1,
    })));
    await login('fixture-admin', existingPassword, 401);
    await login('fixture-user', existingPassword, 401);
    await permissions(seedSession.token, 401);
    await permissions(seedViewerSession.token, 401);
    const revokedSeedRead = await readUsers(seedSession.token);
    assert.equal(revokedSeedRead.status, 401);
    await revokedSeedRead.body?.cancel();
    await permissions(existingSession.token, 200);
    const viewer = await login('user', existingPassword, 200);
    await permissions(viewer.token, 200);
    assert.deepEqual(await accounts(), beforeUpgrade);
    const legacy = await login('admin', existingPassword, 200);
    await permissions(legacy.token, 200);
    let afterLogin = await accounts();
    for (let attempt = 0; attempt < 60 && afterLogin.find(row => row.username === 'admin')?.password_hash === shaHash; attempt++) {
      await delay(100);
      afterLogin = await accounts();
    }
    const rehashed = afterLogin.find(row => row.username === 'admin')?.password_hash;
    assert.match(rehashed, /^\$2/);
    assert.equal(await bcrypt.compare(existingPassword, rehashed), true);
    assert.deepEqual(afterLogin.map(row => row.username === 'admin' ? { ...row, password_hash: shaHash } : row), beforeUpgrade);
    const retained = await login('operator', env.INITIAL_ADMIN_PASSWORD, 200); await permissions(retained.token, 200);
    if (takeover) {
      const classification = readFileSync(originFile);
      const newUsername = 'post-takeover-user';
      const newPassword = 'synthetic-post-takeover-password';
      const created = await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { authorization: `Bearer ${retained.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ username: newUsername, password: newPassword }),
      });
      assert.equal(created.status, 201);
      await created.body?.cancel();
      const [[{ id: userId }]] = await pool.query<mysql.RowDataPacket[]>('SELECT id FROM users WHERE username=?', [newUsername]);
      assert.ok(userId && !origins.some(account => account.id === userId));
      const regular = await login(newUsername, newPassword, 200);
      await permissions(regular.token, 200);
      const seedState = await readSeeds();
      const readUsersAfterTakeover = async () => (await pool.query<mysql.RowDataPacket[]>(
        `SELECT u.id,u.username,u.status,u.session_version,u.password_hash,r.name AS role
         FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id
         WHERE u.username IN ('operator',?) ORDER BY u.id,r.name`, [newUsername],
      ))[0];
      const newAccounts = await readUsersAfterTakeover();
      assert.equal(newAccounts.find(account => account.username === 'operator')?.role, 'admin');
      assert.equal(newAccounts.find(account => account.username === newUsername)?.role, null);
      for (let restart = 1; restart <= 2; restart++) {
        await stop();
        await start({ SLIDE_LEGACY_ACCOUNT_ORIGINS_FILE: originFile });
        for (const token of [existingSession.token, retained.token, regular.token]) await permissions(token, 200);
        await login('admin', existingPassword, 200);
        await login('user', existingPassword, 200);
        await login('operator', env.INITIAL_ADMIN_PASSWORD, 200);
        await login(newUsername, newPassword, 200);
        await login('fixture-admin', existingPassword, 401);
        await login('fixture-user', existingPassword, 401);
        await permissions(seedSession.token, 401);
        await permissions(seedViewerSession.token, 401);
        assert.deepEqual(await accounts(), afterLogin);
        assert.deepEqual(await readUsersAfterTakeover(), newAccounts);
        assert.deepEqual(await readLegacyLedger(), oldLedger);
        assert.deepEqual(await readSeeds(), seedState);
        assert.deepEqual(readFileSync(originFile), classification);
      }
      console.log('Adopted production restart twice with original classification: old and new users, sessions, RBAC, seeds and ledger: PASS');
    }
    await stop();
    console.log('Upgrade: both existing accounts, RBAC and live session retained; SHA login upgrades only its hash: PASS');
    console.log('Upgrade: proven development seed credentials and both prior sessions rejected: PASS');
    if (takeover) console.log('Cross-session init-db --baseline: old cutoff excluded both seeds; missing and cutoff-only classifications blocked before HTTP startup; complete classification preserved the adopted ledger: PASS');
  }
  let listenerSeen = false;
  const invalid = launch(['start'], { INITIAL_ADMIN_PASSWORD: '' });
  for (let attempt = 0; invalid.exitCode === null && invalid.signalCode === null && attempt < 1200; attempt++) {
    try { await fetch(`${base}/api/health`); listenerSeen = true; } catch {}
    await delay(50);
  }
  assert.notEqual(invalid.exitCode, null, 'invalid startup must terminate');
  assert.notEqual(invalid.exitCode, 0); assert.equal(listenerSeen, false);
  await stop();
  console.log('Invalid production bootstrap config: nonzero exit, HTTP listener never available: PASS');
} catch (error) {
  businessError = error;
  throw error;
} finally {
  const errors: unknown[] = [];
  for (const cleanup of [() => stop(), () => pool.end(), () => admin.query(`DROP DATABASE ${database}`), () => admin.end(), () => rmSync(originDirectory, { recursive: true, force: true })]) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError([...(businessError ? [businessError] : []), ...errors], 'Bootstrap acceptance cleanup failed; original business failure retained');
}
console.log('MAX-267 formal-entry HTTP acceptance PASS; schemas removed; child processes stopped; LLM calls=0');
