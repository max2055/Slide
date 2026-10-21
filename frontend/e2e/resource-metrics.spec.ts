import { expect, test, type Page } from '@playwright/test';
import { collectionStatus } from '../src/app/ui/components/metric-test-fixtures.js';
const fixture = async (page: Page, tag: string, file: string) => {
  await page.route('**/resource-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${tag}<script type="module">import '/src/app/styles.css'; import '/src/app/ui/${file}.ts';</script></body></html>` }));
  await page.goto('/resource-fixture');
};
// Isolated response fixtures exercise layout and failure states; they are not live collection evidence.
const lists = [
  ['instances-page', 'instances-db', '/api/database/instances', 'instance', '实例', '版本'],
  ['servers-page', 'servers-page', '/api/servers', 'server', '主机名称', '系统版本'],
  ['network-devices-page', 'network-devices-page', '/api/network-devices', 'network_device', '设备', '型号'],
] as const;
const fixtureEntries = Array.from({ length: 25 }, (_, i) => ({
  id: 1001 + i, name: i === 0 ? '生产资源长名称用于检查截断及完整值'.repeat(4) : `资源-${i + 1}`,
  label: i === 0 ? '生产资源长名称用于检查截断及完整值'.repeat(4) : `资源-${i + 1}`,
  db_type: 'mysql', db_version: i === 1 ? null : '8.4.2', host: i === 0 ? 'very-long-address-for-resource-list-layout.example.internal' : `192.0.2.${i + 1}`, port: 3306,
  os_type: 'linux', os_version: i === 1 ? null : 'Ubuntu 24.04 LTS', model: i === 1 ? null : 'C9300-48T',
  status: 'online', health_status: 'healthy', hasCredential: true, username: 'readonly', snmp_port: 161, ssh_port: 22, vendor: 'cisco', site: '测试站点',
}));
async function listResponses(page: Page, restricted = false) {
  await page.addInitScript(restricted => { localStorage.setItem('permissions', JSON.stringify(restricted ? ['instance:view', 'servers:view', 'network_devices:view'] : ['*'])); }, restricted);
  await page.route('**/api/**', route => {
    const p = new URL(route.request().url()).pathname;
    if (!p.startsWith('/api/')) return route.fallback();
    if (lists.some(list => list[2] === p)) return route.fulfill({ json: fixtureEntries });
    if (p === '/api/resources/overview') return route.fulfill({ json: { items: lists.flatMap(list => fixtureEntries.map((entry, i) => ({
      resource: { type: list[3], id: entry.id }, status: 'healthy', gaps: [], unresolvedAlerts: 0, quality: 'good',
      freshness: i === 0 ? 'fresh' : i === 1 ? 'missing' : 'stale', observedAt: i === 1 ? null : new Date(Date.now() - (i === 0 ? 1000 : 600000)).toISOString(),
    }))) } });
    if (p === '/api/metrics/config/bulk') return route.fulfill({ json: { jobs: [] } });
    if (p.endsWith('/status')) {
      const status = collectionStatus();
      const id = Number(p.split('/').at(-2));
      status.collection.state = id === 1001 ? 'running' : id === 1002 ? 'failed' : 'succeeded';
      status.collection.in_flight = id === 1001;
      status.collection.last_success_at = '2026-10-20T03:04:05Z';
      status.collection.last_attempt_at = '2026-10-21T05:06:07Z';
      return route.fulfill({ json: status });
    }
    if (p === '/api/metrics/query') {
      const resource = route.request().postDataJSON().resource;
      const metric = { definition: { id: 'mysql.tables.estimated_allocated_bytes', unit: 'By', meaning: '隔离构造的表和索引分配空间' }, observed_at: '2026-10-20T03:00:00Z', state: resource.id === 1002 ? 'not_configured' : 'available', series: resource.id === 1002 ? [] : [{ dimensions: {}, buckets: [{ value: { encoding: 'uint64', value: resource.id === 1001 ? '8192' : '0' }, unit: 'By', coverage: 1, quality: { status: 'good' }, freshness: resource.id === 1003 ? 'stale' : 'fresh' }] }] };
      return route.fulfill({ json: { profile: { columns: resource.type === 'instance' ? [{ key: 'database_size', metric: { id: metric.definition.id } }] : [] }, window: { from: '2026-10-20T00:00:00Z', to: '2026-10-20T00:01:00Z' }, metrics: resource.type === 'instance' ? [metric] : [] } });
    }
    if (/\/api\/servers\/\d+$/.test(p)) return route.fulfill({ json: { ...fixtureEntries[0], credential_username: 'readonly' } });
    if (p.endsWith('/hosts')) return route.fulfill({ json: { hosts: [] } });
    if (p.endsWith('/access')) return route.fulfill({ json: { can_manage: !restricted } });
    return route.fulfill({ json: [] });
  });
}
async function keyboardFocus(page: Page, target: import('@playwright/test').Locator) {
  await target.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
  expect(await target.evaluate(el => el.matches(':focus-visible'))).toBe(true);
}
async function visibleFullValue(target: import('@playwright/test').Locator) {
  const tip = target.locator('.full-value');
  await expect(tip).toBeVisible();
  // Visibility alone misses overflow clipping. Hit-test the top and bottom of
  // the actual rendered surface in its ShadowRoot, including after scrolling.
  await expect.poll(() => tip.evaluate(el => {
    const r = el.getBoundingClientRect();
    const root = el.getRootNode() as ShadowRoot;
    return r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight &&
      [r.top + 2, r.bottom - 2].every(y => {
        const hit = root.elementFromPoint(r.left + r.width / 2, y);
        return hit === el || !!hit && el.contains(hit);
      });
  })).toBe(true);
  return tip;
}
for (const width of [375, 1440]) for (const theme of ['light', 'dark']) {
  test(`capacity help keyboard contrast ${width} ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await listResponses(page);
    await fixture(page, '<instances-page></instances-page>', 'views/instances-db');
    await page.evaluate(theme => {
      document.documentElement.dataset.themeMode = theme;
      document.documentElement.style.setProperty('--accent', '#265f99');
    }, theme);
    const table = page.locator('resource-metrics-table');
    const help = table.getByRole('button', { name: '数据量说明', exact: true });
    await keyboardFocus(page, help);
    const measurement = await help.evaluate(el => {
      const luminance = (rgb: string) => rgb.match(/[\d.]+/g)!.slice(0, 3).map(Number)
        .map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
        .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      let node: Element | null = el, background = '';
      while (node) {
        background = getComputedStyle(node).backgroundColor;
        if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') break;
        node = node.parentElement ?? (node.getRootNode() as ShadowRoot).host;
      }
      const style = getComputedStyle(el), a = luminance(style.outlineColor), b = luminance(background);
      return { outline: style.outline, background, width: parseFloat(style.outlineWidth), contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    });
    await info.attach('actual-keyboard-contrast', { body: JSON.stringify(measurement), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('capacity-help-focus.png'), fullPage: true });
    expect(measurement.width).toBeGreaterThanOrEqual(2);
    expect(measurement.contrast).toBeGreaterThanOrEqual(3);
    await page.keyboard.press('Enter');
    await expect(table.getByRole('dialog', { name: '数据库大小：支持范围与统计口径' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(help).toBeFocused();
  });
  test(`full text keyboard clipping ${width} ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await listResponses(page);
    // Explicitly constructed 239-character value; no production asset is edited.
    const long = '首末行可视全文检查'.repeat(26) + '完整值结尾';
    await page.route('**/api/servers', route => route.fulfill({ json: fixtureEntries.slice(0, 3).map(e => ({ ...e, label: long })) }));
    await fixture(page, '<servers-page></servers-page>', 'views/servers-page');
    await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; }, theme);
    const table = page.locator('resource-metrics-table');
    await expect(table.locator('tbody tr')).toHaveCount(3);
    for (const index of [0, 2]) {
      const row = table.locator('tbody tr').nth(index);
      const name = row.locator('.resource-name');
      await keyboardFocus(page, name.locator('button'));
      const tip = await visibleFullValue(name);
      await expect(tip).toHaveText(long);
      await page.screenshot({ path: info.outputPath(`full-name-row-${index}.png`), fullPage: true });
      await page.keyboard.press('Escape');
      await expect(tip).toBeHidden();
      await expect(name.locator('button')).toBeFocused();
      // Read a different column after horizontal keyboard scrolling.
      const region = table.getByRole('region', { name: '资源表格，可横向滚动' });
      await region.focus(); await page.keyboard.press('ArrowRight');
      const value = row.locator('td').nth(3).locator('.cell-value');
      await keyboardFocus(page, value);
      const addressTip = await visibleFullValue(value);
      await page.screenshot({ path: info.outputPath(`full-address-row-${index}.png`), fullPage: true });
      await page.keyboard.press('Escape');
      await expect(addressTip).toBeHidden(); await expect(value).toBeFocused();
    }
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const lastName = table.locator('tbody tr').last().locator('.resource-name');
    const toolbarButton = table.locator('.bulk-tools button').first();
    await keyboardFocus(page, toolbarButton);
    await lastName.locator('button').hover();
    const hovered = await visibleFullValue(lastName);
    await hovered.hover(); await expect(hovered).toBeVisible();
    await page.keyboard.press('Escape'); await expect(hovered).toBeHidden();
    await expect(toolbarButton).toBeFocused();
    await page.mouse.move(1, 1); await lastName.locator('button').hover();
    await visibleFullValue(lastName);
    await page.mouse.move(1, 1); await expect(hovered).toBeHidden();
    await keyboardFocus(page, lastName.locator('button'));
    await visibleFullValue(lastName);
    // Disconnecting an open native popover must not leave an orphan or throw.
    await table.evaluate(el => el.remove());
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const width of [375, 768, 1440]) for (const theme of ['light', 'dark']) test(`three lists ${width} ${theme}`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); await page.setViewportSize({ width, height: 1000 });
  await listResponses(page);
  for (const [tag, file, , type, identity, version] of lists) {
    await fixture(page, `<${tag}></${tag}>`, `views/${file}`);
    await page.evaluate(t => { document.documentElement.dataset.themeMode = t; }, theme);
    const table = page.locator('resource-metrics-table');
    const grid = table.locator('app-data-table');
    await expect(grid.locator('tbody tr')).toHaveCount(20);
    await expect(grid.locator('th')).toHaveText(['选择', '序号', identity, '地址', version, ...(type === 'instance' ? ['数据量 ⓘ'] : []), '观测健康', '采集状态', '最近采集时间', '操作']);
    await expect(grid.locator('tbody tr').first().locator('.actions button')).toHaveText(['详情', '编辑', '测试', '删除']);
    await expect(table.locator('.actions details, .mobile-resources')).toHaveCount(0);
    await expect(grid.locator('tbody tr').first().locator('td').nth(type === 'instance' ? 7 : 6)).toContainText('采集中');
    await expect(grid.locator('tbody tr').nth(1).locator('td').nth(type === 'instance' ? 7 : 6)).toContainText('失败');
    await expect(grid.locator('tbody tr').nth(1).locator('td').nth(4)).toContainText('未知');
    await expect(grid.locator('tbody tr').nth(2).locator('td').nth(type === 'instance' ? 6 : 5)).toContainText('已过期');
    await expect(grid.locator('tbody tr').first().locator('time:not(.size-observed)')).toHaveAttribute('datetime', '2026-10-20T03:04:05Z');
    if (type === 'instance') {
      await expect(grid.locator('tbody tr').first().locator('td').nth(5)).toContainText('8.00 KiB');
      await expect(grid.locator('tbody tr').nth(2).locator('td').nth(5)).toContainText('0 B · 已过期');
    }
    const sizes = await grid.locator('tbody tr').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    const ys = await grid.locator('tbody tr').first().locator('.actions button').evaluateAll(buttons => buttons.map(b => b.getBoundingClientRect().y));
    expect(new Set(ys).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${file}-${width}-${theme}-isolated.png`), fullPage: true });
    const scroll = table.getByRole('region', { name: '资源表格，可横向滚动' });
    await scroll.focus(); await page.keyboard.press('ArrowRight');
    if (width < 1440) await expect.poll(() => scroll.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    // Full text is available on focus, and long strings do not increase row height.
    const address = grid.locator('tbody tr').first().locator('td').nth(3).locator('.cell-value');
    await address.focus(); await expect(address.locator('.full-value')).toBeVisible();
    await expect(address).toHaveAttribute('aria-label', new RegExp(fixtureEntries[0].host));
    await grid.locator('tbody tr').first().getByRole('checkbox').check();
    await expect(table.locator('.bulk-tools')).toContainText('已选 1 个对象');
    await table.getByRole('button', { name: '批量绑定采集模板', exact: true }).click();
    await expect(table.getByRole('dialog', { name: '批量绑定采集模板', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await table.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(grid.locator('tbody tr').first().locator('td').nth(1)).toHaveText('21');
    await expect(table.locator('.bulk-tools')).toContainText('已选 1 个对象');
    const search = page.locator('input.search-input, input.resource-search-input');
    await expect(search).toHaveAccessibleName(/搜索/);
    await search.fill('资源-25');
    await expect(grid.locator('tbody tr')).toHaveCount(1);
    await expect(grid.locator('tbody tr').first().locator('td').nth(1)).toHaveText('1');
    await search.fill('没有这条资源'); await expect(grid).toContainText('没有符合条件的资源');
    await search.fill('');
    await table.getByRole('button', { name: '清空选择', exact: true }).click();
    await page.locator(tag).locator('.resource-toolbar').getByRole('button', { name: '列设置', exact: true }).click();
    const dialog = table.locator('app-dialog').filter({ has: page.getByRole('dialog', { name: '列设置' }) });
    await expect(dialog.getByRole('dialog', { name: '列设置' })).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: /序号|地址|版本|型号|观测健康|采集状态|最近采集时间/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(tag).locator('.resource-toolbar').getByRole('button', { name: '列设置', exact: true })).toBeFocused();
  }
  expect(errors).toEqual([]);
});

for (const [tag, file, , type] of lists) test(`${type} four direct actions and permission states`, async ({ page }, info) => {
  await listResponses(page);
  const writes: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET') writes.push(new URL(request.url()).pathname); });
  await fixture(page, `<${tag}></${tag}><app-toast-container></app-toast-container>`, `views/${file}`);
  await page.evaluate(() => { (window as any).navigationEvents = []; window.addEventListener('slide-navigate', (event: any) => (window as any).navigationEvents.push(event.detail)); });
  const table = page.locator('resource-metrics-table');
  const actions = () => table.locator('tbody tr').first().locator('.actions');
  await actions().getByRole('button', { name: '详情', exact: true }).click();
  const navigation = await page.evaluate(() => (window as any).navigationEvents.at(-1));
  expect(navigation[type === 'network_device' ? 'networkDeviceId' : type === 'server' ? 'serverId' : 'id']).toBe(1001);
  await actions().getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByRole('heading', { name: type === 'instance' ? '编辑资源' : type === 'server' ? '编辑服务器' : '编辑网络设备', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回资源列表', exact: true }).click();
  await expect(actions().getByRole('button', { name: '编辑', exact: true })).toBeFocused();
  await actions().getByRole('button', { name: '删除', exact: true }).click();
  const dialog = page.locator('app-dialog').filter({ has: page.getByRole('dialog', { name: /确认删除/ }) });
  await expect(dialog).toContainText(type === 'server' ? fixtureEntries[0].host : fixtureEntries[0].name);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(actions().getByRole('button', { name: '删除', exact: true })).toBeFocused();
  const probe = type === 'instance' ? '/api/database/instances/test-connection' : type === 'server' ? '/api/servers/1001/collect' : '/api/network-devices/1001/probe';
  await page.route(`**${probe}`, route => route.fulfill({ status: 503, json: { success: false, error: '隔离测试：目标暂不可达' } }));
  await actions().getByRole('button', { name: '测试', exact: true }).click();
  if (type === 'instance') {
    const testDialog = page.locator('app-dialog').filter({ has: page.getByRole('dialog', { name: /测试连接/ }) });
    await testDialog.getByLabel('密码', { exact: true }).fill('isolated-test-password');
    await testDialog.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(testDialog).toContainText('隔离测试：目标暂不可达');
    await page.keyboard.press('Escape');
    await expect(actions().getByRole('button', { name: '测试', exact: true })).toBeFocused();
  } else await expect(page.locator('app-toast-container')).toContainText('隔离测试：目标暂不可达');
  expect(writes.filter(path => !path.endsWith('/query'))).toEqual([probe]);
  await page.evaluate(() => { localStorage.setItem('permissions', JSON.stringify(['instance:view', 'servers:view', 'network_devices:view'])); window.dispatchEvent(new Event('slide-permissions-loaded')); });
  await expect(actions().getByRole('button', { name: '编辑', exact: true })).toBeDisabled();
  await expect(actions().getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  await expect(actions().getByRole('button', { name: '测试', exact: true })).toBeEnabled({ enabled: type === 'network_device' });
  await expect(actions().getByRole('button', { name: '详情', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath(`${file}-restricted-isolated.png`), fullPage: true });
});
test('preview, failed and empty trials, invalidation, publish and application', async ({ page }) => {
  let published = false, applied = false, succeed = false, hasSamples = false; const writes: string[] = []; const pack = { id: 'mysql-basic', version: '1.0.0', digest: 'pin', resource_type: 'instance' }; const resolved = { settings: {}, sources: {}, metric_templates: [], metric_sources: {} };
  await page.route('**/api/**', route => {
    const p = new URL(route.request().url()).pathname; if (!p.startsWith('/api/')) return route.fallback();
    if (p.endsWith('/catalog')) return route.fulfill({ json: { packages: [{ package: pack, recommendations: {}, documentation: [] }], metrics: [] } });
    if (p.endsWith('/recommendations')) return route.fulfill({ json: { packages: [{ release: { package: pack }, compatibility: 'compatible', recommended: true, checks: [], coverage: [], missing_core_metrics: [] }] } });
    if (p.endsWith('/groups')) return route.fulfill({ json: { groups: [] } });
    if (p === '/api/metrics/config/bulk') return route.fulfill({ json: { jobs: [] } });
    if (p.endsWith('/status')) {
      const status = collectionStatus(published ? 'bound' : 'unbound');
      status.binding.application = applied ? 'applied' : 'pending'; status.binding.applied_revision = applied ? 1 : null;
      status.formal_visibility.state = applied ? 'available' : 'pending';
      return route.fulfill({ json: status });
    }
    if (p.endsWith('/access')) return route.fulfill({ json: { can_manage: true } });
    if (p.endsWith('/attempts')) return route.fulfill({ json: [] });
    if (p.endsWith('/effective')) return route.fulfill({ json: { resolved } });
    if (p.endsWith('/preview')) return route.fulfill({ json: { affected_resources: 1, resources: [{ resolved }] } });
    if (p.endsWith('/trial')) return route.fulfill({ json: { decision: 'attempted', attempts: [{ status: succeed ? 'succeeded' : 'failed' }], samples: hasSamples ? [{ metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, unit: 's', value: { encoding: 'float64', value: 60 }, quality: { status: 'good' } }] : [] } });
    if (p.endsWith('/activate')) { writes.push(p); published = true; return route.fulfill({ json: {} }); }
    return route.fulfill({ status: published ? 200 : 404, json: published ? { binding: { package: pack, revision: 1, group_id: null, overrides: {} }, application: { status: applied ? 'applied' : 'pending', applied_revision: applied ? 1 : null } } : { error: 'POLICY_NOT_FOUND' } });
  });
  await page.setViewportSize({ width: 375, height: 900 }); await fixture(page, '<metric-configuration resourceid="1"></metric-configuration>', 'components/metric-configuration');
  await page.getByRole('button', { name: '检查并启用', exact: true }).click();
  const preview = page.getByRole('button', { name: '预检与影响预览' }), trial = page.getByRole('button', { name: '试采', exact: true }), publish = page.getByRole('button', { name: '发布', exact: true });
  await preview.click(); await trial.click(); await expect(publish).toBeDisabled();
  succeed = true;
  await trial.click();
  await expect(page.getByText('试采未返回样本，不能发布。请检查指标是否启用并重新试采。', { exact: true })).toBeVisible();
  await expect(publish).toBeDisabled();
  expect(writes).toHaveLength(0);
  hasSamples = true;
  await trial.click(); await expect(publish).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.getByRole('switch', { name: '启用此对象采集' }).check();
  await page.getByRole('button', { name: '检查并启用', exact: true }).click();
  await expect(trial).toBeDisabled(); await expect(publish).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('switch', { name: '启用此对象采集' }).uncheck();
  await page.getByRole('button', { name: '检查并启用', exact: true }).click();
  await preview.click(); await trial.click(); await publish.click(); await expect(page.locator('.state-card .collection-facts')).toContainText('发布 1'); await expect(page.locator('.state-card .collection-facts')).toContainText('等待应用'); expect(writes).toHaveLength(1); applied = true; await page.keyboard.press('Escape'); await page.getByText('最近正式采集尝试与技术证据', { exact: true }).click(); await page.getByRole('button', { name: '重新加载', exact: true }).click(); await expect(page.locator('.state-card .collection-facts')).toContainText('应用 1'); await expect(page.locator('.state-card .collection-facts')).toContainText('已应用'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('empty resources and named resource selector', async ({ page }) => {
  await page.route('**/api/**', route => { const p = new URL(route.request().url()).pathname; if (!p.startsWith('/api/')) return route.fallback(); return route.fulfill({ json: p.endsWith('/catalog') ? { packages: [], metrics: [] } : p === '/api/resources' ? { items: [{ resource: { type: 'instance', id: 1 }, label: '订单数据库' }] } : [] }); });
  await fixture(page, '<network-devices-page></network-devices-page>', 'views/network-devices-page'); await expect(page.getByText('暂无网络设备', { exact: true })).toBeVisible();
  await fixture(page, '<metric-settings view="policies"></metric-settings>', 'views/metric-settings'); await expect(page.getByLabel('资源', { exact: true }).locator('option')).toHaveText(['请选择资源', '订单数据库 · 数据库实例']); await expect(page.getByLabel('资源 ID')).toHaveCount(0);
});
