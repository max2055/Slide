import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('Canvas resolves theme variables and alpha through theme changes and resize', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/chart-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
    <script type="module">import '/src/app/styles.css'; import '/src/app/ui/components/metric-chart.ts';</script>
    <metric-chart title="颜色边界回归（受控数据）"></metric-chart>` }));
  await page.goto('/chart-fixture');
  await page.waitForFunction(() => customElements.get('metric-chart'));
  await page.evaluate(() => {
    const chart = document.querySelector('metric-chart') as any;
    chart.timeData = ['10:00', '10:05', '10:10'];
    chart.series = ['var(--accent)', '#abc', 'rgb(12, 34, 56)', 'rgba(12, 34, 56, 0.5)', 'hsl(120, 100%, 50%)', 'red', '#12345680', 'var(--missing, var(--accent))', 'oklch(60% 0.15 240)'].map((color, i) => ({ name: color, color, data: [10 + i, 50 + i, 30 + i] }));
    chart.thresholds = [{ name: '阈值', value: 75, color: 'var(--accent)' }];
  });
  for (const [theme, accent] of [['light', '#1264a3'], ['dark', 'rgb(90, 190, 240)']]) {
    await page.evaluate(({ theme, accent }) => {
      document.documentElement.dataset.themeMode = theme;
      document.documentElement.style.setProperty('--accent', accent);
    }, { theme, accent });
    await expect.poll(() => page.evaluate(() => {
      const chart = document.querySelector('metric-chart') as any;
      const series = chart._chart?.getOption().series;
      return series?.[0]?.itemStyle.color;
    })).toBe(theme === 'light' ? 'rgba(18,100,163,1)' : 'rgba(90,190,240,1)');
    const colors = await page.evaluate(() => {
      const series = (document.querySelector('metric-chart') as any)._chart.getOption().series;
      return series.map((s: any) => ({ line: s.itemStyle.color, stops: s.areaStyle.color.colorStops }));
    });
    expect(colors[3].stops[0].color).toBe(`rgba(12,34,56,${0.5 * 64 / 255})`);
    expect(colors[3].stops[1].color).toBe(`rgba(12,34,56,${0.5 * 5 / 255})`);
    await page.setViewportSize({ width: theme === 'light' ? 1280 : 700, height: 800 });
    await expect(page.locator('metric-chart canvas')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`chart-${theme}.png`) });
  }
  expect(errors).toEqual([]);
});

for (const sample of [
  { type: 'text/html; charset=utf-8', body: '<!DOCTYPE html><html>历史报告</html>', disposition: 'attachment; filename="historical.html"', expected: 'historical.html' },
  { type: 'application/pdf', body: '%PDF-1.3\nfixture', disposition: 'attachment; filename="export.pdf"', expected: 'export.pdf' },
  { type: 'application/json', body: '{"id":1}', disposition: 'attachment; filename="wrong.pdf"', expected: 'wrong.json' },
  { type: 'text/markdown', body: '# Report', disposition: `attachment; filename="fallback.md"; filename*=UTF-8''%E5%81%A5%E5%BA%B7.md`, expected: '健康.md' },
  { type: 'text/csv', body: 'name,value\r\nload,10', disposition: '', expected: '旧报告.csv' },
  { type: 'text/html', body: '<!DOCTYPE html>', disposition: `attachment; filename*=UTF-8''%ZZ; filename="safe.html"`, expected: 'safe.html' },
  { type: 'text/html', body: '<!DOCTYPE html>', disposition: 'attachment; filename="../../report.pdf"', expected: 'report.html' },
]) test(`download ${sample.expected} matches response MIME and bytes`, async ({ page }, info) => {
  await page.route('**/report-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/reports.ts';</script><reports-page></reports-page>` }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    if (path.endsWith('/download')) return route.fulfill({ headers: { 'Content-Type': sample.type, ...(sample.disposition ? { 'Content-Disposition': sample.disposition } : {}) }, body: sample.body });
    return route.fulfill({ json: path === '/api/reports' ? [{ id: 1, name: '旧报告.pdf', status: 'completed', type: 'health', created_at: new Date().toISOString() }] : path.endsWith('/stats') ? { total: 1 } : [] });
  });
  await page.goto('/report-fixture');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe(sample.expected);
  const saved = info.outputPath(sample.expected);
  await download.saveAs(saved);
  expect(await readFile(saved, 'utf8')).toBe(sample.body);
});
