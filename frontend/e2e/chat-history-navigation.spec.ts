import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/chat/greeting', (route) => route.fulfill({ json: { greeting: '你好' } }));
  await page.goto('/e2e/fixtures/chat-history.html');
  await expect(page.locator('chat-history-nav .tick')).toHaveCount(260);
});

test('equal ticks expand near the pointer, preview without scrolling, and restore on leave', async ({ page }) => {
  const ticks = page.locator('chat-history-nav .tick');
  const thread = page.locator('.chat-thread');
  const top = await thread.evaluate((element) => element.scrollTop);
  await expect.poll(() => ticks.nth(0).evaluate((el) => getComputedStyle(el, '::before').width)).toBe('12px');
  await ticks.nth(180).hover();
  await expect(page.getByRole('tooltip')).toContainText('第 181 轮');
  await expect.poll(() => ticks.nth(180).evaluate((el) => parseFloat(getComputedStyle(el, '::before').width))).toBe(52);
  const widths = await ticks.evaluateAll((elements) => [180, 181, 182, 183, 184].map((i) => parseFloat(getComputedStyle(elements[i], '::before').width)));
  expect(widths).toEqual([52, 42, 32, 22, 12]);
  expect(await thread.evaluate((el) => el.scrollTop)).toBe(top);
  await page.screenshot({ path: test.info().outputPath('history-hover.png') });
  await page.mouse.move(1000, 20);
  await expect(page.getByRole('tooltip')).toBeHidden();
  await expect.poll(() => ticks.nth(180).evaluate((el) => getComputedStyle(el, '::before').width)).toBe('12px');
});

test('old turns render on demand, highlight accurately, and streaming does not steal position', async ({ page }) => {
  await expect(page.locator('[data-chat-turn="msg:0"]')).toHaveCount(0);
  await page.locator('chat-history-nav .tick').first().click();
  const target = page.locator('[data-chat-turn="msg:0"]');
  await expect(target).toBeVisible();
  await expect(target).toHaveClass(/chat-history-highlight/);
  await expect(page.locator('[data-chat-turn]')).toHaveCount(100);
  const top = await page.locator('.chat-thread').evaluate((el) => el.scrollTop);
  await page.evaluate(() => (window as any).historyFixture.stream());
  await page.waitForTimeout(350);
  expect(await page.locator('.chat-thread').evaluate((el) => el.scrollTop)).toBe(top);
  await expect(page.getByText('新增流式回复', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '回到最新' }).click();
  await expect(page.locator('[data-chat-turn="msg:518"]')).toBeVisible();
  await expect(page.getByText('新增流式回复', { exact: true })).toBeVisible();
});

test('manual scrolling updates the active tick; switching sessions clears preview and history selection', async ({ page }) => {
  await page.locator('chat-history-nav .tick').nth(180).click();
  await page.locator('.chat-thread').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('chat-history-nav .tick[aria-current="true"]')).toHaveAttribute('aria-label', /第 260 轮/);
  await page.locator('chat-history-nav .tick').last().hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.evaluate(() => (window as any).historyFixture.switchSession());
  await expect(page.locator('chat-history-nav .tick')).toHaveCount(1);
  await expect(page.getByRole('tooltip')).toBeHidden();
  await expect(page.locator('[data-chat-turn="msg:new-user"]')).toBeVisible();
});

test('keyboard navigation and preview remain within narrow dark viewports', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme-mode', 'dark'));
  const ticks = page.locator('chat-history-nav .tick');
  await ticks.nth(160).focus();
  await page.keyboard.press('End');
  await expect(ticks.last()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(ticks.nth(258)).toBeFocused();
  await expect(page.getByRole('tooltip')).toBeVisible();
  const box = await page.getByRole('tooltip').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y + box!.height).toBeLessThanOrEqual(640);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-chat-turn="msg:516"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
  await page.screenshot({ path: test.info().outputPath('history-narrow.png') });
});


test('empty sessions hide the ruler and a pending jump cannot affect another session', async ({ page }) => {
  await page.locator('chat-history-nav .tick').first().focus();
  await page.evaluate(() => {
    const navigator = document.querySelector('chat-history-nav') as any;
    void navigator.navigate(navigator.turns[0]);
    (window as any).historyFixture.switchSession();
  });
  await expect(page.locator('[data-chat-turn="msg:new-user"]')).toBeVisible();
  await expect(page.locator('.chat-history-highlight')).toHaveCount(0);
  expect(await page.locator('.chat-thread').getAttribute('data-history-reading')).toBeNull();
  await page.evaluate(() => {
    const fixture = (window as any).historyFixture;
    fixture.props.messages = [];
    fixture.update();
  });
  await expect(page.locator('chat-history-nav')).toBeHidden();
});


test('sending a new question resets historical reading and restores the latest segment', async ({ page }) => {
  await page.locator('chat-history-nav .tick').first().click();
  await expect(page.locator('[data-chat-turn="msg:0"]')).toBeVisible();
  await page.evaluate(() => (window as any).historyFixture.send());
  await expect(page.locator('[data-chat-turn="msg:sent"]')).toBeVisible();
  await expect(page.locator('[data-chat-turn="msg:0"]')).toHaveCount(0);
  expect(await page.locator('.chat-thread').getAttribute('data-history-reading')).toBeNull();
});

test('the application shell wires transcript scrolling and return-to-latest callbacks', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
  // Production renderApp -> renderChat props, without starting a real transport.
  await page.evaluate(() => (window as any).historyFixture.mountShell());
  await expect(page.locator('chat-history-nav .tick')).toHaveCount(260);
  await page.locator('.chat-thread').evaluate((el) => { el.scrollTop = 900; });
  await expect(page.getByRole('button', { name: '回到最新' })).toBeVisible();
  await page.locator('chat-history-nav .tick').first().click();
  await expect(page.locator('[data-chat-turn="msg:0"]')).toBeVisible();
  await page.getByRole('button', { name: '回到最新' }).click();
  await expect(page.locator('[data-chat-turn="msg:518"]')).toBeVisible();
  await expect.poll(() => page.locator('.chat-thread').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5);
});
