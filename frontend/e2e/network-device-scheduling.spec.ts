import { expect, test } from '@playwright/test';

for (const width of [390, 1280]) for (const canBackup of [true, false]) {
  test(`Chinese device detail and persistent backup settings at ${width}px (${canBackup ? 'backup permission' : 'read only'})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    // This fixture mounts the detail directly, bypassing the app's permission bootstrap.
    await page.addInitScript(canBackup => {
      localStorage.setItem('permissions', JSON.stringify(canBackup
        ? ['network_devices:view', 'network_devices:backup'] : ['network_devices:view']));
    }, canBackup);
    let schedule = { enabled: true, dailyTime: '00:00', timeZone: 'Asia/Shanghai', lastRun: null };
    const writes: unknown[] = [];
    await page.route('**/api/metrics/latest', route => {
      const resource = { type: 'network_device', id: 7 };
      const at = '2026-09-18T00:00:00Z';
      expect(route.request().postDataJSON()).toEqual(resource);
      return route.fulfill({ json: { resource, evaluated_at: at, metrics: [{
        definition: { id: 'network_device.cpu.utilization_percent', semantic_version: '1.0.0',
          kind: 'gauge', value_type: 'float64', unit: '%', meaning: '设备 CPU 使用率' },
        state: 'available',
        series: [{ dimensions: {}, observed_at: at, value: { encoding: 'float64', value: 25 },
          unit: '%', quality: { status: 'good' }, freshness: 'fresh', accuracy: 'exact' }],
      }] } });
    });
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
    await page.route(url => url.pathname === '/network-schedule-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
      <network-device-detail deviceid="7"></network-device-detail>
      <script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/network-device-detail.ts';</script>
      </body></html>` }));
    await page.goto('/network-schedule-fixture');
    await expect(page.getByRole('heading', { name: '测试交换机' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '当前需要关注' })).toBeVisible();
    await expect(page.locator('resource-metric-browser')).toHaveCount(0);
    await page.getByRole('tab', { name: '指标与趋势', exact: true }).click();
    const metrics = page.locator('resource-metric-browser');
    await expect(metrics.getByRole('heading', { name: '最新采集数据' })).toBeVisible();
    await expect(metrics.getByText('25 %', { exact: true })).toBeVisible();
    await expect(metrics.locator('time')).toHaveAttribute('datetime', '2026-09-18T00:00:00Z');
    await page.getByRole('tab', { name: '配置备份', exact: true }).click();
    await expect(page.getByLabel('每日执行时间', { exact: true })).toHaveValue('00:00');
    await expect(page.getByLabel('启用每日定时备份')).toBeChecked();
    if (!canBackup) {
      await expect(page.getByLabel('每日执行时间', { exact: true })).toBeDisabled();
      await expect(page.getByLabel('启用每日定时备份')).toBeDisabled();
      await expect(page.getByRole('button', { name: '保存定时设置' })).toBeDisabled();
      await expect(page.getByRole('button', { name: '立即备份', exact: true })).toBeDisabled();
      expect(writes).toEqual([]);
      return;
    }
    await expect(page.getByLabel('每日执行时间', { exact: true })).toBeEnabled();
    await page.getByLabel('每日执行时间', { exact: true }).fill('03:45');
    await page.getByLabel('启用每日定时备份').uncheck();
    await page.getByRole('button', { name: '保存定时设置' }).click();
    await expect.poll(() => writes).toEqual([{ enabled: false, dailyTime: '03:45' }]);
    await page.reload();
    await page.getByRole('tab', { name: '配置备份', exact: true }).click();
    await expect(page.getByLabel('每日执行时间', { exact: true })).toHaveValue('03:45');
    await expect(page.getByLabel('启用每日定时备份')).not.toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('network-backup-settings.png'), fullPage: true });
    const interfacesTab = page.getByRole('tab', { name: '接口', exact: true });
    await interfacesTab.click();
    await expect(interfacesTab).toHaveClass(/active/);
    await expect(interfacesTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('resource-metric-browser')).toHaveCount(0);
    await expect(page.getByText('尚未取得接口记录', { exact: true })).toBeVisible();
    await expect(page.getByLabel('接口名称或别名', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '关联资源', exact: true }).click();
    await expect(page.getByText('暂无关联资源', { exact: true })).toBeVisible();
  });
}
