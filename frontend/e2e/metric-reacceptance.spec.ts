import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

// Controlled API responses exercise browser state and rendering, not formal
// collection or real-model acceptance. Those require separate live receipts.
for (const width of [375, 768, 1440]) for (const theme of ['light', 'dark']) {
  test(`metric state, names and local times ${width} ${theme}`, async ({ page, context }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const queries: any[] = []; let release: (() => void) | undefined, hold = false, missing = false;
    await page.route('**/api/metrics/query', async route => {
      const query = route.request().postDataJSON(); queries.push(query);
      if (hold) await new Promise<void>(resolve => { release = resolve; });
      const points = [0, 1, 2].map(i => ({ value: { encoding: 'float64', value: i === 1 ? null : 0 }, unit: '%', coverage: 1,
        quality: { status: i === 1 ? 'unknown' : 'good', reason: 'controlled browser fixture' }, freshness: 'fresh', accuracy: 'exact', observed_at: query.to,
        window: { from: new Date(Date.parse(query.from) + i * 60000).toISOString(), to: new Date(Date.parse(query.from) + (i + 1) * 60000).toISOString() } }));
      const metric = (id: string, series: any[] = []) => ({ definition: { id, category: 'extension', meaning: 'Controlled browser evidence', unit: '%' }, state: 'available', series });
      return route.fulfill({ json: { profile: { columns: [] }, window: { from: query.from, to: query.to }, metrics: missing ? [] : [
        metric('mysql.key_cache.used_percent', [{ dimensions: {}, buckets: points }]),
        metric('mysql.threads.running'), metric('vendor.unrecognized_metric'),
      ] } });
    });
    await page.route('**/metric-reacceptance-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><semantic-metrics resourceid="8"></semantic-metrics></main><script type="module">import '/src/app/styles.css'; import '/src/app/ui/components/semantic-metrics.ts'; document.documentElement.dataset.themeMode = '${theme}';</script></body></html>` }));
    await page.goto('/metric-reacceptance-fixture');
    const metrics = page.locator('semantic-metrics');
    const select = metrics.getByRole('combobox', { name: '指标', exact: true });
    await expect(metrics.locator('.metric-name')).toHaveCount(3);
    await select.selectOption('mysql.key_cache.used_percent');
    hold = true;
    await metrics.getByRole('combobox', { name: '时间范围', exact: true }).selectOption('6');
    await expect(metrics.getByLabel('正在读取指标')).toBeVisible();
    await expect(select).toHaveValue('mysql.key_cache.used_percent');
    await expect.poll(() => !!release).toBe(true); hold = false; release!();
    await expect(metrics.locator('.metric-name')).toHaveText(['键缓存使用率']);
    await expect(select).toHaveValue('mysql.key_cache.used_percent');
    const query = queries.at(-1);
    expect(query.view).toBe('all'); expect(query.resource).toEqual({ type: 'instance', id: 8 });
    expect(Date.parse(query.to) - Date.parse(query.from)).toBe(6 * 3600000);
    await metrics.getByRole('button', { name: '刷新标准指标' }).click();
    await expect(metrics.getByRole('button', { name: '刷新标准指标' })).toBeEnabled();
    await expect(select).toHaveValue('mysql.key_cache.used_percent');
    const current = metrics.locator('.current');
    await expect(current.locator('strong')).toHaveText('0');
    await current.getByText('指标标识', { exact: true }).click();
    await expect(current.locator('code')).toHaveText('mysql.key_cache.used_percent');
    await current.getByRole('button', { name: '复制 mysql.key_cache.used_percent', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('mysql.key_cache.used_percent');
    const chart = metrics.locator('metric-chart');
    await expect(chart.locator('canvas')).toBeVisible();
    await expect(chart).toContainText('Asia/Shanghai');
    const chartData = await chart.evaluate((el: any) => ({ times: el.timeData, series: el.series, option: el._chart.getOption().xAxis[0].data,
      label: el._chart.getOption().xAxis[0].axisLabel.formatter(el.timeData[0]) }));
    expect(chartData.option).toEqual(chartData.times);
    expect(chartData.series[0].data).toEqual([0, null, 0]);
    expect(chartData.label).not.toContain('T'); expect(chartData.label.length).toBeLessThan(15);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    writeFileSync(info.outputPath('metric-query.json'), JSON.stringify({
      source: 'controlled browser API, not real collection', at: new Date().toISOString(), width, theme,
      queries, selected: await select.inputValue(), renderedHeadings: await metrics.locator('.metric-name').allTextContents(), chartData,
    }, null, 2));
    await page.screenshot({ path: info.outputPath(`trend-${width}-${theme}.png`), fullPage: true });
    await select.selectOption('mysql.threads.running');
    await expect(metrics.locator('.metric-name')).toHaveText(['当前运行线程数']);
    await expect(metrics.locator('.current')).toContainText('暂无可用观测');
    await expect(metrics.locator('metric-chart')).toHaveCount(0);
    await select.selectOption('vendor.unrecognized_metric');
    await expect(metrics.locator('.metric-name')).toHaveText(['vendor.unrecognized_metric']);
    missing = true;
    await metrics.getByRole('button', { name: '刷新标准指标' }).click();
    await expect(metrics.getByText('当前窗口未返回所选指标；可刷新或选择全部指标。')).toBeVisible();
    await expect(select).toHaveValue('vendor.unrecognized_metric');
    missing = false; await select.selectOption('');
    await metrics.getByRole('button', { name: '刷新标准指标' }).click();
    await expect(metrics.locator('.metric-name')).toHaveCount(3);
    await expect(select).toHaveValue('');
    expect(errors).toEqual([]);
  });
}
