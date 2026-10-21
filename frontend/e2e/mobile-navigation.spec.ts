import { expect, test, type Page } from '@playwright/test';

// Real authenticated shell; provide a protected storageState for the target API.
async function setup(page: Page, width: number, theme = 'light') {
  await page.setViewportSize({ width, height: 812 });
  await page.goto('/settings');
  await expect(page.locator('.shell')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (document.querySelector('slide-app') as any)?.connected)).toBe(true);
  await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; }, theme);
}

for (const width of [375, 768]) for (const theme of ['light', 'dark']) {
  test(`mobile modal navigation ${width} ${theme}`, async ({ page }, info) => {
    await setup(page, width, theme);
    const toggle = page.locator('.topbar-nav-toggle'), nav = page.locator('.shell-nav');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.screenshot({ path: info.outputPath('open.png') });
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    const box = await toggle.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Tab');
    expect(await nav.evaluate(el => el.contains(document.activeElement))).toBe(false);
    await toggle.click();
    await expect.poll(() => nav.evaluate(el => el.contains(document.activeElement))).toBe(true);
    const buttons = nav.locator('button:visible, a[href]:visible');
    const first = buttons.first(), last = buttons.last();
    await first.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(last).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    await page.locator('.topbar-search').evaluate(el => (el as HTMLElement).focus());
    expect(await nav.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.screenshot({ path: info.outputPath('keyboard-focus.png') });
    await page.mouse.click(width - 10, 400);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await page.screenshot({ path: info.outputPath('closed.png') });
  });
}

for (const theme of ['light', 'dark']) test(`desktop navigation ${theme}`, async ({ page }, info) => {
  await setup(page, 1440, theme);
  await expect(page.locator('.topbar-nav-toggle')).not.toBeVisible();
  await expect(page.locator('.shell-nav')).toBeVisible();
  const toggle = page.locator('.nav-collapse-toggle');
  const before = await page.locator('.shell').getAttribute('class');
  await toggle.click();
  await expect.poll(() => page.locator('.shell').getAttribute('class')).not.toBe(before);
  await toggle.click();
  await expect(page.locator('.shell')).toHaveAttribute('class', before!);
  await page.screenshot({ path: info.outputPath('desktop.png') });
});

test('route, breakpoint, repeated opening and short-height navigation scrolling', async ({ page }) => {
  await setup(page, 375);
  const toggle = page.locator('.topbar-nav-toggle'), nav = page.locator('.shell-nav');
  for (let i = 0; i < 3; i++) {
    await toggle.click(); await page.keyboard.press('Escape'); await expect(toggle).toBeFocused();
  }
  await toggle.click();
  await nav.locator('a[href="/attention"]').click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  await toggle.click();
  await page.setViewportSize({ width: 1440, height: 812 });
  await expect(nav).not.toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('.topbar-search')).toBeEnabled();
  await page.locator('.topbar-search').focus();
  await expect(page.locator('.topbar-search')).toBeFocused();
  await page.setViewportSize({ width: 768, height: 460 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const items = nav.locator('a[href]:visible');
  await items.last().focus();
  await expect(items.last()).toBeInViewport();
  await page.keyboard.press('Escape'); await expect(toggle).toBeFocused();
  await page.goBack();
});
