import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, options: { emptyNetwork?: boolean; overviewFailure?: boolean } = {}) {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'fixture-token'); localStorage.setItem('refreshToken', 'fixture-refresh');
    localStorage.setItem('permissions', '["*"]'); localStorage.setItem('slide.i18n.locale', 'zh-CN');
    localStorage.setItem('slide.control.session_token.v1', 'fixture-token');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
  });
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => { if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' })); }));
  const now = new Date().toISOString();
  const metrics = (type: string) => (type === 'network_device' ? ['device_reachability', 'device_cpu_percent', 'device_memory_percent', 'device_temperature_celsius'] : ['cpu_usage', 'memory_usage', 'disk_usage', 'connections', 'qps']).map((metricId, index) => ({ metricId, value: metricId === 'device_reachability' ? 1 : index * 14, quality: 'good', observedAt: now, validUntil: new Date(Date.now() + 300_000).toISOString() }));
  const items = ['instance', 'server', 'network_device'].flatMap((type, index) => options.emptyNetwork && type === 'network_device' ? [] : [0, 1].map(n => ({
    resource: { type, id: index * 10 + n + 1 }, label: ['Orders MySQL', 'Payments host', 'Core switch'][index] + (n ? ' secondary' : ''),
    status: type === 'server' && !n ? 'offline' : 'online', quality: n ? 'partial' : 'good', freshness: n ? 'stale' : 'fresh',
    observedAt: n ? new Date(Date.now() - 3600_000).toISOString() : now, unresolvedAlerts: n ? 0 : 1, alertIds: n ? [] : [String(index + 1)], alertSeverity: index === 1 ? 'critical' : 'warning',
    relationCount: 1, impactScope: [{ type: 'server', id: 11 }], gaps: n ? ['OBSERVATIONS_STALE'] : [],
    attributes: { dbType: 'mysql', host: `10.0.0.${index + 1}`, model: type === 'network_device' ? 'S5735' : null },
    observations: n ? [] : metrics(type),
  })));
  let posts = 0;
  let polls = 0;
  let fail = options.overviewFailure;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    let body: unknown = {};
    if (path === '/api/auth/permissions') body = ['*'];
    if (path === '/api/user/preferences') body = { preferences: { locale: 'zh-CN' } };
    if (path === '/api/version') body = { version: 'fixture' };
    if (path === '/api/resources/overview') {
      if (fail) return route.fulfill({ status: 503, json: { error: 'UNAVAILABLE' } });
      body = { collectedAt: now, dataQuality: 'partial', truncated: false, items };
    }
    if (/^\/api\/servers\/\d+\/instances$/.test(path)) body = { instances: [] };
    if (/^\/api\/servers\/\d+$/.test(path)) body = { id: 11, host: '10.0.0.2', port: 22, status: 'offline', label: 'Payments host', os_type: 'linux' };
    if (/^\/api\/network-devices\/\d+$/.test(path)) body = { id: 21, label: 'Core switch', name: 'Core switch', host: '10.0.0.3', vendor: 'huawei', status: 'online', snmp_port: 161 };
    if (/^\/api\/network-devices\/\d+\/(metrics|interfaces|relations)$/.test(path)) body = { metrics: [], interfaces: [], relations: [] };
    if (path === '/api/resources') body = { items: items.map(item => ({ resource: item.resource, label: item.label, status: item.status, attributes: item.attributes })) };
    if (path === '/api/dashboard/capacity-trend') body = { current_total_gb: 2.71, trend: [{ time: new Date(Date.now() - 7200_000).toISOString(), total_size_gb: 2.4 }, { time: now, total_size_gb: 2.71 }] };
    if (path.endsWith('/evidence')) body = { generatedAt: now, facts: [{ id: 'a'.repeat(64), kind: 'observation', status: 'fact', quality: 'good', observedAt: now, validUntil: new Date(Date.now() + 300_000).toISOString(), source: 'fixture', correlationId: 'test', provenance: {}, payload: { metricId: 'cpu_usage', value: 0 } }], inferences: [], hypotheses: [], gaps: [], truncated: false };
    if (path.endsWith('/diagnose-agent')) { posts++; body = { analysisId: 42, status: 'queued' }; }
    if (path.endsWith('/analyses/42')) { polls++; body = { analysisId: 42, status: polls > 1 ? 'completed' : 'running', completedAt: now, result: { summary: '已读取真实记录（测试夹具）' } }; }
    if (path.endsWith('/config-backups')) body = { backups: [{ collectedAt: now, versionNo: 2, redactionStatus: 'redacted' }] };
    if (path.endsWith('/evaluation')) return route.fulfill({ status: 503, json: { error: 'EVALUATION_UNAVAILABLE' } });
    await route.fulfill({ status: 200, json: body });
  });
  return { posts: () => posts, fail: () => { fail = true; } };
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
  test(`four professional views and responsive layout at ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport); const control = await fixture(page);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('/dashboard'); const view = page.locator('dashboard-page');
    for (const name of ['综合态势', '数据库', '服务器', '网络设备']) {
      await view.getByRole('tab', { name, exact: true }).click();
      await expect(view.locator('stat-card')).toHaveCount(4);
      await expect(view.locator('.risk-row').first()).toBeVisible();
      if (viewport.width >= 1280) {
        const tops = await view.locator('stat-card').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
        expect(new Set(tops).size).toBe(1);
        expect((await view.locator('.risk-row').first().boundingBox())!.y).toBeLessThan(viewport.height);
      }
      if (name !== '综合态势') await expect(view.getByRole('combobox', { name: '指标', exact: true })).toHaveValue(name === '网络设备' ? 'device_cpu_percent' : 'cpu_usage');
      if (name === '服务器') { await expect(view).not.toContainText('Orders MySQL'); await expect(view).toContainText('Payments host'); }
      if (name === '网络设备') { await view.getByRole('button', { name: '读取最近备份' }).click(); await expect(view).toContainText('最近已保存备份 v2'); }
      if (name === '数据库') await expect(view.locator('.trend-chart-container')).toBeVisible();
      else await expect(view.locator('.trend-chart-container')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await view.evaluate((element: any) => { element.scrollingParent().scrollTop = 0; });
      await page.screenshot({ path: testInfo.outputPath(`overview-${name}-${viewport.width}.png`), fullPage: true });
    }
    expect(control.posts()).toBe(0); expect(errors).toEqual([]);
  });
}

test('diagnosis is explicit, task is tracked, and return restores scope', async ({ page }) => {
  const control = await fixture(page); await page.goto('/dashboard?scope=server&q=Payments');
  const view = page.locator('dashboard-page'); await expect(view.locator('.risk-row').first()).toBeVisible();
  await view.locator('.risk-row').first().getByRole('link', { name: '查看证据', exact: true }).click();
  await expect(page).toHaveURL(/resourceType=server&resourceId=11/);
  const diagnosis = page.locator('resource-diagnosis-page');
  await expect(diagnosis.getByRole('combobox', { name: '资源', exact: true })).toHaveValue('server:11');
  expect(control.posts()).toBe(0);
  await diagnosis.getByRole('button', { name: '开始只读诊断', exact: true }).click();
  await expect(diagnosis.locator('[data-analysis-id="42"]')).toContainText('运行中');
  await expect(diagnosis.getByRole('button', { name: '开始只读诊断', exact: true })).toBeDisabled();
  await expect(diagnosis.locator('[data-analysis-id="42"]')).toContainText('已读取真实记录', { timeout: 10_000 });
  expect(control.posts()).toBe(1);
  await diagnosis.getByRole('link', { name: '返回原运维总览' }).click();
  await expect(page).toHaveURL(/scope=server&q=Payments/);
  await expect(page.locator('dashboard-page').getByRole('searchbox')).toHaveValue('Payments');
});

test('empty, no match, retained partial failure and keyboard tabs', async ({ page }, testInfo) => {
  const control = await fixture(page, { emptyNetwork: true }); await page.goto('/dashboard?scope=network_device');
  const view = page.locator('dashboard-page');
  await expect(view.locator('app-empty-state')).toHaveAttribute('title', '尚未纳管 网络设备');
  await expect(view.locator('stat-card')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('overview-unmanaged.png'), fullPage: true });
  await view.getByRole('tab', { name: '服务器', exact: true }).click();
  await view.getByRole('searchbox').fill('no-match'); await expect(view.locator('app-empty-state')).toHaveAttribute('title', '当前筛选无结果');
  await view.getByRole('searchbox').fill('');
  control.fail(); await view.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(view.getByRole('alert')).toContainText('保留上次成功快照');
  await expect(view.locator('stat-card')).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath('overview-partial-failure.png'), fullPage: true });
  await view.getByRole('tab', { name: '服务器', exact: true }).focus(); await page.keyboard.press('ArrowLeft');
  await expect(view.getByRole('tab', { name: '数据库', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home'); await expect(view.getByRole('tab', { name: '综合态势', exact: true })).toBeFocused();
});

for (const mode of ['light', 'dark']) {
  test(`theme ${mode} remains readable and keyboard-operable`, async ({ page }, testInfo) => {
    await fixture(page); await page.goto('/dashboard');
    const view = page.locator('dashboard-page'); await expect(view.locator('stat-card')).toHaveCount(4);
    await page.evaluate(mode => document.documentElement.setAttribute('data-theme-mode', mode), mode);
    await view.getByRole('tab', { name: '数据库', exact: true }).click();
    await expect(view.locator('.trend-chart-container')).toBeVisible();
    await view.evaluate((element: any) => { element.scrollingParent().scrollTop = 0; });
    const ratio = await view.locator('.resource-name').first().evaluate(element => {
      const luminance = (rgb: number[]) => rgb.map(value => { const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
      const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d')!;
      const color = (value: string) => { ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3); };
      const foreground = luminance(color(getComputedStyle(element).color));
      const background = luminance(color(getComputedStyle(element).getPropertyValue('--card')));
      return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: testInfo.outputPath(`overview-theme-${mode}.png`), fullPage: true });
  });
}

for (const type of ['server', 'network_device']) {
  test(`direct ${type} detail resolves ID and returns the original overview`, async ({ page }) => {
    await fixture(page); await page.goto(`/dashboard?scope=${type}`);
    const view = page.locator('dashboard-page');
    await view.locator('.risk-row').first().getByRole('link', { name: '查看资源', exact: true }).click();
    const detail = page.locator(type === 'server' ? 'server-detail' : 'network-device-detail');
    await expect(detail).toContainText(type === 'server' ? '10.0.0.2' : 'Core switch');
    await detail.getByRole('button', { name: type === 'server' ? '返回列表' : 'Network devices', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`dashboard\\?scope=${type}`));
    await expect(page.locator('dashboard-page stat-card')).toHaveCount(4);
  });
}
