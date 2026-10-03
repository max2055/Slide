import { expect, test } from '@playwright/test';

test('tracks concurrent exact Cron runs, keeps queued distinct from legacy success, restores after refresh and cleans up on navigation', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const jobs = [1, 2].map(id => ({ id, name: `任务${id}`, cron_expr: '* * * * *', enabled: true, last_result: 'success' }));
  const states = new Map([[1, 'queued'], [2, 'running']]);
  const posts: string[] = []; const polls: string[] = []; let offline = false;
  await page.route('**/api/cron/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/cron/jobs') return route.fulfill({ json: jobs });
    const id = Number(url.pathname.split('/')[4]);
    if (url.pathname.endsWith('/run')) {
      posts.push(route.request().headers()['idempotency-key']);
      return route.fulfill({ status: 202, json: { jobId: id, runId: `current-${id}`, status: 'queued' } });
    }
    if (url.pathname.includes('/runs/')) {
      polls.push(url.pathname);
      if (offline) return route.abort('internetdisconnected');
      return route.fulfill({ json: { jobId: id, runId: `current-${id}`, status: states.get(id), completion: states.get(id) === 'failed' ? { summary: '本次业务失败' } : null } });
    }
    // Historical logs must never be consulted to finish a new run.
    return route.fulfill({ json: { logs: [{ status: 'success' }] } });
  });
  await page.route('**/cron-runs-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <cron-jobs-settings></cron-jobs-settings>
    <script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/cron-jobs-settings.ts';</script>
    </body></html>` }));
  await page.goto('/cron-runs-fixture');
  const rows = page.locator('.table-row').filter({ has: page.getByRole('button', { name: '执行', exact: true }) });
  await rows.nth(0).getByRole('button', { name: '执行', exact: true }).click();
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(rows.nth(0)).toContainText('排队中');
  await rows.nth(1).getByRole('button', { name: '执行', exact: true }).click();
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect.poll(() => polls.length).toBeGreaterThanOrEqual(2);
  await expect(rows.nth(0)).toContainText('排队中');
  await expect(rows.nth(1)).toContainText('运行中');
  offline = true;
  await expect(rows.nth(0)).toContainText('状态待确认');
  offline = false; states.set(1, 'failed');
  await page.reload();
  await expect(rows.nth(0)).toContainText('本次业务失败');
  await expect(rows.nth(1)).toContainText('运行中');
  expect(posts).toHaveLength(2);
  expect(polls.every(url => /runs\/current-[12]$/.test(url))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('cron-current-runs.png'), fullPage: true });
  await page.evaluate(() => document.querySelector('cron-jobs-settings')!.remove());
  const count = polls.length;
  // Advance browser timers after unmount without a fixed wall-clock sleep.
  await page.clock.install(); await page.clock.fastForward(10000);
  expect(polls).toHaveLength(count);
  expect(errors).toEqual([]);
});
