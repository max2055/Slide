import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const testingRequire = createRequire(import.meta.resolve('@open-wc/testing'));
const axeRequire = createRequire(testingRequire.resolve('chai-a11y-axe'));

async function capture(page: Page, path: string, theme: string) {
  // Exercise the production theme tokens without persisting a preference edit.
  await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; }, theme);
  await page.screenshot({ path, animations: 'disabled' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', theme);
}

// Real authenticated shell; provide a protected storageState for the target API.
async function setup(page: Page, width: number, theme = 'light') {
  await page.setViewportSize({ width, height: 812 });
  await page.goto('/settings');
  await expect(page.locator('.shell')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (document.querySelector('slide-app') as any)?.connected)).toBe(true);
  await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; }, theme);
}

test.beforeEach(async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  (info as any).navigationErrors = errors;
});
test.afterEach(async ({ page }, info) => {
  const result = {
    scenario: info.title, status: info.status, errors: (info as any).navigationErrors,
    viewport: page.viewportSize(),
    theme: await page.locator('html').getAttribute('data-theme-mode'),
    service: { pid: Number(execFileSync('lsof', ['-tiTCP:5219', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim()), port: 5219,
      cwd: process.cwd(), command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5219 --strictPort',
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), lifecycle: 'Playwright-managed; stopped after tests',
    },
  };
  await writeFile(info.outputPath('result.json'), JSON.stringify(result, null, 2));
  expect(result.errors).toEqual([]);
});

for (const width of [375, 768]) for (const theme of ['light', 'dark']) {
  test(`mobile modal navigation ${width} ${theme}`, async ({ page }, info) => {
    await setup(page, width, theme);
    const toggle = page.locator('.topbar-nav-toggle'), nav = page.locator('.shell-nav');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await capture(page, info.outputPath('open.png'), theme);
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    const box = await toggle.boundingBox();
    // The shell entrance transform can introduce sub-pixel floating point noise.
    expect(Math.round(box!.width * 100) / 100).toBeGreaterThanOrEqual(44);
    expect(Math.round(box!.height * 100) / 100).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Tab');
    expect(await nav.evaluate(el => el.contains(document.activeElement))).toBe(false);
    await toggle.click();
    await expect.poll(() => nav.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await expect(toggle).toHaveAttribute('aria-controls', await nav.getAttribute('id') as string);
    await expect(toggle).toHaveAttribute('aria-haspopup', 'dialog');
    const close = nav.locator('.nav-collapse-toggle');
    await expect(close).toHaveAccessibleName('折叠侧边栏');
    const closeBox = await close.boundingBox();
    expect(Math.round(closeBox!.width)).toBeGreaterThanOrEqual(44);
    expect(Math.round(closeBox!.height)).toBeGreaterThanOrEqual(44);
    const buttons = nav.locator('button:visible, a[href]:visible');
    const first = buttons.first(), last = buttons.last();
    await first.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(last).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    await page.locator('.topbar-search').evaluate(el => (el as HTMLElement).focus());
    expect(await nav.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await capture(page, info.outputPath('keyboard-focus.png'), theme);
    await page.addScriptTag({ path: axeRequire.resolve('axe-core/axe.min.js') });
    const violations = await nav.evaluate(async el => (await (window as any).axe.run(el)).violations.map((v: any) => ({ id: v.id, impact: v.impact })));
    await writeFile(info.outputPath('axe.json'), JSON.stringify(violations));
    expect(violations).toEqual([]);
    const cdp = await page.context().newCDPSession(page);
    const tree = await cdp.send('Accessibility.getFullAXTree');
    expect(tree.nodes.some(node => !node.ignored && node.role?.value === 'dialog' && node.name?.value)).toBe(true);
    expect(tree.nodes.some(node => !node.ignored && node.role?.value === 'button' && node.name?.value === 'Open command palette')).toBe(false);
    await cdp.detach();
    await page.mouse.click(width - 10, 400);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await capture(page, info.outputPath('closed.png'), theme);
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
  await capture(page, info.outputPath('desktop.png'), theme);
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
  await toggle.click();
  await page.goForward();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('right drawer, close button and closed navigation cannot receive Tab', async ({ page }) => {
  await setup(page, 375);
  await page.evaluate(() => { document.documentElement.dataset.sidebarPosition = 'right'; });
  const toggle = page.locator('.topbar-nav-toggle'), nav = page.locator('.shell-nav');
  await toggle.click();
  await nav.locator('.nav-collapse-toggle').click();
  await expect(toggle).toBeFocused();
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    expect(await nav.evaluate(el => el.contains(document.activeElement))).toBe(false);
  }
  await toggle.click();
  await nav.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
  const box = await nav.boundingBox();
  expect(Math.round(box!.x + box!.width)).toBe(375);
  await page.mouse.click(5, 400);
  await expect(toggle).toBeFocused();
});

test('existing compact mobile rail remains clickable while excluded from Tab', async ({ page }) => {
  await setup(page, 768);
  await page.evaluate(() => {
    const app = document.querySelector('slide-app') as any;
    app.settings = { ...app.settings, navCollapsed: true };
    app.setTab('operations-knowledge');
  });
  const nav = page.locator('.shell-nav'), toggle = page.locator('.topbar-nav-toggle');
  await expect(nav).toBeVisible();
  await toggle.focus();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    expect(await nav.evaluate(el => el.contains(document.activeElement))).toBe(false);
  }
  await nav.locator('a[href="/attention"]').click();
  await expect(page).toHaveURL(/attention/);
  await toggle.click();
  await nav.locator('.nav-collapse-toggle').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(nav.locator('a[href]:visible').last()).toBeFocused();
});
