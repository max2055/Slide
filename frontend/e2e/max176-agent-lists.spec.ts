import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const errors: string[] = []; browserErrors.set(page, errors); page.on('pageerror', error => errors.push(error.message)); });
test.afterEach(({ page }) => { expect(browserErrors.get(page)).toEqual([]); });

const output = process.env.MAX176_OUTPUT_DIR || '../.runtime/max176/evidence';
let cachedAuth: any;
let cachedPermissions: any;
async function login(page: Page, theme = 'light') {
  if (!cachedAuth) {
  const response = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.MAX176_TEST_PASSWORD || 'max176-isolated-test-only' } });
  expect(response.ok()).toBe(true);
  const auth = await response.json();
  expect(auth.token).toBeTruthy();
  cachedAuth = auth;
  cachedPermissions = await page.request.get('/api/auth/permissions', { headers: { Authorization: `Bearer ${auth.token}` } }).then(r => r.json());
  }
  const auth = cachedAuth, permissions = cachedPermissions;
  const prefs = await page.request.put('/api/user/preferences', { headers: { Authorization: `Bearer ${auth.token}` }, data: { preferences: { theme: 'claw', themeMode: theme, locale: 'zh-CN' } } });
  expect(prefs.ok()).toBe(true);
  await page.addInitScript(({ auth, permissions, theme }) => {
    localStorage.setItem('token', auth.token); localStorage.setItem('refreshToken', auth.refreshToken);
    localStorage.setItem('slide.control.session_token.v1', auth.token);
    localStorage.setItem('permissions', JSON.stringify(permissions)); localStorage.setItem('user', JSON.stringify(auth.user));
    localStorage.setItem('slide.i18n.locale', 'zh-CN'); localStorage.setItem('app-theme-mode', theme);
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', themeMode: theme, navCollapsed: false }));
  }, { auth, permissions, theme });
}
async function capture(page: Page, name: string) {
  await mkdir(output, { recursive: true });
  if (name.includes('-dark')) await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  if (name.includes('-light')) await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
}
for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
  test(`tools real representative ${width} ${theme}`, async ({ page }) => {
    await login(page, theme); await page.setViewportSize({ width, height: 1000 });
    await page.goto('/settings/ai/capabilities?view=tools');
    const view = page.locator('agent-tools-page');
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', theme);
    await expect(view.locator('tbody tr')).toHaveCount(6);
    await expect(view).toContainText('执行时仍需校验');
    await capture(page, `tools-${width}-${theme}-real`);
    const detail = view.getByRole('button', { name: /查看 .* 详情/ }).first();
    await detail.focus(); await page.keyboard.press('Enter');
    await expect(view.locator('app-dialog[title="工具详情"]')).toContainText('参数 Schema');
    await view.getByText('完整技术信息', { exact: true }).click();
    await expect(view.locator('app-dialog[title="工具详情"] pre').last()).toContainText('security');
    await capture(page, `tools-detail-${width}-${theme}-real`);
    await page.keyboard.press('Escape'); await expect(detail).toBeFocused();
    await view.getByRole('button', { name: '下一页', exact: true }).click();
    await view.getByRole('searchbox').fill('query_metrics');
    await expect(view).toContainText('第 1 / 1 页'); await expect(view.locator('tbody tr')).toHaveCount(1);
  });
}

