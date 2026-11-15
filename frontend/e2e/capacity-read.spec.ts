import { expect, test } from '@playwright/test';

// Real Lit components and HTTP reads, controlled API responses; no database or LLM claims.
for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`MAX-529/530 failures, keyboard retry and signs at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    let failing = true;
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname.includes('/capacity')) return failing
        ? route.fulfill({ status: 503, json: { error: 'controlled outage' } })
        : route.fulfill({ json: url.pathname.endsWith('/history') ? { history: [] } : { total_size_gb: 10, top_tables: [] } });
      if (url.pathname === '/api/ai/analysis/history') return failing
        ? route.fulfill({ status: 500, json: {} })
        : route.fulfill({ json: { records: [] } });
      return route.fulfill({ json: {} });
    });
    await page.goto('/e2e/fixtures/capacity-read.html');
    await page.waitForFunction(() => customElements.get('instance-detail-page'));
    const el = page.locator('instance-detail-page');
    await el.evaluate(async (el: any) => {
      el.stopAutoRefresh(); el.loading = false;
      el.instanceId = 529; el.instance = { id: 529, name: '受控接口样本', db_type: 'mysql', host: 'fixture', port: 3308 };
      el.activeTab = 'capacity'; await el.loadTabData(); await el.loadDiagnosisHistory();
    });
    await expect(el.locator('app-card [role=alert]')).toContainText('HTTP 503');
    await expect(el.getByText('暂无容量数据')).toHaveCount(0);
    const retry = el.getByRole('button', { name: '重试容量读取', exact: true });
    await retry.focus(); await expect(retry).toBeFocused();
    const bounds = await retry.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
    await page.screenshot({ path: info.outputPath('capacity-failure.png') });
    failing = false;
    await page.keyboard.press('Enter');
    await expect(el.getByText('容量读取结果：10.00 GB')).toBeVisible();
    await el.evaluate((el: any) => { el.activeTab = 'diagnosis'; });
    await expect(el.locator('app-card [role=alert]')).toContainText('HTTP 500');
    await page.screenshot({ path: info.outputPath('diagnosis-failure.png') });
    await el.getByRole('button', { name: '重试诊断历史', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(el.locator('app-card [role=alert]')).toHaveCount(0);
    await page.evaluate(() => {
      const page = document.querySelector('instance-detail-page')!; page.remove();
      const health = document.createElement('health-center-page') as any;
      health.render = () => health._renderCapacityDetailTable([95, 105, 100].map(inst_size => ({ name: '受控容量样本', inst_size, cap_size: 100 })));
      document.body.append(health);
    });
    const cells = page.locator('health-center-page tbody tr td:last-child');
    await expect(cells).toHaveText(['-5%', '+5%', '0%']);
    await page.screenshot({ path: info.outputPath('capacity-signs.png') });
  });
}
