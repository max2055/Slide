import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const mysql = require('mysql2/promise');
test.describe.configure({ mode: 'serial' });
test.skip(!process.env.MAX178_ISOLATED_MYSQL, 'Use scripts/qualification/run-MAX-178.sh');
const out = 'test-results/MAX-178-evidence';
let pool: any, token: string, user: any, id: number, origin: string, server: Server;
const calls: { path: string; savedCredential: boolean }[] = [];
const model = { id: 'max178-controlled-model', name: 'MAX178 隔离运维模型', contextWindow: 64000, maxTokens: 8192, cost: { input: 0 }, supportsFunctionCall: true, opaque_extension: { preserved: true }, parameterSource: 'manual' };
test.beforeAll(async ({ request }) => {
  await mkdir(out, { recursive: true });
  pool = mysql.createPool({ host: '127.0.0.1', port: Number(process.env.DB_PORT), user: 'root', password: '', database: 'db_ops_ai_qualification' });
  server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain only; never retain prompts or credentials. */ }
    calls.push({ path: req.url!, savedCredential: req.headers.authorization === 'Bearer max178-fake-key-not-a-secret' });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url?.endsWith('/models') ? { data: [{ id: model.id }, { id: 'max178-unknown' }] } : {
      id: 'max178-controlled-response', model: model.id, choices: [{ message: { role: 'assistant', content: 'MAX178 受控连接验证' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const login = await request.post('/api/auth/login', { data: { username: 'admin', password: process.env.QUALIFICATION_ADMIN_PASSWORD } });
  expect(login.status()).toBe(200); ({ token, user } = await login.json());
  const create = await request.post('/api/llm/configs', { headers: { Authorization: `Bearer ${token}` }, data: {
    name: 'max178-isolated', displayName: 'MAX178 隔离 Provider', deploymentType: 'api', apiFormat: 'openai-completions', baseURL: origin,
    apiKey: 'max178-fake-key-not-a-secret', model: model.id, modelsSupported: [model], contextWindow: 64000, maxTokens: 2048, enabled: false,
  } });
  const result = await create.json(); expect(result.success).toBe(true); id = result.providerId;
  expect(id).toBeGreaterThan(0);
  await writeFile(`${out}/metadata.json`, JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceSha256: createHash('sha256').update(await readFile('src/app/ui/views/llm-config.ts')).digest('hex'), data: 'Task-owned MySQL container, current server.ts, password login/JWT/current authorization; controlled local OpenAI-compatible connection probe. No shared Provider/routes changed; no product model calls.', design: 'R1.1 112502a0ad6dbadc7eea35efda027ccfb079fed756bf0ed51956ac6fd71347fe' }, null, 2));
});
test.afterAll(async () => { await pool?.end(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('permissions', JSON.stringify(['*']));
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' })); localStorage.setItem('slide.i18n.locale', 'zh-CN');
  }, { token, user });
});
async function harness(page: Page) {
  // Host-only harness; normal flows use real REST APIs and MySQL.
  await page.route('**/MAX-178-harness', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/app/styles/tokens.css"><style>body{margin:0;padding:24px;background:var(--bg);font:14px system-ui;box-sizing:border-box;height:100vh}@media(max-width:600px){body{padding:16px}}llm-config-page{height:100%}</style><body><llm-config-page></llm-config-page><script type="module">import '/src/app/ui/views/llm-config.ts';</script></body></html>` }));
  await page.goto('/MAX-178-harness');
  const view = page.locator('llm-config-page');
  await view.locator('.sidebar-item').filter({ hasText: 'MAX178 隔离 Provider' }).click();
  return view;
}
async function capture(page: Page, name: string, source = 'real service / isolated MySQL') {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const geometry = await page.locator('llm-config-page').evaluate(el => ({
    pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
    overflowing: Array.from(el.shadowRoot!.querySelectorAll('.section-body,.model-list,.detail-inner')).filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className),
  }));
  expect(geometry.overflowing).toEqual([]);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true, animations: 'disabled' });
  await writeFile(`${out}/${name}.json`, JSON.stringify({ viewport: page.viewportSize(), theme: await page.evaluate(() => document.documentElement.dataset.themeMode || 'light'), source, geometry, at: new Date().toISOString() }, null, 2));
}
async function persisted() {
  const [[row]] = await pool.query('SELECT display_name,api_base_url,api_key_encrypted,models_supported,default_model,context_window,max_tokens FROM llm_providers WHERE id=?', [id]);
  return { ...row, models: typeof row.models_supported === 'string' ? JSON.parse(row.models_supported) : row.models_supported };
}
test('representative first: real single model read/edit/save/refresh and credential-retaining connection probe', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1080 });
  const view = await harness(page);
  await expect(view.locator('.model-row')).toHaveCount(1);
  await expect(view.locator('.advanced')).not.toHaveAttribute('open');
  const before = await persisted();
  expect(before.api_key_encrypted).not.toContain('max178-fake-key');
  await expect(view.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password');
  await capture(page, 'single-1440-light');
  const trigger = view.getByRole('button', { name: `编辑模型 ${model.name}`, exact: true });
  await trigger.click();
  const dialog = view.locator('app-dialog').first();
  await expect(dialog.getByLabel('输入价格（$/1M tokens）', { exact: true })).toHaveValue('0');
  await expect(dialog.getByLabel('输出价格（$/1M tokens）', { exact: true })).toHaveValue('');
  await dialog.getByLabel('模型显示名称').fill('MAX178 单模型真实保存');
  await dialog.getByLabel('模型上下文窗口').fill('96000');
  await capture(page, 'single-editor-1440-light');
  await dialog.getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(view.locator('.model-feedback')).toContainText('已保存');
  let row = await persisted(); expect(row.models[0]).toMatchObject({ name: 'MAX178 单模型真实保存', contextWindow: 96000, cost: { input: 0 }, opaque_extension: { preserved: true } });
  expect(row.api_key_encrypted).toBe(before.api_key_encrypted); expect(row.max_tokens).toBe(2048);
  await page.reload(); await view.locator('.sidebar-item').filter({ hasText: 'MAX178 隔离 Provider' }).click();
  await expect(view.locator('.model-row')).toContainText('96,000');
  await view.getByLabel('显示名称', { exact: true }).fill('MAX178 连接真实保存');
  await view.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(view.getByRole('button', { name: '✓ 已保存配置', exact: true })).toBeVisible();
  row = await persisted(); expect(row.display_name).toBe('MAX178 连接真实保存'); expect(row.api_key_encrypted).toBe(before.api_key_encrypted);
  await view.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(view.getByRole('status', { name: '连接测试结果' })).toContainText('连接成功');
  expect(calls.at(-1)).toEqual({ path: '/v1/chat/completions', savedCredential: true });
  await writeFile(`${out}/real-business.json`, JSON.stringify({ providerId: id, readEditSaveRefresh: true, contextWindow: row.models[0].contextWindow, modelExtensionPreserved: true, zeroPricePreserved: true, blankKeyRetainedCiphertext: row.api_key_encrypted === before.api_key_encrypted, connectionProbe: calls, productModelCalls: 0, errors }, null, 2));
  await capture(page, 'single-saved-1440-light'); expect(errors).toEqual([]);
});
test('multiple models: isolated saves, unknown semantics, keyboard, responsive themes, default parameters and real application shell', async ({ page }) => {
  const view = await harnessAfterRename(page);
  const base = await persisted();
  const longName = 'MAX178 长模型名称_'.repeat(18);
  const models = [...base.models, { id: 'max178-unknown', name: longName, parameterSource: 'unknown', opaque: { retained: 'unknown' } }, { id: 'max178-third', contextWindow: 32768, maxTokens: 8192 }];
  await pool.query('UPDATE llm_providers SET models_supported=? WHERE id=?', [JSON.stringify(models), id]);
  await page.reload(); await view.locator('.sidebar-item').filter({ hasText: 'MAX178 连接真实保存' }).click();
  await expect(view.locator('.model-row')).toHaveCount(3);
  const trigger = view.getByRole('button', { name: `编辑模型 ${longName}`, exact: true });
  await view.getByLabel('显示名称', { exact: true }).fill('尚未提交的连接草稿');
  await trigger.click(); const dialog = view.locator('app-dialog').first();
  await expect(dialog.getByLabel('模型上下文窗口')).toHaveValue('');
  await expect(dialog.getByLabel('模型工具调用能力')).toHaveValue('');
  await dialog.getByLabel('模型显示名称').fill(longName + ' 已编辑');
  await dialog.getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(view.locator('.model-feedback')).toContainText('连接草稿未提交');
  expect((await persisted()).display_name).toBe('MAX178 连接真实保存');
  await view.locator('.add-btn').click(); await expect(view.getByText('放弃未保存修改？', { exact: true })).toBeVisible();
  await view.getByRole('button', { name: '继续编辑', exact: true }).click();
  await page.reload(); await view.locator('.sidebar-item').filter({ hasText: 'MAX178 连接真实保存' }).click();
  for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(t => document.documentElement.dataset.themeMode = t, theme);
    await capture(page, `multiple-${width}-${theme}`);
    const open = view.getByRole('button', { name: `编辑模型 ${longName} 已编辑`, exact: true });
    await open.focus(); await page.keyboard.press('Enter');
    await expect(dialog.getByLabel('模型 ID', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '取消', exact: true }).focus(); await page.keyboard.press('Tab');
    expect(await dialog.evaluate(el => { let active: Element | null = document.activeElement; while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement; return !!active && (el.contains(active) || el.shadowRoot!.contains(active)); })).toBe(true);
    await capture(page, `model-editor-${width}-${theme}`);
    await page.keyboard.press('Escape'); await expect(open).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await view.locator('.advanced summary').click();
  await view.getByLabel('Max Tokens', { exact: true }).fill('3072');
  await capture(page, 'connection-advanced-1440-dark');
  await view.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(view.getByRole('button', { name: '✓ 已保存配置', exact: true })).toBeVisible(); expect((await persisted()).max_tokens).toBe(3072);
  for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 }); await page.goto('/settings/ai/models?view=providers');
    await page.evaluate(t => document.documentElement.dataset.themeMode = t, theme);
    await page.locator('llm-config-page .sidebar-item').filter({ hasText: 'MAX178 连接真实保存' }).click();
    await capture(page, `application-shell-${width}-${theme}`);
  }
});
async function harnessAfterRename(page: Page) {
  await page.route('**/MAX-178-harness', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/app/styles/tokens.css"><style>body{margin:0;padding:16px;background:var(--bg);font:14px system-ui;height:100vh;box-sizing:border-box}</style><body><llm-config-page></llm-config-page><script type="module">import '/src/app/ui/views/llm-config.ts';</script></body></html>` }));
  await page.goto('/MAX-178-harness'); const view = page.locator('llm-config-page');
  await view.locator('.sidebar-item').filter({ hasText: 'MAX178 连接真实保存' }).click(); return view;
}
test('real add/cancel/remove, saved discovery credential and current permission rejection', async ({ page, request }) => {
  const view = await harnessAfterRename(page);
  const before = await persisted();
  await view.getByRole('button', { name: '+ 添加模型', exact: true }).click();
  const dialog = view.locator('app-dialog').first();
  await dialog.getByLabel('模型 ID', { exact: true }).fill('max178-added-unknown');
  await dialog.getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(view.locator('.model-row')).toHaveCount(4);
  expect((await persisted()).models.at(-1)).toMatchObject({ id: 'max178-added-unknown' });
  await view.getByRole('button', { name: '编辑模型 max178-added-unknown', exact: true }).click();
  await dialog.getByLabel('模型显示名称').fill('Cancel this draft');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await persisted()).models.at(-1).name).toBeUndefined();
  await view.getByRole('button', { name: '编辑模型 max178-added-unknown', exact: true }).click();
  await dialog.getByRole('button', { name: '从配置中移除（待保存）', exact: true }).click();
  expect((await persisted()).models).toHaveLength(4);
  await view.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(view.getByRole('button', { name: '✓ 已保存配置', exact: true })).toBeVisible();
  expect((await persisted()).models).toHaveLength(3);
  await view.getByRole('button', { name: '加载模型', exact: true }).click();
  await expect(view.locator('.model-row')).toHaveCount(2);
  expect(calls.at(-1)).toEqual({ path: '/v1/models', savedCredential: true });
  expect((await persisted()).models).toHaveLength(3); // Discovery is staged until configuration save.
  await page.reload(); await view.locator('.sidebar-item').filter({ hasText: 'MAX178 连接真实保存' }).click();
  const login = await request.post('/api/auth/login', { data: { username: 'qualification-viewer', password: process.env.QUALIFICATION_ADMIN_PASSWORD } });
  expect(login.status()).toBe(200); const viewer = await login.json();
  await page.evaluate(value => localStorage.setItem('token', value), viewer.token);
  await view.getByRole('button', { name: '编辑模型 MAX178 单模型真实保存', exact: true }).click();
  await dialog.getByLabel('模型显示名称').fill('Real permission rejection draft');
  await dialog.getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect((await persisted()).models[0].name).toBe(before.models[0].name);
  await capture(page, 'real-permission-rejection', 'real service: viewer JWT lacks llm:manage; isolated MySQL unchanged');
  await writeFile(`${out}/real-model-lifecycle.json`, JSON.stringify({ addPersisted: true, cancelNoWrite: true, removeStagedThenPersisted: true, discoveryStagedWithSavedKey: true, viewerSaveRejected: true, providerUnchangedOn403: true }, null, 2));
});
test('supplemental controlled loading, failure, forbidden, empty and model-save errors', async ({ page }) => {
  const view = await harnessAfterRename(page);
  for (const state of ['loading', 'error', 'forbidden', 'empty']) {
    await page.route('**/api/llm/configs', async route => {
      if (state === 'loading') { await new Promise(resolve => setTimeout(resolve, 1500)); return route.fulfill({ json: [] }); }
      return route.fulfill(state === 'empty' ? { json: [] } : { status: state === 'forbidden' ? 403 : 503, json: { error: state === 'forbidden' ? '当前没有查看权限' : 'MAX178 受控读取失败' } });
    });
    await page.reload();
    if (state === 'loading') await expect(view.locator('.loading')).toBeVisible();
    else if (state !== 'empty') await expect(view.getByRole('alert')).toBeVisible();
    else await expect(view).toContainText('新建提供商');
    for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 1000 }); await page.evaluate(t => document.documentElement.dataset.themeMode = t, theme);
      if (state === 'loading') { await page.reload(); await expect(view.locator('.loading')).toBeVisible(); await page.evaluate(t => document.documentElement.dataset.themeMode = t, theme); }
      await capture(page, `controlled-${state}-${width}-${theme}`, 'HTTP controlled supplemental state');
    }
    await page.unroute('**/api/llm/configs');
  }
  await page.reload(); await view.locator('.sidebar-item').filter({ hasText: 'MAX178 连接真实保存' }).click();
  await view.getByRole('button', { name: '编辑模型 MAX178 单模型真实保存', exact: true }).click();
  const dialog = view.locator('app-dialog').first(); await dialog.getByLabel('模型显示名称').fill('失败草稿应保留');
  await page.route(`**/api/llm/configs/${id}`, route => route.fulfill({ status: 403, json: { error: 'MAX178 受控管理权限受限' } }));
  await dialog.getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('受限'); await expect(dialog.getByLabel('模型显示名称')).toHaveValue('失败草稿应保留');
  await capture(page, 'controlled-save-error-390-dark', 'HTTP controlled supplemental failure');
});
