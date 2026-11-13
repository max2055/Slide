/** MAX-611/#432 + MAX-612/#648. Opt-in real MySQL/HTTP/Chromium acceptance.
 * Inject MAX611_MYSQL_CONFIG (non-platform connection, no database) and evidence directory.
 * Uses production views, JWT middleware, relation routes/stores and instance update service.
 * The isolated HTTP composition omits the app shell, schedulers and device collectors.
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
import { requirePermission } from '../auth/require-permission.js';
import { requireInstanceAccess } from '../auth/require-instance-access.js';
import { MigrationRunner } from '../migrations/runner.js';
import type { MigrationPool } from '../migrations/types.js';
import { createOwnedDatabase, generateRunNonce, type OwnedDatabase } from '../testing/owned-fixture.js';
import { registerNetworkDeviceRoutes } from './network-device-routes.js';
import { registerInstanceHostRoutes } from '../instance-host-routes.js';
import { registerInstanceListRoutes } from '../instance-list-routes.js';
import { instanceHostService } from '../resources/instance-host-service.js';
import { instanceDatabaseService } from '../instance-database-service.js';
import { serverDatabaseService } from '../server-database-service.js';
import { publicServerDto } from '../security/public-dto.js';

const enabled = process.env.MAX611_MYSQL === '1';
const output = process.env.MAX611_EVIDENCE_DIR;
const roles = ['standalone', 'primary', 'replica', 'shard', 'arbiter', 'unknown'];
const labels = ['独立节点', '主节点', '副本', '分片', '仲裁节点', '未知角色'];

describe.skipIf(!enabled)('MAX-611 real persisted metadata in production views', () => {
  let root: Pool, pool: Pool, owned: OwnedDatabase, browser: Browser, vite: ChildProcess;
  let app: ReturnType<typeof Fastify>, base: string, token: string;
  let poolSpy: ReturnType<typeof vi.spyOn>, deviceId: number, instanceId: number;
  const serverIds: number[] = [];
  const evidence: Record<string, unknown> = { checks: [], scope: 'isolated composition; real MySQL + JWT/HTTP + production views in Chromium; no model/collector/production' };
  const rows = async (sql: string, values: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, values as never))[0];
  const call = async (method: 'POST' | 'PUT' | 'GET', url: string, payload?: unknown, status = 200, bearer = token) => {
    const response = await app.inject({ method, url, headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, ...(payload === undefined ? {} : { payload }) });
    expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status);
    return response.json();
  };

  beforeAll(async () => {
    if (!output) throw Error('MAX611_EVIDENCE_DIR required');
    const config = JSON.parse(process.env.MAX611_MYSQL_CONFIG ?? 'null');
    if (!config?.port || Number(config.port) === 3306 || config.database) throw Error('explicit non3306 connection without database required');
    mkdirSync(output, { recursive: true });
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    root = mysql.createPool(config);
    owned = await createOwnedDatabase(root, { nonce: generateRunNonce(), purpose: 'metadata', handleDir: join(output, 'handles') });
    pool = mysql.createPool({ ...config, database: owned.database, connectionLimit: 2, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    await pool.query('UPDATE users SET session_version=1 WHERE id=1');
    await pool.query("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT 1,id FROM roles WHERE name='admin'");
    const secret = randomBytes(32).toString('hex');
    token = jwt.sign({ userId: 1, sessionVersion: 1 }, secret, { expiresIn: '1h' });
    const verify = createVerifyToken(secret);
    app = Fastify();
    await registerNetworkDeviceRoutes(app, verify);
    await registerInstanceListRoutes(app, verify);
    await registerInstanceHostRoutes(app, {
      verifyToken: verify, service: instanceHostService, serverLookup: serverDatabaseService,
      evidenceService: { collect: async () => { throw Error('not part of metadata acceptance'); } },
    });
    app.get('/api/servers', { preHandler: [verify, requirePermission('servers:view')] }, async () => (await serverDatabaseService.getAllServers()).map(s => publicServerDto(s as unknown as Record<string, unknown>)));
    // Same production update service and permission chain as the inline server.ts handler.
    app.put('/api/database/instances/:id', { preHandler: [verify, requirePermission('instance:update'), requireInstanceAccess('read-write')] }, async (request, reply) => {
      const result = await instanceDatabaseService.updateInstance(Number((request.params as { id: string }).id), request.body as Parameters<typeof instanceDatabaseService.updateInstance>[1]);
      return reply.code(result.success ? 200 : 400).send(result);
    });
    base = await app.listen({ host: '127.0.0.1', port: 0 });
    deviceId = (await call('POST', '/api/network-devices', { name: 'MAX611 设备', host: '192.0.2.111', collectionEnabled: false }, 201)).id;
    await pool.query("INSERT INTO database_instances(name,environment,db_type,host,port,username,password_encrypted) VALUES('MAX611 实例','testing','mysql','192.0.2.112',3308,'metadata','')");
    instanceId = Number((await rows('SELECT id FROM database_instances'))[0].id);
    for (let i = 0; i < roles.length; i++) {
      await pool.query("INSERT INTO servers(host,label,os_type,credential_type,credential_encrypted,collection_enabled) VALUES(?,?,'Linux','password','',0)", [`192.0.2.${120 + i}`, `MAX611 ${roles[i]}`]);
      serverIds.push(Number((await rows('SELECT id FROM servers WHERE label=?', [`MAX611 ${roles[i]}`]))[0].id));
    }
    const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>(resolve => socket.close(() => resolve()));
    const viteConfig = join(output, 'vite.config.mjs');
    writeFileSync(viteConfig, `export default ${JSON.stringify({ server: { proxy: { '/api': { target: base } } } })};`);
    vite = spawn(process.execPath, [resolve('../../frontend/node_modules/vite/bin/vite.js'), '--config', viteConfig, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve('../../frontend'), stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Vite readiness timeout')), 15000);
      vite.once('exit', () => { clearTimeout(timer); reject(Error('Vite exited before readiness')); });
      vite.stdout!.on('data', chunk => { if (String(chunk).includes(`127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } });
    });
    browser = await chromium.launch({ headless: true });
    evidence.environment = { database: owned.database, mysqlPort: config.port, poolLimit: 2, apiBase: base, webBase: `http://127.0.0.1:${port}`, chromium: browser.version(), vitePid: vite.pid };
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
    evidence.cleanup = { complete: !errors.length, errors };
    if (output) writeFileSync(join(output, 'real-metadata.json'), JSON.stringify(evidence, null, 2));
    expect(errors).toEqual([]);
  }, 30000);

  it('shows persisted prototype names as text in the actual device detail relations tab', async () => {
    const values = ['constructor', 'toString', '__proto__', 'manual', 'custom-source'];
    for (let i = 0; i < values.length; i++) {
      await call('PUT', `/api/network-devices/${deviceId}/relations`, { relations: [{ target: { type: 'server', id: serverIds[i] }, relationType: 'connected_to', provenance: values[i] }] });
    }
    expect((await call('GET', `/api/network-devices/${deviceId}/relations`)).relations.map((r: { provenance: string }) => r.provenance)).toEqual(expect.arrayContaining(values));
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await setupPage(page, `<network-device-detail deviceId="${deviceId}"></network-device-detail>`, 'network-device-detail');
    await page.getByRole('tab', { name: '关联资源', exact: true }).click();
    const table = page.locator('network-device-detail app-data-table');
    for (const text of ['constructor', 'toString', '__proto__', '手动配置', 'custom-source']) await browserExpect(table.getByText(text, { exact: true })).toBeVisible();
    await browserExpect(table).not.toContainText('[native code]');
    await page.screenshot({ path: join(output!, 'device-relations-1440.png'), fullPage: true });
    evidence.provenance = (await rows("SELECT provenance FROM resource_relations WHERE source_type='network_device' AND source_id=?", [deviceId])).map(r => r.provenance);
    await page.unrouteAll({ behavior: 'wait' });
    await page.close();
    (evidence.checks as string[]).push('#432 real PUT/GET/SQL + production detail: prototype names/normal/custom provenance displayed as text');
  }, 30000);

  async function setupPage(page: import('@playwright/test').Page, body: string, module: string) {
    await page.addInitScript(({ token }) => { const storage = (globalThis as any).localStorage; storage.setItem('token', token); storage.setItem('permissions', JSON.stringify(['*'])); }, { token });
    await page.route('**/metadata-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>MAX611 元数据验收</title><body>${body}<script type="module">import "/src/app/styles.css";import "/src/app/ui/views/${module}.ts";</script></body></html>` }));
    const environment = evidence.environment as { webBase: string };
    await page.goto(`${environment.webBase}/metadata-fixture`);
  }

  it('first renders all saved roles in the actual instance editor and persists unchanged save', async () => {
    const hosts = roles.map((role, i) => ({ serverId: serverIds[i], role }));
    await call('PUT', `/api/database/instances/${instanceId}/hosts`, { hosts });
    for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const pageErrors: string[] = []; page.on('pageerror', e => pageErrors.push(e.message));
      await setupPage(page, '<instances-page></instances-page>', 'instances-db');
      const edit = page.locator(`[data-resource-edit-id="${instanceId}"]:visible`);
      await edit.click();
      await browserExpect(page.getByRole('heading', { name: '编辑资源', exact: true })).toBeFocused();
      const selectors = page.locator('instance-host-field select');
      await browserExpect(selectors).toHaveCount(6);
      for (let i = 0; i < roles.length; i++) {
        const select = page.locator(`instance-host-field select[data-server-id="${serverIds[i]}"]`);
        await browserExpect(select).toHaveValue(roles[i]);
        await browserExpect(select.locator('option:checked')).toHaveText(labels[i]);
        await browserExpect(select).toHaveAccessibleName('节点角色');
      }
      await selectors.first().focus(); await browserExpect(selectors.first()).toBeFocused();
      await page.keyboard.press('Tab');
      await browserExpect(selectors.first()).not.toBeFocused();
      await page.screenshot({ path: join(output!, `instance-roles-${width}.png`), fullPage: true });
      const hostWrite = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/database/instances/${instanceId}/hosts`);
      await page.getByRole('button', { name: '保存修改', exact: true }).click();
      const saved = await hostWrite;
      expect(saved.status()).toBe(200);
      expect(saved.request().postDataJSON()).toEqual({ hosts });
      const persisted = await call('GET', `/api/database/instances/${instanceId}/hosts`);
      expect(persisted.hosts.map((h: { serverId: number; role: string }) => ({ serverId: h.serverId, role: h.role }))).toEqual(hosts);
      expect(pageErrors).toEqual([]);
      await page.unrouteAll({ behavior: 'wait' });
      await page.close();
    }
    evidence.roles = (await rows("SELECT target_id,metadata FROM resource_relations WHERE source_type='instance' AND source_id=? AND valid_until IS NULL ORDER BY target_id", [instanceId]));
    (evidence.checks as string[]).push('#648 all six roles: real PUT/GET + first editor display at 3 desktop sizes + accessible labels/focus/Tab + unchanged UI save + GET/SQL readback');
  }, 60000);

  it('rejects unauthenticated writes and retains saved metadata', async () => {
    const before = await call('GET', `/api/database/instances/${instanceId}/hosts`);
    await call('PUT', `/api/database/instances/${instanceId}/hosts`, { hosts: [] }, 401, '');
    await call('PUT', `/api/network-devices/${deviceId}/relations`, { relations: [] }, 401, '');
    expect(await call('GET', `/api/database/instances/${instanceId}/hosts`)).toEqual(before);
    (evidence.checks as string[]).push('real JWT rejects unauthenticated writes; saved roles retained');
  });
});
