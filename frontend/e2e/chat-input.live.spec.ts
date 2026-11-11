import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'vite';
import { MigrationRunner } from '../../apps/db-ops-api/src/migrations/runner.ts';
import { dbConnection } from '../../apps/db-ops-api/src/db-connection.ts';
import { chatDatabaseService } from '../../apps/db-ops-api/src/chat-database-service.ts';
import { registerChatRoutes } from '../../apps/db-ops-api/src/chat-routes.ts';
import { DirectAdapter } from '../../apps/db-ops-api/src/adapter/direct-adapter.ts';
import { ToolRegistry, type LLMProvider } from '../../packages/agent-core/src/index.ts';

// Opt-in live acceptance. Default collection never reads local credentials or shared DBs.
const enabled = process.env.CHAT_INPUT_LIVE === '1';
test.skip(!enabled, 'explicit CHAT_INPUT_LIVE and task database configuration required');

test('MAX-627 four fixes: real MySQL, HTTP, Adapter, WS, Gateway and desktop composer', async ({ page, browser }, info) => {
  const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
  const port = Number(process.env.CHAT_INPUT_DB_PORT);
  if (!port || port === 3306) throw new Error('use an explicit test MySQL port, never the platform database');
  const options = { host: process.env.CHAT_INPUT_DB_HOST ?? '127.0.0.1', port,
    user: process.env.CHAT_INPUT_DB_USER!, password: process.env.CHAT_INPUT_DB_PASSWORD };
  const schema = `max627_${randomUUID().replaceAll('-', '')}`;
  const admin = await require('mysql2/promise').createConnection(options);
  const workspace = await mkdtemp(join(tmpdir(), 'slide-max627-'));
  let adapter: DirectAdapter | undefined;
  let rest: any; let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  let failure: unknown;
  let calls = 0, blockNext = false, holdFrames = false;
  const sent: any[] = [], errors: string[] = [], cleanupErrors: string[] = [];
  const received: any[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const sqlBody = 'SELECT  *  FROM test;  \n\n\n';
  const content = `\`\`\`sql\n${sqlBody}\`\`\``;
  try {
    await admin.query(`CREATE DATABASE \`${schema}\``);
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
    process.env.JWT_SECRET_KEY = randomBytes(32).toString('hex');
    process.env.AGENT_WS_PORT = '0'; process.env.AGENT_WS_HOST = '127.0.0.1';
    expect(await dbConnection.initialize({ ...options, password: options.password ?? '', database: schema })).toBe(true);
    const pool = dbConnection.getPool()!;
    await new MigrationRunner(pool).run();
    const [insert] = await pool.execute("INSERT INTO users (username,password_hash,status) VALUES (?, 'no-login-fixture', 'active')", [`max627-${randomUUID()}`]) as any;
    const actor = { userId: insert.insertId, username: 'max627-fixture', roles: ['viewer'], permissions: [],
      sessionVersion: 1, instanceScopes: {}, requestId: randomUUID() };
    const sessions = await Promise.all(['普通消息', '图片重试', '停止命令'].map(title => chatDatabaseService.createSession(actor, { title })));
    rest = require('fastify')();
    rest.get('/api/chat/greeting', async () => ({ greeting: '聊天输入验收' }));
    await registerChatRoutes(rest, { service: chatDatabaseService,
      verifyToken: async (request: any) => { request.user = actor; },
      handleChatSend: async () => { throw new Error('WS admission only'); } });
    await rest.listen({ port: 0, host: '127.0.0.1' });
    const response = { content, finishReason: 'stop', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, shouldExecuteTools: false, hasToolCalls: false };
    const provider: LLMProvider = { getDefaultModel: () => 'controlled-max627', chat: async () => response,
      getModelCapabilities: () => ({ version: 'fixture/v1', model: 'controlled-max627', supportsVision: true,
        contextWindowTokens: 200_000, maxOutputTokens: 8192, source: 'configuration' }),
      chatStream: async (_messages, _tools, callbacks, opts) => {
        calls++;
        if (blockNext) {
          blockNext = false;
          await new Promise<void>((_resolve, reject) => {
            if (opts?.signal?.aborted) reject(opts.signal.reason);
            else opts?.signal?.addEventListener('abort', () => reject(opts.signal!.reason), { once: true });
          });
        }
        await callbacks.onContentDelta(content); return response;
      } };
    adapter = new DirectAdapter({ workspace, tools: new ToolRegistry(), llmProvider: provider,
      actorContextService: { authenticateAccessToken: async () => actor, revalidateActor: async () => actor } });
    await adapter.start();
    const server = (adapter as any).wsServer;
    if (!server.address()) await once(server, 'listening');
    const wsPort = server.address().port;
    await page.routeWebSocket('**/max627-ws', ws => {
      const remote = ws.connectToServer();
      ws.onMessage(raw => { sent.push(JSON.parse(String(raw))); remote.send(raw); });
      remote.onMessage(raw => {
        received.push(JSON.parse(String(raw)));
        if (!holdFrames || JSON.parse(String(raw)).type === 'auth_ok') ws.send(raw);
      });
    });
    vite = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false,
      proxy: { '/api': { target: `http://127.0.0.1:${rest.server.address().port}` } } } });
    await vite.listen();
    const origin = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
    const mount = async (index: number) => {
      await page.goto(`${origin}/e2e/fixtures/chat-input.html?session=${sessions[index].session_id}&ws=${encodeURIComponent(`ws://127.0.0.1:${wsPort}/max627-ws`)}`);
      await expect(page.locator('textarea')).toBeEnabled();
      await page.waitForFunction(() => (window as any).chatInputFixture.client.isConnected());
    };
    const draft = page.locator('textarea');
    await page.setViewportSize({ width: 1440, height: 900 }); await mount(0);
    for (const word of ['stop', 'wait', 'exit', 'abort', 'esc', 'STOP']) {
      await draft.fill(word); await draft.press('Enter');
      await expect.poll(async () => page.evaluate(() => (window as any).chatInputFixture.app.chatRunId)).toBeNull();
      await expect(page.locator('.chat-group.user').last()).toContainText(word);
    }
    const [words] = await pool.execute('SELECT content FROM chat_messages WHERE session_id=? AND role=? ORDER BY id', [sessions[0].session_id, 'user']) as any;
    expect(words).toHaveLength(6);
    await expect(page.locator('.chat-group.assistant pre code').first()).toHaveText(sqlBody);
    expect(await page.locator('.chat-group.assistant pre code').first().textContent()).toBe(sqlBody);

    // Local queries: genuine REST route, then controlled transport failure and pending edits.
    await draft.fill('/usage'); await draft.press('Escape'); await draft.press('Enter'); await expect(draft).toHaveValue('');
    await page.route('**/api/sessions', route => route.fulfill({ status: 500, json: { error: 'MAX627 controlled failure' } }));
    await draft.fill('/usage'); await draft.press('Escape'); await draft.press('Enter');
    await expect(page.getByText('命令未完成，可重试。草稿已保留；排队命令仍在队列中。', { exact: true })).toBeVisible();
    await expect(draft).toHaveValue('/usage');
    await page.unroute('**/api/sessions');
    let release!: () => void;
    await page.route('**/api/sessions', async route => {
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ status: 500, json: { error: 'MAX627 delayed failure' } });
    });
    await draft.press('Escape'); await draft.press('Enter'); await expect.poll(() => Boolean(release)).toBe(true);
    await draft.fill('后续新输入'); release();
    await expect(draft).toHaveValue('后续新输入'); await page.unroute('**/api/sessions');

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG5kAAAAASUVORK5CYII=', 'base64');
    const attach = async (bytes: Buffer) => {
      await page.locator('input[type=file]').setInputFiles({ name: 'max627.png', mimeType: 'image/png', buffer: bytes });
      await expect(page.locator('.chat-attachment-thumb')).toHaveCount(1);
    };
    await draft.fill('/usage'); await attach(png); await draft.press('Escape'); await draft.press('Enter');
    await expect(draft).toHaveValue('/usage'); await expect(page.locator('.chat-attachment-thumb')).toHaveCount(1);
    await expect(page.getByText(/本地斜杠命令不支持附件/)).toBeVisible();
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(viewport); await draft.focus(); await expect(draft).toBeFocused();
      const send = page.getByRole('button', { name: 'Send message', exact: true });
      await expect(send).toBeVisible(); expect(await send.getAttribute('aria-label')).toBeTruthy();
      const box = await send.boundingBox(); expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      await page.screenshot({ path: info.outputPath(`composer-${viewport.width}.png`) });
    }

    await mount(1); holdFrames = true; const beforeImages = calls;
    await attach(png); await draft.press('Enter');
    await expect(draft).toHaveValue(''); // attachment-only draft, restored on timeout
    await expect(page.locator('.chat-attachment-thumb')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('.chat-group.user .chat-message-image')).toHaveCount(1);
    holdFrames = false; await draft.press('Enter');
    await expect.poll(() => sent.filter(frame => frame.type === 'chat.send' && frame.sessionKey === sessions[1].session_id).length).toBe(2);
    await expect.poll(async () => page.evaluate(() => (window as any).chatInputFixture.app.chatRunId)).toBeNull();
    await expect(page.locator('.chat-attachment-thumb')).toHaveCount(1);
    await expect(page.locator('.chat-group.user .chat-message-image')).toHaveCount(1);
    // Current production v2 rejects attachments. Exercise its real unconfirmed retry
    // path without claiming that image inference/persistence is supported.
    expect(calls - beforeImages).toBe(0);
    const imageSends = sent.filter(frame => frame.type === 'chat.send' && frame.sessionKey === sessions[1].session_id);
    expect(imageSends).toHaveLength(2); expect(imageSends[0].messageId).toBe(imageSends[1].messageId);
    expect(imageSends[0].idempotencyKey).toBe(imageSends[1].idempotencyKey);
    await page.getByRole('button', { name: 'Remove attachment', exact: true }).click();
    await attach(Buffer.concat([png, Buffer.from([0])])); await draft.press('Enter');
    await expect(page.locator('.chat-group.user .chat-message-image')).toHaveCount(2);
    await expect.poll(async () => page.evaluate(() => (window as any).chatInputFixture.app.chatRunId)).toBeNull();
    const [images] = await pool.execute('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id=? AND role=?', [sessions[1].session_id, 'user']) as any;
    expect(images[0].count).toBe(0);
    expect(received.some(frame => frame.type === 'protocol.error' && frame.code === 'PROTOCOL_V2_INVALID')).toBe(true);

    await mount(2); blockNext = true; const beforeStop = calls;
    await draft.fill('保持运行以验证停止'); await draft.press('Enter');
    // A provisional client ID is not yet an accepted running server operation.
    await expect.poll(() => calls).toBe(beforeStop + 1);
    const acceptedRun = received.find(frame => frame.type === 'run.started' && frame.sessionKey === sessions[2].session_id);
    await expect.poll(async () => page.evaluate(() => (window as any).chatInputFixture.app.chatRunId)).toBe(acceptedRun.runId);
    await draft.fill('/stop'); await draft.press('Escape'); await draft.press('Enter');
    await expect.poll(() => sent.filter(frame => frame.type === 'chat.cancel').length).toBe(1);
    await expect.poll(async () => page.evaluate(() => (window as any).chatInputFixture.app.chatRunId)).toBeNull();
    expect(errors).toEqual([]);
    await writeFile(info.outputPath('business-evidence.json'), JSON.stringify({ schema, browser: browser.version(),
      ordinaryMessages: words.length, distinctImageBubbles: 2, persistedImageMessages: images[0].count, imageAttempts: imageSends.length,
      imageProviderExecutions: 0, imageLimitation: 'production protocol v2 rejects attachments; real failure/retry UI verified',
      providerCalls: calls, externalModelCalls: 0, actor: 'controlled fixture',
      transport: 'real DirectAdapter and WS; acceptance frames withheld for retry case', errors }, null, 2));
  } catch (error) {
    failure = error;
    await writeFile(info.outputPath('failure-wire.json'), JSON.stringify({ sent, received, calls }, null, 2));
    await page.screenshot({ path: info.outputPath('failure.png') });
    throw error;
  } finally {
    // Stop producers before services/storage, and preserve each cleanup failure.
    for (const [name, action] of [
      ['browser', () => page.close()], ['adapter', () => adapter?.dispose()], ['vite', () => vite?.close()],
      ['HTTP', () => rest?.close()], ['pool', () => dbConnection.close()],
      ['schema', () => admin.query(`DROP DATABASE IF EXISTS \`${schema}\``)],
      ['admin', () => admin.end()], ['workspace', () => rm(workspace, { recursive: true, force: true })],
    ] as const) {
      try { await action(); } catch (error) { cleanupErrors.push(`${name}: ${String(error)}`); }
    }
    await writeFile(info.outputPath('cleanup.json'), JSON.stringify({ cleanupErrors }, null, 2));
    if (cleanupErrors.length && !failure) throw new Error(cleanupErrors.join('\n'));
  }
});
