import { expect, test, type Page } from '@playwright/test';

// Real renderChat, deletion handlers, CSS and browser storage. History/API data is controlled.
const messages = [
  { id: 'one', role: 'user', content: '删除测试问题一' },
  { id: 'two', role: 'assistant', content: '删除测试回答一' },
  { id: 'three', role: 'user', content: '删除测试问题二' },
  { id: 'four', role: 'assistant', content: '删除测试回答二' },
];
async function open(page: Page) {
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: {} }));
  await page.goto('/e2e/fixtures/chat-history.html');
  await page.evaluate(messages => {
    const f = (window as any).historyFixture;
    f.props.messages = messages; f.props.stream = null; f.update();
  }, messages);
  await expect(page.locator('.chat-thread')).toBeVisible();
}
const group = (page: Page, text: string) => page.locator('.chat-group').filter({ hasText: text });
async function remove(page: Page, text: string) {
  const row = group(page, text);
  await row.hover();
  await row.getByRole('button', { name: 'Delete message', exact: true }).click();
  await row.getByRole('button', { name: 'Delete', exact: true }).click();
}
async function restoreAll(page: Page) {
  await page.evaluate(async () => {
    const { DeletedMessages } = await import('/src/app/ui/chat/deleted-messages.ts');
    new DeletedMessages('fixture-one').clear();
    (window as any).historyFixture.update();
  });
}

for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
  test(`MAX-637 #637 keyboard and hover at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await open(page);
    await page.mouse.move(0, 0);
    const row = group(page, messages[0].content);
    const button = row.getByRole('button', { name: 'Delete message', exact: true });
    await expect(button).toHaveCSS('opacity', '0');
    // Reach the delete control through Tab, with no mouse hover or scripted focus on it.
    await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); });
    for (let i = 0; i < 50; i++) {
      await page.keyboard.press('Tab');
      if (await button.evaluate(el => el === document.activeElement)) break;
    }
    await expect(button).toBeFocused();
    await expect(button).toHaveCSS('opacity', '1');
    await expect(button).toHaveCSS('pointer-events', 'auto');
    await page.screenshot({ path: info.outputPath(`focus-${width}.png`) });
    await page.keyboard.press('Enter');
    const confirm = row.getByRole('button', { name: 'Delete', exact: true });
    await page.mouse.move(0, 0);
    await expect(confirm).toHaveCSS('opacity', '1');
    await expect(confirm).toHaveCSS('pointer-events', 'auto');
    await confirm.focus();
    await page.keyboard.press('Enter');
    await expect(group(page, messages[0].content)).toHaveCount(0);
    const other = group(page, messages[2].content).getByRole('button', { name: 'Delete message', exact: true });
    await group(page, messages[2].content).hover();
    await expect(other).toHaveCSS('opacity', '1');
  });
}

test('MAX-638 #642 two tabs merge simultaneous deletes, restore, refresh and session switch', async ({ page, context }, info) => {
  await open(page);
  const second = await context.newPage();
  await open(second);
  await Promise.all([remove(page, messages[0].content), remove(second, messages[2].content)]);
  for (const tab of [page, second]) {
    await expect(group(tab, messages[0].content)).toHaveCount(0);
    await expect(group(tab, messages[2].content)).toHaveCount(0);
  }
  await second.reload(); await open(second);
  await expect(group(second, messages[0].content)).toHaveCount(0);
  await expect(group(second, messages[2].content)).toHaveCount(0);
  await restoreAll(second);
  for (const tab of [page, second]) {
    await expect(group(tab, messages[0].content)).toHaveCount(1);
    await expect(group(tab, messages[2].content)).toHaveCount(1);
  }
  await page.evaluate(() => {
    const f = (window as any).historyFixture; f.props.sessionKey = 'other-session'; f.update();
  });
  await remove(second, messages[0].content);
  await expect(group(page, messages[0].content)).toHaveCount(1);
  await page.evaluate(() => {
    const f = (window as any).historyFixture; f.props.sessionKey = 'fixture-one'; f.update();
  });
  await expect(group(page, messages[0].content)).toHaveCount(0);
  await expect(group(page, messages[2].content)).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('two-tabs.png') });
  await info.attach('storage.json', { body: JSON.stringify(await page.evaluate(() => Object.fromEntries(
    Object.entries(localStorage).filter(([key]) => key.startsWith('slide:deleted')),
  ))), contentType: 'application/json' });
});

test('MAX-638 legacy deletions restore and remain restored after reload', async ({ page, context }) => {
  await open(page);
  await remove(page, messages[0].content);
  const key = await page.evaluate(() => {
    const key = Object.keys(localStorage).find(k => k.startsWith('slide:deleted-message:fixture-one:'))!;
    const message = key.slice('slide:deleted-message:fixture-one:'.length);
    localStorage.setItem('slide:deleted:fixture-one', JSON.stringify([message]));
    localStorage.removeItem(key);
    return message;
  });
  const second = await context.newPage(); await open(second);
  await expect(group(second, messages[0].content)).toHaveCount(0);
  await restoreAll(second);
  await expect(group(page, messages[0].content)).toHaveCount(1);
  await open(second);
  await expect(group(second, messages[0].content)).toHaveCount(1);
  expect(await second.evaluate(key => localStorage.getItem('slide:deleted-message:fixture-one:' + key), key)).toBe('false');
});

test('MAX-637 production SlideApp shell updates both tabs after deletion', async ({ page, context }) => {
  const second = await context.newPage();
  for (const tab of [page, second]) {
    await open(tab);
    await tab.evaluate(async () => (window as any).historyFixture.mountShell());
    await expect(tab.locator('history-fixture-shell .chat-thread')).toBeVisible();
  }
  await remove(page, messages[0].content);
  await expect(group(second, messages[0].content)).toHaveCount(0);
  await remove(second, messages[2].content);
  await expect(group(page, messages[2].content)).toHaveCount(0);
  await page.reload(); await open(page);
  await page.evaluate(async () => (window as any).historyFixture.mountShell());
  await expect(group(page, messages[0].content)).toHaveCount(0);
  await expect(group(page, messages[2].content)).toHaveCount(0);
});
