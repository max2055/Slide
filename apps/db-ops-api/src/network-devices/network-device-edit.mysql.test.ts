/** MAX-609/#552, MAX-610/#605, MAX-613/#720.
 * Explicit opt-in only; default collection never reads credentials or opens sockets.
 * Config is injected by the caller; all writes use a run-owned disposable schema.
 */
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
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
import { addNetworkDeviceTool } from '../tools/generated/slide-self-mgmt/add_network_device.js';

const enabled = process.env.MAX609_MYSQL === '1';
const browserEnabled = process.env.MAX609_BROWSER === '1';
const output = process.env.MAX609_EVIDENCE_DIR;
const secret = randomBytes(32).toString('hex');
const token = jwt.sign({ userId: 1, sessionVersion: 1 }, secret, { expiresIn: '1h' });

describe.skipIf(!enabled)('MAX-609 real network-device edit contract', () => {
  let root: Pool, pool: Pool, owned: OwnedDatabase, deviceId: number;
  let browser: Browser | undefined, vite: ChildProcess | undefined;
  let app: ReturnType<typeof Fastify>, base: string;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  const evidence: Record<string, unknown> = { scope: 'owned MySQL + real JWT/HTTP + Chromium; no device protocol operations', checks: [], cleanup: {} };
  const mark = (check: string) => (evidence.checks as string[]).push(check);
  const rows = async (sql: string, values: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, values as never))[0];
  const call = async (method: 'POST' | 'PUT' | 'GET', url: string, payload?: unknown, status = 200, bearer = token) => {
    const response = await app.inject({ method, url, headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, ...(payload === undefined ? {} : { payload }) });
    expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status);
    return response.json();
  };
  const update = (payload: unknown, status = 200) => call('PUT', `/api/network-devices/${deviceId}`, payload, status);
  const metadata = async () => (await rows('SELECT os_version,serial_number,snmp_port,ssh_port FROM network_devices WHERE id=?', [deviceId]))[0];

  beforeAll(async () => {
    if (!output) throw Error('MAX609_EVIDENCE_DIR required');
    const config = JSON.parse(process.env.MAX609_MYSQL_CONFIG ?? 'null');
    if (!config || !config.port || Number(config.port) === 3306 || config.database) throw Error('explicit non3306 root connection config without database required');
    mkdirSync(output, { recursive: true });
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    root = mysql.createPool(config);
    owned = await createOwnedDatabase(root, { nonce: generateRunNonce(), purpose: 'networkedit', handleDir: join(output, 'handles') });
    pool = mysql.createPool({ ...config, database: owned.database, connectionLimit: 2, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    await pool.query('UPDATE users SET session_version=1 WHERE id=1');
    await pool.query("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT 1,id FROM roles WHERE name='admin'");
    app = Fastify(); await registerNetworkDeviceRoutes(app, createVerifyToken(secret));
    base = await app.listen({ host: '127.0.0.1', port: 0 });
    const created = await call('POST', '/api/network-devices', { name: 'MAX609 编辑设备', host: '192.0.2.109', osVersion: 'old-os', serialNumber: 'old-serial', snmpPort: 1161, sshPort: 2222, snmpv2c: { community: randomBytes(12).toString('hex') }, collectionEnabled: false }, 201);
    deviceId = created.id;
    evidence.environment = { database: owned.database, mysqlPort: config.port, poolLimit: 2, apiBase: base, deviceId };
  }, 60000);

  afterAll(async () => {
    const errors: string[] = [];
    const cleanup = async (name: string, action: () => Promise<unknown>) => { try { await action(); } catch { errors.push(name); } };
    await cleanup('browser', async () => { await browser?.close(); });
    await cleanup('vite', async () => { if (vite && vite.exitCode === null) { const exited = once(vite, 'exit'); vite.kill('SIGTERM'); await exited; } });
    await cleanup('http', async () => { await app?.close(); });
    poolSpy?.mockRestore();
    await cleanup('pool', async () => { await pool?.end(); });
    await cleanup('schema', async () => { await owned?.drop(); });
    await cleanup('root', async () => { await root?.end(); });
    vi.unstubAllEnvs();
    evidence.cleanup = { complete: errors.length === 0, errors };
    if (output) writeFileSync(join(output, 'real-edit-workflow.json'), JSON.stringify(evidence, null, 2));
    expect(errors).toEqual([]);
  }, 30000);

  it('persists omitted/new/null metadata through both aliases, rejects conflicting aliases atomically', async () => {
    const credentials = (await rows('SELECT * FROM network_device_credentials WHERE device_id=?', [deviceId]));
    await update({ name: 'MAX609 编辑设备' });
    expect(await metadata()).toMatchObject({ os_version: 'old-os', serial_number: 'old-serial' });
    for (const [os, serial] of [['osVersion', 'serialNumber'], ['os_version', 'serial_number']]) {
      await update({ [os]: 'new-os', [serial]: 'new-serial' });
      expect(await metadata()).toMatchObject({ os_version: 'new-os', serial_number: 'new-serial' });
      await update({ [os]: null, [serial]: null });
      expect(await metadata()).toMatchObject({ os_version: null, serial_number: null });
    }
    await update({ osVersion: 'same', os_version: 'same', serialNumber: null, serial_number: null });
    const before = await metadata();
    for (const input of [{ osVersion: null, os_version: 'old' }, { osVersion: 'new', os_version: null }, { serialNumber: 'a', serial_number: 'b' }]) {
      expect(await update({ name: 'must-not-save', ...input }, 400)).toMatchObject({ error: 'NETWORK_DEVICE_ALIAS_CONFLICT' });
      expect(await metadata()).toEqual(before);
      expect((await store.getDeviceById(deviceId))?.name).toBe('MAX609 编辑设备');
    }
    expect(await rows('SELECT * FROM network_device_credentials WHERE device_id=?', [deviceId])).toEqual(credentials);
    mark('#552 real POST/PUT/SELECT: omit retains, assign replaces, both null aliases clear, equal aliases accepted, conflicting aliases 400 with no writes, credentials retained');
  });

  it('rejects invalid ports without writes and enforces real JWT authorization', async () => {
    const before = await metadata();
    for (const key of ['snmpPort', 'sshPort']) for (const value of [0, 70000, -1, 1.5, '']) {
      await update({ [key]: value }, 400); expect(await metadata()).toEqual(before);
    }
    await call('PUT', `/api/network-devices/${deviceId}`, { osVersion: null }, 401, '');
    await pool.query("INSERT INTO users(username,password_hash,session_version) VALUES('max609-no-permission','fixture-not-for-login',1)");
    const readerId = (await rows("SELECT id FROM users WHERE username='max609-no-permission'"))[0].id;
    const readerToken = jwt.sign({ userId: readerId, sessionVersion: 1 }, secret, { expiresIn: '1h' });
    await call('PUT', `/api/network-devices/${deviceId}`, { osVersion: null }, 403, readerToken);
    expect(await metadata()).toEqual(before);
    mark('invalid ports reject before persistence + real JWT unauthenticated/permission denied preserve data');
  });

  it('classifies a real concurrent unique-key loser exactly like the precheck and retains transient failure retryability', async () => {
    const context = { actor: { userId: 1 } as any } as any;
    const input = { name: 'race-winner', host: '192.0.2.110', snmp_port: 1161 };
    const originalRead = store.getAllDevices.bind(store);
    let checked = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const read = vi.spyOn(store, 'getAllDevices').mockImplementation(async () => {
      const result = await originalRead();
      if (++checked <= 2) { if (checked === 2) release(); await barrier; }
      return result;
    });
    const creates = vi.spyOn(store, 'createDevice');
    try {
      const outcomes = await Promise.all([addNetworkDeviceTool.handler(input, context), addNetworkDeviceTool.handler(input, context)]);
      expect(outcomes.filter(result => result.success)).toHaveLength(1);
      const loser = outcomes.find(result => !result.success)!;
      expect(loser).toMatchObject({ errorCode: 'NETWORK_DEVICE_EXISTS', details: { retryable: false, terminal: true } });
      expect(loser).toEqual(await addNetworkDeviceTool.handler(input, context));
      const persisted = await rows('SELECT id FROM network_devices WHERE host=? AND snmp_port=?', [input.host, input.snmp_port]);
      expect(persisted).toHaveLength(1);
      const results = await Promise.all(creates.mock.results.map(result => result.value));
      expect(results.filter(result => result.errorCode === 'NETWORK_DEVICE_EXISTS')).toHaveLength(1);
      evidence.race = { outcomes: outcomes.map(r => ({ success: r.success, errorCode: r.errorCode, details: r.details })), rowCount: persisted.length, synchronizedPrechecks: 2 };
    } finally { read.mockRestore(); creates.mockRestore(); }
    await pool.query("CREATE TRIGGER max609_insert_failure BEFORE INSERT ON network_devices FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MAX609_STORE_FAILURE'");
    try {
      expect(await addNetworkDeviceTool.handler({ ...input, host: '192.0.2.111' }, context)).toMatchObject({ errorCode: 'CREATE_NETWORK_DEVICE_FAILED', details: { retryable: true } });
    } finally { await pool.query('DROP TRIGGER max609_insert_failure'); }
    await pool.query('DELETE FROM network_devices WHERE host=?', [input.host]);
    mark('#605 real synchronized prechecks + two concurrent INSERT transactions + one persisted device + loser equals precheck result; SQL failure remains retryable');
  });

  it.skipIf(!browserEnabled)('creates/edits through Chromium and real HTTP/MySQL at three desktop sizes', async () => {
    const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>(r => socket.close(() => r()));
    vite = spawn(process.execPath, [resolve('../../frontend/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve('../../frontend'), stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Vite readiness timeout')), 15000);
      vite!.once('exit', () => { clearTimeout(timer); reject(Error('Vite exited before readiness')); });
      vite!.stdout!.on('data', chunk => { if (String(chunk).includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } });
    });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(); const page = await context.newPage();
    let writes = 0;
    await page.addInitScript(({ token }) => { const storage = (globalThis as any).localStorage; storage.setItem('token', token); storage.setItem('permissions', JSON.stringify(['*'])); }, { token });
    await page.route(url => url.pathname.startsWith('/api/'), async route => {
      if (['POST', 'PUT'].includes(route.request().method()) && /^\/api\/network-devices(?:\/\d+)?$/.test(new URL(route.request().url()).pathname)) writes++;
      const response = await route.fetch({ url: `${base}${new URL(route.request().url()).pathname}` });
      await route.fulfill({ response });
    });
    await page.route('**/edit-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>MAX609 编辑验收</title><body><network-devices-page></network-devices-page><script type="module">import "/src/app/styles.css"; import "/src/app/ui/views/network-devices-page.ts";</script></body></html>' }));
    await page.goto(`http://127.0.0.1:${port}/edit-fixture`);
    const edit = page.getByRole('button', { name: '编辑', exact: true });
    const save = page.getByRole('button', { name: '保存', exact: true });
    for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
      await page.setViewportSize({ width, height }); await edit.click();
      await browserExpect(page.getByRole('heading', { name: '编辑网络设备' })).toBeFocused();
      for (const label of ['SNMP', 'SSH']) {
        const field = page.getByLabel(`${label} 端口`, { exact: true });
        await browserExpect(field).toHaveAccessibleName(`${label} 端口`);
        for (const value of ['', '0', '70000', '1.5']) {
          await field.fill(value); await browserExpect(field).toHaveValue(value);
          const before = writes; await save.click();
          await browserExpect(page.getByRole('alert')).toContainText(`${label} 端口`);
          expect(writes).toBe(before); await browserExpect(field).toHaveValue(value);
        }
        await field.fill(label === 'SNMP' ? '1161' : '2222');
      }
      await page.getByLabel('SNMP 端口', { exact: true }).focus(); await page.keyboard.press('Tab');
      await browserExpect(page.getByLabel('SSH 端口', { exact: true })).toBeFocused();
      await save.scrollIntoViewIfNeeded(); await browserExpect(save).toBeInViewport();
      await page.screenshot({ path: join(output!, `editor-${width}.png`) });
      await page.getByRole('button', { name: '取消', exact: true }).click(); await browserExpect(edit).toBeFocused();
    }
    await edit.click();
    await page.getByLabel('OS 版本（可选）', { exact: true }).fill('');
    await page.getByLabel('SNMP 端口', { exact: true }).fill('3161');
    await page.getByLabel('SSH 端口', { exact: true }).fill('3222');
    await save.click(); await browserExpect(edit).toBeFocused();
    expect(await metadata()).toMatchObject({ os_version: null, snmp_port: 3161, ssh_port: 3222 });
    await edit.click(); await browserExpect(page.getByLabel('SNMP 端口', { exact: true })).toHaveValue('3161');
    await browserExpect(page.getByLabel('SSH 端口', { exact: true })).toHaveValue('3222');
    await browserExpect(page.getByLabel('OS 版本（可选）', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    const add = page.getByRole('button', { name: '添加设备', exact: true });
    await add.click();
    await page.getByLabel('名称', { exact: true }).fill('MAX609 新建设备');
    await page.getByLabel('主机', { exact: true }).fill('192.0.2.112');
    await page.getByLabel('Community', { exact: true }).fill(randomBytes(12).toString('hex'));
    await page.getByLabel('SNMP 端口', { exact: true }).fill('');
    const before = writes; await save.click(); await browserExpect(page.getByRole('alert')).toContainText('SNMP 端口'); expect(writes).toBe(before);
    await page.getByLabel('SNMP 端口', { exact: true }).fill('65535');
    await page.getByLabel('SSH 端口', { exact: true }).fill('1');
    await save.click(); await browserExpect(add).toBeFocused();
    expect(await rows('SELECT snmp_port,ssh_port FROM network_devices WHERE host=?', ['192.0.2.112'])).toMatchObject([{ snmp_port: 65535, ssh_port: 1 }]);
    expect(writes).toBe(2);
    evidence.browser = { version: browser.version(), viewports: ['1440x900', '1366x768', '1920x1080'], successfulWrites: writes, noTraceOrSecretRecording: true };
    mark('#552/#720 Chromium actual edit and create → HTTP → MySQL; empty/zero/out-of-range/fraction blocked; valid/boundary ports persisted and reopened; OS null cleared; names, Tab, focus/restore, save visible');
    await page.unrouteAll({ behavior: 'wait' }); await context.close();
  }, 60000);
});
