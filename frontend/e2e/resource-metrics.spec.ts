import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { TemplateBindingRequest, TemplateBindingStatus, TemplatePreview, TemplateTrial } from '../src/app/ui/components/metric-api.js';
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
const listViewPermissions = ['instance:view', 'servers:view', 'network_devices:view'];
async function listResponses(page: Page, restricted = false) {
  const permissions = restricted ? listViewPermissions : ['*'];
  await page.addInitScript(permissions => {
    localStorage.setItem('token', 'fixture.' + btoa(JSON.stringify({ userId: 1, sessionVersion: 1 })) + '.fixture');
    localStorage.setItem('permissions', JSON.stringify(permissions));
  }, permissions);
  await page.route('**/api/**', route => {
    const p = new URL(route.request().url()).pathname;
    if (!p.startsWith('/api/')) return route.fallback();
    if (p === '/api/auth/permissions') return route.fulfill({ json: permissions });
    if (lists.some(list => list[2] === p)) return route.fulfill({ json: fixtureEntries });
    if (p === '/api/metrics/templates') return route.fulfill({ json: { templates: [], next_cursor: null } });
    if (p === '/api/metrics/template-governance/resources') return route.fulfill({ json: [] });
    if (p === '/api/resources/overview') return route.fulfill({ json: { items: lists.flatMap(list => fixtureEntries.map((entry, i) => ({
      resource: { type: list[3], id: entry.id }, status: 'healthy', gaps: [], unresolvedAlerts: 0, quality: 'good',
      freshness: i === 0 ? 'fresh' : i === 1 ? 'missing' : 'stale', observedAt: i === 1 ? null : new Date(Date.now() - (i === 0 ? 1000 : 600000)).toISOString(),
    }))) } });
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
for (const width of [375, 768, 1440]) for (const theme of ['light', 'dark']) {
  test(`capacity help keyboard contrast ${width} ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await listResponses(page);
    await fixture(page, '<instances-page></instances-page>', 'views/instances-db');
    await page.evaluate(theme => {
      document.documentElement.dataset.themeMode = theme;
      document.documentElement.style.setProperty('--accent', '#265f99');
    }, theme);
    const table = page.locator('resource-metrics-table');
    await page.getByRole('button', { name: '列设置', exact: true }).click();
    await table.getByRole('checkbox', { name: '数据库大小', exact: true }).check();
    await table.getByRole('button', { name: '完成', exact: true }).click();
    const help = table.getByRole('button', { name: '数据库大小说明', exact: true });
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
    if (width === 1440) {
      await page.getByRole('button', { name: '列设置', exact: true }).click();
      const columns = table.locator('app-dialog[title="列设置"]');
      await expect(columns.getByRole('dialog', { name: '列设置', exact: true })).toBeVisible();
      for (const option of await columns.getByRole('checkbox').all()) await option.check();
      await columns.getByRole('button', { name: '完成', exact: true }).click();
    }
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
      // A stationary pointer can cross another cell as focus scrolls the table.
      // Keyboard reading retains priority over unrelated hover previews.
      await row.locator('td').nth(5).locator('.cell-value').hover();
      await expect(addressTip).toBeVisible();
      if (width < 1440) {
        // A pending keyboard scroll can finish after focus enters the cell.
        await region.evaluate(el => { el.scrollTo({ left: el.scrollWidth, behavior: 'instant' }); });
        await expect.poll(() => region.evaluate(el => el.scrollLeft)).toBeGreaterThan(100);
        await visibleFullValue(value);
        await expect.poll(() => addressTip.evaluate(el => {
          const gap = parseFloat(getComputedStyle(el).paddingTop);
          const anchor = el.parentElement!.getBoundingClientRect(), r = el.getBoundingClientRect();
          return Math.abs(r.left - Math.max(gap, Math.min(anchor.left, innerWidth - r.width - gap)));
        })).toBeLessThanOrEqual(1);
      }
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
    const hoverBounds = await hovered.boundingBox();
    const nameBounds = await lastName.locator('button').boundingBox();
    await page.mouse.move(nameBounds!.x + nameBounds!.width / 2, hoverBounds!.y + 3, { steps: 20 });
    await expect(hovered).toBeVisible();
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
    await expect(grid.locator('th')).toHaveText(['选择', '序号', identity, '地址', version, '观测健康', '采集状态', '最近成功采集', '操作']);
    await expect(grid.locator('tbody tr').first().locator('.actions button')).toHaveText(['详情', '编辑', '测试', '删除']);
    await expect(table.locator('.actions details, .mobile-resources')).toHaveCount(0);
    await expect(grid.locator('tbody tr').first().locator('td').nth(6)).toContainText('采集中');
    await expect(grid.locator('tbody tr').nth(1).locator('td').nth(6)).toContainText('失败');
    await expect(grid.locator('tbody tr').nth(1).locator('td').nth(4)).toContainText('未知');
    await expect(grid.locator('tbody tr').nth(2).locator('td').nth(5)).toContainText('已过期');
    await expect(grid.locator('tbody tr').first().locator('time:not(.size-observed)')).toHaveAttribute('datetime', '2026-10-20T03:04:05Z');
    if (type === 'instance') {
      await page.getByRole('button', { name: '列设置', exact: true }).click();
      const sizeColumn = table.getByRole('checkbox', { name: '数据库大小', exact: true });
      await expect(sizeColumn).not.toBeChecked();
      await sizeColumn.check();
      await table.getByRole('button', { name: '完成', exact: true }).click();
      await expect(grid.locator('th')).toHaveCount(10);
      await expect(grid.locator('tbody tr').first().locator('td').nth(9)).toContainText('8.00 KiB');
      await expect(grid.locator('tbody tr').nth(2).locator('td').nth(9)).toContainText('0 B · 已过期');
    }
    const sizes = await grid.locator('tbody tr').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    const ys = await grid.locator('tbody tr').first().locator('.actions button').evaluateAll(buttons => buttons.map(b => b.getBoundingClientRect().y));
    expect(new Set(ys).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${file}-${width}-${theme}-isolated.png`), fullPage: true });
    const scroll = table.getByRole('region', { name: /^资源表格/ });
    await scroll.focus(); await page.keyboard.press('ArrowRight');
    if (width < 1440) await expect.poll(() => scroll.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    // Full text is available on focus, and long strings do not increase row height.
    const address = grid.locator('tbody tr').first().locator('td').nth(3).locator('.cell-value');
    await address.focus(); await expect(address.locator('.full-value')).toBeVisible();
    await expect(address).toHaveAttribute('aria-label', new RegExp(fixtureEntries[0].host));
    await grid.locator('tbody tr').first().getByRole('checkbox').check();
    await expect(table.locator('.bulk-tools')).toContainText('已选 1 个对象');
    await table.getByRole('button', { name: '批量绑定采集模板', exact: true }).click();
    const binding = table.getByRole('dialog', { name: '批量绑定监控模板', exact: true });
    await expect(binding).toBeVisible();
    await expect(table.locator('template-governance').getByRole('combobox', { name: '治理模板' })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(binding).toHaveCount(0);
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
  await expect(page.getByRole('heading', { name: type === 'instance' ? '编辑数据库实例' : type === 'server' ? '编辑服务器' : '编辑网络设备', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回资源列表', exact: true }).click();
  await expect(actions().getByRole('button', { name: '编辑', exact: true })).toBeFocused();
  await actions().getByRole('button', { name: '删除', exact: true }).click();
  const dialog = page.locator('app-dialog').filter({ has: page.getByRole('dialog', { name: /确认删除/ }) });
  await expect(dialog).toContainText(type === 'server' ? fixtureEntries[0].host : fixtureEntries[0].name);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(actions().getByRole('button', { name: '删除', exact: true })).toBeFocused();
  const probe = type === 'instance' ? '/api/database/instances/1001/test-connection' : type === 'server' ? '/api/servers/1001/collect-diagnostics' : '/api/network-devices/1001/probe';
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
  await page.route('**/api/auth/permissions', route => route.fulfill({ json: listViewPermissions }));
  await page.evaluate(permissions => {
    localStorage.setItem('permissions', JSON.stringify(permissions));
    window.dispatchEvent(new Event('slide-permissions-loaded'));
  }, listViewPermissions);
  await expect(actions().getByRole('button', { name: '编辑', exact: true })).toBeDisabled();
  await expect(actions().getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  await expect(actions().getByRole('button', { name: '测试', exact: true })).toBeEnabled({ enabled: type === 'network_device' });
  await expect(actions().getByRole('button', { name: '详情', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath(`${file}-restricted-isolated.png`), fullPage: true });
});
test('preview, failed and empty trials, invalidation, publish and application', async ({ page }) => {
  const at = '2026-11-21T00:00:00.000Z';
  const expires = '2026-11-21T00:10:00.000Z';
  const hash = (digit: string) => 'sha256:' + digit.repeat(64);
  const templateName = 'MySQL 基础监控';
  const pin = { template_id: 'tpl-mysql', version: 1, content_hash: hash('b') };
  const resource = { type: 'instance', id: 1 };
  const release = { id: 'mysql-basic', version: '1.0.0', digest: hash('c') };
  const releaseRef = release.id + '@' + release.version + '#' + release.digest;
  const itemRef = { template_id: pin.template_id, item_id: 'uptime', item_version: 1 };
  const metric = { id: 'db.uptime_seconds', semantic_version: '1.0.0' };
  const settings = { enabled: true, interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000,
    max_counter_gap_ms: 300000, max_rows: 100, max_concurrency: 1, max_series_per_resource: 100 };
  const unbound: TemplateBindingStatus = { source: 'unbound', revision: null, application: null, template_pins: [],
    pending: null, configuration: null, effective: null, published_at: null };
  const preview: TemplatePreview = {
    template: true, resource, revision: 0, resolution_identity: hash('a'), executable: true, settings,
    parameters: [], releases: [{ release, release_ref: releaseRef, interval_ms: 60000, timeout_ms: 5000,
      collector_ids: ['mysql-status'], metric_keys: ['db.uptime_seconds@1.0.0'], requests_per_hour_estimate: 60, applicability: [] }],
    items: [{ ...itemRef, canonical_metric: metric, unit: 's', dimensions: {}, release, release_ref: releaseRef,
      collector_id: 'mysql-status', implementation_id: 'builtin:mysql.status', enabled: true, decision: 'collect', capability: 'supported' }],
    excluded: [], budget: { estimated_series_upper_bound: 1, max_series_per_resource: 100, requests_per_hour_estimate: 60 }, plan: {},
  };
  let outcome: 'failed' | 'empty' | 'sampled' = 'failed';
  let applied = false;
  let hasFormalSample = false;
  type ApplyRequest = TemplateBindingRequest & { receipt_id: string; caller_key: string };
  const checks: Array<{ action: string; body: TemplateBindingRequest }> = [];
  const receipts: string[] = [];
  const writes: ApplyRequest[] = [];
  const bindingPath = '/api/metrics/template-bindings/instance/1';

  await page.addInitScript(() => {
    localStorage.setItem('token', 'fixture.' + btoa(JSON.stringify({ userId: 1, sessionVersion: 1 })) + '.fixture');
  });
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    if (path.endsWith('/groups')) return route.fulfill({ json: { groups: [] } });
    if (path.endsWith('/recommendations')) return route.fulfill({ json: { resource, evaluated_at: at, packages: [] } });
    if (path === '/api/metrics/templates') return route.fulfill({ json: { next_cursor: null, templates: [{
      template_id: pin.template_id, name: templateName, status: 'active', current_published_version: pin.version,
      versions: [{ version: pin.version, content_hash: pin.content_hash, status: 'published' }],
    }] } });
    if (path === '/api/metrics/templates/' + pin.template_id + '/versions/' + pin.version) return route.fulfill({ json: {
      ...pin, status: 'published', published_at: at, parameters: { schema: {}, defaults: {} }, source_chain: {},
      items: [{ item_id: itemRef.item_id, version: 1, display_name: '运行时长', canonical_metric: metric, unit: 's', dimensions: {},
        collector_ref: { package_release: releaseRef, implementation_id: 'builtin:mysql.status' } }],
    } });
    if (path === bindingPath) {
      const committed = writes.at(-1);
      if (!committed) return route.fulfill({ json: unbound });
      const binding: TemplateBindingStatus = {
        source: 'template', revision: 1, template_pins: [pin], published_at: at,
        configuration: { group_id: null, overrides: committed.overrides ?? {} },
        application: { status: applied ? 'applied' : 'pending', applied_revision: applied ? 1 : null,
          reported_at: applied ? at : null, error_code: null },
        pending: { base_revision: 0, target_revision: 1, resolution_identity: hash('a'), decided_at: at,
          operation_key: committed.caller_key, plan: { settings, parameters: [], releases: [], excluded: [] } },
        effective: applied ? { revision: 1, resolution_identity: hash('a') } : null,
      };
      return route.fulfill({ json: binding });
    }
    if (path.endsWith('/status')) {
      const status = collectionStatus(writes.length ? 'bound' : 'unbound');
      if (writes.length) {
        status.binding = { ...status.binding, package: null, application: applied ? 'applied' : 'pending', applied_revision: applied ? 1 : null };
        status.formal_visibility = { state: hasFormalSample ? 'available' : applied ? 'waiting_sample' : 'pending',
          source: hasFormalSample ? 'semantic' : 'none', last_observed_at: hasFormalSample ? at : null, generation: hasFormalSample ? 1 : null };
      }
      return route.fulfill({ json: status });
    }
    if (path === bindingPath + '/probe' || path === bindingPath + '/preview') {
      const action = path.endsWith('/probe') ? 'probe' : 'preview';
      checks.push({ action, body: request.postDataJSON() });
      return route.fulfill({ json: action === 'preview' ? preview : { template: true, resource, revision: 0,
        probed_at: at, expires_at: expires, capabilities: [{ resource_id: '1', metric, status: 'supported', method: 'sql',
          basis: [{ kind: 'method', evidence: 'mysql-status' }], evaluated_at: at, valid_until: expires }] } });
    }
    if (path === bindingPath + '/trial') {
      const { receipt_id } = request.postDataJSON() as { receipt_id: string };
      receipts.push(receipt_id);
      const passed = outcome !== 'failed';
      const trial: TemplateTrial = {
        trial: true, persisted: false, decision: 'attempted', receipt_id, expires_at: expires, resolution_identity: hash('a'),
        items: [{ ...itemRef, phases: { read: passed, transform: passed, unit: passed } }], optional_exclusions: [],
        samples: outcome === 'sampled' ? [{ ...itemRef, metric, value: 60, unit: 's', observed_at: at, quality: { status: 'good' },
          read: { collector_id: 'mysql-status', attempt_ids: ['trial-attempt'], status: 'succeeded' }, transform: { version: '1' },
          unit_check: { input_unit: 's', output_unit: 's' } }] : [],
        attempts: [{ collector_id: 'mysql-status', status: passed ? 'succeeded' : 'failed', ...(!passed && { error: '目标采集失败' }) }],
        releases: [{ release_ref: releaseRef, decision: 'attempted' }],
      };
      return route.fulfill({ json: trial });
    }
    if (path === bindingPath + '/apply') {
      const body = request.postDataJSON() as ApplyRequest;
      writes.push(body);
      return route.fulfill({ json: { kind: 'committed', revision: 1, resolution_identity: hash('a'),
        operation: { key: 'apply-operation', caller_key: body.caller_key, receipt_id: body.receipt_id, status: 'committed' } } });
    }
    return route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page, '<metric-configuration resourceid="1"></metric-configuration>', 'components/metric-configuration');
  const check = page.getByRole('button', { name: '检查配置', exact: true });
  const trial = page.getByRole('button', { name: '试采', exact: true });
  const publish = page.getByRole('button', { name: '首次绑定并启用', exact: true });
  const stateFacts = page.locator('.state-card dl.facts');

  await page.getByRole('checkbox', { name: '选择模板 ' + templateName }).check();
  await expect(page.getByRole('combobox', { name: '模板版本 ' + templateName })).toHaveValue('1');
  await check.click();
  await expect(trial).toBeEnabled();
  const candidate = { expected_revision: 0, template_pins: [pin], overrides: {}, group_id: null };
  expect(checks).toEqual([{ action: 'probe', body: candidate }, { action: 'preview', body: candidate }]);
  await trial.click();
  await expect(page.getByRole('alert').filter({ hasText: '采集尝试错误' })).toContainText('目标采集失败');
  await expect(publish).toBeDisabled();

  outcome = 'empty';
  await trial.click();
  await expect(page.getByText('采集尝试错误', { exact: true })).toHaveCount(0);
  await expect(page.getByText('试采未满足启用门禁', { exact: false })).toBeVisible();
  await expect(page.getByText('本次返回 0 个样本', { exact: false })).toBeVisible();
  await expect(publish).toBeDisabled();
  expect(writes).toHaveLength(0);

  outcome = 'sampled';
  await trial.click();
  await expect(page.getByText('试采通过', { exact: true })).toBeVisible();
  await expect(publish).toBeEnabled();
  const enabled = page.getByRole('switch', { name: '启用此对象采集' });
  await enabled.uncheck();
  await expect(trial).toBeDisabled();
  await expect(publish).toBeDisabled();
  await enabled.check();
  await expect(trial).toBeDisabled();
  await expect(publish).toBeDisabled();
  expect(writes).toHaveLength(0);
  await check.click();
  await trial.click();
  await publish.click();
  await expect(page.getByText('配置已提交，目标版本 1', { exact: false })).toBeVisible();
  await expect(stateFacts.getByText('目标版本 1', { exact: false })).toBeVisible();
  await expect(stateFacts.getByText('尚未收到正式首样本', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(new Set(receipts).size).toBe(4);
  expect(writes[0]).toMatchObject({ ...candidate, overrides: { enabled: 'enable' }, receipt_id: receipts.at(-1), caller_key: expect.any(String) });

  applied = true;
  await page.getByRole('button', { name: '重新加载配置', exact: true }).click();
  await expect(stateFacts.getByText('无待应用版本', { exact: true })).toBeVisible();
  await expect(stateFacts.getByText('已应用 · 已应用 1', { exact: true })).toBeVisible();
  await expect(stateFacts.getByText('尚未收到正式首样本', { exact: true })).toBeVisible();
  await expect(stateFacts.getByText('待样本', { exact: true })).toBeVisible();
  hasFormalSample = true;
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect(stateFacts.getByText('正式可用 · 第 1 代', { exact: true })).toBeVisible();
  await expect(stateFacts.getByText('尚未收到正式首样本', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('shows an empty network device list', async ({ page }) => {
  await page.route('**/api/**', route => { const p = new URL(route.request().url()).pathname; if (!p.startsWith('/api/')) return route.fallback(); return route.fulfill({ json: p.endsWith('/catalog') ? { packages: [], metrics: [] } : p === '/api/resources' ? { items: [{ resource: { type: 'instance', id: 1 }, label: '订单数据库' }] } : [] }); });
  await fixture(page, '<network-devices-page></network-devices-page>', 'views/network-devices-page'); await expect(page.getByText('暂无网络设备', { exact: true })).toBeVisible();
});

for (const width of [1366, 1440, 1920]) test(`MAX-397 SNMP capacity guidance stays readable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1366 ? 768 : width === 1440 ? 900 : 1080 });
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    if (path.endsWith('/status')) return route.fulfill({ json: collectionStatus() });
    if (path.endsWith('/attempts')) return route.fulfill({ json: [{ status: 'failed', started_at: '2026-11-12T00:00:00Z', error: 'parse_error', evidence_code: 'SNMP_INTERFACE_CAPACITY_EXCEEDED' }] });
    return route.fulfill({ json: { profile: { columns: [] }, window: { from: '2026-11-12T00:00:00Z', to: '2026-11-12T01:00:00Z' }, metrics: [] } });
  });
  await fixture(page, '<semantic-metrics resourceid="1" resourcetype="network_device"></semantic-metrics>', 'components/semantic-metrics');
  const guidance = page.getByText('接口数量超过采集容量', { exact: false });
  await expect(guidance).toBeVisible();
  await expect(guidance).toContainText('max_rows');
  await expect(guidance).toContainText('max_series_per_resource');
  await expect(guidance).toContainText('100 行');
  expect(await guidance.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

const metricReadings = [
  { id: 'db.uptime_seconds', unit: 's', encoding: 'float64', value: 318711, reading: '3 天 16 小时' },
  { id: 'mysql.connections.limit', unit: 'count', encoding: 'uint64', value: '13', reading: '13 个连接' },
  { id: 'mysql.queries.per_second', unit: 'count/s', encoding: 'float64', value: 6.774611940888977, reading: '6.77 次/秒' },
  { id: 'mysql.tables.estimated_allocated_bytes', unit: 'By', encoding: 'uint64', value: '5638258688', reading: '5.25 GiB' },
];
const metricsFixture = (from: string, to: string) => metricReadings.map((item, index) => {
  const definition = { id: item.id, semantic_version: '1.0.0', category: 'canonical', meaning: item.id,
    unit: item.unit, kind: 'gauge', value_type: item.encoding };
  const point = {
    dimensions: { scope: 'primary' }, unit: item.unit, value: { encoding: item.encoding, value: item.value }, observed_at: from,
    quality: { status: 'good', reason: 'none' }, freshness: index === 1 ? 'stale' : 'fresh', accuracy: 'exact',
    sources: [{ source: { collector_id: 'controlled-fixture' } }],
  };
  const bucket = { ...point, coverage: 1, window: { from, to } };
  return { definition, point, bucket, state: index === 1 ? 'temporary_failure' : 'available' };
});

for (const [resourceType, width, height] of [['instance', 1366, 768], ['server', 1440, 900], ['network_device', 1920, 1080]] as const) {
  test(`metric readings, evidence and dimensions for ${resourceType} at ${width}×${height}`, async ({ page, context }, info) => {
    await page.setViewportSize({ width, height });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const observed = new Date(Date.now() - 30 * 60_000).toISOString();
    const latest = metricsFixture(observed, new Date().toISOString());
    let history: { metric: unknown; dimensions: unknown; from: string; to: string } | undefined;
    await page.route('**/api/metrics/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/status')) return route.fulfill({ json: collectionStatus() });
      if (path.endsWith('/attempts')) return route.fulfill({ json: [] });
      const body = route.request().postDataJSON();
      if (path.endsWith('/latest')) return route.fulfill({ json: {
        resource: body, evaluated_at: observed, metrics: latest.map(({ definition, point, state }) => ({ definition, state, series: [point] })),
      } });
      if (path.endsWith('/catalog')) return route.fulfill({ json: { metrics: [], snapshots: [] } });
      const window = { from: body.from, to: body.to };
      const metrics = metricsFixture(body.from, body.to);
      if (path.endsWith('/observations')) {
        history = body;
        const point = metrics.find(item => item.definition.id === body.metric.id)!.point;
        return route.fulfill({ json: { window, observations: [point], total: 1, has_more: false } });
      }
      return route.fulfill({ json: { profile: { columns: [] }, window, metrics: metrics.map(({ definition, bucket, state }) => ({
        definition, state, series: [
          { dimensions: { scope: 'primary' }, buckets: definition.unit === 'count/s'
            ? [bucket, { ...bucket, value: null, observed_at: null, quality: { status: 'unknown', reason: 'gap' } }] : [bucket] },
          ...(definition.id === 'db.uptime_seconds' ? [{ dimensions: { scope: 'replica' }, buckets: [{ ...bucket, value: null, observed_at: null, quality: { status: 'unknown', reason: 'gap' }, freshness: 'unknown' }] }] : []),
        ],
      })) } });
    });
    await page.route('**/api/maintenance-windows/intervals/**', route => {
      const url = new URL(route.request().url());
      return route.fulfill({ json: { resource: { type: resourceType, id: 1 }, from: url.searchParams.get('from'),
        to: url.searchParams.get('to'), intervals: [], event_links: [] } });
    });
    await fixture(page, `<resource-metric-browser resourcetype="${resourceType}" resourceid="1"></resource-metric-browser>`, 'components/resource-metric-browser');
    const browser = page.locator('resource-metric-browser');
    const table = browser.locator('app-data-table').first();
    for (const { reading } of metricReadings) await expect(table.getByText(reading, { exact: true })).toBeVisible();
    await expect(table.getByText('旧值', { exact: true })).toBeVisible();
    await browser.getByText('进阶分析与采集证据', { exact: true }).click();
    const metrics = browser.locator('semantic-metrics');
    const summary = metrics.getByRole('region', { name: '窗口内最近可用值' });
    for (const { reading } of metricReadings) {
      const value = summary.getByText(reading, { exact: true });
      await expect(value).toBeVisible();
      expect(await value.evaluate(element => {
        const selection = document.createRange();
        selection.selectNodeContents(element);
        return selection.getClientRects().length;
      })).toBe(1);
    }
    await expect(summary.locator('.latest-value').filter({ hasText: 'scope=replica' })).toContainText('暂无可用观测');
    await summary.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`metrics-${width}x${height}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    if (resourceType === 'instance') {
      const actions = metrics.getByRole('group', { name: '所选指标操作' });
      await actions.getByRole('combobox').selectOption({ label: 'MySQL 每秒语句数 · scope=primary' });
      await actions.getByText('原始值与来源', { exact: true }).click();
      await actions.getByRole('button', { name: '复制证据' }).click();
      const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
      expect(copied).toMatchObject({ metric: 'mysql.queries.per_second', semantic_version: '1.0.0', dimensions: { scope: 'primary' },
        unit: 'count/s', value: { encoding: 'float64', value: 6.774611940888977 }, sources: [{ source: { collector_id: 'controlled-fixture' } }] });
      await actions.getByRole('button', { name: '查看历史趋势' }).click();
      const chart = metrics.locator('.trend-grid metric-chart');
      await expect(chart.locator('canvas').first()).toBeVisible();
      const plotted = await chart.evaluate((element: any) => ({
        data: element.series[0].data,
        tooltip: element._chart.getOption().tooltip[0].valueFormatter(element.series[0].data[0]),
      }));
      expect(plotted).toEqual({ data: [6.774611940888977, null], tooltip: '6.77 次/秒' });
      await actions.getByRole('button', { name: '查看采集详情' }).click();
      await expect(metrics.locator('.raw-observations').getByText('6.77 次/秒', { exact: true })).toBeVisible();
      expect(history).toMatchObject({ metric: { id: copied.metric, semantic_version: copied.semantic_version }, dimensions: copied.dimensions });
    }
  });
}

test('metric, maintenance and 30-day study reads recover independently', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let queryStatus = 503, maintenanceStatus = 504, studyStatus = 503;
  let populate = false;
  const queries: Array<{ from: string; to: string }> = [];
  const maintenance: Array<{ from: string | null; to: string | null }> = [];
  const studies: Array<{ from: string; to: string }> = [];
  await page.route('**/api/metrics/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) return route.fulfill({ json: collectionStatus() });
    if (path.endsWith('/attempts')) return route.fulfill({ json: [] });
    const { from, to } = route.request().postDataJSON();
    if (path.endsWith('/catalog')) {
      studies.push({ from, to });
      return route.fulfill({ status: studyStatus, json: studyStatus === 200 ? { metrics: [], snapshots: [] } : {} });
    }
    queries.push({ from, to });
    const metrics = populate ? metricsFixture(from, to).map(({ definition, bucket, state }) =>
      ({ definition, state, series: [{ dimensions: {}, buckets: [bucket] }] })) : [];
    return route.fulfill({ status: queryStatus, json: queryStatus === 200 ? { profile: { columns: [] }, window: { from, to }, metrics } : {} });
  });
  await page.route('**/api/maintenance-windows/intervals/**', route => {
    const url = new URL(route.request().url());
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    maintenance.push({ from, to });
    return route.fulfill({ status: maintenanceStatus, json: maintenanceStatus === 200 ? {
      resource: { type: 'instance', id: 9 }, from, to, event_links: [],
      intervals: populate ? [{ id: 'test', revision: 1, name: '计划维护', reason: '定期巡检', timezone: 'Asia/Shanghai',
        effective_from: from, effective_to: to }] : [],
    } : {} });
  });
  await fixture(page, '<semantic-metrics resourceid="9"></semantic-metrics>', 'components/semantic-metrics');
  const metrics = page.locator('semantic-metrics');
  const section = metrics.getByRole('region', { name: '维护历史' });
  const study = metrics.locator('metric-study');
  await expect(metrics.getByText('指标查询服务暂不可用（503），请稍后重试。', { exact: true })).toBeVisible();
  await expect(section).toContainText('维护历史读取超时');
  await expect(study).toContainText('长窗口目录服务暂不可用（503）');
  await expect(study.getByRole('combobox', { name: '历史研究窗口' })).toHaveValue('30');
  await expect(metrics.getByText('主图窗口（', { exact: false }).first()).toBeVisible();
  await expect(study.getByText('研究窗口（', { exact: false })).toBeVisible();
  await expect(metrics).not.toContainText('正在读取');
  await expect(metrics).not.toContainText('保留同窗口');
  await page.screenshot({ path: info.outputPath('independent-read-errors.png') });

  queryStatus = 504;
  await metrics.getByRole('button', { name: '重试主图指标' }).click();
  await expect(metrics.getByText('指标查询读取超时，请重试。', { exact: true })).toBeVisible();
  queryStatus = 200;
  await metrics.getByRole('button', { name: '重试主图指标' }).click();
  await expect(metrics.getByText('主图窗口没有指标记录。')).toBeVisible();

  maintenanceStatus = 503;
  await section.getByRole('button', { name: '重试维护历史' }).click();
  await expect(section).toContainText('维护历史服务暂不可用（503）');
  maintenanceStatus = 200;
  await section.getByRole('button', { name: '重试维护历史' }).click();
  await expect(section).toContainText('没有已记录的有限期限维护区段');

  studyStatus = 200;
  await study.getByRole('button', { name: '重试长窗口目录' }).click();
  await expect(study).toContainText('研究窗口没有可读取的正式历史');
  expect(queries).toEqual([queries[0], queries[0], queries[0]]);
  expect(maintenance).toEqual([queries[0], queries[0], queries[0]]);
  expect(studies).toEqual([studies[0], studies[0]]);
  expect(Date.parse(studies[0].to) - Date.parse(studies[0].from)).toBe(30 * 86_400_000);

  populate = true;
  await metrics.getByRole('button', { name: '刷新标准指标' }).click();
  await expect(metrics.getByRole('region', { name: '窗口内最近可用值' })).toBeVisible();
  await expect(section).toContainText('计划维护');
  await expect(section).toContainText('告警通知受抑制');
  await section.getByText('维护区间边界与事件影响', { exact: true }).click();
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('maintenance-recovered.png') });
  expect(studies).toHaveLength(2);

  queryStatus = 403;
  await metrics.getByRole('button', { name: '刷新标准指标' }).click();
  await expect(metrics.getByText('没有此资源的查看权限', { exact: true })).toBeVisible();
  await expect(metrics.getByRole('region', { name: '窗口内最近可用值' })).toHaveCount(0);
  await expect(section).not.toContainText('计划维护');
});

test('MAX-719 study keeps the 30-day catalog and rule choices when dimensions cannot be read', async ({ page }) => {
  const missing = { id: 'legacy.missing_definition', semantic_version: '1.0.0' };
  const first = { id: 'db.uptime_seconds', semantic_version: '1.0.0' };
  const second = { id: 'mysql.threads.connected', semantic_version: '1.0.0' };
  const dimensionReads: Array<{ from: string; to: string; metric: typeof first }> = [];
  let window: { from: string; to: string };
  await page.route('**/api/metrics/study/**', route => {
    const { from, to, metric, dimensions } = route.request().postDataJSON();
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/catalog')) {
      window = { from, to };
      return route.fulfill({ json: {
        metrics: [{ metric: missing, definition: null }, { metric: first, definition: { unit: 's' } },
          { metric: second, definition: { unit: 'count' } }],
        snapshots: [{ config_revision: 3, snapshot_hash: 'fixture', rules: [{ metric: first, version: 1, rule_id: 'uptime', scope: 'item:uptime' }] }],
      } });
    }
    if (path.endsWith('/dimensions')) {
      dimensionReads.push({ from, to, metric });
      if (metric.id === missing.id) return route.fulfill({ status: 400, json: { error: 'UNKNOWN_METRIC' } });
      if (metric.id === first.id) return route.fulfill({ status: 503, json: {} });
      return route.fulfill({ json: { dimensions: [{}] } });
    }
    expect({ from, to }).toEqual(window);
    expect(metric).toEqual(second);
    expect(dimensions).toEqual({});
    const value = { numerator: '13', denominator: '1' };
    return route.fulfill({ json: { tier: '1h', note: '受控趋势', buckets: [{
      from, to: new Date(Date.parse(from) + 3_600_000).toISOString(),
      count: 1, numeric_count: 1, min: value, max: value, avg: value,
      quality: 'good', coverage: 1, max_gap_ms: 0, invalid_count: 0, non_numeric_count: 0, estimated_count: 0,
    }] } });
  });
  await fixture(page, '<metric-study resourceid="9"></metric-study>', 'components/metric-study');
  const study = page.locator('metric-study');
  const choices = study.getByRole('combobox', { name: '历史研究指标' });
  const rule = study.getByRole('combobox', { name: '历史回放规则' });
  const dimensions = study.getByRole('region', { name: '历史研究维度' });
  await expect(choices).toHaveValue(JSON.stringify(missing));
  await expect(rule).toBeEnabled();
  const selectedRule = await rule.inputValue();
  expect(selectedRule).toContain('uptime');
  await expect(dimensions).toContainText('该指标缺少定义');
  await choices.selectOption(JSON.stringify(first));
  await expect(dimensions.getByRole('alert')).toContainText('长窗口维度服务暂不可用（503）');
  await expect(rule).toHaveValue(selectedRule);
  await dimensions.getByRole('button', { name: '重试长窗口维度' }).click();
  await expect.poll(() => dimensionReads.length).toBe(2);
  await choices.selectOption(JSON.stringify(second));
  await expect(dimensions.getByRole('alert')).toHaveCount(0);
  await study.getByRole('button', { name: '对照原始与趋势' }).click();
  await expect(study).toContainText('趋势已完成 · 1 个桶');
  await expect(study.getByText('13 个连接', { exact: true })).toHaveCount(3);
  await expect(study.getByRole('combobox', { name: '历史研究窗口' })).toHaveValue('30');
  await expect(rule).toHaveValue(selectedRule);
  expect(Date.parse(window!.to) - Date.parse(window!.from)).toBe(30 * 86_400_000);
  expect(dimensionReads).toEqual([first, first, second].map(metric => ({ ...window, metric })));
});

for (const outcome of ['503', 'late success'] as const) {
  test(`MAX-719 study discards the previous metric's ${outcome} from the resource menu`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await listResponses(page);
    await page.addInitScript(() => {
      localStorage.setItem('slide.i18n.locale', 'zh-CN');
      localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
    });
    await page.route('**/api/auth/permissions', route => route.fulfill({ json: ['*'] }));
    await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
    await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
      if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
    }));
    const resource = { type: 'instance', id: fixtureEntries[0].id };
    await page.route(`**/api/database/instances/${resource.id}`, route => route.fulfill({ json: fixtureEntries[0] }));
    const first = { id: 'db.uptime_seconds', semantic_version: '1.0.0' };
    const second = { id: 'mysql.threads.connected', semantic_version: '1.0.0' };
    const reads: Array<{ operation: string; body: { from: string; to: string; metric?: typeof first; dimensions?: Record<string, string> }; status: number }> = [];
    const interrupted: Array<{ metric: typeof first; error?: string }> = [];
    page.on('requestfailed', request => {
      if (request.url().endsWith('/study/trend')) interrupted.push({
        metric: request.postDataJSON().metric, error: request.failure()?.errorText,
      });
    });
    let secondDimensions = 0, secondTrends = 0;
    let releaseFirst!: () => void;
    const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstReleased!: () => void;
    const firstFinished = new Promise<void>(resolve => { firstReleased = resolve; });
    await page.route('**/api/metrics/study/**', async route => {
      const operation = new URL(route.request().url()).pathname.split('/').at(-1)!;
      const body = route.request().postDataJSON();
      const { from, to, metric, dimensions, tier, interval_ms } = body;
      const respond = async (json: object, status = 200) => {
        reads.push({ operation, body, status });
        await route.fulfill({ status, json });
      };
      if (operation === 'catalog') return respond({
        resource, window: { from, to },
        metrics: [{ metric: first, definition: { unit: 's' } }, { metric: second, definition: { unit: 'count' } }],
        snapshots: [{ config_revision: 3, snapshot_hash: 'fixture', rules: [{ metric: first, version: 1, rule_id: 'uptime', scope: 'item:uptime' }] }],
      });
      const isFirst = metric.id === first.id;
      if (operation === 'dimensions') {
        if (!isFirst && outcome === '503' && ++secondDimensions === 1) return respond({}, 503);
        return respond({ dimensions: [isFirst ? { scope: 'primary' } : { scope: 'replica' }] });
      }
      if (isFirst && outcome === '503') return respond({}, 503);
      if (!isFirst && outcome === '503' && ++secondTrends === 1) return respond({}, 503);
      const reading = { numerator: isFirst ? '318711' : '13', denominator: '1' };
      const result = { resource, window: { from, to }, metric, dimensions, tier,
        sampling: { interval_ms, basis: 'explicit_measurement_assumption' },
        evidence_hash: isFirst ? 'evidence-A' : 'evidence-B', note: '受控趋势',
        buckets: [{ from, to: new Date(Date.parse(from) + 3_600_000).toISOString(),
          count: 1, numeric_count: 1, min: reading, max: reading, avg: reading, quality: 'good',
          coverage: 1, max_gap_ms: 0, invalid_count: 0, non_numeric_count: 0, estimated_count: 0 }],
      };
      if (isFirst) {
        await firstResponse;
        try { await respond(result); }
        finally { firstReleased(); }
      } else await respond(result);
    });
    await page.goto('/');
    await page.getByRole('link', { name: '数据库', exact: true }).click();
    await page.locator(`button[data-resource-detail-id="${resource.id}"]`).click();
    await page.getByRole('tab', { name: '指标与趋势', exact: true }).click();
    await page.getByText('进阶分析与采集证据', { exact: true }).click();
    const study = page.locator('metric-study');
    const choices = study.getByRole('combobox', { name: '历史研究指标' });
    const rule = study.getByRole('combobox', { name: '历史回放规则' });
    const trend = study.getByRole('button', { name: '对照原始与趋势' });
    const trendRetry = study.getByRole('button', { name: '重试长窗口趋势', exact: true });
    const dimensions = study.getByRole('region', { name: '历史研究维度' });
    await expect(trend).toBeEnabled();
    const selectedRule = await rule.inputValue();
    const initial = page.waitForRequest(request => request.url().endsWith('/study/trend'));
    try {
      await trend.click();
      await initial;
      if (outcome === '503') await expect(trendRetry).toBeVisible();
      else await expect(study.getByText('正在读取长窗口趋势', { exact: true })).toBeVisible();
      await expect(choices).toBeEnabled({ timeout: 3000 });
      await choices.selectOption(JSON.stringify(second));
      await expect(study.getByText('长窗口趋势服务暂不可用（503）', { exact: false })).toHaveCount(0);
      await expect(trendRetry).toHaveCount(0);
      if (outcome === '503') {
        await expect(dimensions.getByRole('alert')).toContainText('长窗口维度服务暂不可用（503）');
        const retryDimensions = study.getByRole('button', { name: '重试长窗口维度', exact: true });
        await expect(retryDimensions).toHaveCount(1);
        await expect(trend).toBeDisabled();
        await retryDimensions.press('Enter');
        await expect(dimensions.getByRole('alert')).toHaveCount(0);
      }
      await trend.click();
      if (outcome === '503') {
        await expect(trendRetry).toBeVisible();
        await trendRetry.press('Enter');
      }
      await expect(study).toContainText('趋势已完成 · 1 个桶');
      if (outcome === 'late success') {
        releaseFirst();
        await firstFinished;
      }
      await expect(choices).toHaveValue(JSON.stringify(second));
      await study.getByText('趋势定义与证据', { exact: true }).click();
      await expect(study.getByText('mysql.threads.connected · 语义版本 1.0.0 · 单位 count', { exact: true })).toBeVisible();
      await expect(study.getByText('证据 evidence-B', { exact: true })).toBeVisible();
      await expect(study.getByText('13 个连接', { exact: true })).toHaveCount(3);
      await expect(study).not.toContainText(/evidence-A|318711/);
      await expect(study.getByRole('combobox', { name: '历史研究窗口' })).toHaveValue('30');
      await expect(rule).toHaveValue(selectedRule);
      const { from, to } = reads.find(read => read.operation === 'catalog')!.body;
      expect(Date.parse(to) - Date.parse(from)).toBe(30 * 86_400_000);
      for (const read of reads) expect(read.body).toMatchObject({ resource, from, to });
      const dimensionReads = reads.filter(read => read.operation === 'dimensions');
      expect(dimensionReads.map(({ body, status }) => [body.metric, status])).toEqual(outcome === '503'
        ? [[first, 200], [second, 503], [second, 200]] : [[first, 200], [second, 200]]);
      if (outcome === '503') expect(dimensionReads[1].body).toEqual(dimensionReads[2].body);
      const trends = reads.filter(read => read.operation === 'trend');
      expect(trends.map(({ body, status }) => [body.metric, body.dimensions, status])).toEqual(outcome === '503'
        ? [[first, { scope: 'primary' }, 503], [second, { scope: 'replica' }, 503], [second, { scope: 'replica' }, 200]]
        : [[second, { scope: 'replica' }, 200], [first, { scope: 'primary' }, 200]]);
      if (outcome === '503') expect(trends[1].body).toEqual(trends[2].body);
      await study.getByText('证据 evidence-B', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath('trend-B.png') });
      await writeFile(info.outputPath('reads.json'), JSON.stringify({
        browser: page.context().browser()?.version(), viewport: page.viewportSize(), outcome, reads, interrupted,
      }, null, 2));
    } finally {
      releaseFirst();
    }
  });
}

