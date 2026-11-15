import { expect, test, type Page, type Route } from '@playwright/test';
import { createServer } from 'vite';
import { resolve } from 'node:path';

// Production application entry; HTTP fixtures control delay/failure. These are
// browser interaction checks, not evidence of real SSH collection or persistence.
let vite: Awaited<ReturnType<typeof createServer>>, origin: string;
test.beforeAll(async () => {
  vite = await createServer({ configFile: resolve('vite.config.js'),
    server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await vite.listen();
  origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
});
test.afterAll(async () => { await vite?.close(); });

async function open(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'inspection-fixture');
    localStorage.setItem('permissions', JSON.stringify(['*']));
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
    localStorage.setItem('slide.control.session_token.v1', 'inspection-fixture');
    (window as any).inspectionNavigations = [];
    window.addEventListener('slide-navigate', (e: any) => {
      if (e.detail.tab === 'reports') (window as any).inspectionNavigations.push(e.detail);
    });
  });
  await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    let body: any = {};
    if (path === '/api/auth/permissions') body = ['*'];
    else if (/\/api\/servers\/\d+$/.test(path)) body = {
      id: Number(path.split('/').pop()), label: '巡检测试服务器', host: 'controlled-host', port: 22, os_type: 'Linux',
    };
    else if (path.endsWith('/instances')) body = { instances: [] };
    else if (path === '/api/resources/overview') body = { items: [] };
    else if (path === '/api/servers') body = [];
    else if (path === '/api/reports') body = { reports: [], total: 0 };
    return route.fulfill({ json: body });
  });
  await page.goto(origin + '/server-detail?id=9');
  await expect(page.locator('server-detail').getByRole('button', { name: '一键巡检' })).toBeVisible();
}
const inspection = (page: Page) => page.locator('server-detail').getByRole('button', { name: /一键巡检|巡检中/ });
const navCount = (page: Page) => page.evaluate(() => (window as any).inspectionNavigations.length);

for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
  test(`controlled rapid clicks, one report response and one navigation at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height }); await open(page);
    const pending: Route[] = [];
    await page.route('**/api/servers/reports/generate', route => { pending.push(route); });
    // Dispatch several native clicks in one JS turn, before Lit renders disabled.
    await inspection(page).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); button.click(); });
    await expect.poll(() => pending.length).toBe(1);
    await expect(inspection(page)).toBeDisabled();
    await expect(inspection(page)).toHaveAttribute('aria-busy', 'true');
    await expect(inspection(page)).toHaveAccessibleName('巡检中…');
    expect(pending[0].request().postDataJSON()).toEqual({ server_id: 9 });
    expect(await navCount(page)).toBe(0);
    const box = await inspection(page).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`pending-${width}.png`), animations: 'disabled' });
    await pending[0].fulfill({ json: { reportId: 558 } });
    await expect(page).toHaveURL(/\/reports/);
    expect(await navCount(page)).toBe(1);
    expect(pending).toHaveLength(1);
  });
}

test('controlled failure remains visible; keyboard focus and retry succeed', async ({ page }, info) => {
  await open(page);
  let calls = 0;
  await page.route('**/api/servers/reports/generate', route => {
    calls++;
    return calls === 1 ? route.fulfill({ status: 503, json: { error: '受控：服务器采集超时' } })
      : route.fulfill({ json: { reportId: 559 } });
  });
  const button = inspection(page);
  await button.focus(); await expect(button).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.locator('server-detail').getByRole('alert').filter({ hasText: '受控：服务器采集超时' })).toBeVisible();
  await expect(button).toBeEnabled(); await expect(button).toHaveAttribute('aria-busy', 'false');
  // A disabled native button may relinquish focus; keyboard traversal can reach it again.
  await page.locator('server-detail').getByRole('button', { name: '刷新', exact: true }).focus();
  await page.keyboard.press('Shift+Tab'); await expect(button).toBeFocused();
  await page.screenshot({ path: info.outputPath('failure-keyboard-retry.png'), animations: 'disabled' });
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/\/reports/); expect(calls).toBe(2); expect(await navCount(page)).toBe(1);
});

test('controlled old-object result cannot navigate or unlock current inspection', async ({ page }) => {
  await open(page);
  const pending: Route[] = [];
  await page.route('**/api/servers/reports/generate', route => { pending.push(route); });
  await inspection(page).click(); await expect.poll(() => pending.length).toBe(1);
  // Use the normal shell navigation event, without calling component methods.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('slide-navigate', {
    detail: { tab: 'server-detail', serverId: 10 },
  })));
  await expect(inspection(page)).toBeEnabled(); await inspection(page).click();
  await expect.poll(() => pending.length).toBe(2);
  expect(pending[1].request().postDataJSON()).toEqual({ server_id: 10 });
  await pending[0].fulfill({ json: { reportId: 560 } });
  await expect(inspection(page)).toBeDisabled(); expect(await navCount(page)).toBe(0);
  await pending[1].fulfill({ json: { reportId: 561 } });
  await expect(page).toHaveURL(/\/reports/); expect(await navCount(page)).toBe(1);
});

test('controlled unmounted result does not pull user back to reports', async ({ page }) => {
  await open(page);
  let pending!: Route;
  await page.route('**/api/servers/reports/generate', route => { pending = route; });
  await inspection(page).click(); await expect.poll(() => Boolean(pending)).toBe(true);
  await page.locator('server-detail').getByRole('button', { name: '返回列表' }).click();
  await expect(page.locator('server-detail')).toHaveCount(0);
  const url = page.url();
  const response = page.waitForResponse('**/api/servers/reports/generate');
  await pending.fulfill({ json: { reportId: 562 } }); await response;
  // Wait a browser rendering turn after response handling.
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  expect(page.url()).toBe(url); expect(await navCount(page)).toBe(0);
});
