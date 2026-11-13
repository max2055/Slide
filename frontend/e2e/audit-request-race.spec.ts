import { expect, test, type Page, type Route } from '@playwright/test';

const toolRecord = (id: number) => ({ id, phase: 'decision', actorId: 1, actorUsername: '验收用户', agentId: 'audit-test', requestId: `req-${id}`, toolName: `tool-${id}`, allowed: true, reasonCode: 'allowed', resource: {}, approvalId: null, createdAt: '2026-11-13T00:00:00Z' });
const systemRecord = (id: number) => ({ id: `system-${id}`, eventType: 'system_operation', level: 'info', username: '验收用户', action: `action-${id}`, result: 'success', timestamp: 1794528000000 });

async function fixture(page: Page) {
  const requests: { route: Route; url: URL; done: boolean }[] = [];
  await page.route('**/api/**', route => {
    if (!new URL(route.request().url()).pathname.startsWith('/api/')) return route.fallback();
    requests.push({ route, url: new URL(route.request().url()), done: false });
  });
  await page.route('**/audit-race-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><body>
    <agent-tool-audit-page></agent-tool-audit-page><system-audit-page></system-audit-page>
    <script type="module">
      import '/src/app/styles.css';
      import { apiClient } from '/src/api/index.ts';
      window.auditCompletions = {};
      const get = apiClient.get.bind(apiClient);
      apiClient.get = async (path, ...args) => {
        const completions = window.auditCompletions[path] ??= [];
        const index = completions.push(false) - 1;
        try { return await get(path, ...args); } finally { completions[index] = true; }
      };
      await import('/src/app/ui/views/agent-tool-audit.ts');
      await import('/src/app/ui/views/system-audit.ts');
    </script>
    </body></html>` }));
  await page.goto('/audit-race-fixture');
  const take = async (path: string, index = 0) => {
    await expect.poll(() => requests.filter(r => r.url.pathname === `/api${path}`).length).toBeGreaterThan(index);
    return requests.filter(r => r.url.pathname === `/api${path}`)[index];
  };
  const reply = async (path: string, index: number, body: unknown, status = 200) => {
    const request = await take(path, index); request.done = true;
    await request.route.fulfill({ status, json: body });
    await expect.poll(() => page.evaluate(({ path, index }) => (window as any).auditCompletions[path]?.[index], { path, index })).toBe(true);
  };
  await reply('/agent/security/audit', 0, { records: [toolRecord(1), toolRecord(2)], nextCursor: 25 });
  await reply('/audit/logs', 0, { items: [systemRecord(1)], total: 60 });
  const agent = page.locator('agent-tool-audit-page'); const system = page.locator('system-audit-page');
  await expect(agent.getByRole('button', { name: '下一页' })).toBeEnabled();
  await expect(system.getByRole('button', { name: '下一页' })).toBeEnabled();
  return { agent, system, take, reply, requests };
}

test('MAX-429 closes pending detail with Escape, restores focus and ignores late completion', async ({ page }) => {
  const h = await fixture(page); const trigger = h.agent.getByRole('button', { name: '查看详情' }).first();
  await trigger.click(); await h.take('/agent/security/audit/1');
  await expect(h.agent.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(h.agent.getByRole('dialog')).toBeHidden(); await expect(trigger).toBeFocused();
  await h.reply('/agent/security/audit/1', 0, { record: { ...toolRecord(1), args: 'late' } });
  await expect.poll(() => h.agent.evaluate((el: any) => el.detailLoading)).toBe(false);
  await expect(h.agent.getByRole('dialog')).toBeHidden();
  await trigger.click(); await h.reply('/agent/security/audit/1', 1, { record: { ...toolRecord(1), args: 'reopened' } });
  await expect(h.agent.locator('.dialog-grid')).toContainText('reopened');
});

test('MAX-429 newest selection owns detail data with reversed responses', async ({ page }) => {
  const h = await fixture(page);
  // Both real row handlers fire before Lit renders the modal, reproducing fast selection changes.
  await h.agent.evaluate(el => { const buttons = el.shadowRoot!.querySelectorAll<HTMLButtonElement>('[aria-label="查看详情"]'); buttons[0].click(); buttons[1].click(); });
  await h.take('/agent/security/audit/1'); await h.take('/agent/security/audit/2');
  await h.reply('/agent/security/audit/2', 0, { record: { ...toolRecord(2), args: 'current-detail' } });
  await expect(h.agent.locator('.dialog-grid')).toContainText('current-detail');
  await h.reply('/agent/security/audit/1', 0, { record: { ...toolRecord(1), args: 'stale-detail' } });
  await expect(h.agent.locator('.dialog-grid')).toContainText('#2');
  await expect(h.agent.locator('.dialog-grid')).not.toContainText('stale-detail');
});

for (const agent of [true, false]) test(`${agent ? 'MAX-429' : 'MAX-433'} pagination, filter, stale failure and recovery in one session`, async ({ page }) => {
  const h = await fixture(page); const view = agent ? h.agent : h.system; const path = agent ? '/agent/security/audit' : '/audit/logs';
  const result = (id: number) => agent ? { records: [toolRecord(id)], nextCursor: 50 } : { items: [systemRecord(id)], total: 75 };
  await view.getByRole('button', { name: '下一页' }).click(); const old = await h.take(path, 1);
  expect(old.url.searchParams.get(agent ? 'cursor' : 'offset')).toBe('25');
  const input = view.locator(agent ? 'input[type="text"]' : 'input[type="search"]').first();
  await input.fill('new'); await view.getByRole('button', { name: '查询', exact: true }).click();
  const current = await h.take(path, 2); expect(current.url.searchParams.get(agent ? 'toolName' : 'keyword')).toBe('new');
  await h.reply(path, 2, result(3)); await expect(view).toContainText(agent ? 'tool-3' : 'action-3');
  await h.reply(path, 1, result(2));
  await expect(view).not.toContainText(agent ? 'tool-2' : 'action-2');
  if (!agent) await expect(view.locator('.pagination-info')).toHaveText('1-25 / 75');
  await view.getByRole('button', { name: '刷新', exact: true }).click(); await h.take(path, 3);
  await view.getByRole('button', { name: '查询', exact: true }).click(); await h.take(path, 4);
  await h.reply(path, 3, { error: 'old failure' }, 403);
  await expect(view.getByRole('button', { name: '刷新', exact: true })).toBeDisabled();
  await h.reply(path, 4, { error: 'current failure' }, 403);
  await expect(view.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await view.getByRole('button', { name: '刷新', exact: true }).click(); await h.reply(path, 5, result(4));
  await expect(view).toContainText(agent ? 'tool-4' : 'action-4');
});

test('MAX-429 duplicate pagination events mutate the cursor stack once', async ({ page }) => {
  const h = await fixture(page);
  await h.agent.evaluate(el => { const next = el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.pagination button')[1]; next.click(); next.click(); });
  await h.take('/agent/security/audit', 1);
  await expect.poll(() => h.agent.evaluate((el: any) => el.cursorStack.length)).toBe(1);
  expect(h.requests.filter(r => r.url.pathname === '/api/agent/security/audit')).toHaveLength(2);
  await h.reply('/agent/security/audit', 1, { records: [toolRecord(3)], nextCursor: 50 });
  await expect(h.agent).toContainText('tool-3'); await h.agent.getByRole('button', { name: '上一页' }).click();
  const previous = await h.take('/agent/security/audit', 2); expect(previous.url.searchParams.has('cursor')).toBe(false);
  await h.reply('/agent/security/audit', 2, { records: [toolRecord(1)], nextCursor: 25 });
  await expect(h.agent).toContainText('tool-1');
});

for (const width of [1366, 1440, 1920]) test(`audit controls and dialog remain usable at ${width}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: width === 1366 ? 768 : width === 1440 ? 900 : 1080 });
  const h = await fixture(page); await h.agent.getByRole('button', { name: '查看详情' }).first().click();
  await h.reply('/agent/security/audit/1', 0, { record: toolRecord(1) });
  const dialog = h.agent.getByRole('dialog'); await expect(dialog).toBeVisible();
  const rect = await dialog.boundingBox(); expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
  await page.screenshot({ path: testInfo.outputPath(`audit-${width}.png`) });
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
});


