import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import * as https from 'node:https';
import { promises as dns } from 'node:dns';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import mysql, { type Pool } from 'mysql2/promise';
import { transpileModule } from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from './migrations/runner.js';
import { assertSchemaInvariants } from './migrations/invariants.js';
import { migrateNotificationCredentials } from './notification-credential-migration.js';
import { dbConnection, decryptData, encryptData } from './db-connection.js';
import { notificationDatabaseService as channels } from './notification-database-service.js';
import { notificationService } from './notification-service.js';
import { publicNotificationDto } from './security/public-dto.js';
import { validateNotificationChannelConfig, isNotificationChannelType } from './notification-channel-config.js';
import { createVerifyToken } from './auth-middleware.js';
import { requirePermission } from './auth/require-permission.js';
import { actorContextService } from './auth/actor-context.js';
import { smtpRecipient } from './workflows/delivery-test-recipients.js';

vi.mock('node:https', async original => ({
  ...await original<typeof import('node:https')>(),
  request: vi.fn(() => { throw new Error('TEST_TRANSPORT_NOT_CONFIGURED'); }),
}));

// Opt-in only. Configuration is injected, never read from local profiles/.env.
// Full production schema, actual route registrations/JWT middleware/MySQL, and
// loopback recipients; account snapshot, DNS and HTTPS destination are controlled.
const input = process.env.NOTIFICATION_CREDENTIALS_MYSQL_JSON;
describe.skipIf(!input)('MAX-590 #296/#342 real MySQL and normal notification entries', () => {
  const schema = 'max590_' + randomBytes(8).toString('hex');
  const key = '0123456789abcdef0123456789abcdef';
  const sentinelUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/sentinel-private?x-arbitrary=sentinel-token';
  const jwtSecret = 'max590-isolated-jwt-signing-secret';
  const token = jwt.sign({ userId: 590, sessionVersion: 1 }, jwtSecret);
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const actor = { userId: 590, username: 'max590', roles: [], sessionVersion: 1,
    permissions: ['admin:*', 'notification:view'], instanceScopes: {}, requestId: 'max590-test' };
  let admin: Pool;
  let pool: Pool;
  let app: ReturnType<typeof Fastify>;
  let address: string;
  let receiver: ReturnType<typeof http.createServer>;
  let receiverPort: number;
  let received: Array<{ path: string; body: any }>;
  let smtp: Awaited<ReturnType<typeof smtpRecipient>>;
  let receiverError = false;
  const audit: Record<string, unknown>[] = [];

  function routes() {
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const fragment = source.slice(source.indexOf('  function validateWebhookUrl('),
      source.indexOf('  registerDeliveryRoutes(fastify,'));
    const deps = { fastify: app, verifyToken: createVerifyToken(jwtSecret), requirePermission,
      notificationDatabaseService: channels, notificationService, publicNotificationDto,
      validateNotificationChannelConfig, isNotificationChannelType };
    new Function(...Object.keys(deps), transpileModule(fragment, {}).outputText)(...Object.values(deps));
  }

  async function api(method: string, path: string, body?: unknown) {
    const response = await fetch(address + '/api/notification/channels' + path, {
      method, headers: body !== undefined ? headers : { authorization: headers.authorization }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  }
  async function stored(id: number) {
    const [rows] = await pool.execute<any[]>('SELECT * FROM notification_channels WHERE id = ?', [id]);
    const row = rows[0];
    return row ? { ...row, config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config } : null;
  }
  async function create(type = 'webhook', config: Record<string, unknown> = { webhook_url: sentinelUrl, secret: 'sentinel-signature' }) {
    const result = await api('POST', '', { name: 'sentinel-channel', type, enabled: false, config });
    expect(result.status).toBe(200);
    return Number(result.body.id);
  }

  beforeAll(async () => {
    vi.stubEnv('ENCRYPTION_KEY', key);
    vi.stubEnv('JWT_SECRET_KEY', jwtSecret);
    vi.stubEnv('NODE_ENV', 'test');
    const config = JSON.parse(input!);
    admin = mysql.createPool({ ...config, database: undefined, connectionLimit: 2 });
    await admin.query('CREATE DATABASE ' + schema);
    pool = mysql.createPool({ ...config, database: schema, connectionLimit: 2, dateStrings: true });
    const began = Date.now();
    await new MigrationRunner(pool as any).run();
    await assertSchemaInvariants(pool as any);
    expect(await migrateNotificationCredentials(pool)).toBe(0);
    console.info('MAX590 empty schema + invariant + empty credential migration', { durationMs: Date.now() - began, schema });
    receiver = http.createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        received.push({ path: request.url!, body: JSON.parse(body) });
        response.end(JSON.stringify(receiverError ? { code: 403, msg: sentinelUrl } : { code: 0 }));
      });
    });
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
    receiverPort = (receiver.address() as any).port;
    smtp = await smtpRecipient();
    app = Fastify({ forceCloseConnections: true });
    routes();
    address = await app.listen({ host: '127.0.0.1', port: 0 });
  }, 120000);

  beforeEach(async () => {
    await pool.query('DELETE FROM notification_channels');
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    vi.spyOn(actorContextService, 'loadActiveActor').mockResolvedValue(actor as any);
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as any);
    vi.mocked(https.request).mockImplementation(((options: any, callback: any) => {
      expect(options.rejectUnauthorized).toBe(true);
      expect(options.servername).toBe('open.feishu.cn');
      expect(options.port).toBe(443);
      const pin = vi.fn();
      options.lookup(options.hostname, {}, pin);
      expect(pin).toHaveBeenCalledWith(null, '203.0.113.10', 4);
      return http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1',
        port: receiverPort, lookup: undefined }, callback);
    }) as any);
    received = [];
    receiverError = false;
  });

  afterEach(async context => {
    const [rows] = await pool.query<any[]>('SELECT id, type, config, enabled, delivery_start_at FROM notification_channels ORDER BY id');
    const parsed = rows.map(row => ({ ...row, config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config }));
    audit.push({ case: context.task.name, channelCount: rows.length,
      plaintextUrlRows: parsed.filter(row => Object.hasOwn(row.config, 'webhook_url')).length,
      emailWithWebhookFields: parsed.filter(row => row.type === 'email' && ('webhook_url_encrypted' in row.config || 'secret_encrypted' in row.config)).length,
      webhookWithEmailFields: parsed.filter(row => row.type !== 'email' && ('password_encrypted' in row.config || 'oauth2_refresh_token_encrypted' in row.config)).length,
      snapshotSha256: createHash('sha256').update(JSON.stringify(parsed)).digest('hex') });
    await pool.query('DROP TRIGGER IF EXISTS max590_fail_upgrade');
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    // Stop clients/HTTP services before destroying the task-owned schema.
    await app?.close();
    await smtp?.close();
    receiver?.closeAllConnections();
    if (receiver?.listening) await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve()));
    await pool?.end();
    if (admin) {
      await admin.query('DROP DATABASE IF EXISTS ' + schema);
      const [rows] = await admin.query<any[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [schema]);
      expect(rows).toHaveLength(0);
      console.info('MAX590 cleanup: owned schema absent', { schema });
      const output = process.env.NOTIFICATION_CREDENTIALS_EVIDENCE_DIR;
      if (output) {
        mkdirSync(output, { recursive: true });
        const [version] = await admin.query<any[]>('SELECT VERSION() AS version');
        writeFileSync(output + '/mysql-audit.json', JSON.stringify({
          schema, version: version[0].version, schemaAbsentAfterCleanup: rows.length === 0, audit,
          queries: ['SELECT id, type, config, enabled, delivery_start_at FROM notification_channels ORDER BY id',
            'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?'],
          disclosure: 'Only hashes and field-presence counts; all test credentials synthetic.',
        }, null, 2));
      }
      await admin.end();
    }
    vi.unstubAllEnvs();
  }, 30000);

  it('upgrades legacy plaintext, preserves metadata/ciphertexts, runs twice, and keeps full schema invariant', async () => {
    const cipher = encryptData('sentinel-authoritative-url');
    const [insert] = await pool.execute<any>('INSERT INTO notification_channels(name,type,config,enabled,delivery_start_at) VALUES (?,?,?,0,CURRENT_TIMESTAMP)',
      ['legacy', 'webhook', JSON.stringify({ webhook_url: sentinelUrl, secret: 'sentinel-secret', severity: 'p0',
        password_encrypted: encryptData('sentinel-stale-email') })]);
    const before = await stored(insert.insertId);
    // Legacy sender compatibility before migration still uses outbound policy.
    expect(await notificationService.send(before, { text: 'before upgrade' })).toEqual({ success: true });
    await pool.execute('INSERT INTO notification_channels(name,type,config,enabled,delivery_start_at) VALUES (?,?,?,0,CURRENT_TIMESTAMP)',
      ['both formats', 'webhook', JSON.stringify({ webhook_url: sentinelUrl, webhook_url_encrypted: cipher })]);
    await new MigrationRunner(pool as any).run();
    expect(await migrateNotificationCredentials(pool)).toBe(2);
    const after = await stored(insert.insertId);
    expect(after.config).not.toHaveProperty('webhook_url');
    expect(after.config).not.toHaveProperty('password_encrypted');
    expect(decryptData(after.config.webhook_url_encrypted)).toBe(sentinelUrl);
    expect(decryptData(after.config.secret_encrypted)).toBe('sentinel-secret');
    expect(after.created_at).toBe(before.created_at);
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.delivery_start_at).toBe(before.delivery_start_at);
    const snapshot = JSON.stringify(await channels.getChannels());
    expect(await migrateNotificationCredentials(pool)).toBe(0);
    expect(JSON.stringify(await channels.getChannels())).toBe(snapshot);
    await assertSchemaInvariants(pool as any);
    expect(await notificationService.send(after, { text: 'after upgrade' })).toEqual({ success: true });
    expect(received).toHaveLength(2);
    const both = (await channels.getChannels()).find(channel => channel.name === 'both formats')!;
    expect(both.config.webhook_url_encrypted).toBe(cipher);
    console.info('MAX590 upgrade audit', { migrated: 2, repeated: 0, schemaInvariant: true,
      snapshotSha256: createHash('sha256').update(snapshot).digest('hex') });
  });

  it('rolls back failed upgrade, exposes only a code, and never replays unknown SQL', async () => {
    await pool.execute('INSERT INTO notification_channels(name,type,config,enabled,delivery_start_at) VALUES (?,?,?,0,CURRENT_TIMESTAMP)',
      ['legacy-failing', 'webhook', JSON.stringify({ webhook_url: sentinelUrl })]);
    await pool.query("CREATE TRIGGER max590_fail_upgrade BEFORE UPDATE ON notification_channels FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sentinel-driver-echo'");
    await expect(migrateNotificationCredentials(pool)).rejects.toThrow('NOTIFICATION_CREDENTIAL_MIGRATION_FAILED');
    const [rows] = await pool.query<any[]>('SELECT config FROM notification_channels');
    const config = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
    expect(config).toEqual({ webhook_url: sentinelUrl });
  });

  it('uses authenticated API → encrypted storage → decrypted pinned HTTP delivery, rejects private DNS, and redacts receiver errors', async () => {
    const id = await create('feishu');
    const row = await stored(id);
    expect(JSON.stringify(row.config)).not.toContain('sentinel');
    expect(decryptData(row.config.webhook_url_encrypted)).toBe(sentinelUrl);
    const read = await api('GET', '');
    expect(read.body[0].config).toMatchObject({ hasWebhook: true, hasCredential: true });
    expect(JSON.stringify(read.body)).not.toContain('sentinel-private');
    expect(JSON.stringify(read.body)).not.toContain('v2:');
    expect((await api('POST', '/' + id + '/test')).status).toBe(200);
    expect(received[0].path).toContain('sentinel-private?x-arbitrary=sentinel-token');
    expect(received[0].body.sign).toBeTruthy();
    receiverError = true;
    const failure = await api('POST', '/' + id + '/test');
    expect(failure.status).toBe(500);
    expect(failure.body.error).toBe('OUTBOUND_PLATFORM_REJECTED');
    expect(JSON.stringify(failure.body)).not.toContain('sentinel');
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
    const count = received.length;
    expect((await api('POST', '/' + id + '/test')).body.error).toBe('PRIVATE_ADDRESS');
    expect(received).toHaveLength(count);
  });

  it('retains omitted credentials, explicitly clears, and only stores fields for the new channel type both ways', async () => {
    const id = await create();
    const old = await stored(id);
    expect((await api('PUT', '/' + id, { config: { severity: 'p0' } })).status).toBe(200);
    expect((await stored(id)).config).toEqual({ ...old.config, severity: 'p0' });
    for (const enabled of [true, true, false]) {
      expect((await api('PUT', '/' + id, { enabled })).status).toBe(200);
      expect((await stored(id)).config).toEqual({ ...old.config, severity: 'p0' });
    }
    expect((await api('PUT', '/' + id, { config: { secret: '' } })).status).toBe(200);
    expect((await stored(id)).config).not.toHaveProperty('secret_encrypted');
    const email = { ...smtp.channel.config, password: 'sentinel-mail-password', webhook_url: sentinelUrl, secret: 'sentinel-inapplicable' };
    expect((await api('PUT', '/' + id, { type: 'email', config: email })).status).toBe(200);
    const mail = await stored(id);
    expect(mail.config).not.toHaveProperty('webhook_url_encrypted');
    expect(mail.config).not.toHaveProperty('secret_encrypted');
    expect(decryptData(mail.config.password_encrypted)).toBe('sentinel-mail-password');
    expect((await api('POST', '/' + id + '/test')).status).toBe(200);
    expect(smtp.messages.length).toBeGreaterThan(0);
    expect((await api('PUT', '/' + id, { config: { to: 'new@example.test' } })).status).toBe(200);
    expect((await stored(id)).config.password_encrypted).toBe(mail.config.password_encrypted);
    expect((await api('PUT', '/' + id, { config: { password: null } })).status).toBe(200);
    expect((await stored(id)).config).not.toHaveProperty('password_encrypted');
    expect((await api('PUT', '/' + id, { type: 'webhook', config: { webhook_url: sentinelUrl,
      password: 'sentinel-stale', oauth2_refresh_token: 'sentinel-stale', secret: 'sentinel-new-signature' } })).status).toBe(200);
    expect(Object.keys((await stored(id)).config).sort()).toEqual(['secret_encrypted', 'webhook_url_encrypted']);
    expect((await api('PUT', '/' + id, { config: { webhook_url: null, secret: null } })).status).toBe(200);
    expect((await stored(id)).config).toEqual({});
    expect((await api('POST', '/' + id + '/test')).status).toBe(500);
  });

  it('serializes concurrent field saves and a type switch without reviving old encrypted fields (pool size 1)', async () => {
    const id = await create('email', { ...smtp.channel.config, password: 'sentinel-old-password', oauth2_refresh_token: 'sentinel-old-refresh' });
    const single = mysql.createPool({ ...JSON.parse(input!), database: schema, connectionLimit: 1 });
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(single);
    try {
      const results = await Promise.all([
        channels.updateChannel(id, { config: { to: 'parallel@example.test' } }),
        channels.updateChannel(id, { type: 'webhook', config: { webhook_url: sentinelUrl } }),
        channels.updateOAuth2RefreshToken(id, 'sentinel-rotation'),
      ]);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(Object.keys((await stored(id)).config)).toEqual(['webhook_url_encrypted']);
      const edits = await Promise.all([
        channels.updateChannel(id, { config: { severity: 'p0' } }),
        channels.updateChannel(id, { config: { secret: 'sentinel-parallel' } }),
      ]);
      expect(edits.every(result => result.success)).toBe(true);
      expect((await stored(id)).config).toMatchObject({ severity: 'p0', secret_encrypted: expect.any(String) });
    } finally { await single.end(); }
  });

  it('retains live permissions and refuses client ciphertext/aliases or internal URLs before storing', async () => {
    expect((await fetch(address + '/api/notification/channels')).status).toBe(401);
    vi.mocked(actorContextService.loadActiveActor).mockResolvedValue({ ...actor, permissions: [] } as any);
    expect((await api('POST', '', { name: 'forbidden', type: 'webhook', config: {} })).status).toBe(403);
    vi.mocked(actorContextService.loadActiveActor).mockResolvedValue(actor as any);
    for (const field of ['webhook_url_encrypted', 'password_encrypted', 'secret_encrypted', 'oauth2_refresh_token_encrypted', 'webhookUrlEncrypted']) {
      expect((await api('POST', '', { name: 'invalid', type: 'webhook', config: { [field]: 'sentinel' } })).status).toBe(400);
    }
    expect((await api('POST', '', { name: 'invalid', type: 'webhook', config: { webhook_url: 'http://127.0.0.1/private' } })).status).toBe(400);
    expect(await channels.getChannels()).toHaveLength(0);
  });

  it('drives the real settings UI through normal HTTP routes and encrypted MySQL at all desktop sizes', async () => {
    const frontendRequire = createRequire(new URL('../../../frontend/package.json', import.meta.url));
    const { chromium } = frontendRequire('@playwright/test');
    const { createServer } = await import(frontendRequire.resolve('vite'));
    const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('../../../frontend', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': address } } });
    let browser: any;
    try {
      await vite.listen();
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.route('**/max590-fixture', (route: any) => route.fulfill({ contentType: 'text/html',
        body: '<html lang="zh-CN"><link rel="stylesheet" href="/src/app/styles/tokens.css"><body></body></html>' }));
      await page.goto(vite.resolvedUrls!.local[0] + 'max590-fixture');
      await page.evaluate(async (jwtToken: string) => {
        (globalThis as any).localStorage.setItem('token', jwtToken);
        await new Function('return import("/src/app/ui/views/feishu-notification-settings.ts")')();
        (globalThis as any).document.body.append((globalThis as any).document.createElement('feishu-notification-settings'));
      }, token);
      const form = page.locator('feishu-notification-settings');
      const urlInput = form.locator('app-form-field').filter({ has: page.locator('input[type=url]') }).locator('input');
      await urlInput.fill(sentinelUrl);
      await form.locator('input[type=password]').fill('sentinel-ui-signature');
      await form.getByRole('button', { name: '保存配置', exact: true }).click();
      await expect.poll(async () => (await channels.getChannels()).length).toBe(1);
      const id = (await channels.getChannels())[0].id;
      const saved = await stored(id);
      expect(JSON.stringify(saved.config)).not.toContain('sentinel');
      await page.reload(); // Recreate same real component and reload public API configuration.
      await page.evaluate(async () => {
        await new Function('return import("/src/app/ui/views/feishu-notification-settings.ts")')();
        (globalThis as any).document.body.append((globalThis as any).document.createElement('feishu-notification-settings'));
      });
      await form.getByText('Webhook 已配置', { exact: true }).waitFor();
      expect(await urlInput.inputValue()).toBe('');
      expect(await urlInput.evaluate((element: any) => Array.from(element.labels || []).map((label: any) => label.textContent).join(' '))).toContain('替换飞书 Webhook');
      await urlInput.focus();
      await page.keyboard.press('Tab');
      expect(await form.locator('input[type=password]').evaluate((element: any) => element === element.getRootNode().activeElement)).toBe(true);
      expect(await form.locator('input[type=password]').inputValue()).toBe('');
      await form.locator('input[type=password]').fill('sentinel-ui-replacement');
      await form.getByRole('button', { name: '保存配置', exact: true }).click();
      await expect.poll(async () => decryptData((await stored(id)).config.secret_encrypted)).toBe('sentinel-ui-replacement');
      expect((await stored(id)).config.webhook_url_encrypted).toBe(saved.config.webhook_url_encrypted);
      for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
        await page.setViewportSize({ width, height });
        await form.getByRole('button', { name: '发送测试消息' }).click();
        await expect.poll(() => received.length).toBeGreaterThan(0);
        await expect.poll(async () => page.evaluate(() => ((globalThis as any).document.querySelector('feishu-notification-settings') as any).testing)).toBe(false);
        expect(received.at(-1)!.body.sign).toBeTruthy();
        await form.locator('input[type=checkbox]').check();
        await form.getByRole('button', { name: '保存配置', exact: true }).click();
        await expect.poll(async () => page.evaluate(() => ((globalThis as any).document.querySelector('feishu-notification-settings') as any).saving)).toBe(false);
        await expect.poll(async () => Boolean((await stored(id)).enabled)).toBe(true);
        expect((await stored(id)).config.webhook_url_encrypted).toBe(saved.config.webhook_url_encrypted);
        const output = process.env.NOTIFICATION_CREDENTIALS_EVIDENCE_DIR;
        if (output) {
          mkdirSync(output, { recursive: true });
          await page.screenshot({ path: output + '/settings-' + width + '.png', fullPage: true });
        }
        expect(await form.evaluate((element: any) => element.scrollWidth <= (globalThis as any).innerWidth)).toBe(true);
      }
      const dto = await api('GET', '');
      expect(JSON.stringify(dto.body)).not.toContain('sentinel-ui');
      expect(await form.locator('input[type=password]').inputValue()).toBe('');
      await page.close();
    } finally {
      await browser?.close();
      await vite.close();
    }
  }, 60000);
});
