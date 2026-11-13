import { expect, test, type Locator } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

// Production shell/chat rendering; remote services return controlled sample data.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('permissions', '["*"]');
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
  });
  await page.routeWebSocket('**/session-fixture', socket => socket.onMessage(raw => {
    if (JSON.parse(String(raw)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    const body = path === '/api/docs/list' ? { docs: [{ file: 'sample.md', title: '字体验收样本' }] }
      : path.startsWith('/api/docs/files/') ? { content: '<pre><code>SELECT 111, WWW;</code></pre>' }
      : path === '/api/agent/security/audit' ? { records: [{ id: 1, phase: 'decision', actorId: 1, agentId: 'sample', requestId: 'req-111-WWW', toolName: 'sql_query', allowed: true, reasonCode: 'policy_allowed', createdAt: '2026-11-13T00:00:00Z' }], nextCursor: null }
      : path === '/api/audit/logs' ? { items: [{ id: 'audit-111-WWW', eventType: 'login', level: 'info', action: 'login_success', result: 'success', timestamp: 1794528000000 }], total: 1 }
      : path === '/api/agent/security/sandbox' ? { configured: true, reachable: true, status: {
        activeJobs: 0, maxConcurrentJobs: 1, daemon: { reachable: true, rootless: true },
        policy: { network: 'none', rootFilesystem: 'readonly', user: '1000', capabilities: 'none', noNewPrivileges: true, runtimes: ['node'], limits: {} },
        recentJobs: [{ jobId: 'job-111-WWW', runtime: 'node', status: 'succeeded', exitCode: 0, createdAt: '2026-11-13T00:00:00Z', durationMs: 1 }],
      } }
      : path === '/api/agent/security/sandbox/config' ? { enabled: false }
      : { sessions: [], messages: [] };
    return route.fulfill({ json: body });
  });
  await page.goto('/e2e/fixtures/chat-sessions.html');
  await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'light');
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.locator('.topbar-search__label')).toHaveText('搜索');
});

for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`#636 topbar and contents stay inside their grid row at ${width}×${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    const geometry = await page.locator('.shell').evaluate(shell => {
      const bar = shell.querySelector('.topbar')!;
      const nav = shell.querySelector('.topnav-shell')!;
      const content = shell.querySelector('.content')!;
      return {
        row: parseFloat(getComputedStyle(shell).gridTemplateRows),
        token: parseFloat(getComputedStyle(shell).getPropertyValue('--shell-topbar-height')),
        bar: bar.getBoundingClientRect().toJSON(), nav: nav.getBoundingClientRect().toJSON(),
        content: content.getBoundingClientRect().toJSON(),
        border: parseFloat(getComputedStyle(bar).borderBottomWidth),
        children: [...nav.children].map(child => child.getBoundingClientRect().toJSON()),
      };
    });
    expect(geometry.bar.height).toBe(geometry.token);
    expect(geometry.bar.height).toBe(geometry.row);
    expect(geometry.bar.bottom).toBeLessThanOrEqual(geometry.content.top);
    expect(geometry.nav.top).toBeGreaterThanOrEqual(geometry.bar.top);
    expect(geometry.nav.bottom).toBeLessThanOrEqual(geometry.bar.bottom - geometry.border);
    for (const child of geometry.children) {
      expect(child.top).toBeGreaterThanOrEqual(geometry.bar.top);
      expect(child.bottom).toBeLessThanOrEqual(geometry.bar.bottom - geometry.border);
    }
    const geometryPath = info.outputPath('geometry.json');
    await writeFile(geometryPath, JSON.stringify(geometry, null, 2));
    await info.attach('geometry', { path: geometryPath, contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath(`desktop-${width}.png`) });
  });
}

test('#636 preserves the existing narrow-screen auto minimum', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.locator('.topbar')).toHaveCSS('min-height', 'auto');
});

test('#706 disabled export keeps its colors on hover; enabled ghost still responds', async ({ page }, info) => {
  const button = page.getByRole('button', { name: 'Export chat', exact: true });
  const colors = (node: Locator) => node.evaluate(el => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, color: style.color, border: style.borderColor };
  });
  await expect(button).toBeDisabled();
  const before = await colors(button);
  await button.hover({ force: true });
  await expect.poll(() => colors(button)).toEqual(before);
  await page.screenshot({ path: info.outputPath('disabled-export-hover.png') });
  // Use the same production control to exercise the enabled variant without exporting.
  await page.mouse.move(0, 0);
  await button.evaluate(el => { (el as HTMLButtonElement).disabled = false; });
  const enabled = await colors(button);
  await button.hover();
  await expect.poll(async () => (await colors(button)).background).not.toBe(enabled.background);
});

test('#705 mono token reaches chat kbd and actual Shadow DOM consumers', async ({ page }, info) => {
  const checkMono = async (locator: Locator) => {
    await expect(locator).toBeVisible();
    await expect(locator).toHaveCSS('font-family', /monospace/);
    // Check glyph advances too, so an inherited proportional font cannot pass.
    const widths = await locator.evaluate(el => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d')!;
      const style = getComputedStyle(el);
      context.font = `${style.fontSize} ${style.fontFamily}`;
      return [context.measureText('iiii').width, context.measureText('WWWW').width];
    });
    expect(widths[0]).toBeCloseTo(widths[1], 2);
  };
  await checkMono(page.locator('.agent-chat__hint kbd').first());
  const consumers = [
    ['docs-viewer', 'docs-viewer-page', '.docs-content code'],
    ['agent-tool-audit', 'agent-tool-audit-page', '.tool-name'],
    ['system-audit', 'system-audit-page', '.mono'],
    ['agent-sandbox-status', 'agent-sandbox-status-page', '.mono'],
  ];
  for (const [module, tag, selector] of consumers) {
    await page.evaluate(async ({ module, tag }) => {
      await import(`/src/app/ui/views/${module}.ts`);
      document.querySelector('chat-sessions-fixture')?.remove();
      document.querySelector('[data-font-consumer]')?.remove();
      const element = document.createElement(tag);
      element.dataset.fontConsumer = '';
      element.style.cssText = 'display:block;height:100vh;padding:16px';
      document.body.append(element);
    }, { module, tag });
    await checkMono(page.locator(`${tag} ${selector}`).first());
    await page.screenshot({ path: info.outputPath(`${module}.png`) });
  }
});
