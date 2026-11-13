import { expect, test, type Page, type Route } from '@playwright/test';

const literal = `<img src=x onerror="window.pwned=1"> a < b > c & "quote" 'single'`;
const result = { summary: literal, [literal]: [literal, { [literal]: literal }, 7, null], object: { [literal]: literal }, scalar: literal };

async function fixture(page: Page) {
  let posts = 0;
  const observations: Route[] = [];
  await page.clock.install({ time: new Date('2026-11-13T01:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-13T01:00:00Z'));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    if (path === '/api/logs/analysis/42') { observations.push(route); return; }
    if (path === '/api/logs/analyze') { posts++; return route.fulfill({ json: { analysisId: 42 } }); }
    if (path === '/api/logs') return route.fulfill({ json: { logs: [{ id: 1, instance_id: 1, log_level: 'error', source: 'mysql_error', message: '受控日志', collected_at: '2026-11-13T01:00:00Z' }], total: 1 } });
    return route.fulfill({ json: { total: 1, by_level: { error: 1 } } });
  });
  await page.route('**/log-analysis-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><title>日志分析验收</title></head><body>
    <database-log-tab instanceId="1"></database-log-tab>
    <alert-detail-modal></alert-detail-modal>
    <script type="module">
      import '/src/app/styles.css';
      await import('/src/app/ui/views/database-log-tab.ts');
      await import('/src/app/ui/components/alert-detail-modal.ts');
    </script>
    </body></html>` }));
  await page.goto('/log-analysis-fixture');
  const view = page.locator('database-log-tab');
  await view.getByRole('checkbox', { name: '选择日志 1', exact: true }).check();
  await view.getByRole('button', { name: 'AI 分析 (1)', exact: true }).click();
  await expect(view.getByRole('status')).toContainText('最多观察 5 分钟');
  const tick = async (ms: number) => { await page.clock.runFor(ms); };
  const reply = async (index: number, body: unknown, status = 200) => {
    await expect.poll(() => observations.length).toBeGreaterThan(index);
    await observations[index].fulfill({ json: body, status });
    // Await body processing and scheduling before advancing the virtual clock.
    await expect.poll(() => view.evaluate((el: any) => el.pollController === null)).toBe(true);
  };
  return { view, tick, reply, observations, posts: () => posts };
}

for (const width of [1366, 1440, 1920]) test(`MAX-431/444/449 timeout recovery, literal result and Chinese history at ${width}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: width === 1366 ? 768 : width === 1440 ? 900 : 1080 });
  const h = await fixture(page);
  await h.tick(3000); await h.reply(0, {}, 503);
  await expect(h.view.getByRole('status')).toContainText('6 秒后重试');
  await h.tick(5999); expect(h.observations).toHaveLength(1);
  await h.tick(1); await h.reply(1, {}, 503);
  await expect(h.view.getByRole('status')).toContainText('12 秒后重试');
  await h.tick(12000); await expect.poll(() => h.observations.length).toBe(3);
  // Hang the third response until the independent observation deadline expires.
  await h.tick(279_000);
  await expect(h.view.getByRole('status')).toContainText('状态未知');
  await expect(h.view.getByRole('button', { name: 'AI 分析 (1)', exact: true })).toBeDisabled();
  await h.tick(60_000); expect(h.observations).toHaveLength(3); expect(h.posts()).toBe(1);
  const resume = h.view.getByRole('button', { name: '继续查询', exact: true });
  await resume.focus(); await page.keyboard.press('Enter');
  await h.tick(3000); await h.reply(3, { status: 'completed', result });
  await expect(h.view.locator('p').filter({ hasText: literal })).toHaveText(literal);
  await expect(h.view.locator('ul')).toContainText(`${literal}: ${literal}`);
  await expect(h.view.locator('pre')).toHaveText(JSON.stringify(result.object, null, 2));
  await expect(h.view.locator('img,script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
  expect(h.posts()).toBe(1);
  await page.evaluate(() => {
    const modal = document.querySelector('alert-detail-modal') as any;
    modal.alert = { id: 1, title: '受控测试告警', severity: 'info', status: 'unread', created_at: '2026-11-13T01:00:00Z' };
    modal.analysisHistory = ['pending', 'running', 'completed', 'failed', 'unknown', 'future-state'].map(status => ({ status, created_at: '2026-11-13T01:00:00Z' }));
    modal.open = true;
  });
  const modal = page.locator('alert-detail-modal');
  for (const label of ['等待中', '进行中', '已完成', '失败']) await expect(modal.getByText(label, { exact: true })).toBeVisible();
  await expect(modal.getByText('状态未知', { exact: true })).toHaveCount(2);
  await expect(modal).not.toContainText('future-state');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`result-${width}.png`), fullPage: true });
  await page.evaluate(() => document.body.replaceChildren());
});

test('MAX-431 slow response serializes GETs and completed/failed stop observing', async ({ page }) => {
  const h = await fixture(page);
  await h.tick(30_000); await expect.poll(() => h.observations.length).toBe(1);
  await h.reply(0, { status: 'running' });
  await h.tick(2999); expect(h.observations).toHaveLength(1);
  await h.tick(1); await h.reply(1, { status: 'failed', error_message: '受控任务失败' });
  await expect(h.view).toContainText('AI 分析失败: 受控任务失败');
  await h.tick(300_000); expect(h.observations).toHaveLength(2); expect(h.posts()).toBe(1);
});

for (const action of ['instance', 'unmount', 'permission']) test(`MAX-431 ${action} aborts active observation and clears its context`, async ({ page }) => {
  const h = await fixture(page); await h.tick(3000);
  await expect.poll(() => h.observations.length).toBe(1);
  await page.evaluate(action => {
    const view = document.querySelector('database-log-tab') as any;
    (window as any).oldLogView = view;
    if (action === 'instance') view.instanceId = 2;
    if (action === 'unmount') view.remove();
    if (action === 'permission') window.dispatchEvent(new Event('slide-permissions-loaded'));
  }, action);
  await expect.poll(() => page.evaluate(() => (window as any).oldLogView.analysisId)).toBeNull();
  await h.tick(300_000); expect(h.observations).toHaveLength(1);
  if (action === 'permission') await expect(h.view).toContainText('权限或登录状态已变更');
  await page.evaluate(() => document.body.replaceChildren());
});
