import { expect, test } from '@playwright/test';

const cases = [
  ['balance', '余额不足，请充值后重试', 'run', 'error'],
  ['model-auth', '模型 API 认证失败，请检查 API Key 和提供商配置', 'run', 'error'],
  ['rate-limit', '请求 rate_limit exceeded，请稍后重试', 'run', 'error'],
  ['timeout', '模型响应 timeout，请稍后重试', 'run', 'error'],
  ['network', '网络中断，请检查网络后重试', 'connection', 'error'],
  ['restart', '服务重启，请稍后重连', 'connection', 'error'],
  ['cold', '连接已恢复；仅恢复已保存边界，未保存的流尾部可能丢失。', 'cold', 'warning'],
  ['truncated', '恢复快照仅保留本轮尾部和结果预览；完整已保存内容请查看聊天历史。', 'truncated', 'warning'],
];
for (const width of [1440, 390]) {
  test.describe(`notices ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: {} }));
      await page.goto('/e2e/fixtures/chat-notices.html');
      await expect(page.locator('notice-fixture .chat')).toBeVisible();
    });
    for (const [name, message, source, severity] of cases) {
      test(`${name} shows exactly one actionable reason`, async ({ page }, info) => {
        await page.evaluate(({ message, source }) => (window as any).noticeFixture.error(message, source), { message, source });
        await expect(page.locator('app-notice')).toHaveCount(1);
        await expect(page.getByText(message, { exact: severity !== 'warning' })).toHaveCount(1);
        await expect(page.locator('app-notice')).toHaveAttribute('severity', severity);
        await expect(page.locator('.content-header')).not.toContainText(message);
        await expect(page.getByText('AI 服务暂时不可用', { exact: false })).toHaveCount(0);
        const box = await page.locator('app-notice').boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        const count = await page.getByText(message, { exact: severity !== 'warning' }).count();
        await info.attach('notice-count.json', { body: JSON.stringify({ width, name, count, severity }), contentType: 'application/json' });
        if (name === 'balance' || name === 'truncated') await page.screenshot({ path: info.outputPath(`${name}-${width}.png`) });
      });
    }
    test('initial cold history hydration is silent', async ({ page }) => {
      await page.evaluate(() => (window as any).noticeFixture.hydrate());
      await expect(page.locator('app-notice')).toHaveCount(0);
    });
    test('risk is dismissible with keyboard and does not reappear on watch', async ({ page }, info) => {
      await page.evaluate(() => (window as any).noticeFixture.error('', 'truncated'));
      await page.evaluate(() => (window as any).noticeFixture.history());
      await expect(page.locator('app-notice')).toHaveCount(1);
      const close = page.getByRole('button', { name: '关闭提示' });
      await expect(close).toBeVisible();
      await page.screenshot({ path: info.outputPath(`recovery-${width}.png`) });
      await close.focus(); await page.keyboard.press('Enter');
      await expect(page.locator('app-notice')).toHaveCount(0);
      await page.evaluate(() => (window as any).noticeFixture.repeatSnapshot());
      await expect(page.locator('app-notice')).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`dismissed-${width}.png`) });
    });
    test('new view and returning to a session clear the prior risk', async ({ page }) => {
      await page.evaluate(() => (window as any).noticeFixture.error('', 'truncated'));
      await expect(page.locator('app-notice')).toHaveCount(1);
      await page.getByRole('button', { name: '新建对话' }).click();
      await expect(page.locator('app-notice')).toHaveCount(0);
      await page.evaluate(() => (window as any).noticeFixture.switch());
      await expect(page.locator('app-notice')).toHaveCount(0);
    });
    test('send failure preserves draft and has no assistant error', async ({ page }) => {
      await page.evaluate(() => (window as any).noticeFixture.rejectSend());
      await expect(page.locator('app-notice')).toHaveCount(1);
      await expect(page.locator('textarea')).toHaveValue('检查数据库状态');
      expect(await page.evaluate(() => (window as any).noticeFixture.app.chatMessages.map((m: any) => m.role))).toEqual(['user']);
      expect(await page.evaluate(() => (window as any).noticeFixture.app.chatSending)).toBe(false);
      await page.evaluate(() => (window as any).noticeFixture.history());
      await expect(page.locator('app-notice')).toHaveCount(1);
      await page.evaluate(() => (window as any).noticeFixture.switch());
      await expect(page.locator('app-notice')).toHaveCount(0);
    });
    test('unconfirmed send retry retains identity and one user prompt', async ({ page }) => {
      await page.evaluate(() => (window as any).noticeFixture.rejectSend(true));
      const result = await page.evaluate(async () => {
        const app = (window as any).noticeFixture.app;
        await app.handleSendChat();
        return { sending: app.chatSending, roles: app.chatMessages.map((m: any) => m.role), draft: app.chatMessage,
          stats: (window as any).noticeFixture.sendStats() };
      });
      await expect(page.locator('app-notice')).toHaveCount(1);
      expect(result).toEqual({ sending: false, roles: ['user'], draft: '检查数据库状态', stats: { calls: 1, retries: 1 } });
    });
    test('session expiry and unreachable login each use one form reason and re-login succeeds', async ({ page }) => {
      await page.evaluate(() => (window as any).noticeFixture.expire());
      await expect(page.getByText('登录已超时，请重新登录。', { exact: true })).toHaveCount(1);
      await expect(page.locator('app-toast')).toHaveCount(0);
      expect(await page.evaluate(() => ['token', 'refreshToken', 'permissions', 'user'].map(k => localStorage.getItem(k)))).toEqual([null, null, null, null]);
      await page.locator('input[autocomplete="current-password"]').fill('fixture-password');
      await page.route('**/api/auth/login', route => route.fulfill({ status: 503, json: {} }));
      await page.locator('.login-gate__connect').click();
      await expect(page.locator('app-notice')).toContainText('无法连接服务器');
      await expect(page.locator('app-notice')).toHaveCount(1);
      await expect(page.locator('app-toast')).toHaveCount(0);
      await page.route('**/api/auth/login', route => route.fulfill({ json: { token: 'fixture-relogin' } }));
      // Keep the real form/API flow, replacing only connection startup.
      await page.evaluate(() => { const app = (window as any).noticeFixture.app; app.connect = () => { app.connected = true; }; });
      await page.locator('.login-gate__connect').click();
      await expect(page.locator('.chat')).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('fixture-relogin');
    });
    test('explicit refresh and next send clear stale run/recovery notices', async ({ page }) => {
      await page.evaluate(() => (window as any).noticeFixture.error('余额不足，请充值后重试'));
      if (width === 1440) await page.getByRole('button', { name: 'Refresh chat data' }).click();
      else await page.evaluate(() => (window as any).noticeFixture.history(true));
      await expect(page.locator('app-notice')).toHaveCount(0);
      await page.evaluate(async () => {
        const fixture = (window as any).noticeFixture;
        await fixture.error('', 'cold');
        fixture.app.chatRunId = null;
        fixture.app.chatMessage = 'next question';
        await fixture.app.handleSendChat();
      });
      await expect(page.locator('app-notice')).toHaveCount(0);
    });
    test('stream text and tool cards remain visible', async ({ page }) => {
      await page.evaluate(() => (window as any).noticeFixture.stream());
      await expect(page.getByText('正常流式回答', { exact: false })).toBeVisible();
      await expect(page.locator('.chat-tool-msg-collapse')).toHaveCount(1);
      await page.getByRole('button', { name: /query/ }).click();
      await expect(page.locator('.chat-tool-card')).toHaveCount(1);
      await expect(page.locator('app-notice')).toHaveCount(0);
    });
  });
}
