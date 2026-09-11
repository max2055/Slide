import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, options: { emptyNetwork?: boolean; overviewFailure?: boolean; longName?: boolean; relations?: 'empty' | 'failed'; permissions?: string[] } = {}) {
  await page.addInitScript((permissions) => {
    localStorage.setItem('token', 'fixture-token'); localStorage.setItem('refreshToken', 'fixture-refresh');
    localStorage.setItem('permissions', JSON.stringify(permissions)); localStorage.setItem('slide.i18n.locale', 'zh-CN');
    localStorage.setItem('slide.control.session_token.v1', 'fixture-token');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
  }, options.permissions ?? ['*']);
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => { if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' })); }));
  const now = new Date().toISOString();
  const metrics = (type: string) => (type === 'network_device' ? ['device_reachability', 'device_cpu_percent', 'device_memory_percent', 'device_temperature_celsius'] : ['cpu_usage', 'memory_usage', 'disk_usage', 'connections', 'qps']).map((metricId, index) => ({ metricId, value: metricId === 'device_reachability' ? 1 : index * 14, quality: 'good', observedAt: now, validUntil: new Date(Date.now() + 300_000).toISOString() }));
  const items = ['instance', 'server', 'network_device'].flatMap((type, index) => options.emptyNetwork && type === 'network_device' ? [] : [0, 1].map(n => ({
    resource: { type, id: index * 10 + n + 1 }, label: (options.longName ? '长资源名称'.repeat(24) : '') + ['Orders MySQL', 'Payments host', 'Core switch'][index] + (n ? ' secondary' : ''),
    status: type === 'server' && !n ? 'offline' : 'online', quality: n ? 'partial' : 'good', freshness: n ? 'stale' : 'fresh',
    observedAt: n ? new Date(Date.now() - 3600_000).toISOString() : now, unresolvedAlerts: n ? 0 : 1, alertIds: n ? [] : [String(index + 1)], alertSeverity: index === 1 ? 'critical' : 'warning',
    relationCount: 1, impactScope: options.relations ? [] : [{ type: 'server', id: 11 }], gaps: [...(n ? ['OBSERVATIONS_STALE'] : []), ...(options.relations === 'failed' ? ['RELATIONS_UNAVAILABLE'] : [])],
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
    if (path === '/api/auth/permissions') body = options.permissions ?? ['*'];
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
    if (path === '/api/dashboard/capacity-trend') body = { current_total_gb: 2.71, trend: [{ time: new Date(Date.now() - 3600_000).toISOString(), total_size_gb: 2.4, instance_count: 2 }, { time: now, total_size_gb: 2.71, instance_count: 2 }] };
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
      await expect(view.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(view.locator('stat-card')).toHaveCount(4);
      await expect(view.locator('.risk-row').first()).toBeVisible();
      if (viewport.width >= 1280) {
        const tops = await view.locator('stat-card').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
        expect(new Set(tops).size).toBe(1);
        const heights = await view.locator('stat-card').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
        for (const height of heights) { expect(height).toBeGreaterThanOrEqual(88); expect(height).toBeLessThanOrEqual(104); }
        if (name === '综合态势') { const first = (await view.locator('.risk-row').first().boundingBox())!; expect(first.y + first.height).toBeLessThan(viewport.height); }
        if (viewport.width === 1440 && name === '综合态势') {
          const last = (await view.locator('.risk-row').nth(4).boundingBox())!; expect(last.y + last.height).toBeLessThan(900);
          const quality = (await view.locator('.collection-summary').boundingBox())!; expect(quality.y + quality.height).toBeLessThan(900);
        }
      }
      if (name !== '综合态势') await expect(view.getByRole('combobox', { name: '指标', exact: true })).toHaveValue(name === '网络设备' ? 'device_cpu_percent' : 'cpu_usage');
      if (name === '服务器') { await expect(view).not.toContainText('Orders MySQL'); await expect(view).toContainText('Payments host'); }
      if (name === '网络设备') { await view.getByRole('button', { name: '读取最近备份' }).click(); await expect(view).toContainText('最近已保存备份 v2'); }
      if (name === '数据库') { await expect(view.locator('.trend-chart-container')).toBeVisible(); await expect(view.locator('.engine-pie')).toBeVisible(); }
      else await expect(view.locator('.trend-chart-container')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await view.evaluate((element: any) => { element.scrollingParent().scrollTop = 0; });
      await page.screenshot({ path: testInfo.outputPath(`overview-${name}-${viewport.width}.png`), fullPage: true, animations: 'disabled' });
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
  await page.screenshot({ path: testInfo.outputPath('overview-unmanaged.png'), fullPage: true, animations: 'disabled' });
  await view.getByRole('tab', { name: '服务器', exact: true }).click();
  await view.getByRole('searchbox').fill('no-match'); await expect(view.locator('app-empty-state')).toHaveAttribute('title', '当前筛选无结果');
  await view.getByRole('searchbox').fill('');
  control.fail(); await view.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(view.getByRole('alert')).toContainText('保留上次成功快照');
  await expect(view.locator('stat-card')).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath('overview-partial-failure.png'), fullPage: true, animations: 'disabled' });
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
    const ratios = await view.locator('.resource-name, .risk-observation time, .collection-summary h2, .collection-summary .metadata, stat-card .stat-card__hint, stat-card .stat-card__label, .risk-row app-badge').evaluateAll(elements => elements.map(element => {
      const luminance = (rgb: number[]) => rgb.map(value => { const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
      const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d')!;
      const color = (value: string) => { ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3); };
      const foreground = luminance(color(getComputedStyle(element).color));
      const ancestors: Element[] = []; let node: Element | null = element;
      while (node) { ancestors.unshift(node); node = node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null; }
      ctx.fillStyle = getComputedStyle(element).getPropertyValue('--card'); ctx.fillRect(0, 0, 1, 1);
      for (const ancestor of ancestors) { ctx.fillStyle = getComputedStyle(ancestor).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
      const background = luminance(Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3));
      return { text: (element as HTMLElement).innerText, ratio: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) };
    }));
    for (const result of ratios) expect(result.ratio, result.text ?? '').toBeGreaterThanOrEqual(4.5);
    for (const name of ['综合态势', '数据库', '服务器', '网络设备']) {
      await view.getByRole('tab', { name, exact: true }).click();
      await expect(view.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
      await page.screenshot({ path: testInfo.outputPath(`overview-theme-${mode}-${name}.png`), fullPage: true, animations: 'disabled' });
    }
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

for (const relations of ['empty', 'failed'] as const) {
  test(`risk selection distinguishes ${relations} relations and clears on filter`, async ({ page }) => {
    const control = await fixture(page, { relations }); await page.goto('/dashboard');
    const view = page.locator('dashboard-page'); const row = view.locator('.risk-row').first();
    await expect(view.locator('#risk-relations')).toContainText('选择风险');
    await row.getByRole('button', { name: /关联资源/ }).click();
    await expect(row).toHaveClass(/selected/);
    await expect(row.getByRole('button', { name: /关联资源/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(view.locator('.relation-source')).toHaveText(await row.locator('.resource-name').innerText());
    await expect(view.locator('#risk-relations')).toContainText(relations === 'empty' ? '未建立关系' : '关联信息不可用');
    await view.getByRole('searchbox').fill('Orders');
    await expect(view.locator('.risk-row.selected')).toHaveCount(0);
    await expect(view.locator('#risk-relations')).toContainText('选择风险');
    expect(control.posts()).toBe(0);
    await view.locator('stat-card').nth(2).click();
    await expect(view.locator('stat-card').nth(2)).toHaveAttribute('aria-pressed', 'true');
    await expect(view.locator('#resource-details')).toContainText('明细筛选');
    await view.getByRole('tab', { name: '数据库', exact: true }).click();
    await view.getByRole('combobox', { name: '数据库引擎', exact: true }).selectOption('mysql');
    await expect(page).toHaveURL(/engine=mysql/);
    expect(control.posts()).toBe(0);
  });
}

test('long risk names wrap without hiding actions', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await fixture(page, { longName: true }); await page.goto('/dashboard');
  const rows = page.locator('dashboard-page .risk-row'); await expect(rows).toHaveCount(5);
  for (const row of await rows.all()) {
    await expect(row.getByRole('link', { name: '查看证据', exact: true })).toBeVisible();
    await expect(row.getByRole('link', { name: '只读诊断', exact: true })).toBeVisible();
    expect(await row.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  }
});

for (const permissions of [['network_devices:view'], ['network_devices:view', 'network_devices:manage'], ['instance:view']]) {
  test(`network empty state respects permissions ${permissions.join(',')}`, async ({ page }) => {
    await fixture(page, { emptyNetwork: true, permissions }); await page.goto('/dashboard?scope=network_device');
    const view = page.locator('dashboard-page');
    await expect(view.locator('app-empty-state')).toHaveAttribute('title', permissions.includes('network_devices:view') ? '尚未纳管 网络设备' : '当前账号无此类资源查看权限');
    const action = view.getByRole('link', { name: '纳管资源', exact: true });
    await expect(action).toHaveCount(permissions.includes('network_devices:manage') ? 1 : 0);
    if (permissions.includes('network_devices:manage')) expect((await action.boundingBox())!.width).toBeLessThan(200);
    await expect(view.locator('stat-card')).toHaveCount(0);
  });
}

test('database pie and total trend follow the filtered inventory', async ({ page }) => {
  await fixture(page); await page.goto('/dashboard?scope=instance');
  const view = page.locator('dashboard-page');
  await expect(view.locator('.engine-pie')).toHaveAttribute('aria-label', 'mysql: 2 (100%)');
  await expect(view.getByRole('combobox', { name: '统计范围', exact: true })).toHaveValue('');
  await expect(view.locator('.trend-chart-container svg')).toBeVisible();
  const width = await view.locator('.trend-chart-container svg').evaluate(node => node.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(200);
  await view.getByRole('searchbox').fill('10.0.0.1');
  await view.getByRole('searchbox').fill('Orders MySQL secondary');
  await expect(view.locator('.engine-pie')).toHaveAttribute('aria-label', 'mysql: 1 (100%)');
  // The selected single-instance mode remains available alongside the default total.
  const selected = page.waitForResponse(response => response.url().includes('capacity-trend') && response.url().includes('instance_id=2'));
  await view.getByRole('combobox', { name: '统计范围', exact: true }).selectOption('2'); await selected;
});
