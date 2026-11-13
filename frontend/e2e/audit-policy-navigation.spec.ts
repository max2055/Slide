import { expect, test, type Page } from '@playwright/test';

const policy = (agentId: string) => ({ agentId, toolAllowlist: null, skillAllowlist: null, allowedEffects: ['read'], resourceScope: { instanceIds: null, serverIds: null, networkDeviceIds: null }, version: 1 });

// Real view components and HTTP clients; the server responses are controlled fault fixtures.
async function fixture(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('permissions', '["admin:*","audit:view"]');
    localStorage.setItem('token', 'fixture');
  });
  let failure: '403' | '500' | 'network' | 'empty' = '403';
  const calls: string[] = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    calls.push(`${route.request().method()} ${path}`);
    if (path.endsWith('/history')) {
      if (failure === 'network') return route.abort('failed');
      return route.fulfill({ status: failure === 'empty' ? 200 : Number(failure), json: failure === 'empty' ? { records: [] } : { error: '测试失败' } });
    }
    const body = path === '/api/agent/security/policies'
      ? { agents: [{ id: 'a', name: 'Agent A' }, { id: 'b', name: 'Agent B' }], policies: [policy('a'), policy('b')], tools: [], skills: [] }
      : path.endsWith('/config') ? { approvalEnabled: true, restrictedNetworkEnabled: false }
      : path.endsWith('/catalog') ? { packages: [], metrics: [] }
      : path === '/api/resources' ? { items: [] }
      : path.endsWith('/policy/groups') ? { groups: [{ id: 'valid-group', label: '合法组', revision: 1 }, { id: 'bad/id', label: '非法组', revision: 1 }] }
      : path.endsWith('/access') ? { can_manage: true }
      : /\/valid-group\/(preview|publish)$/.test(path) ? { affected_resources: 1, requests_per_hour_before: 10, requests_per_hour_after: 8 }
      : path.endsWith('/valid-group') ? { revision: 1, overrides: {} }
      : path.endsWith('/audit') ? { records: [], nextCursor: null }
      : { items: [], total: 0 };
    return route.fulfill({ json: body });
  });
  await page.route('**/audit-policy-fixture*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><body>
    <audit-center-page></audit-center-page><agent-security-policy-page></agent-security-policy-page><metric-settings view="policies"></metric-settings>
    <script type="module">import '/src/app/styles.css'; import '/src/app/ui/components/app-empty-state.ts'; import '/src/app/ui/views/audit-center.ts'; import '/src/app/ui/views/agent-security-policy.ts'; import '/src/app/ui/views/metric-settings.ts';</script>
    </body></html>` }));
  await page.goto('/audit-policy-fixture');
  return { calls, fail: (value: typeof failure) => { failure = value; } };
}

for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`MAX-446/447/448/450 same-session recovery and navigation ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    const h = await fixture(page);
    const audit = page.locator('audit-center-page');
    const system = audit.getByRole('tab', { name: '系统审计', exact: true });
    const agent = audit.getByRole('tab', { name: 'Agent 审计', exact: true });
    const length = await page.evaluate(() => history.length);
    await system.click(); await system.click();
    expect(await page.evaluate(() => history.length)).toBe(length);
    await agent.focus(); await page.keyboard.press('Enter');
    await expect(agent).toHaveAttribute('aria-selected', 'true');
    await expect(audit.locator('agent-tool-audit-page')).toBeVisible();
    await agent.click(); await agent.click();
    expect(await page.evaluate(() => history.length)).toBe(length + 1);
    await page.goBack();
    await expect(system).toHaveAttribute('aria-selected', 'true');
    await expect(audit.locator('system-audit-page')).toBeVisible();
    expect(new URL(page.url()).searchParams.has('view')).toBe(false);
    await page.goForward();
    await expect(agent).toHaveAttribute('aria-selected', 'true');
    const security = page.locator('agent-security-policy-page');
    const retry = security.getByRole('button', { name: '重试加载变更记录' });
    for (const failure of ['403', '500', 'network'] as const) {
      h.fail(failure);
      if (failure !== '403') await retry.click();
      await expect(security.getByRole('alert')).toContainText('策略变更记录加载失败');
      await expect(security.getByText('暂无策略变更', { exact: true })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`history-${failure}.png`), fullPage: true });
    }
    h.fail('empty'); await retry.focus(); await page.keyboard.press('Enter');
    await expect(security.getByText('暂无策略变更', { exact: true })).toBeVisible();
    await expect(security.getByRole('alert')).toHaveCount(0);
    const metrics = page.locator('metric-settings');
    await metrics.getByRole('button', { name: '策略组', exact: true }).click();
    await metrics.getByRole('button', { name: '读取策略组', exact: true }).click();
    await expect(metrics.getByRole('alert')).toContainText('请先选择策略组');
    await metrics.getByLabel('策略组', { exact: true }).selectOption('bad/id');
    await metrics.getByRole('button', { name: '读取策略组', exact: true }).click();
    await expect(metrics.getByRole('alert')).toContainText('策略组标识仅支持');
    expect(h.calls.some(c => c.includes('/bad/'))).toBe(false);
    await metrics.getByLabel('策略组', { exact: true }).selectOption('valid-group');
    await metrics.getByRole('button', { name: '读取策略组', exact: true }).click();
    await expect(metrics.getByRole('alert')).toHaveCount(0);
    await metrics.getByRole('button', { name: '预览组影响' }).click();
    await expect(metrics.getByText('影响 1 个资源，每小时逻辑读取 10 → 8')).toBeVisible();
    await metrics.getByRole('button', { name: '发布策略组' }).click();
    await expect(metrics.getByText('发布版本 2；未覆盖字段继承采集包与平台值。')).toBeVisible();
    expect(h.calls).toContain('POST /api/metrics/policy/groups/valid-group/publish');
    await page.screenshot({ path: info.outputPath('recovered.png'), fullPage: true });
  });
}

test('MAX-446 loading and Agent selection reject stale history responses', async ({ page }) => {
  await fixture(page);
  const security = page.locator('agent-security-policy-page');
  await expect(security.getByRole('alert')).toBeVisible();
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/api/agent/security/policies/a/history', async route => {
    await waiting;
    await route.fulfill({ status: 500, json: { error: 'late error' } });
  });
  await page.route('**/api/agent/security/policies/b/history', route => route.fulfill({ json: { records: [{ version: 7, changeNote: 'Agent B 当前变更', changedBy: 1, createdAt: '2026-11-13T00:00:00Z' }] } }));
  try {
    await security.getByRole('button', { name: '重试加载变更记录' }).click();
    await expect(security.getByRole('status')).toHaveText('正在加载策略变更记录…');
    await expect(security.getByText('暂无策略变更', { exact: true })).toHaveCount(0);
    await security.getByLabel('Agent', { exact: true }).selectOption('b');
    await expect(security.getByText('Agent B 当前变更', { exact: true })).toBeVisible();
    finish(); await page.unrouteAll({ behavior: 'wait' });
    await expect(security.getByRole('alert')).toHaveCount(0);
    await expect(security.getByText('Agent B 当前变更', { exact: true })).toBeVisible();
  } finally {
    finish(); await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' });
  }
});
