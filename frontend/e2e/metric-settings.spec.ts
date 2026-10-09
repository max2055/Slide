import { expect, test, type Page } from '@playwright/test';
import { createConfigurationRegistry } from '../../apps/db-ops-api/src/metrics-v2/config/registry.js';
import { canonicalDefinitions } from '../../apps/db-ops-api/src/metrics-v2/packages/builtins.js';

// Use the production immutable releases, including derived outputs and multiple versions.
const packages = createConfigurationRegistry().list();
const catalog = { packages, metrics: [...new Map([...canonicalDefinitions, ...packages.flatMap(p => p.extensions)]
  .map(m => [`${m.id}@${m.semantic_version}`, m])).values()] };
async function setup(page: Page, theme = 'light') {
  await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' });
  await page.addInitScript(theme => {
    localStorage.setItem('token', 'fixture-token');
    localStorage.setItem('permissions', '["*"]');
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
    localStorage.setItem('slide.control.session_token.v1', 'fixture-token');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', themeMode: theme }));
  }, theme);
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
  await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    return route.fulfill({ json: path.endsWith('/config/catalog') ? catalog
      : path === '/api/auth/permissions' ? ['*']
      : path === '/api/user/preferences' ? { preferences: { locale: 'zh-CN', themeMode: theme } }
      : path === '/api/resources' ? { items: [] } : {} });
  });
}
const go = (page: Page, view = 'catalog') => page.goto(`/settings/monitoring/metrics?view=${view}`);
const entries = (page: Page) => page.locator('metric-settings .package-entry');
const noOverflow = async (page: Page) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const control of await page.locator('metric-settings .filter-toolbar input, metric-settings .filter-toolbar select').all()) {
    const box = (await control.boundingBox())!;
    expect(box.width).toBeGreaterThan(120);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
};

