/** MAX-601/#341, MAX-602/#365, MAX-603/#435.
 * Explicit opt-in: real isolated MySQL, JWT/permissions, HTTP, controlled SNMP/SSH.
 * Default test collection neither reads developer credentials nor opens sockets.
 */
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { createSocket, type Socket } from 'node:dgram';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as snmp from 'net-snmp';
import { Server as SshServer } from 'ssh2';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import Fastify from 'fastify';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { createVerifyToken } from '../auth-middleware.js';
import { MigrationRunner } from '../migrations/runner.js';
import type { MigrationPool } from '../migrations/types.js';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from '../testing/owned-fixture.js';
import { networkDeviceDatabaseService as store } from './network-device-database-service.js';
import { registerNetworkDeviceRoutes } from './network-device-routes.js';
import { verifySshHostKey } from './config-backup-service.js';
import { createAssetCollectorAccess } from '../metrics/config/access.js';
import { createConfigurationRegistry } from '../metrics/config/registry.js';
import { runPackage } from '../metrics/packages/runner.js';

const enabled = process.env.MAX601_MYSQL === '1';
const browserEnabled = process.env.MAX601_BROWSER === '1';
const output = process.env.MAX601_EVIDENCE_DIR;
const host = process.env.MAX601_SNMP_HOST;
const v2 = { version: 2, community: randomBytes(16).toString('hex') };
const v2Rotated = { version: 2, community: randomBytes(16).toString('hex') };
const v3 = { username: 'max601-monitor', securityLevel: 'authPriv', authProtocol: 'SHA', authSecret: randomBytes(16).toString('hex'), privacyProtocol: 'AES', privacySecret: randomBytes(16).toString('hex') };
const v3Rotated = { ...v3, username: 'max601-rotated', authSecret: randomBytes(16).toString('hex'), privacySecret: randomBytes(16).toString('hex') };
const ssh = { username: 'max601-backup', credentialType: 'password' as const, credentialValue: randomBytes(16).toString('hex') };
const secret = randomBytes(32).toString('hex');
const token = jwt.sign({ userId: 1, sessionVersion: 1 }, secret, { expiresIn: '1h' });

