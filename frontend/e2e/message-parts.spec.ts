import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { migrateMessageParts } from '../../packages/agent-core/src/message-parts';

test('real browser preserves old/new history, image references and Stop', async ({ page }) => {
  await page.route('**/api/chat/greeting', route => route.fulfill({ json: { greeting: '你好' } }));
  await page.route('**/api/branding/config', route => route.fulfill({ json: {} }));
  await page.goto('/e2e/fixtures/chat-history.html');
  const messages = process.env.PARTS_HISTORY_OUTPUT ? JSON.parse(readFileSync(process.env.PARTS_HISTORY_OUTPUT, 'utf8')) : [
    { id: 'user', role: 'user', content: 'history question', timestamp: 1 },
    { id: 'answer', role: 'assistant', content: '<think>history thinking</think>\n\ncache independent', timestamp: 2 },
  ].map(m => migrateMessageParts(m as any, { status: 'completed', durable: { kind: 'mysql', reference: m.id } }));
  const mount = async (value: any[]) => page.evaluate(messages => {
    const fixture = (window as any).historyFixture;
    fixture.props.messages = messages; fixture.props.stream = null; fixture.props.showThinking = true; fixture.update();
  }, value);
  await mount(messages);
  await expect(page.getByText('cache independent', { exact: true })).toBeVisible();
  const textWithParts = await page.locator('.chat-thread').innerText();
  await mount(messages.map(({ messageParts: _parts, ...message }: any) => message));
  await expect(page.getByText('cache independent', { exact: true })).toBeVisible();
  expect(await page.locator('.chat-thread').innerText()).toBe(textWithParts);
  await page.reload(); await mount(messages);
  await expect(page.getByText('cache independent', { exact: true })).toHaveCount(1);
  const image = migrateMessageParts({ id: 'image', role: 'user', content: [{ type: 'text', text: 'inspect image' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR3sAAAAASUVORK5CYII=' } }] });
  await mount([image]);
  await expect(page.getByText('inspect image', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-thread img[src^="data:image/png"]')).toBeVisible();
  await page.evaluate(() => {
    const fixture = (window as any).historyFixture;
    (window as any).partsStopCount = 0;
    fixture.props.sending = true; fixture.props.canAbort = true; fixture.props.onAbort = () => { (window as any).partsStopCount++; };
    fixture.update();
  });
  await page.getByRole('button', { name: /Stop|停止/ }).click();
  expect(await page.evaluate(() => (window as any).partsStopCount)).toBe(1);
  await page.screenshot({ path: test.info().outputPath('parts-history.png') });
});
