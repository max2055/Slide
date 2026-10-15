import { test, expect, type Page } from '@playwright/test';

// API/auth states are controlled; the actual app, controls, i18n and local preference
// persistence run in Chromium. These tests never call a product model or shared API.
const key = 'slide.control.settings.v1:default';
const output = process.env.MAX168_OUTPUT_DIR ?? 'test-results/max168';
async function setup(page: Page, locale = 'zh-CN', theme = 'light', mode = 'normal') {
  await page.addInitScript(({ key, locale, theme }) => {
    if (!sessionStorage.getItem('appearance-initialized')) {
      sessionStorage.setItem('appearance-initialized', '1');
      localStorage.setItem('token', 'controlled-appearance-token');
      localStorage.setItem('slide.control.session_token.v1', 'controlled-appearance-token');
      localStorage.setItem('slide.i18n.locale', locale);
      localStorage.setItem(key, JSON.stringify({ locale, themeMode: theme, defaultTab: 'instances-db', visibleTabs: [], navCollapsed: false }));
    }
  }, { key, locale, theme });
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    if (/diagnose-agent|chat\/send|completions/.test(path)) throw new Error('Product model calls forbidden in appearance tests');
    if (path === '/api/auth/permissions') return route.fulfill({ json: mode === 'forbidden' ? [] : ['*'] });
    if (path === '/api/user/preferences') {
      if (route.request().method() !== 'GET') return route.fulfill({ json: { success: true } });
      if (mode === 'loading') await new Promise(resolve => setTimeout(resolve, 1800));
      if (mode === 'failed' || mode === 'forbidden') return route.fulfill({ status: mode === 'failed' ? 503 : 403, json: { error: 'CONTROLLED_PREFERENCES_UNAVAILABLE' } });
      return route.fulfill({ json: { preferences: {} } });
    }
    return route.fulfill({ json: {} });
  });
}
function card(page: Page, title: string) {
  return page.locator('appearance-settings app-card').filter({ has: page.locator('[slot="header"]').filter({ hasText: new RegExp(`^${title}$`) }) });
}
async function capture(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
}
for (const locale of ['en', 'zh-CN']) for (const theme of ['light', 'dark']) for (const width of [1280, 390]) {
  test(`labels and values ${locale} ${theme} ${width}`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 }); await setup(page, locale, theme);
    await page.goto('/settings/platform/appearance');
    const chinese = locale === 'zh-CN';
    const landing = card(page, chinese ? '默认首页' : 'Default Landing Page').locator('select');
    await expect(landing).toHaveValue('instances-db');
    await expect(landing.locator('option[value="instances-db"]')).toHaveText(chinese ? '数据库' : 'Databases');
    await expect(landing.locator('option[value="network-devices"]')).toHaveText(chinese ? '网络设备' : 'Network Devices');
    const visible = card(page, chinese ? '侧边栏标签' : 'Sidebar Tabs');
    await expect(visible).not.toContainText('instances-db');
    await expect(visible).not.toContainText('network-devices');
    await expect(visible).toContainText(chinese ? '数据库' : 'Databases');
    const data = card(page, chinese ? '数据显示' : 'Data Display');
    await expect(data.locator('select').first().locator('option').first()).toHaveText(chinese ? '10 条' : '10 rows');
    await expect(page.locator('appearance-settings h1')).toHaveText(chinese ? '外观' : 'Appearance');
    if (!chinese) expect(await page.locator('appearance-settings').evaluate(el => el.shadowRoot!.textContent!.replace('简体中文', ''))).not.toMatch(/[\u4e00-\u9fff]/);
    await capture(page, `${locale}-${theme}-${width}-controlled-shell`);
    await landing.scrollIntoViewIfNeeded(); await capture(page, `${locale}-${theme}-${width}-route-options`);
    await data.scrollIntoViewIfNeeded(); await capture(page, `${locale}-${theme}-${width}-data-options`);
    expect(errors).toEqual([]);
  });
}

test('selection and keyboard toggle preserve route IDs and local preferences across reload', async ({ page }) => {
  await setup(page); await page.goto('/settings/platform/appearance');
  const landing = card(page, '默认首页').locator('select');
  await landing.selectOption('servers');
  await expect(landing).toHaveValue('servers');
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).defaultTab, key)).toBe('servers');
  const toggle = card(page, '侧边栏标签').locator('app-toggle').filter({ hasText: '数据库' }).locator('button');
  await toggle.focus(); await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).visibleTabs.includes('instances-db'), key)).toBe(false);
  await card(page, '数据显示').locator('select').first().selectOption('25');
  const language = card(page, '语言').locator('select');
  await language.selectOption('en');
  await expect(page.locator('appearance-settings h1')).toHaveText('Appearance');
  await expect(card(page, 'Language').locator('select')).toHaveValue('en');
  await page.reload();
  await expect(card(page, 'Default Landing Page').locator('select')).toHaveValue('servers');
  await expect(card(page, 'Data Display').locator('select').first()).toHaveValue('25');
  await expect(card(page, 'Language').locator('select')).toHaveValue('en');
  await capture(page, 'keyboard-reload-english');
});

for (const mode of ['empty', 'loading', 'failed', 'forbidden']) test(`local appearance works with ${mode} server preferences`, async ({ page }) => {
  await setup(page, 'zh-CN', 'light', mode); await page.goto('/settings/platform/appearance');
  await expect(page.locator('appearance-settings h1')).toHaveText('外观');
  await expect(card(page, '默认首页').locator('select')).toHaveValue('instances-db');
  await card(page, '默认首页').locator('select').selectOption('network-devices');
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).defaultTab, key)).toBe('network-devices');
});

test('unknown route and stale locale stay readable without silently replacing the stored route', async ({ page }) => {
  await setup(page); await page.goto('/settings/platform/appearance');
  await expect(page.locator('appearance-settings h1')).toHaveText('外观');
  await page.addInitScript(key => {
    const settings = JSON.parse(localStorage.getItem(key)!);
    settings.defaultTab = 'obsolete-route'; settings.locale = 'unsupported';
    localStorage.setItem(key, JSON.stringify(settings));
  }, key);
  await page.reload();
  await expect(card(page, '语言').locator('select')).toHaveValue('zh-CN');
  const landing = card(page, '默认首页').locator('select');
  await expect(landing).toHaveValue('obsolete-route');
  await expect(landing.locator('option:checked')).toHaveText('原选页面已不可用');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).defaultTab, key)).toBe('obsolete-route');
  await capture(page, 'unavailable-route-controlled');
});