for (const width of [1440, 1280, 375]) for (const theme of ['light', 'dark']) {
  test(`catalog and package layout ${width}px ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page, theme);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await go(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', theme);
    await expect(page.getByLabel('搜索指标')).toBeVisible();
    await expect(page.getByLabel('指标资源类型')).toHaveValue('instance');
    await expect(page.locator('metric-settings app-data-table tbody tr').first()).toBeVisible();
    const fields = page.locator('metric-settings .filter-toolbar app-form-field');
    if (width >= 1280) {
      const tops = await fields.evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top));
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(2);
    }
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('catalog.png'), fullPage: true });
    await page.getByRole('tab', { name: '采集包', exact: true }).click();
    await expect(entries(page)).toHaveCount(packages.length);
    await expect(entries(page).locator(':scope > summary').filter({ hasText: 'PostgreSQL 数据库采集' })).toBeVisible();
    await expect(entries(page).locator(':scope > summary').filter({ hasText: '达梦数据库采集' }).first()).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('packages.png'), fullPage: true });
    const mysql = entries(page).filter({ has: page.locator('summary small', { hasText: /^mysql-basic$/ }) }).first();
    await mysql.locator(':scope > summary').click();
    for (const heading of ['包含指标', '适用范围', '所需权限', '发现方式', '推荐周期与配置']) await expect(mysql.getByRole('heading', { name: heading })).toBeVisible();
    await expect(mysql.locator('pre')).not.toBeVisible();
    await expect(mysql).toContainText('SHOW GLOBAL STATUS');
    await expect(mysql).toContainText('mysql.queries.per_second');
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('package-detail.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
}

for (const width of [1280, 375]) test(`package names/IDs, combined type filter, empty results, clear and advanced details ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await setup(page); await go(page, 'packages');
  const search = page.getByLabel('搜索采集包');
  await search.fill(' POSTGRESQL-REPRESENTATIVE ');
  await expect(entries(page)).toHaveCount(1);
  await expect(page.locator('metric-settings [role="status"]')).toHaveText(`显示 1 / ${packages.length} 个采集包版本`);
  await page.getByLabel('采集包资源类型').selectOption('server');
  await expect(page.getByText('没有符合条件的采集包', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清空筛选' }).click();
  await expect(search).toHaveValue('');
  await expect(page.getByLabel('采集包资源类型')).toHaveValue('');
  await expect(entries(page)).toHaveCount(packages.length);
  await search.fill('达梦');
  await expect(entries(page)).toHaveCount(2);
  await page.getByLabel('采集包资源类型').selectOption('instance');
  await expect(entries(page)).toHaveCount(2);
  const entry = entries(page).first();
  await entry.locator(':scope > summary').click();
  await expect(entry).toContainText('数据库版本：8.1');
  await expect(entry.locator('pre')).not.toBeVisible();
  await entry.getByText('高级详情：原始 JSON', { exact: true }).click();
  await expect(entry.locator('pre')).toBeVisible();
  await expect(entry.locator('pre')).toContainText('"digest"');
  // Filtering must not reuse an expanded entry for a different package.
  await search.fill('PostgreSQL');
  await expect(entries(page)).toHaveCount(1);
  await expect(entries(page).getByRole('heading', { name: '包含指标' })).not.toBeVisible();
});

test('catalog search, source/resource combination and definition reading', async ({ page }) => {
  await setup(page); await go(page);
  const rows = page.locator('metric-settings app-data-table tbody tr');
  await page.getByLabel('搜索指标').fill('数据库运行时长');
  await expect(rows).toHaveCount(1);
  await rows.getByText('定义与版本', { exact: true }).click();
  await expect(rows.getByText('语义版本 1.0.0', { exact: true })).toBeVisible();
  await page.getByLabel('指标来源').selectOption('extension');
  await expect(page.getByText('暂无数据', { exact: true })).toBeVisible();
  await page.getByLabel('搜索指标').fill(' POSTGRESQL.DATABASE.DISK_BYTES ');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('PostgreSQL 当前数据库物理文件大小');
  await page.getByLabel('指标资源类型').selectOption('server');
  await expect(page.getByText('暂无数据', { exact: true })).toBeVisible();
  await page.getByLabel('指标资源类型').selectOption('');
  await expect(rows).toHaveCount(1);
});

test('unknown IDs remain distinguishable and metric count deduplicates derived outputs', async ({ page }) => {
  await setup(page);
  const custom = ['vendor-one', 'vendor-two'].map(id => ({ package: { id, version: '2.0.0', resource_type: 'server', applicability: [],
    collectors: [{ mappings: [{ metric: { id: `${id}.value` } }, { metric: { id: `${id}.value` } }] }] }, derived: [{ output: { id: `${id}.rate` } }], documentation: [], recommendations: {} }));
  await page.route('**/api/metrics-v2/config/catalog', route => route.fulfill({ json: { packages: custom, metrics: [] } }));
  await go(page, 'packages');
  await expect(entries(page)).toHaveCount(2);
  await expect(entries(page).first().locator('strong')).toHaveText('vendor-one');
  await expect(entries(page).last().locator('strong')).toHaveText('vendor-two');
  await expect(entries(page).first().locator(':scope > summary')).toContainText('2 项指标');
  await entries(page).first().locator(':scope > summary').click();
  await expect(page.getByText('vendor-one.value', { exact: true })).toBeVisible();
  await expect(page.getByText('vendor-one.rate', { exact: true })).toBeVisible();
  await expect(entries(page).first().getByText('未提供权限说明', { exact: true })).toBeVisible();
});

test('package loading, forbidden error, retry and empty catalog', async ({ page }) => {
  await setup(page);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/api/metrics-v2/config/catalog', async route => {
    await pending; return route.fulfill({ status: 403, json: {} });
  });
  await go(page, 'packages');
  await expect(page.getByRole('status', { name: '正在读取采集包' })).toBeVisible();
  await expect(page.getByText('暂无采集包', { exact: true })).toHaveCount(0);
  finish();
  await expect(page.getByRole('alert')).toContainText('没有此资源的操作权限');
  await expect(page.getByText('暂无采集包', { exact: true })).toHaveCount(0);
  await page.route('**/api/metrics-v2/config/catalog', route => route.fulfill({ json: { packages: [], metrics: [] } }));
  await page.getByRole('button', { name: '重新加载目录' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('暂无采集包', { exact: true })).toBeVisible();
  await expect(page.locator('metric-settings [role="status"]')).toHaveText('显示 0 / 0 个采集包版本');
});