const detailLocationCases = [
  { menu: '数据库', type: 'instance', view: 'instance-detail-page', route: 'instance-detail', idKey: 'id',
    api: '/api/database/instances', label: '日志', key: 'logs', filter: 'mysql', width: 1440, height: 900 },
  { menu: '服务器', type: 'server', view: 'server-detail', route: 'server-detail', idKey: 'id',
    api: '/api/servers', label: '关联资源', key: 'related', filter: 'linux', width: 1920, height: 1080 },
  { menu: '网络设备', type: 'network_device', view: 'network-device-detail', route: 'network-device-detail', idKey: 'networkDeviceId',
    api: '/api/network-devices', label: '配置备份', key: 'backups', filter: '测试站点', width: 1366, height: 768 },
] as const;

for (const item of detailLocationCases) {
  test(`MAX-726 ${item.type} restores inventory and shares the detail tab`, async ({ page, context }, info) => {
    await page.setViewportSize({ width: item.width, height: item.height });
    const writes: string[] = [];
    context.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (/^\/api\/(database|servers|network-devices|resources|investigations|diagnosis|metrics)\//.test(path)
        && request.method() !== 'GET' && !['/api/metrics/query', '/api/metrics/latest'].includes(path)) {
        writes.push(`${request.method()} ${path}`);
      }
    });
    const inventory = [...fixtureEntries, ...fixtureEntries.slice(0, 20).map((entry, index) => ({
      ...entry, id: 1026 + index, name: `补充资源 ${index + 1}`, label: `补充资源 ${index + 1}`,
    }))];
    const seed = async (tab: Page) => {
      await listResponses(tab);
      await tab.addInitScript(() => localStorage.setItem('slide.i18n.locale', 'zh-CN'));
      await tab.route('**/api/auth/permissions', route => route.fulfill({ json: ['*'] }));
      await tab.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
        if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
      }));
      await tab.route(`**${item.api}`, route => route.fulfill({ json: inventory }));
      await tab.route(`**${item.api}/1021`, route => route.fulfill({ json: fixtureEntries[20] }));
      if (item.type === 'server') {
        await tab.route('**/api/servers/1021/instances', route => route.fulfill({ json: { instances: [] } }));
      }
      await tab.route('**/api/metrics/policy/groups', route => route.fulfill({ json: {
        groups: [{ id: 'draft-group', label: '待发布策略组' }],
      } }));
      const pin = { template_id: 'history-template', version: 1, content_hash: 'history-fixture' };
      await tab.route(`**/api/metrics/template-bindings/${item.type}/1021`, route => route.fulfill({ json: {
        source: 'template', revision: 1, configuration: { group_id: null, overrides: {} },
        template_pins: [pin], pending: null,
      } }));
      await tab.route('**/api/metrics/templates/history-template/versions/1', route => route.fulfill({ json: {
        ...pin, parameters: { schema: {}, defaults: {} }, items: [],
      } }));
    };
    await seed(page);
    await page.goto('/workbench');
    await page.getByRole('navigation').getByRole('link', { name: item.menu, exact: true }).click();
    const toolbar = page.locator('.resource-toolbar');
    const search = toolbar.locator('input');
    const table = page.locator('resource-metrics-table');
    const scroll = table.locator('.scroll');
    const pageScroller = page.locator('main.content');
    const row = table.locator('[data-resource-detail-id="1021"]');
    await expect(toolbar.getByRole('button', { name: /^添加/ })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: '刷新', exact: true })).toBeVisible();
    await expect(page.locator('.resource-result-count')).toContainText('45');
    await expect(table.getByRole('button', { name: fixtureEntries[0].name, exact: true })).toBeVisible();
    const checkOverflow = async () => {
      const overflow = await scroll.evaluate(el => el.scrollWidth > el.clientWidth);
      await expect(table.locator('.scroll-hint')).toHaveCount(overflow ? 1 : 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      return overflow;
    };
    const defaultOverflow = await checkOverflow();
    await search.fill('资源-25');
    await expect(table.locator('tbody tr')).toHaveCount(1);
    const narrowOverflow = await checkOverflow();
    if (item.width >= 1920) expect(narrowOverflow).toBe(false);
    await search.fill(item.filter);
    await toolbar.getByRole('button', { name: '列设置', exact: true }).click();
    const columns = table.locator('app-dialog[title="列设置"]');
    await expect(columns.getByRole('dialog', { name: '列设置', exact: true })).toBeVisible();
    const options = await columns.getByRole('checkbox').all();
    for (const option of options) await option.check();
    await columns.getByRole('button', { name: '完成', exact: true }).click();
    expect(await checkOverflow()).toBe(true);
    if (item.type === 'network_device') {
      await toolbar.getByLabel('站点筛选').selectOption('测试站点');
      await toolbar.getByLabel('状态筛选').selectOption('online');
    }
    const next = table.getByRole('button', { name: '下一页', exact: true });
    await expect(next).toBeEnabled();
    await next.click();
    await expect(row).toBeVisible();
    await row.scrollIntoViewIfNeeded();
    await row.focus();
    await scroll.evaluate(el => { el.scrollLeft = 93; });
    await pageScroller.evaluate(el => { el.scrollTop = Math.min(160, el.scrollHeight - el.clientHeight); });
    const position = { left: await scroll.evaluate(el => el.scrollLeft), top: await pageScroller.evaluate(el => el.scrollTop) };
    expect(position.left).toBeGreaterThan(0);
    expect(position.top).toBeGreaterThan(0);
    const detail = page.locator(item.view);
    await page.keyboard.press('Enter');
    const selected = detail.getByRole('tab', { name: item.label, exact: true });
    const overview = detail.getByRole('tab', { name: '概览', exact: true });
    await expect(overview).toHaveAttribute('aria-selected', 'true');
    await expect(detail.getByRole('heading', { name: fixtureEntries[20].name })).toBeVisible();
    await expect(detail.getByRole('button', { name: '监控配置', exact: true })).toHaveCount(0);
    const historySnapshot = () => page.evaluate(() => ({
      url: location.href, length: history.length, index: navigation.currentEntry?.index,
      entries: navigation.entries().map(({ key, url }) => ({ key, url })),
    }));
    const overviewHistory = await historySnapshot();
    const config = detail.getByRole('tab', { name: '监控配置', exact: true });
    await detail.getByRole('button', { name: '查看监控配置', exact: true }).click();
    await expect(config).toHaveAttribute('aria-selected', 'true');
    await expect(detail.locator('resource-collection-section')).toHaveJSProperty('resourceId', 1021);
    await detail.getByRole('button', { name: '修改模板与参数', exact: true }).click();
    const group = detail.getByRole('combobox', { name: '策略组', exact: true });
    await group.selectOption('draft-group');
    const configHistory = await historySnapshot();
    expect(configHistory.length).toBe(overviewHistory.length + 1);
    const discard = detail.getByRole('dialog', { name: '放弃未发布的修改？' });
    await page.goBack();
    await expect(discard).toBeVisible();
    await detail.getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(discard).toBeHidden();
    await expect(config).toHaveAttribute('aria-selected', 'true');
    await expect(group).toHaveValue('draft-group');
    await expect.poll(historySnapshot).toEqual(configHistory);
    await page.goBack();
    await expect(discard).toBeVisible();
    await detail.getByRole('button', { name: '放弃修改并继续', exact: true }).click();
    await expect(overview).toHaveAttribute('aria-selected', 'true');
    const afterDiscard = await historySnapshot();
    expect(afterDiscard).toEqual({ ...configHistory, url: overviewHistory.url, index: overviewHistory.index });
    await page.goForward();
    await expect(config).toHaveAttribute('aria-selected', 'true');
    expect(await historySnapshot()).toEqual(configHistory);
    await expect(group).toHaveCount(0);
    await page.goBack();
    await expect(overview).toHaveAttribute('aria-selected', 'true');
    await selected.focus();
    await page.keyboard.press('Enter');
    await expect(selected).toHaveAttribute('aria-selected', 'true');
    const share = new URL(page.url());
    expect(share.pathname).toBe(`/${item.route}`);
    expect(share.searchParams.get(item.idKey)).toBe('1021');
    expect(share.searchParams.get('detailTab')).toBe(item.key);
    await page.goBack();
    await expect(overview).toHaveAttribute('aria-selected', 'true');
    await page.goForward();
    await expect(selected).toHaveAttribute('aria-selected', 'true');
    const copy = await context.newPage();
    await seed(copy);
    await copy.goto(share.href);
    const copyDetail = copy.locator(item.view);
    const copyTab = copyDetail.getByRole('tab', { name: item.label, exact: true });
    await expect(copyTab).toHaveAttribute('aria-selected', 'true');
    await expect(copyDetail.getByRole('heading', { name: fixtureEntries[20].name })).toBeVisible();
    await copy.reload();
    await expect(copyTab).toHaveAttribute('aria-selected', 'true');

    const legacy = new URL(share);
    legacy.searchParams.delete('detailTab');
    legacy.searchParams.delete('tab');
    legacy.searchParams.set('metricResource', `${item.type}:1021`);
    legacy.searchParams.set('metricFrom', '2026-11-01T01:00:00.000Z');
    legacy.searchParams.set('metricTo', '2026-11-01T02:00:00.000Z');
    await copy.goto(legacy.href);
    const metrics = copyDetail.getByRole('tab', { name: '指标与趋势', exact: true });
    await expect(metrics).toHaveAttribute('aria-selected', 'true');
    await copyTab.click();
    await copy.goBack();
    await expect(metrics).toHaveAttribute('aria-selected', 'true');
    expect(new URL(copy.url()).searchParams.get('metricFrom')).toBe(legacy.searchParams.get('metricFrom'));
    expect(new URL(copy.url()).searchParams.get('metricTo')).toBe(legacy.searchParams.get('metricTo'));

    const legacyEntry = new URL(legacy);
    legacyEntry.pathname = '/';
    legacyEntry.searchParams.set('tab', item.route);
    await copy.goto(legacyEntry.href);
    await expect(metrics).toHaveAttribute('aria-selected', 'true');
    await expect(copyDetail.getByRole('heading', { name: fixtureEntries[20].name })).toBeVisible();
    const restored = new URL(copy.url());
    expect(restored.pathname).toBe(legacy.pathname);
    for (const key of [item.idKey, 'metricResource', 'metricFrom', 'metricTo']) {
      expect(restored.searchParams.get(key)).toBe(legacy.searchParams.get(key));
    }

    legacy.searchParams.set('detailTab', 'unrecognized');
    await copy.goto(legacy.href);
    await expect(copyDetail.getByRole('tab', { name: '概览', exact: true })).toHaveAttribute('aria-selected', 'true');
    const forbidden = () => copy.locator(item.view).getByRole('tab');
    await copy.route(`**${item.api}/1021`, route => route.fulfill({ status: 403, json: {} }));
    const denial = copy.waitForResponse(response => response.url().endsWith(`${item.api}/1021`) && response.status() === 403);
    await copy.goto(share.href);
    await denial;
    await expect(forbidden()).toHaveCount(0);
    await expect(copyDetail.getByRole('heading', { name: fixtureEntries[20].name })).toHaveCount(0);
    await copy.close();

    await detail.getByRole('button', { name: item.type === 'network_device' ? '网络设备' : '返回列表', exact: true }).click();
    await expect(search).toHaveValue(item.filter);
    if (item.type === 'network_device') {
      await expect(toolbar.getByLabel('站点筛选')).toHaveValue('测试站点');
      await expect(toolbar.getByLabel('状态筛选')).toHaveValue('online');
    }
    await expect(table).toContainText('第 2 页');
    await expect(row).toBeFocused();
    await expect.poll(() => scroll.evaluate(el => el.scrollLeft)).toBe(position.left);
    await expect.poll(() => pageScroller.evaluate(el => el.scrollTop)).toBe(position.top);
    await row.press('Enter');
    await expect(overview).toHaveAttribute('aria-selected', 'true');
    await page.goBack();
    await expect(search).toHaveValue(item.filter);
    await expect(table).toContainText('第 2 页');
    await expect(row).toBeFocused();
    if (item.type === 'instance') {
      await toolbar.getByRole('button', { name: '添加实例', exact: true }).click();
      await expect(page.getByRole('heading', { name: '添加数据库实例', exact: true })).toBeVisible();
      const caption = page.locator('.editor-head p');
      await expect(caption).toHaveText('mysql');
      await page.locator('input[name="name"]').fill('独占测试数据库');
      await expect(caption).toHaveText('独占测试数据库 · mysql');
    }
    expect(writes).toEqual([]);
    await info.attach('MAX-726 result', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      resource: item.type, browser: page.context().browser()?.version(), viewport: page.viewportSize(),
      detailTab: item.key, defaultOverflow, narrowOverflow, position, writes,
      discardHistory: { overview: overviewHistory, config: configHistory, afterDiscard },
    }, null, 2)) });
  });
}