async function freePort() {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

describe.skipIf(!enabled)('MAX-601 real SNMP credential workflow', () => {
  let root: Pool, pool: Pool, owned: OwnedDatabase, deviceId: number, endpoint: number, sshPort: number;
  let agent: ReturnType<typeof snmp.createAgent>, sshServer: SshServer;
  let browser: Browser | undefined, vite: ChildProcess | undefined;
  let app: ReturnType<typeof Fastify>, base: string;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  let packets = 0, sshConnections = 0;
  const clients = new Set<{ end(): void }>();
  const evidence: Record<string, unknown> = { hardware: false, scope: 'owned MySQL + controlled SNMP UDP/SSH TCP + real application HTTP and collector access', checks: [], cleanup: {} };
  const mark = (check: string) => (evidence.checks as string[]).push(check);
  const rows = async (sql: string, values: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, values as never))[0];
  const snapshot = () => rows('SELECT * FROM network_device_credentials WHERE device_id=? ORDER BY protocol', [deviceId]);
  const call = async (method: 'POST' | 'PUT' | 'GET', url: string, payload?: unknown, status = 200, bearer = token) => {
    const response = await app.inject({ method, url, headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, ...(payload === undefined ? {} : { payload }) });
    // Never include request bodies / credentials in assertion diagnostics.
    expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status);
    return response.json();
  };
  const update = (payload: unknown) => call('PUT', `/api/network-devices/${deviceId}`, payload);
  const collect = async (version: 2 | 3) => {
    const ref = { type: 'network_device' as const, id: deviceId };
    const access = await createAssetCollectorAccess().resolve(ref);
    expect(String(access.resource.attributes['snmp.version'].value)).toBe(String(version));
    const registry = createConfigurationRegistry();
    const pkg = registry.list().map(r => r.package).find(p => p.id === 'snmp-standard')!;
    const result = await runPackage(registry, { package: { id: pkg.id, version: pkg.version, digest: pkg.digest }, credential_ref: access.credential_ref, overrides: { enabled: true } }, {
      ...access, binding_id: 'max601', attempt_id: randomBytes(8).toString('hex'), config_revision: 1,
      observed_at: new Date().toISOString(), metric_keys: ['snmp.agent.uptime_seconds@1.0.0'],
    });
    const observation = result.observations.find(o => o.observation.metric.id === 'snmp.agent.uptime_seconds')?.observation;
    expect(observation?.quality.status).toBe('good');
    expect(observation?.value).toMatchObject({ value: 95 });
    expect(packets).toBeGreaterThan(0);
  };
  beforeAll(async () => {
    if (!output || !host || host.startsWith('127.')) throw Error('MAX601_EVIDENCE_DIR and owned nonloopback MAX601_SNMP_HOST required');
    const config = JSON.parse(process.env.MAX601_MYSQL_CONFIG ?? 'null');
    if (!config || !config.port || Number(config.port) === 3306 || config.database) throw Error('explicit non3306 root connection config without database required');
    mkdirSync(output, { recursive: true });
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    root = mysql.createPool(config);
    owned = await createOwnedDatabase(root, { nonce: generateRunNonce(), purpose: 'snmpcredentials', handleDir: join(output, 'handles') });
    // Small pool also detects accidental nested acquisition while holding transaction locks.
    pool = mysql.createPool({ ...config, database: owned.database, connectionLimit: 2, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    await pool.query('UPDATE users SET session_version=1 WHERE id=1');
    await pool.query("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT 1,id FROM roles WHERE name='admin'");
    await pool.query("INSERT INTO users(username,password_hash,session_version) VALUES('max601-reader','fixture-not-for-login',1)");
    const reader = (await rows("SELECT id FROM users WHERE username='max601-reader'"))[0].id;
    await pool.query("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE name='dba'", [reader]);
    evidence.readerId = reader;
    const probe = createSocket('udp4'); probe.bind(0, host); await once(probe, 'listening'); endpoint = probe.address().port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    agent = snmp.createAgent({ address: host, port: endpoint }, () => { packets++; });
    agent.getAuthorizer().addCommunity(v2.community); agent.getAuthorizer().addCommunity(v2Rotated.community);
    for (const credentials of [v3, v3Rotated]) agent.getAuthorizer().addUser({ name: credentials.username, level: snmp.SecurityLevel.authPriv,
      authProtocol: snmp.AuthProtocols.sha, authKey: credentials.authSecret, privProtocol: snmp.PrivProtocols.aes, privKey: credentials.privacySecret });
    await Promise.all(Object.values(agent.listener.sockets).map(s => once(s as Socket, 'listening')));
    agent.getMib().registerProvider({ name: 'uptime', type: snmp.MibProviderType.Scalar, oid: '1.3.6.1.2.1.1.3', scalarType: snmp.ObjectType.TimeTicks, maxAccess: snmp.MaxAccess['read-only'] });
    agent.getMib().setScalarValue('uptime', 9500);
    const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
    sshServer = new SshServer({ hostKeys: [key] }, client => {
      clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
      client.on('authentication', ctx => ctx.method === 'password' && ctx.username === ssh.username && ctx.password === ssh.credentialValue ? ctx.accept() : ctx.reject());
      client.on('ready', () => { sshConnections++; });
    });
    sshServer.listen(0, host); await once(sshServer, 'listening'); sshPort = (sshServer.address() as { port: number }).port;
    app = Fastify(); await registerNetworkDeviceRoutes(app, createVerifyToken(secret));
    base = await app.listen({ host: '127.0.0.1', port: 0 });
    const created = await call('POST', '/api/network-devices', { name: 'MAX601 受控交换机', host, snmpPort: endpoint, sshPort, snmpv2c: v2, ssh }, 201);
    deviceId = created.id; expect(created.snmpVersion).toBe(2);
    evidence.environment = { database: owned.database, mysqlPort: config.port, poolLimit: 2, snmpHost: host, snmpPort: endpoint, sshPort, apiBase: base, deviceId };
    mark('real JWT + API create + encrypted SNMP/SSH credentials');
  }, 60000);

  afterAll(async () => {
    const errors: string[] = [];
    const cleanup = async (name: string, action: () => Promise<unknown>) => { try { await action(); } catch { errors.push(name); } };
    await cleanup('browser', async () => { await browser?.close(); });
    await cleanup('vite', async () => { if (vite && vite.exitCode === null) { const exited = once(vite, 'exit'); vite.kill('SIGTERM'); await exited; } });
    await cleanup('http', async () => { await app?.close(); });
    await cleanup('snmp', async () => { if (agent) await new Promise<void>(r => agent.close(() => r())); });
    await cleanup('ssh', async () => { for (const client of clients) client.end(); if (sshServer) await new Promise<void>(r => sshServer.close(() => r())); });
    poolSpy?.mockRestore();
    await cleanup('pool', async () => { await pool?.end(); });
    await cleanup('schema', async () => { await owned?.drop(); });
    await cleanup('root', async () => { await root?.end(); });
    vi.unstubAllEnvs();
    evidence.packets = packets; evidence.sshConnections = sshConnections; evidence.cleanup = { complete: errors.length === 0, errors };
    if (output) writeFileSync(join(output, 'real-workflow.json'), JSON.stringify(evidence, null, 2));
    expect(errors).toEqual([]);
  }, 30000);

  it('switches v2c→v3→v2c, rotates both protocols and preserves functioning SSH', async () => {
    const beforeSsh = (await snapshot()).find(r => r.protocol === 'ssh');
    await collect(2);
    const stale = await createAssetCollectorAccess().resolve({ type: 'network_device', id: deviceId });
    for (const [payload, version] of [[{ snmpv3: v3 }, 3], [{ snmpv3: v3Rotated }, 3], [{ snmpv2c: v2Rotated }, 2], [{ snmpv2c: v2 }, 2]] as const) {
      expect((await update(payload)).snmpVersion).toBe(version);
      const credentials = await snapshot();
      expect(credentials.map(r => r.protocol)).toEqual([version === 2 ? 'snmpv2c' : 'snmpv3', 'ssh']);
      expect(credentials.find(r => r.protocol === 'ssh')).toEqual(beforeSsh);
      await collect(version);
    }
    // Back to exactly the starting credential: capture a different snapshot then change it again.
    await update({ snmpv3: v3 });
    await expect(stale.assertCurrent!()).rejects.toMatchObject({ code: 'permission_denied' });
    const saved = await store.getCredentials(deviceId, 'ssh');
    expect(saved?.credentialValue === ssh.credentialValue).toBe(true);
    await verifySshHostKey({ host: host!, port: sshPort, ...ssh });
    expect(sshConnections).toBe(1);
    mark('bidirectional version switch + v2c/v3 rotation + current collector + stale access rejection + SSH retention and TCP authentication');
  }, 30000);

  it('uses identical alias parsing through real POST and PUT, rejecting missing/conflicting input atomically', async () => {
    for (const credential of [{ snmp: { version: 2, communityString: v2.community } }, { snmpv2: { community: v2.community } }, { version: 2, snmp: v2 }, { version: 3, snmp: v3 }]) {
      await update(credential);
      const created = await call('POST', '/api/network-devices', { name: 'alias-only', host: '192.0.2.61', ...credential }, 201);
      expect(created.snmpVersion).toBe((await store.getDeviceById(deviceId))?.snmpVersion);
      await pool.execute('DELETE FROM network_devices WHERE id=?', [created.id]);
    }
    const before = await snapshot();
    for (const input of [{ version: 2 }, { version: 3 }, { snmp: {} }, { snmpv3: { authSecret: 'partial-only' } }, { snmpv2c: v2, snmpv3: v3 }, { version: 3, snmp: v2 }]) {
      await call('PUT', `/api/network-devices/${deviceId}`, input, 400);
      await call('POST', '/api/network-devices', { name: 'invalid', host: '192.0.2.62', ...input }, 400);
    }
    expect(await snapshot()).toEqual(before);
    mark('public HTTP create/update aliases + top-level version + legacy communityString + clear 400 failures with unchanged persisted credentials');
  });

  it('rolls back metadata, SNMP replacement and ciphertext on real SQL failure', async () => {
    for (const [initial, replacement, version] of [[{ snmpv2c: v2 }, { snmpv3: v3 }, 2], [{ snmpv3: v3 }, { snmpv2c: v2 }, 3]] as const) {
      await update(initial);
      const before = await snapshot();
      const device = await store.getDeviceById(deviceId);
      await pool.query("CREATE TRIGGER max601_fail_delete BEFORE DELETE ON network_device_credentials FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MAX601_INJECTED_FAILURE'");
      try {
        await call('PUT', `/api/network-devices/${deviceId}`, { name: 'must-rollback', ...replacement }, 400);
        expect(await snapshot()).toEqual(before);
        expect((await store.getDeviceById(deviceId))?.name).toBe(device?.name);
        await collect(version);
      } finally { await pool.query('DROP TRIGGER max601_fail_delete'); }
    }
    await pool.query("CREATE TRIGGER max601_fail_ssh BEFORE INSERT ON network_device_credentials FOR EACH ROW BEGIN IF NEW.protocol='ssh' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MAX601_INJECTED_FAILURE'; END IF; END");
    try {
      await call('POST', '/api/network-devices', { name: 'create-must-rollback', host: '192.0.2.63', snmpv2c: v2, ssh }, 400);
      expect(await rows("SELECT id FROM network_devices WHERE name='create-must-rollback'")).toHaveLength(0);
      expect((await rows('SELECT c.id FROM network_device_credentials c LEFT JOIN network_devices d ON d.id=c.device_id WHERE d.id IS NULL'))).toHaveLength(0);
    } finally { await pool.query('DROP TRIGGER max601_fail_ssh'); }
    mark('real MySQL trigger failures in both switch directions roll back metadata + ciphertext; creation SSH insert failure also rolls back device and SNMP');
  });

  it('serializes concurrent opposite-version updates and rotates on a two-connection pool', async () => {
    const results = await Promise.all([store.updateDevice(deviceId, { snmpv3: v3Rotated }), store.updateDevice(deviceId, { snmpv2c: v2Rotated })]);
    expect(results).toEqual([{ success: true }, { success: true }]);
    const credentials = await snapshot();
    expect(credentials.filter(r => r.protocol !== 'ssh')).toHaveLength(1);
    const active = await store.getCredentials(deviceId);
    await collect(active!.protocol === 'snmpv2c' ? 2 : 3);
    mark('concurrent opposite-version updates both commit without deadlock or dual active rows; two-connection pool');
  });

  it('denies unauthenticated/read-only/revoked sessions without changing credentials', async () => {
    const before = await snapshot();
    const readerId = Number(evidence.readerId);
    const readerToken = jwt.sign({ userId: readerId, sessionVersion: 1 }, secret, { expiresIn: '1h' });
    await call('PUT', `/api/network-devices/${deviceId}`, { snmpv3: v3 }, 401, '');
    await call('PUT', `/api/network-devices/${deviceId}`, { snmpv3: v3 }, 403, readerToken);
    await pool.query('UPDATE users SET session_version=2 WHERE id=?', [readerId]);
    await call('PUT', `/api/network-devices/${deviceId}`, { snmpv3: v3 }, 401, readerToken);
    expect(await snapshot()).toEqual(before);
    const publicDto = JSON.stringify(await call('GET', `/api/network-devices/${deviceId}`));
    for (const plaintext of [v2.community, v3.authSecret, v3.privacySecret, ssh.credentialValue]) expect(publicDto.includes(plaintext)).toBe(false);
    expect(publicDto).not.toMatch(/encrypted|authSecret|privacySecret|credentialValue/);
    mark('real JWT/role/session revocation 401/403; unchanged secrets; public inventory exposes version but no credentials');
  });

  it.skipIf(!browserEnabled)('edits via Chromium and real HTTP/MySQL, with keyboard/focus and desktop layout checks', async () => {
    await update({ snmpv3: v3 });
    const port = await freePort();
    const viteEntry = resolve('../../frontend/node_modules/vite/bin/vite.js');
    vite = spawn(process.execPath, [viteEntry, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve('../../frontend'), stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Vite readiness timeout')), 15000);
      vite!.once('exit', () => { clearTimeout(timer); reject(Error('Vite exited before readiness')); });
      vite!.stdout!.on('data', chunk => { if (String(chunk).includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } });
    });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const writes: string[][] = [];
    await page.addInitScript(({ token }) => { const storage = (globalThis as any).localStorage; storage.setItem('token', token); storage.setItem('permissions', JSON.stringify(['*'])); }, { token });
    await page.route(url => url.pathname.startsWith('/api/'), async route => {
      if (route.request().method() === 'PUT') writes.push(Object.keys(route.request().postDataJSON()));
      const result = await route.fetch({ url: `${base}${new URL(route.request().url()).pathname}` });
      await route.fulfill({ response: result });
    });
    await page.route('**/snmp-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>MAX601 受控协议验收</title><body><network-devices-page></network-devices-page><script type="module">import "/src/app/styles.css"; import "/src/app/ui/views/network-devices-page.ts";</script></body></html>' }));
    await page.goto(`http://127.0.0.1:${port}/snmp-fixture`);
    const edit = page.getByRole('button', { name: '编辑', exact: true });
    const save = page.getByRole('button', { name: '保存', exact: true });
    for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      await edit.click();
      await browserExpect(page.getByRole('heading', { name: '编辑网络设备' })).toBeFocused();
      await browserExpect(page.getByLabel('SNMP 版本', { exact: true })).toHaveValue('3');
      const auth = page.getByLabel('认证密钥', { exact: true });
      for (const name of ['SNMP 版本', 'SNMPv3 用户名', '安全级别', '认证协议', '认证密钥', '隐私密钥']) {
        await browserExpect(page.getByLabel(name, { exact: true })).toHaveAccessibleName(name);
      }
      await auth.fill(v3.authSecret);
      await save.click();
      await browserExpect(page.getByRole('alert')).toContainText('SNMPv3 用户名');
      expect(writes).toHaveLength(0);
      await auth.focus(); await auth.press('Tab');
      await browserExpect(page.getByLabel('隐私密钥', { exact: true })).toBeFocused();
      await save.scrollIntoViewIfNeeded(); await browserExpect(save).toBeInViewport();
      await page.screenshot({ path: join(output!, `editor-${width}.png`) });
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await browserExpect(edit).toBeFocused();
    }
    await edit.click();
    await save.click(); // all blank retains v3
    await browserExpect(edit).toBeFocused(); expect(writes).toHaveLength(1); expect(writes[0]).not.toContain('snmpv3');
    expect((await store.getCredentials(deviceId))?.protocol).toBe('snmpv3');
    await edit.click(); await page.getByLabel('SNMP 版本', { exact: true }).selectOption('2');
    await save.click();
    await browserExpect(page.getByRole('alert')).toContainText('切换版本'); expect(writes).toHaveLength(1);
    await page.getByLabel('Community', { exact: true }).fill(v2Rotated.community);
    await save.click(); await browserExpect(edit).toBeFocused();
    expect(writes[1]).toContain('snmpv2c'); await collect(2);
    await edit.click(); await page.getByLabel('SNMP 版本', { exact: true }).selectOption('3');
    await page.getByLabel('SNMPv3 用户名', { exact: true }).fill(v3Rotated.username);
    await page.getByLabel('认证密钥', { exact: true }).fill(v3Rotated.authSecret);
    await page.getByLabel('隐私密钥', { exact: true }).fill(v3Rotated.privacySecret);
    await save.click(); await browserExpect(edit).toBeFocused();
    expect(writes[2]).toContain('snmpv3'); await collect(3);
    evidence.browser = { version: browser.version(), viewports: ['1440x900', '1366x768', '1920x1080'], requestFields: writes, noTraceOrSecretRecording: true };
    mark('Chromium actual PUT → parser → MySQL → collector; partial/switch errors, blank retain, both version changes, named fields, Tab, dialog focus/restore, visible save at three desktop sizes');
    await page.unrouteAll({ behavior: 'wait' }); await context.close();
  }, 60000);
});
