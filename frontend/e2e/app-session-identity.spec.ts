import { expect, test } from '@playwright/test';

// MAX-453 / #288: real app, rendering and session controllers; controlled remote services.
for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`session avatars and Agent tools entry at ${width}x${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    const sessions = ['agent:main:main', 'agent:ops:chat:history'].map(key => ({
      key, kind: 'direct', updatedAt: 1,
    }));
    await page.route('https://avatars.test/**', route => route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><circle cx="28" cy="28" r="28" fill="#2874c6"/></svg>',
    }));
    await page.route('**/avatar/**', route => route.fulfill({ json: { avatarUrl: null } }));
    await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json:
      new URL(route.request().url()).pathname === '/api/sessions'
        ? { ok: true, sessions, defaults: {} } : {},
    }));
    await page.goto('/e2e/fixtures/chat-notices.html');
    await expect(page.locator('notice-fixture .chat')).toBeVisible();
    await page.evaluate((rows) => {
      const { app } = (window as any).noticeFixture;
      app.agentsList = {
        defaultId: 'main', mainKey: 'main', scope: 'per-sender',
        agents: [
          { id: 'main', name: '主助手', identity: { avatarUrl: 'https://avatars.test/main.svg' } },
          { id: 'ops', name: '运维助手', identity: { avatarUrl: 'https://avatars.test/ops.svg' } },
        ],
      };
      app.sessionsResult = { sessions: rows };
      app.sessionKey = 'agent:main:main';
      app.chatAvatarUrl = null;
      app.chatMessages = [];
    }, sessions);
    const avatar = page.locator('.agent-chat__welcome > img');
    await expect(avatar).toHaveAttribute('src', 'https://avatars.test/main.svg');
    const agentSelect = page.locator('.content-header select[data-chat-agent-filter]').first();
    await expect(agentSelect).toHaveAccessibleName(/Agent|助手|智能体/i);
    await agentSelect.focus();
    await expect(agentSelect).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('.content-header .chat-controls__session-row > .chat-controls__session:not(.chat-controls__agent) select').first()).toBeFocused();
    await agentSelect.selectOption('ops');
    await expect(agentSelect).toHaveValue('ops');
    await expect(avatar).toHaveAttribute('src', 'https://avatars.test/ops.svg');
    await expect.poll(() => page.evaluate(() => (window as any).noticeFixture.app.sessionKey))
      .toBe('agent:ops:chat:history');
    await page.screenshot({ path: info.outputPath(`ops-${width}.png`) });
    await agentSelect.selectOption('main');
    await expect(avatar).toHaveAttribute('src', 'https://avatars.test/main.svg');
    for (const key of ['main', 'ops:main', 'agent:ops', 'invalid', '']) {
      await page.evaluate((nextKey) => {
        const { app } = (window as any).noticeFixture;
        app.sessionKey = nextKey;
        app.chatAvatarUrl = null;
      }, key);
      await expect(avatar).toHaveAttribute('src', 'https://avatars.test/main.svg');
    }
    await page.evaluate(() => {
      const { app } = (window as any).noticeFixture;
      app.sessionKey = 'agent:ops:chat:history';
      app.chatMessages = [{ role: 'assistant', content: '会话头像验证', timestamp: 1 }];
    });
    await expect(page.locator('.chat-avatar.assistant')).toHaveAttribute('src', 'https://avatars.test/ops.svg');
    await page.evaluate(() => {
      const { app } = (window as any).noticeFixture;
      app.tab = 'agents';
      app.agentsSelectedId = 'ops';
      app.agentsPanel = 'tools';
    });
    await expect(page.getByText('DirectAdapter 模式下此功能暂不可用')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`tools-existing-placeholder-${width}.png`) });
  });
}
