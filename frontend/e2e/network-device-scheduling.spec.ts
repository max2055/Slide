import { expect, test } from '@playwright/test';

for (const width of [390, 1280]) {
  test(`Chinese device detail and persistent backup settings at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    let schedule = { enabled: true, dailyTime: '00:00', timeZone: 'Asia/Shanghai', lastRun: null };
    const writes: unknown[] = [];
    await page.route('**/api/metrics-v2/query', route => route.fulfill({ json: {
      profile: { columns: [] },
      window: { from: '2026-09-18T00:00:00Z', to: '2026-09-18T00:01:00Z' },
      metrics: [],
    } }));
    await page.route('**/api/network-devices/7**', route => {
      const url = new URL(route.request().url()).pathname;
      if (url.endsWith('/backup-schedule')) {
        if (route.request().method() === 'PUT') {
          const input = route.request().postDataJSON(); writes.push(input); schedule = { ...schedule, ...input };
        }
        return route.fulfill({ json: schedule });
      }
      if (url.endsWith('/metrics')) return route.fulfill({ json: { metrics: [{ metricId: 'device_cpu_percent', value: 25, quality: 'good' }] } });
      if (url.endsWith('/interfaces')) return route.fulfill({ json: { interfaces: [] } });
      if (url.endsWith('/relations')) return route.fulfill({ json: { relations: [] } });
      if (url.endsWith('/config-backups')) return route.fulfill({ json: { backups: [] } });
      return route.fulfill({ json: { id: 7, name: '测试交换机', host: '192.0.2.7', snmp_port: 161, vendor: 'cisco', status: 'online', collection_enabled: true, hasSshCredential: true } });
    });
    await page.route('**/network-schedule-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
      <network-device-detail deviceid="7"></network-device-detail>
      <script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/network-device-detail.ts';</script>
      </body></html>` }));
    await page.goto('/network-schedule-fixture');
    await expect(page.getByRole('heading', { name: '测试交换机' })).toBeVisible();
    await expect(page.getByText('标准指标与能力', { exact: true })).toBeVisible();
    await expect(page.getByText('模板扩展指标', { exact: true })).toBeVisible();
    await expect(page.getByText('自动采集', { exact: true })).toBeHidden();
    await page.getByText('旧版概览（兼容口径）', { exact: true }).click();
    await expect(page.getByText('自动采集', { exact: true })).toBeVisible();
    await expect(page.getByText('CPU 使用率', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '配置备份', exact: true }).click();
    await expect(page.getByLabel('每日执行时间', { exact: true })).toHaveValue('00:00');
    await expect(page.getByLabel('启用每日定时备份')).toBeChecked();
    await page.getByLabel('每日执行时间', { exact: true }).fill('03:45');
    await page.getByLabel('启用每日定时备份').uncheck();
    await page.getByRole('button', { name: '保存定时设置' }).click();
    await expect.poll(() => writes).toEqual([{ enabled: false, dailyTime: '03:45' }]);
    await page.reload();
    await page.getByRole('button', { name: '配置备份', exact: true }).click();
    await expect(page.getByLabel('每日执行时间', { exact: true })).toHaveValue('03:45');
    await expect(page.getByLabel('启用每日定时备份')).not.toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('network-backup-settings.png'), fullPage: true });
    await page.getByRole('button', { name: '接口', exact: true }).click();
    await expect(page.getByText('暂无接口数据', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关联资源', exact: true }).click();
    await expect(page.getByText('暂无关联资源', { exact: true })).toBeVisible();
  });
}