async function openSnapshotResource(page: Page, type: 'server' | 'network_device', readOnly: boolean) {
  await listResponses(page, readOnly);
  const permissions = readOnly ? ['servers:view', 'network_devices:view'] : ['*'];
  await page.addInitScript(() => localStorage.setItem('slide.i18n.locale', 'zh-CN'));
  await page.route('**/api/auth/permissions', route => route.fulfill({ json: permissions }));
  await page.route('**/api/investigations?resource=**', route => route.fulfill({ json: { items: [] } }));
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  return async () => {
    await page.goto('/');
    await page.getByRole('link', { name: type === 'server' ? '服务器' : '网络设备', exact: true }).click();
    await page.locator('button[data-resource-detail-id="1002"]').click();
  };
}

for (const readOnly of [false, true]) {
  test(`MAX-734 server snapshot ${readOnly ? 'read-only' : 'explicit collection'}`, async ({ page }, info) => {
    await page.setViewportSize(readOnly ? { width: 1920, height: 1080 } : { width: 1440, height: 900 });
    const open = await openSnapshotResource(page, 'server', readOnly);
    const server = fixtureEntries[1];
    const requests: string[] = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/servers/') && (/diagnostics/.test(path) || request.method() !== 'GET')) {
        requests.push(`${request.method()} ${path}`);
      }
    });
    await page.route('**/api/servers/1002', route => route.fulfill({ json: server }));
    await page.route('**/api/servers/1002/instances', route => route.fulfill({ json: { instances: [] } }));
    let collectCount = 0;
    const collectedAt = '2026-11-22T17:12:13Z';
    const sample = { collectedAt, quality: 'good', source: ['ss'], items: [{ port: 443 }] };
    await page.route('**/api/servers/1002/collect-diagnostics', route => {
      ++collectCount;
      if (collectCount !== 2) return route.fulfill({ status: 503, json: { error: '测试诊断采集失败' } });
      return route.fulfill({ json: { success: true, diagnostics: {
        serverId: server.id, collectedAt, expiresAt: '2026-11-22T17:17:13Z', quality: 'partial',
        sections: { listeningPorts: sample, systemLogs: { ...sample, quality: 'unknown', items: [], reason: 'SYSTEM_LOGS_UNAVAILABLE' } },
      } } });
    });
    await open();
    const detail = page.locator('server-detail');
    const panel = detail.locator('server-diagnostic-panel');
    const tab = (name: string) => detail.getByRole('tab', { name, exact: true });
    const refresh = detail.getByRole('button', { name: '刷新', exact: true });
    for (const [name, evidence] of [
      ['网络', '网卡流量、错误与丢包和监听端口'], ['进程', 'CPU 占用较高的进程样本'],
      ['服务', '运行中的服务状态'], ['日志', '近期系统日志'],
    ]) {
      await tab(name).click();
      await expect(panel.getByText(new RegExp(`未取得${evidence}，样本数量未知`))).toBeVisible();
      const read = page.waitForResponse(response => new URL(response.url()).pathname === '/api/servers/1002');
      await refresh.click();
      await read;
      await expect(tab(name)).toHaveAttribute('aria-selected', 'true');
    }
    expect(requests).toEqual([]);
    await page.screenshot({ path: info.outputPath('server-no-snapshot.png') });
    const collect = detail.getByRole('button', { name: '采集诊断证据', exact: true });
    if (readOnly) {
      await expect(panel.getByText(/请联系有服务器管理权限/)).toBeVisible();
      await expect(detail.getByRole('button', { name: '去诊断页签采集' })).toHaveCount(0);
      await tab('诊断').click();
      await expect(collect).toBeDisabled();
      expect(requests).toEqual([]);
      return;
    }
    const move = detail.getByRole('button', { name: '去诊断页签采集' });
    await move.focus();
    await page.keyboard.press('Enter');
    await expect(tab('诊断')).toBeFocused();
    expect(requests).toEqual([]);
    await collect.click();
    await expect(panel.getByRole('alert')).toContainText('测试诊断采集失败');
    await collect.click();
    await expect(panel.getByText('已显示 1 条样本', { exact: true })).toBeVisible();
    await tab('网络').click();
    await expect(panel.getByText(/未取得网卡流量与丢包，样本数量未知/)).toBeVisible();
    await expect(panel.getByRole('cell', { name: '443', exact: true })).toBeVisible();
    await expect(panel.getByText('已显示 1 条样本', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('server-partial-snapshot.png') });
    await tab('日志').click();
    await expect(panel.getByText('样本数量未知', { exact: true })).toBeVisible();
    await refresh.click();
    await expect(tab('日志')).toHaveAttribute('aria-selected', 'true');
    await tab('诊断').click();
    await collect.click();
    await expect(panel.getByRole('alert')).toContainText('仍显示上次采集的快照');
    await expect(panel.getByRole('cell', { name: '443', exact: true })).toBeVisible();
    expect(requests).toEqual(Array(3).fill('POST /api/servers/1002/collect-diagnostics'));
    await writeFile(info.outputPath('requests.json'), JSON.stringify(requests));
  });
}

