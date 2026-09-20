import { expect, test, type Page } from '@playwright/test';
const fixture = async (page: Page, tag: string, file: string) => {
  await page.route('**/resource-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${tag}<script type="module">import '/src/app/styles.css'; import '/src/app/ui/${file}.ts';</script></body></html>` }));
  await page.goto('/resource-fixture');
};
for (const width of [375, 1440, 1920]) for (const theme of ['light', 'dark']) test(`three lists ${width} ${theme}`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/**', route => {
    const p = new URL(route.request().url()).pathname; if (!p.startsWith('/api/')) return route.fallback();
    return route.fulfill({ json: p === '/api/database/instances' ? [{ id: 1, name: '订单数据库长名称用于布局检查', db_type: 'mysql', db_version: '8.4', host: '192.0.2.1', port: 3306, health_status: 'unknown', data_size_gb: 0 }] : p === '/api/servers' ? [{ id: 2, label: '应用服务器', host: '192.0.2.2', os_type: 'linux', os_version: '24.04', status: 'online' }] : p === '/api/servers/metrics/summary' ? { servers: {} } : p === '/api/network-devices' ? [{ id: 3, name: '核心交换机', host: '192.0.2.3', vendor: 'cisco', model: 'C9300', os_version: '17.9', status: 'unknown' }] : p.endsWith('/query') ? { profile: { columns: [] }, window: { from: '2026-09-20T00:00:00Z', to: '2026-09-20T00:01:00Z' }, metrics: [] } : [] });
  });
  for (const [tag, file, name, type, version] of [['instances-page', 'instances-db', '订单数据库长名称用于布局检查', 'mysql', '8.4'], ['servers-page', 'servers-page', '应用服务器', 'linux', '24.04'], ['network-devices-page', 'network-devices-page', '核心交换机', '未知', '17.9']]) {
    await fixture(page, `<${tag}></${tag}>`, `views/${file}`); await page.evaluate(t => { document.documentElement.dataset.themeMode = t; }, theme);
    const table = page.locator('resource-metrics-table'); await expect(table).toHaveCount(1); await expect(table.getByText(name, { exact: true })).toBeVisible(); await expect(page.locator('semantic-core-list')).toHaveCount(0); await expect(table.locator('table')).toHaveCount(1);
    await table.getByLabel('类型', { exact: true }).selectOption(type); await table.getByLabel('版本', { exact: true }).selectOption(version); await table.getByLabel('采集状态', { exact: true }).selectOption('not_configured'); await expect(table.getByText(name, { exact: true })).toBeVisible();
    await table.getByRole('button', { name: '清除筛选' }).focus(); await page.keyboard.press('Enter'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: info.outputPath(`${file}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});
test('preview, failed trial, invalidation, publish and application', async ({ page }) => {
  let published = false, applied = false, succeed = false; const writes: string[] = []; const pack = { id: 'mysql-basic', version: '1.0.0', digest: 'pin', resource_type: 'instance' }; const resolved = { settings: {}, sources: {}, metric_templates: [], metric_sources: {} };
  await page.route('**/api/**', route => {
    const p = new URL(route.request().url()).pathname; if (!p.startsWith('/api/')) return route.fallback();
    if (p.endsWith('/catalog')) return route.fulfill({ json: { packages: [{ package: pack, recommendations: {}, documentation: [] }], metrics: [] } });
    if (p.endsWith('/access')) return route.fulfill({ json: { can_manage: true } });
    if (p.endsWith('/attempts')) return route.fulfill({ json: [] });
    if (p.endsWith('/effective')) return route.fulfill({ json: { resolved } });
    if (p.endsWith('/preview')) return route.fulfill({ json: { affected_resources: 1, resources: [{ resolved }] } });
    if (p.endsWith('/trial')) return route.fulfill({ json: { decision: 'attempted', attempts: [{ status: succeed ? 'succeeded' : 'failed' }], samples: [] } });
    if (p.endsWith('/publish')) { writes.push(p); published = true; return route.fulfill({ json: {} }); }
    return route.fulfill({ status: published ? 200 : 404, json: published ? { binding: { package: pack, revision: 1, group_id: null, overrides: {} }, application: { status: applied ? 'applied' : 'pending', applied_revision: applied ? 1 : null } } : {} });
  });
  await page.setViewportSize({ width: 375, height: 900 }); await fixture(page, '<metric-configuration resourceid="1"></metric-configuration>', 'components/metric-configuration');
  const preview = page.getByRole('button', { name: '预检与影响预览' }), trial = page.getByRole('button', { name: '试采', exact: true }), publish = page.getByRole('button', { name: '发布', exact: true });
  await preview.click(); await trial.click(); await expect(publish).toBeDisabled(); succeed = true; await trial.click(); await expect(publish).toBeEnabled();
  await page.getByLabel('采集开关', { exact: true }).selectOption('disable'); await expect(trial).toBeDisabled(); await expect(publish).toBeDisabled(); await page.getByLabel('采集开关', { exact: true }).selectOption('inherit');
  await preview.click(); await trial.click(); await publish.click(); await expect(page.getByText(/当前发布版本 1.*等待应用/)).toBeVisible(); expect(writes).toHaveLength(1); applied = true; await page.getByRole('button', { name: '重新加载', exact: true }).click(); await expect(page.getByText(/当前应用版本 1.*已应用/)).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('empty resources and named resource selector', async ({ page }) => {
  await page.route('**/api/**', route => { const p = new URL(route.request().url()).pathname; if (!p.startsWith('/api/')) return route.fallback(); return route.fulfill({ json: p.endsWith('/catalog') ? { packages: [], metrics: [] } : p === '/api/resources' ? { items: [{ resource: { type: 'instance', id: 1 }, label: '订单数据库' }] } : [] }); });
  await fixture(page, '<network-devices-page></network-devices-page>', 'views/network-devices-page'); await expect(page.getByText('暂无网络设备', { exact: true })).toBeVisible();
  await fixture(page, '<metric-settings view="policies"></metric-settings>', 'views/metric-settings'); await expect(page.getByLabel('资源', { exact: true }).locator('option')).toHaveText(['请选择资源', '订单数据库 · 数据库实例']); await expect(page.getByLabel('资源 ID')).toHaveCount(0);
});
