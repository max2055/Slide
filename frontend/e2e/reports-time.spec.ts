import { expect, test } from '@playwright/test';

test.use({ timezoneId: 'Asia/Shanghai' });

for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`#674 report schedule dates remain readable at ${width}×${height} (controlled API)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.clock.setFixedTime(new Date('2026-11-13T04:00:00Z'));
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('token', `fixture.${btoa(JSON.stringify({ userId: 1, sessionVersion: 1 }))}.fixture`));
    const configs = [
      ['未来计划', '2026-11-13T07:00:00Z'],
      ['非法时间', 'invalid'],
      ['未安排', null],
      ['过去三小时', '2026-11-13T01:00:00Z'],
      ['过去两天', '2026-11-11T04:00:00Z'],
    ].map(([name, next_run], index) => ({ id: index + 1, name, next_run, cron: '0 15 * * *', type: 'health', instance_id: 7, enabled: true }));
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/api/')) return route.fallback();
      const json = path === '/api/reports/configs' ? configs
        : path === '/api/reports/stats' ? { total: 0, completed: 0, running: 0, failed: 0 } : [];
      return route.fulfill({ json });
    });
    await page.route('**/reports-time-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="zh-CN"><body>
      <reports-page></reports-page>
      <script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/reports.ts';</script>
      </body></html>` }));
    await page.goto('/reports-time-fixture');
    const view = page.locator('reports-page');
    for (const [name, expected] of [
      ['未来计划', '2026/11/13 15:00:00'], ['非法时间', '—'], ['未安排', '—'],
      ['过去三小时', '3 小时前'], ['过去两天', '2 天前'],
    ]) {
      const row = view.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
      await expect(row.getByRole('cell').nth(4)).toHaveText(expected);
      await expect(row.getByRole('cell').nth(4)).toBeVisible();
    }
    await expect(view).not.toContainText(/NaN|-\d+ 小时前/);
    await page.screenshot({ path: info.outputPath('report-schedule.png'), fullPage: true });
    expect(errors).toEqual([]);
    await page.goto('about:blank');
    await page.unrouteAll({ behavior: 'wait' });
  });
}