for (const readOnly of [false, true]) {
  test(`MAX-734 network backup ${readOnly ? 'read-only' : 'results, retries and SSH editor'}`, async ({ page }, info) => {
    await page.setViewportSize(readOnly ? { width: 1366, height: 768 } : { width: 1440, height: 900 });
    const open = await openSnapshotResource(page, 'network_device', readOnly);
    let credential: boolean | undefined = readOnly ? false : undefined;
    let listState = readOnly ? 'empty' : 'malformed';
    let scheduleState = readOnly ? 'empty' : 'failedRead';
    const requests: string[] = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/network-devices/')) requests.push(`${request.method()} ${path}`);
    });
    const device = fixtureEntries[1];
    const schedule = { enabled: true, dailyTime: '03:45', timeZone: 'Asia/Shanghai', lastRun: null };
    const backup = { id: 8, deviceId: device.id, versionNo: 2, contentSha256: 'a'.repeat(64),
      sourceProtocol: 'ssh', collectedAt: '2026-11-22T17:12:13Z', sizeBytes: 1024, redactionStatus: 'redacted' };
    await page.route('**/api/network-devices/1002', route => route.fulfill({ json: { ...device, hasSshCredential: credential } }));
    await page.route('**/api/network-devices/1002/relations', route => route.fulfill({ json: { relations: [] } }));
    await page.route('**/api/network-devices/1002/config-backups', route => {
      if (route.request().method() === 'POST') return route.fulfill({ status: 201, json: backup });
      if (listState === 'malformed') return route.fulfill({ json: {} });
      return route.fulfill({ json: { backups: listState === 'empty' ? [] : [backup] } });
    });
    await page.route('**/api/network-devices/1002/config-backups/8', route => route.fulfill({ json: { ...backup, preview: 'sysname test-edge' } }));
    await page.route('**/api/network-devices/1002/backup-schedule', route => {
      if (scheduleState === 'failedRead') return route.fulfill({ status: 503, json: {} });
      return route.fulfill({ json: scheduleState === 'empty' ? schedule : {
        ...schedule, lastRun: { date: '2026-11-23', status: 'failed', errorCode: 'CONFIG_BACKUP_RESULT_UNCONFIRMED' },
      } });
    });
    await open();
    const detail = page.locator('network-device-detail');
    await detail.getByRole('tab', { name: '配置备份' }).click();
    const capture = detail.getByRole('button', { name: '立即备份' });
    const ssh = detail.getByRole('button', { name: '配置 SSH 连接' });
    if (readOnly) {
      await expect(ssh).toHaveCount(0);
      await expect(detail.getByText(/请联系有网络设备管理权限/)).toBeVisible();
      await expect(detail.getByText('最近自动备份：暂无运行记录')).toBeVisible();
      await expect(detail.getByText('暂无配置备份')).toBeVisible();
      await expect(capture).toBeDisabled();
      await expect(detail.getByRole('button', { name: '保存定时设置' })).toBeDisabled();
      expect(requests.filter(request => !request.startsWith('GET'))).toEqual([]);
      await page.screenshot({ path: info.outputPath('backup-read-only.png') });
      await page.goto('/network-devices?edit=1002&editSection=ssh');
      await expect(page.locator('button[data-resource-detail-id="1002"]')).toBeVisible();
      await expect(page.locator('resource-editor-shell')).toHaveCount(0);
      return;
    }
    await expect(detail.getByText(/最近保存的版本未知/)).toBeVisible();
    await expect(detail.getByText('最近自动备份：结果与时间未知')).toBeVisible();
    await expect(detail.getByText('尚未配置 SSH 凭据', { exact: false })).toHaveCount(0);
    await expect(ssh).toHaveCount(0);
    const beforeRetry = requests.length;
    listState = 'empty';
    const retry = detail.getByRole('button', { name: '重试备份列表' });
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(detail.getByText('暂无配置备份')).toBeVisible();
    await expect(detail.getByText('加密配置备份', { exact: true })).toBeFocused();
    expect(requests.slice(beforeRetry)).toEqual(['GET /api/network-devices/1002/config-backups']);
    scheduleState = 'existing';
    await detail.getByRole('button', { name: '重新加载定时设置' }).click();
    await expect(detail.getByText(/2026-11-23 北京时间（UTC\+8） · 备份结果未确认/)).toBeVisible();
    expect(requests.filter(request => !request.startsWith('GET'))).toEqual([]);
    listState = 'existing';
    await capture.click();
    await expect(detail.getByText(/最近保存的版本：v2 · 2026\/11\/23 01:12:13 北京时间（UTC\+8）/)).toBeVisible();
    await detail.getByRole('button', { name: '查看摘要' }).click();
    await expect(page.getByRole('dialog', { name: '配置备份 v2' })).toBeVisible();
    await expect(detail.getByText(/备份时间 .*01:12:13 北京时间（UTC\+8）/)).toBeVisible();
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
    credential = false;
    await detail.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(ssh).toBeVisible();
    await expect(capture).toBeDisabled();
    await page.screenshot({ path: info.outputPath('backup-saved-and-schedule.png') });
    await ssh.focus();
    await page.keyboard.press('Enter');
    const editor = page.locator('resource-editor-shell');
    await expect(editor.getByRole('heading', { name: 'SSH 凭据', exact: true })).toBeFocused();
    await expect(editor.getByRole('heading', { name: '编辑网络设备', exact: true })).toBeVisible();
    await expect(editor.getByRole('tab', { name: '基本信息' })).toHaveAttribute('aria-selected', 'true');
    await expect(editor.getByLabel('名称', { exact: true })).toHaveValue(device.name);
    await expect(page).toHaveURL(/restoreList=/);
    expect(requests.filter(request => !request.startsWith('GET'))).toEqual(['POST /api/network-devices/1002/config-backups']);
    await page.screenshot({ path: info.outputPath('backup-ssh-editor.png') });
    await editor.getByRole('button', { name: '返回资源列表' }).click();
    await expect(page.locator('button[data-resource-edit-id="1002"]')).toBeFocused();
    await writeFile(info.outputPath('requests.json'), JSON.stringify(requests));
  });
}
