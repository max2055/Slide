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
  await expect.poll(() => ticks.nth(0).evaluate((el) => getComputedStyle(el, '::before').width)).toBe('6px');
  expect(await ticks.first().evaluate(el => el.getBoundingClientRect().height)).toBe(10);
  expect(await ticks.first().evaluate(el => getComputedStyle(el, '::before').height)).toBe('2px');
  await ticks.nth(180).hover();
  await expect(page.getByRole('tooltip')).toContainText('第 181 轮');
  await expect.poll(() => ticks.nth(180).evaluate((el) => parseFloat(getComputedStyle(el, '::before').width))).toBe(26);
  const widths = await ticks.evaluateAll((elements) => [180, 181, 182, 183, 184].map((i) => parseFloat(getComputedStyle(elements[i], '::before').width)));
  expect(widths).toEqual([26, 20, 14, 10, 6]);
  expect(await thread.evaluate((el) => el.scrollTop)).toBe(top);
  await page.screenshot({ path: test.info().outputPath('history-hover.png') });
  await page.mouse.move(1000, 20);
  await expect(page.getByRole('tooltip')).toBeHidden();
  await expect.poll(() => ticks.nth(180).evaluate((el) => getComputedStyle(el, '::before').width)).toBe('6px');
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

test('clicking a visible tick keeps the ruler still; manual transcript scrolling follows', async ({ page }) => {
  const ruler = page.locator('chat-history-nav nav');
  const ticks = page.locator('chat-history-nav .tick');
  await ruler.evaluate((el) => { el.scrollTop = 1100; });
  const before = await ruler.evaluate((el) => el.scrollTop);
  await ticks.nth(115).click();
  await expect(page.locator('[data-chat-turn="msg:230"]')).toHaveClass(/chat-history-highlight/);
  await expect(ticks.nth(115)).toHaveAttribute('aria-current', 'true');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await ruler.evaluate((el) => el.scrollTop)).toBe(before);

  await page.locator('.chat-thread').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(ticks.nth(214)).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => ruler.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
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


test('a short ruler is vertically centered and still previews the correct turn', async ({ page }) => {
  await page.evaluate(() => {
    const fixture = (window as any).historyFixture;
    fixture.props.messages = fixture.props.messages.slice(0, 18);
    fixture.update();
  });
  const ticks = page.locator('chat-history-nav .tick');
  await expect(ticks).toHaveCount(9);
  await expect.poll(async () => {
    const host = await page.locator('chat-history-nav').boundingBox();
    const first = await ticks.first().boundingBox();
    const last = await ticks.last().boundingBox();
    return Math.abs((first!.y + last!.y + last!.height) / 2 - (host!.y + host!.height / 2));
  }).toBeLessThan(2);
  await ticks.nth(4).hover();
  await expect(page.getByRole('tooltip')).toContainText('第 5 轮');
});

test('opening and switching conversations wait for history and land on the latest message', async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
  await page.evaluate(() => (window as any).historyFixture.mountShell(true));
  // Let the loading frame finish before data arrives, just as with a slow history request.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => {
    const app = document.querySelector('history-fixture-shell') as any;
    app.chatMessages = (window as any).historyFixture.props.messages;
    app.chatLoading = false;
  });
  const distanceFromBottom = () => page.locator('.chat-thread').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(distanceFromBottom).toBeLessThan(5);
  await expect(page.locator('[data-chat-turn="msg:518"]')).toBeInViewport();
  await page.locator('chat-history-nav .tick').first().click();
  await expect(page.locator('[data-chat-turn="msg:0"]')).toBeInViewport();
  await page.evaluate(() => {
    const app = document.querySelector('history-fixture-shell') as any;
    app.resetChatScroll();
    app.sessionKey = 'shell-second';
    app.chatMessages = [];
    app.chatLoading = true;
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => {
    const app = document.querySelector('history-fixture-shell') as any;
    app.chatMessages = (window as any).historyFixture.props.messages.slice(0, 18);
    app.chatLoading = false;
  });
  await expect.poll(distanceFromBottom).toBeLessThan(5);
  await expect(page.locator('[data-chat-turn="msg:16"]')).toBeInViewport();
  await expect(page.getByRole('button', { name: '回到最新' })).toBeHidden();
  // A subsequent stream must not pull the user away from an explicitly selected old turn.
  await page.locator('chat-history-nav .tick').first().click();
  await expect(page.locator('[data-chat-turn="msg:0"]')).toBeInViewport();
  const before = await page.locator('.chat-thread').evaluate((el) => el.scrollTop);
  await page.evaluate(() => { (document.querySelector('history-fixture-shell') as any).chatStream = '继续输出'; });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.locator('.chat-thread').evaluate((el) => el.scrollTop)).toBe(before);
});

for (const edge of ['first', 'last'] as const) {
  test(`leaving the ${edge} tick into the centered ruler's blank space clears hover`, async ({ page }) => {
    await page.evaluate(() => {
      const fixture = (window as any).historyFixture;
      fixture.props.messages = fixture.props.messages.slice(0, 18);
      fixture.update();
    });
    const ticks = page.locator('chat-history-nav .tick');
    await expect(ticks).toHaveCount(9);
    const tick = edge === 'first' ? ticks.first() : ticks.last();
    await tick.hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
    const bounds = await tick.boundingBox();
    await page.mouse.move(bounds!.x + bounds!.width / 2, edge === 'first' ? bounds!.y - 4 : bounds!.y + bounds!.height + 4);
    await expect(page.getByRole('tooltip')).toBeHidden();
    await expect(page.locator('chat-history-nav .tick[data-hovered]')).toHaveCount(0);
    await expect.poll(() => tick.evaluate(el => getComputedStyle(el, '::before').width)).toBe('6px');
    // Returning to the same end tick should immediately reopen the preview.
    await tick.hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
  });
}
