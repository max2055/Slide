import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('real JWT and MySQL preference save, language and fresh-browser reload', async ({ page, browser }, info) => {
  const login = await page.request.post('/api/auth/login', { data: { username: 'admin', password: process.env.QUALIFICATION_ADMIN_PASSWORD } });
  expect(login.status()).toBe(200); const session = await login.json();
  await page.addInitScript(session => {
    localStorage.setItem('token', session.token); localStorage.setItem('refreshToken', session.refreshToken);
    localStorage.setItem('user', JSON.stringify(session.user)); localStorage.setItem('slide.i18n.locale', 'en');
  }, session);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/settings/platform/appearance');
  const presets = page.locator('appearance-settings .color-swatch');
  await expect(presets).toHaveCount(12); await presets.first().focus();
  await page.keyboard.press('Tab'); await expect(presets.nth(1)).toBeFocused();
  let saved = page.waitForResponse(r => r.url().endsWith('/api/user/preferences') && r.request().method() === 'PUT' && r.request().postDataJSON()?.preferences?.accentColor === '#22d3ee');
  await page.keyboard.press('Enter'); expect((await saved).status()).toBe(200);
  await expect(presets.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Tab'); await expect(presets.nth(2)).toBeFocused();
  saved = page.waitForResponse(r => r.url().endsWith('/api/user/preferences') && r.request().method() === 'PUT' && r.request().postDataJSON()?.preferences?.accentColor === '#34d399');
  await page.keyboard.press('Space'); expect((await saved).status()).toBe(200);
  await expect(presets.nth(2)).toHaveAttribute('aria-pressed', 'true');
  const cdp = await page.context().newCDPSession(page); const tree = await cdp.send('Accessibility.getFullAXTree');
  expect(tree.nodes.some(node => !node.ignored && node.role?.value === 'button' && node.name?.value === 'Emerald' && node.properties?.some(prop => prop.name === 'pressed' && prop.value.value === 'true'))).toBe(true);
  await writeFile(info.outputPath('real-preferences-AX.json'), JSON.stringify(tree, null, 2));
  await info.attach('real-preferences-AX.json', { body: JSON.stringify(tree, null, 2), contentType: 'application/json' }); await cdp.detach();
  await page.screenshot({ path: info.outputPath('real-preferences-focus.png') });
  saved = page.waitForResponse(r => r.url().endsWith('/api/user/preferences') && r.request().method() === 'PUT' && r.request().postDataJSON()?.preferences?.locale === 'zh-CN');
  await page.locator('appearance-settings app-card').filter({ has: page.locator('[slot="header"]').filter({ hasText: /^Language$/ }) }).locator('select').selectOption('zh-CN');
  expect((await saved).status()).toBe(200);
  const prefs = await page.request.get('/api/user/preferences', { headers: { Authorization: `Bearer ${session.token}` } });
  expect(prefs.status()).toBe(200); expect((await prefs.json()).preferences).toMatchObject({ accentColor: '#34d399', locale: 'zh-CN' });
  await page.reload(); await expect(presets.nth(2)).toHaveAttribute('aria-pressed', 'true'); await expect(presets.nth(2)).toHaveAttribute('aria-label', '翠绿');
  // A new context has no local preference copy: verify the real server record is loaded too.
  const context = await browser.newContext();
  try {
    await context.addInitScript(session => { localStorage.setItem('token', session.token); localStorage.setItem('user', JSON.stringify(session.user)); }, session);
    const fresh = await context.newPage();
    await fresh.goto(`${new URL(page.url()).origin}/settings/platform/appearance`);
    // Server sync updates app settings; remount appearance after that async merge.
    await expect.poll(() => fresh.evaluate(() => JSON.parse(localStorage.getItem('slide.control.settings.v1:default') ?? '{}').accentColor)).toBe('#34d399');
    await fresh.reload();
    await expect(fresh.locator('appearance-settings .color-swatch').nth(2)).toHaveAttribute('aria-pressed', 'true');
    await expect(fresh.locator('appearance-settings .color-swatch').nth(2)).toHaveAttribute('aria-label', '翠绿');
    await fresh.screenshot({ path: info.outputPath('real-preferences-fresh-browser.png') });
  } finally { await context.close(); }
  expect(errors).toEqual([]);
});
