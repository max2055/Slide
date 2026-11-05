import { expect, test } from '@playwright/test';

// Real application shell and API client; HTTP responses are isolated injections.
for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`load recovery and failed-save preservation ${width}x${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(() => {
      localStorage.setItem('token', `fixture.${btoa(JSON.stringify({ userId: 1, sessionVersion: 1 }))}.fixture`);
      localStorage.setItem('permissions', '["*"]');
      localStorage.setItem('slide.i18n.locale', 'zh-CN');
      localStorage.setItem('slide.control.session_token.v1', 'fixture-token');
      localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', themeMode: 'light' }));
    });
    await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
      if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
    }));
    await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
    let reads = 0;
    let writes = 0;
    let releaseRead!: () => void;
    let releaseWrite!: () => void;
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const requests: unknown[] = [];
    await page.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (!path.startsWith('/api/')) return route.fallback();
      if (path === '/api/auth/session-config') {
        requests.push({ method: request.method(), body: request.postDataJSON() });
        if (request.method() === 'PUT') {
          writes++;
          await writeGate;
          return route.fulfill({ status: 500, json: { error: 'isolated save failure' } });
        }
        reads++;
        if (reads === 1) return route.fulfill({ status: 500, json: { error: 'isolated load failure' } });
        await readGate;
        return route.fulfill({ json: { idleTimeoutMinutes: 90, minIdleTimeoutMinutes: 5, maxIdleTimeoutMinutes: 43200 } });
      }
      return route.fulfill({ json: path === '/api/auth/permissions' ? ['*']
        : path === '/api/user/preferences' ? { preferences: { locale: 'zh-CN', themeMode: 'light' } }
        : path === '/api/resources' ? { items: [] } : {} });
    });
    await page.goto('/settings/access/login');
    const view = page.locator('session-settings-page');
    await expect(view.getByRole('alert')).toContainText('加载登录安全设置失败');
    await page.screenshot({ path: info.outputPath('load-failed.png'), fullPage: true });
    const retry = view.getByRole('button', { name: '重试', exact: true });
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(view.getByRole('status', { name: '正在加载登录安全设置' })).toBeVisible();
    expect(reads).toBe(2);
    releaseRead();
    const input = view.getByRole('spinbutton', { name: '无操作超时（分钟）' });
    await expect(input).toHaveValue('90');
    await page.screenshot({ path: info.outputPath('retry-success.png'), fullPage: true });
    await input.fill('120');
    await input.press('Tab');
    await page.keyboard.press('Enter');
    await expect(view.getByRole('button', { name: '保存中...' })).toBeDisabled();
    await expect(input).toBeDisabled();
    expect(writes).toBe(1);
    releaseWrite();
    await expect(page.getByText('保存登录安全设置失败', { exact: true })).toBeVisible();
    await expect(input).toHaveValue('120');
    await expect(input).toHaveAttribute('min', '5');
    await expect(input).toHaveAttribute('max', '43200');
    await expect(input).toBeEnabled();
    const save = view.getByRole('button', { name: '保存设置', exact: true });
    await expect(save).toBeEnabled();
    const box = await save.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    await page.screenshot({ path: info.outputPath('save-failed-preserved.png'), fullPage: true });
    await info.attach('injected-http-log.json', { body: JSON.stringify({ environment: 'isolated HTTP injection, real Chromium/application shell', reads, writes, requests }, null, 2), contentType: 'application/json' });
  });
}
