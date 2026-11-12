import { expect, test } from '@playwright/test';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createServer as createViteServer } from 'vite';

// Real browser -> authFetch -> Vite proxy -> isolated HTTP endpoint.
// The endpoint controls failures and accepts synthetic bearer identities; no real login/model.
const requests: string[] = [];
const pending = new Map<string, ServerResponse>();
let http: ReturnType<typeof createHttpServer>;
let frontend: ReturnType<typeof createHttpServer>;
let vite: Awaited<ReturnType<typeof createViteServer>>;
let origin: string;

test.beforeAll(async () => {
  http = createHttpServer((request, response) => {
    if (request.url !== '/api/chat/greeting') { response.writeHead(404).end(); return; }
    const identity = request.headers.authorization?.replace('Bearer ', '') ?? '';
    requests.push(identity);
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (identity.startsWith('pending')) {
      // Release Chromium's cache lock for this URL while holding the JSON body.
      response.flushHeaders(); pending.set(identity, response); return;
    }
    if (identity.startsWith('failure')) response.writeHead(503).end('{}');
    else if (identity.startsWith('empty')) response.end('{"greeting":""}');
    else if (identity.startsWith('invalid')) response.end('{');
    else response.end(JSON.stringify({ greeting: `你好 ${identity}` }));
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const port = (http.address() as { port: number }).port;
  vite = await createViteServer({ server: { middlewareMode: true, hmr: false,
    proxy: { '/api': { target: `http://127.0.0.1:${port}` } } } });
  frontend = createHttpServer(vite.middlewares);
  frontend.listen(0, '127.0.0.1');
  await once(frontend, 'listening');
  origin = `http://127.0.0.1:${(frontend.address() as { port: number }).port}`;
});

test.afterEach(async ({ page }) => {
  // Stop request producers before closing/destroying any in-flight responses.
  await page.goto('about:blank');
  for (const response of pending.values()) response.destroy();
  pending.clear();
  requests.length = 0;
});
test.afterAll(async () => {
  if (frontend) await new Promise<void>((resolve, reject) => frontend.close(error => error ? reject(error) : resolve()));
  await vite?.close();
  if (http) await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
});

for (const [mode, width, height] of [
  ['failure', 1440, 900], ['empty', 1366, 768], ['invalid', 1920, 1080],
] as const) {
  test(`MAX-642 ${mode}: one HTTP request, working keyboard/composer at ${width}`, async ({ page }, info) => {
    const identity = `${mode}-${width}`;
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/e2e/fixtures/chat-greeting.html?identity=${identity}`);
    await expect.poll(() => requests.filter(value => value === identity).length).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as any).greetingFixture.updates)).toBeGreaterThanOrEqual(2);
    await expect(page.getByText('Ready to chat', { exact: true })).toBeVisible();
    for (let index = 0; index < 5; index++) await page.evaluate(() => (window as any).greetingFixture.update());
    const suggestion = page.getByRole('button', { name: '查看实例运行状态', exact: true });
    await suggestion.focus(); await page.keyboard.press('Enter');
    const input = page.locator('textarea');
    await expect(input).toBeEnabled();
    expect(await input.getAttribute('aria-label') || await input.getAttribute('placeholder')).toBeTruthy();
    await input.fill('欢迎语失败后仍可提问'); await input.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).greetingFixture.sent)).toEqual(['查看实例运行状态', '欢迎语失败后仍可提问']);
    // Let automatic completion renders settle before asserting the final count.
    await page.waitForTimeout(200);
    expect(requests.filter(value => value === identity)).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`welcome-${mode}-${width}.png`) });
    await page.evaluate(() => (window as any).greetingFixture.switchIdentity('success-current'));
    await expect(page.locator('.agent-chat__badge--greeting')).toContainText('你好 success-current');
    for (let index = 0; index < 5; index++) await page.evaluate(() => (window as any).greetingFixture.update());
    expect(requests.filter(value => value === 'success-current')).toHaveLength(1);
  });
}

test('MAX-642 old identity HTTP completion cannot expose text or restart the new request', async ({ page }) => {
  // Playwright routing disables Chromium's HTTP cache/coalescing. Requests still
  // continue to the real HTTP endpoint, allowing both bodies to stay in flight.
  await page.route('**/*', route => route.continue());
  await page.goto(`${origin}/e2e/fixtures/chat-greeting.html?identity=pending-old`);
  await expect.poll(() => pending.has('pending-old')).toBe(true);
  await page.evaluate(() => (window as any).greetingFixture.switchIdentity('pending-new'));
  await expect.poll(() => [...pending.keys()]).toContain('pending-new');
  pending.get('pending-old')!.end('{"greeting":"旧身份私有欢迎语"}');
  pending.delete('pending-old');
  await expect.poll(() => page.evaluate(() => (window as any).greetingFixture.updates)).toBeGreaterThanOrEqual(3);
  await page.evaluate(() => (window as any).greetingFixture.update());
  expect(requests.filter(value => value === 'pending-new')).toHaveLength(1);
  await expect(page.locator('body')).not.toContainText('旧身份私有欢迎语');
  pending.get('pending-new')!.end('{"greeting":"当前身份欢迎语"}');
  pending.delete('pending-new');
  await expect(page.locator('.agent-chat__badge--greeting')).toContainText('当前身份欢迎语');
  await page.evaluate(() => (window as any).greetingFixture.update());
  expect(requests.filter(value => value === 'pending-new')).toHaveLength(1);
});

test('MAX-642 aborted browser transport does not retry on re-render', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/chat/greeting', async route => { attempts++; await route.abort('failed'); });
  await page.goto(`${origin}/e2e/fixtures/chat-greeting.html?identity=network-failure`);
  await expect.poll(() => page.evaluate(() => (window as any).greetingFixture.updates)).toBeGreaterThanOrEqual(2);
  await expect(page.getByText('Ready to chat', { exact: true })).toBeVisible();
  for (let index = 0; index < 5; index++) await page.evaluate(() => (window as any).greetingFixture.update());
  await page.waitForTimeout(200);
  expect(attempts).toBe(1);
});