const toolFixtures = Array.from({ length: 19 }, (_, i) => ({
  name: `tool-${String(i).padStart(2, '0')}`, description: `资源核查 ${i}：${'用途长文本；'.repeat(250)}`,
  parameters: { type: 'object', properties: { query: { type: 'string', description: '复杂 Schema'.repeat(800) } } },
  security: i === 0 ? null : { effect: i % 2 ? 'read' : 'write', resource: 'instance', permissions: ['instance:view'], approval: i % 2 ? 'never' : 'always' },
  metadata: { readOnly: i === 2 || i % 2 === 1, ownerOnly: i === 2, dangerLevel: i === 2 ? 3 : 0 },
}));
async function controlled(page: Page, scenario = 'normal', theme = 'light', kind = 'tools') {
  await page.addInitScript(({ theme }) => {
    localStorage.setItem('token', 'max176-controlled'); localStorage.setItem('permissions', '["*"]');
    localStorage.setItem('slide.control.session_token.v1', 'max176-controlled');
    localStorage.setItem('slide.i18n.locale', 'zh-CN'); localStorage.setItem('app-theme-mode', theme);
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', themeMode: theme, navCollapsed: false }));
  }, { theme });
  await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => { if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' })); }));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    if (path === (kind === 'sessions' ? '/api/sessions' : `/api/agent/${kind}`)) {
      if (scenario === 'loading') await new Promise(resolve => setTimeout(resolve, 2000));
      if (['failed', 'forbidden'].includes(scenario)) return route.fulfill({ status: scenario === 'failed' ? 503 : 403, json: { error: 'controlled' } });
      return route.fulfill({ json: { ok: true, [kind]: scenario === 'empty' ? [] : kind === 'sessions' ? sessionFixtures : kind === 'skills' ? skillFixtures : toolFixtures } });
    }
    if (path === '/api/chat/history') return route.fulfill({ json: { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '可追溯思考' }, { type: 'text', text: '长消息；'.repeat(600) }], timestamp: 1780000000000, messageParts: [{ arbitrary: '原始扩展字段' }] }], nextBefore: null } });
    if (path.endsWith('/toggle')) return route.fulfill({ json: { ok: false } });
    return route.fulfill({ json: path === '/api/auth/permissions' ? ['*'] : path === '/api/user/preferences' ? { preferences: { locale: 'zh-CN', themeMode: theme } } : {} });
  });
}
for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) test(`tools controlled long ${width} ${theme}`, async ({ page }) => {
  page.on('pageerror', error => console.error('MAX176 browser:', error.message));
  await controlled(page, 'normal', theme); await page.setViewportSize({ width, height: 1000 });
  await page.goto('/settings/ai/capabilities?view=tools'); const view = page.locator('agent-tools-page');
  await expect(view.locator('tbody tr')).toHaveCount(6); await expect(view).toContainText('边界未知');
  await expect(view).toContainText('读写声明不一致'); await expect(view).toContainText('必须审批');
  expect(await view.locator('tbody tr').first().evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(160);
  await capture(page, `tools-${width}-${theme}-long-controlled`);
  await view.getByRole('button', { name: '下一页', exact: true }).click();
  const button = view.getByRole('button', { name: '查看 tool-06 详情', exact: true });
  await button.focus(); await page.keyboard.press('Enter');
  await expect(view.locator('app-dialog[title="工具详情"]')).toContainText(toolFixtures[6].description);
  await expect(view.locator('app-dialog[title="工具详情"]')).toContainText(toolFixtures[6].parameters.properties.query.description);
  await capture(page, `tools-detail-${width}-${theme}-long-controlled`);
  await page.keyboard.press('Escape'); await expect(button).toBeFocused(); await expect(view).toContainText('第 2 / 4 页');
  await view.getByRole('searchbox').fill('资源核查 18'); await expect(view.locator('tbody tr')).toHaveCount(1); await expect(view).toContainText('第 1 / 1 页');
  await view.getByRole('searchbox').fill('不存在'); await expect(view).toContainText('没有符合条件的记录');
  await view.getByRole('searchbox').fill(''); await view.getByRole('combobox', { name: '清单筛选' }).selectOption('read');
  await expect(view).toContainText('共 9 条');
});
for (const scenario of ['empty', 'failed', 'forbidden', 'loading']) test(`tools controlled ${scenario}`, async ({ page }) => {
  await controlled(page, scenario); await page.setViewportSize({ width: 390, height: 950 });
  await page.goto('/settings/ai/capabilities?view=tools'); const view = page.locator('agent-tools-page');
  if (scenario === 'empty') await expect(view).toContainText('暂无已注册工具');
  else if (scenario === 'loading') await expect(view.getByRole('status')).toContainText('正在加载工具清单');
  else await expect(view.getByRole('alert')).toContainText(scenario === 'failed' ? '暂时无法读取' : '当前没有查看权限');
  await capture(page, `tools-${scenario}-390-light-controlled`);
});

const sessionFixtures = Array.from({ length: 19 }, (_, i) => ({ key: `full-uuid-${i}-private-key`, label: i === 0 ? 'full-uuid-0-private-key' : `会话 ${String(i).padStart(2, '0')} ${'长标题'.repeat(80)}`, kind: 'direct', status: i === 0 ? 'unknown-status' : i % 2 ? 'completed' : 'active', updatedAt: i === 0 ? null : 1780000000000 + i, message_count: 105, instance_id: 42 }));
const skillFixtures = Array.from({ length: 19 }, (_, i) => ({ name: `skill-${String(i).padStart(2, '0')}`, description: '完整用途；'.repeat(400), enabled: i % 2 === 0, filePath: '/' + 'long-directory/'.repeat(50) + 'SKILL.md', frontmatter: { arbitrary: '完整原始字段'.repeat(300) }, source: 'operator', digest: 'a'.repeat(64), trusted: false }));
const urls = { sessions: '/settings/ai/sessions', skills: '/settings/ai/capabilities?view=skills' };
for (const kind of ['sessions', 'skills'] as const) for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
  test(`${kind} real ${width} ${theme}`, async ({ page }) => {
    await login(page, theme); await page.setViewportSize({ width, height: 1000 });
    await page.goto(urls[kind]); const view = page.locator(`agent-${kind}-page`);
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', theme);
    await expect(view.locator('tbody tr')).toHaveCount(kind === 'sessions' ? 6 : 5);
    await capture(page, `${kind}-${width}-${theme}-real`);
    if (kind === 'sessions') {
      await view.getByRole('button', { name: '下一页', exact: true }).click();
      await view.getByRole('searchbox').fill('数据库健康核查');
      await expect(view).toContainText('第 1 / 1 页');
    }
    const button = view.getByRole('button', { name: /查看 .* 详情/ }).first();
    await button.focus(); await page.keyboard.press('Enter');
    const dialog = view.locator(kind === 'sessions' ? 'app-dialog[title="会话详情"]' : 'app-dialog[title="技能详情"]');
    await expect(dialog).toContainText(kind === 'sessions' ? 'max176-0000-session' : 'Frontmatter');
    await capture(page, `${kind}-detail-${width}-${theme}-real`);
    if (kind === 'sessions') {
      await expect(dialog).toContainText('已加载 100 条');
      await expect(dialog.locator('.message-content').last()).toContainText('核对资源证据与缺口');
      await expect(dialog.locator('.message-content').last()).toContainText('长内容可追溯，无需发起模型调用。'.repeat(200));
      await view.getByRole('button', { name: '加载更早消息', exact: true }).click();
      await expect(dialog).toContainText('已加载 105 条 · 已加载全部消息');
      await expect(dialog.locator('.message').first()).toContainText('真实存储验收消息 0');
      expect(await dialog.innerText()).not.toContain('[object Object]');
      expect(await dialog.innerText()).not.toContain('Invalid Date');
      await dialog.locator('.message').last().scrollIntoViewIfNeeded();
      await capture(page, `${kind}-long-message-${width}-${theme}-real`);
    }
    await page.keyboard.press('Escape'); await expect(button).toBeFocused();
    if (kind === 'skills') {
      const name = (await view.locator('tbody .entity').first().innerText()).trim();
      await view.getByRole('button', { name: `禁用 ${name}`, exact: true }).click();
      await expect(view.getByRole('button', { name: `启用 ${name}`, exact: true })).toBeEnabled();
      await expect(view.locator('tbody tr').first()).toContainText('已禁用');
      const readback = await page.request.get('/api/agent/skills', { headers: { Authorization: `Bearer ${cachedAuth.token}` } }).then(r => r.json());
      expect(readback.skills.find((s: any) => s.name === name).enabled).toBe(false);
      await view.getByRole('button', { name: `启用 ${name}`, exact: true }).click();
      await expect(view.getByRole('button', { name: `禁用 ${name}`, exact: true })).toBeEnabled();
    }
  });
}
for (const kind of ['sessions', 'skills'] as const) for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
  test(`${kind} controlled long ${width} ${theme}`, async ({ page }) => {
    await controlled(page, 'normal', theme, kind); await page.setViewportSize({ width, height: 1000 });
    await page.goto(urls[kind]); const view = page.locator(`agent-${kind}-page`);
    await expect(view.locator('tbody tr')).toHaveCount(6);
    expect(await view.locator('tbody tr').first().evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(150);
    await capture(page, `${kind}-${width}-${theme}-long-controlled`);
    await view.getByRole('button', { name: '下一页', exact: true }).click();
    const button = view.getByRole('button', { name: /查看 .* 详情/ }).first();
    await button.focus(); await page.keyboard.press('Enter');
    const dialog = view.locator(kind === 'sessions' ? 'app-dialog[title="会话详情"]' : 'app-dialog[title="技能详情"]');
    await expect(dialog).toContainText(kind === 'sessions' ? 'full-uuid-' : skillFixtures[0].filePath);
    if (kind === 'sessions') {
      await expect(dialog.locator('.message-content')).toContainText('长消息；'.repeat(600));
      await dialog.getByText('消息原始字段', { exact: true }).click(); await expect(dialog).toContainText('原始扩展字段');
    } else await expect(dialog).toContainText(skillFixtures[0].frontmatter.arbitrary);
    await capture(page, `${kind}-detail-${width}-${theme}-long-controlled`);
    if (kind === 'skills') { await dialog.locator('dl').scrollIntoViewIfNeeded(); await capture(page, `skills-technical-${width}-${theme}-long-controlled`); }
    await page.keyboard.press('Escape'); await expect(button).toBeFocused(); await expect(view).toContainText('第 2 / 4 页');
    await view.getByRole('searchbox').fill(kind === 'sessions' ? 'full-uuid-0-' : 'skill-18');
    await expect(view.locator('tbody tr')).toHaveCount(1); await expect(view).toContainText('第 1 / 1 页');
    if (kind === 'sessions') { await expect(view.locator('tbody')).toContainText('未命名会话'); await expect(view.locator('tbody')).toContainText('未知状态'); }
    await view.getByRole('searchbox').fill('不存在'); await expect(view).toContainText('没有符合条件的记录');
    await view.getByRole('searchbox').fill(''); await view.getByRole('combobox', { name: '清单筛选' }).selectOption(kind === 'sessions' ? 'active' : 'enabled');
    await expect(view).toContainText(kind === 'sessions' ? '共 9 条' : '共 10 条');
  });
}
for (const kind of ['sessions', 'skills'] as const) for (const scenario of ['empty', 'failed', 'forbidden', 'loading']) test(`${kind} controlled ${scenario}`, async ({ page }) => {
  await controlled(page, scenario, 'light', kind); await page.setViewportSize({ width: 390, height: 950 });
  await page.goto(urls[kind]); const view = page.locator(`agent-${kind}-page`);
  if (scenario === 'empty') await expect(view).toContainText(kind === 'sessions' ? '暂无会话' : '暂无已加载技能');
  else if (scenario === 'loading') await expect(view.getByRole('status')).toContainText(kind === 'sessions' ? '正在加载会话清单' : '正在加载技能清单');
  else await expect(view.getByRole('alert')).toContainText(scenario === 'failed' ? '暂时无法读取' : '当前没有查看权限');
  await capture(page, `${kind}-${scenario}-390-light-controlled`);
});
test('sessions real deletion with confirmation and server readback', async ({ page }) => {
  await login(page); await page.goto(urls.sessions); const view = page.locator('agent-sessions-page');
  await view.getByRole('searchbox').fill('资源巡检对话 13');
  await expect(view.locator('tbody tr')).toHaveCount(1);
  page.once('dialog', dialog => dialog.dismiss());
  await view.getByRole('button', { name: '删除 资源巡检对话 13', exact: true }).click(); await expect(view.locator('tbody tr')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept());
  await view.getByRole('button', { name: '删除 资源巡检对话 13', exact: true }).click(); await expect(view).toContainText('没有符合条件的记录');
  const data = await page.request.get('/api/sessions', { headers: { Authorization: `Bearer ${cachedAuth.token}` } }).then(r => r.json());
  expect(data.sessions.some((s: any) => s.key === 'max176-0013-session')).toBe(false);
});
test('skills controlled rejected toggle never reports success', async ({ page }) => {
  await controlled(page, 'normal', 'light', 'skills'); await page.goto(urls.skills); const view = page.locator('agent-skills-page');
  await view.getByRole('button', { name: '禁用 skill-00', exact: true }).click();
  await expect(view.getByRole('alert')).toContainText('状态尚未确认');
  await expect(view.locator('tbody tr').first()).toContainText('已启用');
});
for (const kind of ['tools', 'sessions', 'skills'] as const) test(`${kind} controlled ordering and page size`, async ({ page }) => {
  await controlled(page, 'normal', 'light', kind); await page.goto(kind === 'tools' ? '/settings/ai/capabilities?view=tools' : urls[kind]);
  const view = page.locator(`agent-${kind}-page`);
  await view.getByRole('combobox', { name: '排序', exact: true }).selectOption('name-desc');
  await expect(view.locator('tbody .entity').first()).toHaveText(kind === 'sessions' ? '未命名会话' : kind === 'tools' ? 'tool-18' : 'skill-18');
  await view.getByRole('combobox', { name: '每页条数', exact: true }).selectOption('12');
  await expect(view.locator('tbody tr')).toHaveCount(12);
  await view.getByRole('button', { name: '下一页', exact: true }).click(); await expect(view.locator('tbody tr')).toHaveCount(7);
  await view.getByRole('combobox', { name: '排序', exact: true }).selectOption('name');
  await expect(view).toContainText('第 1 / 2 页');
  await expect(view.locator('tbody .entity').first()).toHaveText(kind === 'sessions' ? sessionFixtures[1].label : kind === 'tools' ? 'tool-00' : 'skill-00');
});