test('MAX-429 stale detail failure preserves the newer loading dialog and retry succeeds', async ({ page }) => {
  const h = await fixture(page);
  await h.agent.evaluate(el => { const buttons = el.shadowRoot!.querySelectorAll<HTMLButtonElement>('[aria-label="查看详情"]'); buttons[0].click(); buttons[1].click(); });
  await h.take('/agent/security/audit/2');
  await h.reply('/agent/security/audit/1', 0, { error: 'stale' }, 403);
  await expect(h.agent.getByRole('dialog')).toBeVisible();
  await expect(h.agent.locator('.dialog-grid')).toContainText('#2');
  await expect(h.agent.locator('.dialog-grid')).toContainText('加载中');
  await h.reply('/agent/security/audit/2', 0, { error: 'current' }, 403);
  await expect(h.agent.getByRole('dialog')).toBeHidden();
  await h.agent.getByRole('button', { name: '查看详情' }).nth(1).click();
  await h.reply('/agent/security/audit/2', 1, { record: { ...toolRecord(2), args: 'retry-ok' } });
  await expect(h.agent.locator('.dialog-grid')).toContainText('retry-ok');
});

test('both audit views ignore success/failure after unload and accept reconnect in the same session', async ({ page }) => {
  const h = await fixture(page);
  await h.agent.getByRole('button', { name: '查看详情' }).first().click();
  await h.take('/agent/security/audit/1');
  await page.evaluate(() => {
    const agent: any = document.querySelector('agent-tool-audit-page'); const system: any = document.querySelector('system-audit-page');
    agent.load(); system.load(); agent.remove(); system.remove();
    (window as any).auditViews = [agent, system];
  });
  await h.reply('/agent/security/audit/1', 0, { record: toolRecord(1) });
  await h.reply('/agent/security/audit', 1, { records: [toolRecord(3)], nextCursor: 50 });
  await h.reply('/audit/logs', 1, { error: 'unloaded' }, 403);
  expect(await page.evaluate(() => (window as any).auditViews.map((view: any) => ({ loading: view.loading, selected: view.selected, count: view.records.length })))).toEqual([
    { loading: false, selected: null, count: 0 }, { loading: false, selected: null, count: 0 },
  ]);
  await page.evaluate(() => (window as any).auditViews.forEach((view: HTMLElement) => document.body.append(view)));
  await h.reply('/agent/security/audit', 2, { records: [toolRecord(4)], nextCursor: null });
  await h.reply('/audit/logs', 2, { items: [systemRecord(4)], total: 1 });
  await expect(h.agent).toContainText('tool-4'); await expect(h.system).toContainText('action-4');
});
