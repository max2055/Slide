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
    <audit-center-page></audit-center-page><agent-security-policy-page></agent-security-policy-page>
    <script type="module">import '/src/app/styles.css'; import '/src/app/ui/components/app-empty-state.ts'; import '/src/app/ui/views/audit-center.ts'; import '/src/app/ui/views/agent-security-policy.ts';</script>
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
    const history = security.getByRole('region', { name: '策略变更记录', exact: true });
    const retry = history.getByRole('button', { name: '重试加载变更记录' });
    for (const failure of ['403', '500', 'network'] as const) {
      h.fail(failure);
      if (failure !== '403') await retry.click();
      await expect(history.getByRole('alert')).toContainText('策略变更记录加载失败');
      await expect(history.getByText('暂无策略变更', { exact: true })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`history-${failure}.png`), fullPage: true });
    }
    h.fail('empty'); await retry.focus(); await page.keyboard.press('Enter');
    await expect(history.getByText('暂无策略变更', { exact: true })).toBeVisible();
    await expect(history.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('recovered.png'), fullPage: true });
  });
}

test('MAX-446 loading and Agent selection reject stale history responses', async ({ page }) => {
  await fixture(page);
  const security = page.locator('agent-security-policy-page');
  const history = security.getByRole('region', { name: '策略变更记录', exact: true });
  const saveStatus = security.getByRole('group', { name: '策略保存', exact: true }).getByRole('status');
  await expect(history.getByRole('alert')).toBeVisible();
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/api/agent/security/policies/a/history', async route => {
    await waiting;
    await route.fulfill({ status: 500, json: { error: 'late error' } });
  });
  await page.route('**/api/agent/security/policies/b/history', route => route.fulfill({ json: { records: [{ version: 7, changeNote: 'Agent B 当前变更', changedBy: 1, createdAt: '2026-11-13T00:00:00Z' }] } }));
  try {
    await history.getByRole('button', { name: '重试加载变更记录' }).click();
    await expect(saveStatus).toHaveText('无未保存的修改');
    await expect(history.getByRole('status')).toHaveText('正在加载策略变更记录…');
    await expect(history.getByText('暂无策略变更', { exact: true })).toHaveCount(0);
    await security.getByLabel('Agent', { exact: true }).selectOption('b');
    await expect(history.getByText('Agent B 当前变更', { exact: true })).toBeVisible();
    const staleResponse = page.waitForResponse(response => response.url().endsWith('/a/history') && response.status() === 500);
    finish();
    await (await staleResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(history.getByRole('alert')).toHaveCount(0);
    await expect(history.getByText('Agent B 当前变更', { exact: true })).toBeVisible();
  } finally {
    finish(); await page.goto('about:blank'); await page.unrouteAll({ behavior: 'wait' });
  }
});

test('MAX-727 a completed policy save unlocks editing while history is pending', async ({ page }) => {
  await fixture(page);
  const security = page.locator('agent-security-policy-page');
  const saveArea = security.getByRole('group', { name: '策略保存', exact: true });
  const history = security.getByRole('region', { name: '策略变更记录', exact: true });
  const save = saveArea.getByRole('button', { name: '保存策略', exact: true });
  const note = security.locator('textarea');
  const agent = security.getByLabel('Agent', { exact: true });
  const refresh = security.getByRole('button', { name: '刷新', exact: true });
  await expect(history.getByRole('alert')).toBeVisible();

  const firstPut = Promise.withResolvers<void>();
  const oldHistory = Promise.withResolvers<void>();
  const submitted: string[] = [];
  let historyReads = 0;
  const putUrl = '**/api/agent/security/policies/a';
  const historyUrl = putUrl + '/history';
  const historyRow = (version: number, changeNote: string) => ({
    id: version, version, changeNote, changedBy: 1, createdAt: '2026-11-13T00:00:00Z',
  });

  await page.route(putUrl, async route => {
    expect(route.request().method()).toBe('PUT');
    submitted.push(route.request().postDataJSON().changeNote);
    const version = submitted.length + 1;
    if (version === 2) await firstPut.promise;
    await route.fulfill({ json: { policy: { ...policy('a'), version } } });
  });
  await page.route(historyUrl, async route => {
    switch (++historyReads) {
      case 1:
        await oldHistory.promise;
        await route.fulfill({ json: { records: [historyRow(2, '较早的变更')] } });
        break;
      case 2:
        await route.fulfill({ status: 500, json: { error: 'test history failure' } });
        break;
      default:
        await route.fulfill({ json: { records: [historyRow(3, '最新变更')] } });
    }
  });

  try {
    await note.fill('第一份变更说明');
    await save.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(() => submitted).toEqual(['第一份变更说明']);
    await expect(saveArea.getByRole('status')).toHaveText('正在保存策略…');
    await expect(save).toBeDisabled();
    await expect(note).toBeDisabled();
    await expect(agent).toBeDisabled();
    await expect(refresh).toBeDisabled();

    firstPut.resolve();
    await expect(history.getByRole('status')).toHaveText('正在加载策略变更记录…');
    await expect(history.getByText('暂无策略变更', { exact: true })).toHaveCount(0);
    await expect(saveArea.getByRole('status')).toHaveText('无未保存的修改');
    await expect(note).toBeEnabled();
    await expect(note).toHaveValue('');
    await expect(agent).toBeEnabled();
    await expect(refresh).toBeEnabled();

    await note.fill('第二份变更说明');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(history.getByRole('alert')).toHaveText('策略变更记录加载失败，请重试');
    await expect(saveArea.getByRole('status')).toHaveText('无未保存的修改');
    await expect(note).toBeEnabled();
    await note.fill('尚未提交的第三份草稿');
    await history.getByRole('button', { name: '重试加载变更记录' }).click();
    await expect(history.getByText('最新变更', { exact: true })).toBeVisible();

    const staleResponse = page.waitForResponse(response => response.url().endsWith('/history') && response.ok());
    oldHistory.resolve();
    await (await staleResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(history.getByText('最新变更', { exact: true })).toBeVisible();
    await expect(history.getByText('较早的变更', { exact: true })).toHaveCount(0);
    await expect(history.getByRole('alert')).toHaveCount(0);
    await expect(note).toHaveValue('尚未提交的第三份草稿');
    await expect(saveArea.getByRole('status')).toHaveText('有未保存的修改');
    expect(submitted).toEqual(['第一份变更说明', '第二份变更说明']);
  } finally {
    firstPut.resolve();
    oldHistory.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
