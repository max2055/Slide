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

test('MAX-729 opens only the named counterpart outside the list and restores row focus', async ({ page }) => {
  const h = await fixture(page);
  const first = { ...toolRecord(1), relatedRecordId: 101 };
  const counterpart = { ...first, id: 101, phase: 'result', result: { success: false, error: '合成回执' }, relatedRecordId: 1 };
  const other = { ...first, id: 2, relatedRecordId: null };
  const trigger = h.agent.getByRole('button', { name: '查看详情' }).first();
  await trigger.press('Enter');
  await h.reply('/agent/security/audit/1', 0, { record: first });
  const dialog = h.agent.locator('app-dialog');
  await expect(dialog.getByRole('dialog')).toBeVisible();
  await dialog.getByRole('button', { name: '查看执行结果 #101' }).press('Enter');
  await h.take('/agent/security/audit/101');
  await expect(dialog.getByRole('status')).toContainText('#101');
  await expect(dialog).not.toContainText('合成回执');
  await h.reply('/agent/security/audit/101', 0, { record: counterpart });
  await expect(dialog.getByText('#101 · tool-1')).toBeFocused();
  await expect(dialog.locator('.detail-row').filter({ hasText: '工具回执' })).toContainText('失败');
  await expect(dialog.locator('.detail-row').filter({ hasText: '授权判定' })).toContainText('允许');
  await expect(dialog).toContainText('合成回执');
  await dialog.getByRole('button', { name: '查看权限决策 #1' }).press('Enter');
  await h.reply('/agent/security/audit/1', 1, { record: first });
  await expect(dialog).not.toContainText('执行回执（已脱敏）');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await h.agent.getByRole('button', { name: '查看详情' }).nth(1).click();
  await h.reply('/agent/security/audit/2', 0, { record: other });
  await expect(dialog).toContainText('无法确认关联');
  await expect(dialog.getByRole('button', { name: /查看执行结果/ })).toHaveCount(0);
});

test('MAX-729 queries result and category together, preserves them on close, and resets to all requests', async ({ page }) => {
  const h = await fixture(page);
  const failed = { ...systemRecord(3), result: 'failure', action: 'PATCH /api/example/:id' };
  const background = { ...systemRecord(4), action: 'POST /api/device/register' };
  await h.system.getByRole('combobox', { name: '操作结果' }).selectOption('failure');
  await h.system.getByRole('combobox', { name: '请求类别' }).selectOption('business');
  await h.system.getByRole('button', { name: '查询', exact: true }).press('Enter');
  const filtered = await h.take('/audit/logs', 1);
  expect(Object.fromEntries(filtered.url.searchParams)).toMatchObject({ result: 'failure', requestCategory: 'business', offset: '0' });
  await h.reply('/audit/logs', 1, { items: [failed], total: 1 });
  const trigger = h.system.getByRole('button', { name: '查看详情' });
  await trigger.press('Enter');
  await expect(h.system.locator('app-dialog .dialog-grid')).toContainText(failed.action);
  await h.system.getByRole('button', { name: '返回列表' }).press('Enter');
  await expect(trigger).toBeFocused();
  await expect(h.system.getByRole('combobox', { name: '操作结果' })).toHaveValue('failure');
  await expect(h.system.getByRole('combobox', { name: '请求类别' })).toHaveValue('business');
  await h.system.getByRole('button', { name: '重置' }).press('Enter');
  const reset = await h.take('/audit/logs', 2);
  expect(Object.fromEntries(reset.url.searchParams)).toEqual({ limit: '25', offset: '0' });
  await h.reply('/audit/logs', 2, { items: [background, failed], total: 2 });
  await expect(h.system.locator('tbody')).toContainText(background.action);
});

test('MAX-729 pages and refreshes applied filters while edits wait for query', async ({ page }) => {
  const h = await fixture(page);
  const result = h.system.getByRole('combobox', { name: '操作结果' });
  const category = h.system.getByRole('combobox', { name: '请求类别' });
  const next = h.system.getByRole('button', { name: '下一页' });
  const query = h.system.getByRole('button', { name: '查询', exact: true });
  const refresh = h.system.getByRole('button', { name: '刷新', exact: true });
  const pagination = h.system.locator('.pagination-info');

  await result.selectOption('failure');
  await next.click();
  expect(Object.fromEntries((await h.take('/audit/logs', 1)).url.searchParams)).toEqual({ limit: '25', offset: '25' });
  await h.reply('/audit/logs', 1, { items: [systemRecord(26)], total: 60 });
  await expect(pagination).toHaveText('26-50 / 60');
  await query.click();
  expect(Object.fromEntries((await h.take('/audit/logs', 2)).url.searchParams)).toEqual({ limit: '25', offset: '0', result: 'failure' });
  await h.reply('/audit/logs', 2, { items: [{ ...systemRecord(1), result: 'failure' }], total: 26 });

  await category.selectOption('background');
  await next.click();
  expect(Object.fromEntries((await h.take('/audit/logs', 3)).url.searchParams)).toEqual({ limit: '25', offset: '25', result: 'failure' });
  await h.reply('/audit/logs', 3, { items: [{ ...systemRecord(26), result: 'failure' }], total: 26 });
  await expect(pagination).toHaveText('26-26 / 26');
  await refresh.click();
  expect(Object.fromEntries((await h.take('/audit/logs', 4)).url.searchParams)).toEqual({ limit: '25', offset: '25', result: 'failure' });
  await h.reply('/audit/logs', 4, { items: [], total: 25 });
  expect(Object.fromEntries((await h.take('/audit/logs', 5)).url.searchParams)).toEqual({ limit: '25', offset: '0', result: 'failure' });
  await h.reply('/audit/logs', 5, { items: [{ ...systemRecord(1), result: 'failure' }], total: 25 });
  await expect(pagination).toHaveText('1-25 / 25');
  await query.click();
  expect(Object.fromEntries((await h.take('/audit/logs', 6)).url.searchParams)).toEqual({ limit: '25', offset: '0', result: 'failure', requestCategory: 'background' });
  await h.reply('/audit/logs', 6, { items: [{ ...systemRecord(2), result: 'failure' }], total: 1 });
  await expect(h.system.locator('tbody')).toContainText('action-2');
  await expect(pagination).toHaveText('1-1 / 1');
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
  await h.reply('/agent/security/audit/2', 0, { error: 'current' }, 503);
  await expect(h.agent.getByRole('dialog')).toBeHidden();
  await h.agent.getByRole('button', { name: '查看详情' }).nth(1).click();
  await h.reply('/agent/security/audit/2', 1, { record: { ...toolRecord(2), args: 'retry-ok' } });
  await expect(h.agent.locator('.dialog-grid')).toContainText('retry-ok');
});

test('MAX-729 denied Agent detail erases the previously authorized list', async ({ page }) => {
  const h = await fixture(page);
  await h.agent.getByRole('button', { name: '查看详情' }).first().click();
  await h.reply('/agent/security/audit/1', 0, { error: 'forbidden' }, 403);
  await expect(h.agent.getByRole('dialog')).toBeHidden();
  await expect(h.agent.getByRole('alert')).toContainText('无权查看 Agent 审计');
  await expect(h.agent.locator('app-data-table')).toHaveCount(0);
  await h.agent.getByRole('button', { name: '刷新', exact: true }).click();
  await h.reply('/agent/security/audit', 1, { records: [], nextCursor: null });
  await expect(h.agent).toContainText('当前条件下暂无 Agent 审计记录');
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
