import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const key = 'slide.control.settings.v1:default';
async function ax(page: Page, info: TestInfo, name: string) {
  const session = await page.context().newCDPSession(page);
  const tree = await session.send('Accessibility.getFullAXTree');
  await writeFile(info.outputPath(name), JSON.stringify(tree, null, 2));
  await info.attach(name, { body: JSON.stringify(tree, null, 2), contentType: 'application/json' });
  await session.detach(); return tree.nodes.filter(node => !node.ignored);
}
for (const theme of ['light', 'dark']) test(`table keyboard and help independence ${theme}`, async ({ page }, info) => {
  await page.goto('/e2e/fixtures/keyboard-table.html');
  await page.evaluate(theme => document.documentElement.dataset.themeMode = theme, theme);
  const table = page.locator('app-data-table');
  const name = table.getByRole('button', { name: '名称', exact: true });
  await page.locator('#before').focus(); await page.keyboard.press('Tab'); await expect(name).toBeFocused();
  expect(await name.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter'); await expect(table.locator('th').first()).toHaveAttribute('aria-sort', 'ascending');
  await page.keyboard.press('Space'); await expect(table.locator('th').first()).toHaveAttribute('aria-sort', 'descending');
  await expect.poll(() => page.evaluate(() => (window as any).sorts.length)).toBe(2);
  await page.keyboard.press('Tab'); const help = table.getByRole('button', { name: '名称说明', exact: true }); await expect(help).toBeFocused();
  await page.keyboard.press('Enter'); await page.keyboard.press('Space'); await help.click();
  expect(await page.evaluate(() => ({ sorts: (window as any).sorts.length, helps: (window as any).helps.length }))).toEqual({ sorts: 2, helps: 3 });
  await help.focus(); await page.keyboard.press('Tab'); const size = table.getByRole('button', { name: '大小', exact: true }); await expect(size).toBeFocused();
  await page.keyboard.press('Space'); await expect(table.locator('th').nth(1)).toHaveAttribute('aria-sort', 'ascending');
  await expect(table.locator('th').first()).not.toHaveAttribute('aria-sort');
  await page.keyboard.press('Tab'); await expect(page.locator('#after')).toBeFocused();
  await table.locator('th').nth(1).click();
  await expect(table.locator('th').nth(1)).toHaveAttribute('aria-sort', 'descending');
  const count = await page.evaluate(() => (window as any).sorts.length);
  await table.locator('th').nth(2).click();
  expect(await page.evaluate(() => (window as any).sorts.length)).toBe(count);
  const nodes = await ax(page, info, `table-${theme}-AX.json`);
  expect(nodes.some(node => node.role?.value === 'button' && node.name?.value === '大小')).toBe(true);
  expect(nodes.some(node => node.role?.value === 'columnheader' && String(node.name?.value).includes('大小'))).toBe(true);
  await size.focus(); await page.screenshot({ path: info.outputPath(`table-${theme}-focus.png`) });
  // Same interactive behavior as mouse while loading and when empty; unsortable columns never activate.
  for (const loading of [true, false]) {
    await table.evaluate((el, loading) => { (el as any).rows = []; (el as any).loading = loading; }, loading);
    await name.focus(); await page.keyboard.press('Enter'); await expect(table.locator('th').first()).toHaveAttribute('aria-sort', loading ? 'ascending' : 'descending');
  }
});

for (const mode of ['normal', 'empty', 'loading', 'failed', 'forbidden', 'stale', 'dark-narrow']) test(`preset keyboard persistence ${mode}`, async ({ page }, info) => {
  await page.setViewportSize({ width: mode === 'dark-narrow' ? 390 : 1280, height: 900 });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ key, mode }) => {
    if (sessionStorage.getItem('keyboard-initialized')) return;
    sessionStorage.setItem('keyboard-initialized', '1');
    localStorage.setItem('token', 'controlled-keyboard-token'); localStorage.setItem('slide.control.session_token.v1', 'controlled-keyboard-token');
    localStorage.setItem('slide.i18n.locale', 'en');
    localStorage.setItem(key, JSON.stringify({ locale: 'en', themeMode: mode === 'dark-narrow' ? 'dark' : 'light', accentColor: mode === 'stale' ? '#123456' : '#409eff', visibleTabs: [], navCollapsed: false }));
  }, { key, mode });
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => { if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' })); }));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    if (/diagnose-agent|chat\/send|completions/.test(path)) throw new Error('Product model call forbidden');
    if (path === '/api/auth/permissions') return route.fulfill({ json: mode === 'forbidden' ? [] : ['*'] });
    if (path === '/api/user/preferences') {
      if (mode === 'loading' && route.request().method() === 'GET') await new Promise(resolve => setTimeout(resolve, 1500));
      if (mode === 'failed' || mode === 'forbidden') return route.fulfill({ status: mode === 'failed' ? 503 : 403, json: { error: 'CONTROLLED_PREFERENCE_FAILURE' } });
      return route.fulfill({ json: { preferences: mode === 'normal' ? { accentColor: '#409eff' } : {} } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/settings/platform/appearance');
  const presets = page.locator('appearance-settings .color-swatch');
  await expect(presets).toHaveCount(12);
  if (mode === 'dark-narrow') {
    // Controlled theme tokens: independent of the mocked gateway's shell initialization.
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.dataset.themeMode = 'dark'; });
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark');
  }
  await expect(presets.first()).toHaveAttribute('aria-pressed', mode === 'stale' ? 'false' : 'true');
  if (mode === 'stale') await expect(page.locator('appearance-settings .color-swatch[aria-pressed="true"]')).toHaveCount(0);
  await presets.first().focus(); await page.keyboard.press('Tab'); await expect(presets.nth(1)).toBeFocused();
  expect(await presets.nth(1).evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter'); await expect(presets.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Tab'); await page.keyboard.press('Space'); await expect(presets.nth(2)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).accentColor, key)).toBe('#34d399');
  const nodes = await ax(page, info, `preset-${mode}-AX.json`);
  expect(nodes.some(node => node.role?.value === 'button' && node.name?.value === 'Emerald' && node.properties?.some(prop => prop.name === 'pressed' && prop.value.value === 'true'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`preset-${mode}-focus.png`) });
  await page.locator('appearance-settings app-card').filter({ has: page.locator('[slot="header"]').filter({ hasText: /^Language$/ }) }).locator('select').selectOption('zh-CN');
  await expect(presets.nth(2)).toHaveAttribute('aria-label', '翠绿');
  await page.reload(); await expect(presets.nth(2)).toHaveAttribute('aria-pressed', 'true');
  await expect(presets.nth(2)).toHaveAttribute('aria-label', '翠绿');
  await presets.first().click(); await expect(presets.first()).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});
