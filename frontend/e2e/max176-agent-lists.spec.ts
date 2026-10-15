import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const output = process.env.MAX176_OUTPUT_DIR || '../.runtime/max176/evidence';
async function login(page: Page, theme = 'light') {
  const response = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.MAX176_TEST_PASSWORD || 'max176-isolated-test-only' } });
  expect(response.ok()).toBe(true);
  const auth = await response.json();
  expect(auth.token).toBeTruthy();
  const permissions = await page.request.get('/api/auth/permissions', { headers: { Authorization: `Bearer ${auth.token}` } }).then(r => r.json());
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
}
for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
  test(`tools real representative ${width} ${theme}`, async ({ page }) => {
    await login(page, theme); await page.setViewportSize({ width, height: 1000 });
    await page.goto('/settings/ai/capabilities?view=tools');
    const view = page.locator('agent-tools-page');
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
async function controlled(page: Page, scenario = 'normal', theme = 'light') {
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
    if (path === '/api/agent/tools') {
      if (scenario === 'loading') await new Promise(resolve => setTimeout(resolve, 2000));
      if (['failed', 'forbidden'].includes(scenario)) return route.fulfill({ status: scenario === 'failed' ? 503 : 403, json: { error: 'controlled' } });
      return route.fulfill({ json: { ok: true, tools: scenario === 'empty' ? [] : toolFixtures } });
    }
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
