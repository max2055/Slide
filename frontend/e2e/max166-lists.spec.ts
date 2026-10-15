import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
const baseline = process.env.MAX166_BASELINE === '1';
const tables = Array.from({ length: 125 }, (_, i) => ({ table_name: `table_${String(i).padStart(3, '0')}`, table_rows: 10, data_length: 1024, column_count: 2, table_comment: '受控长列表' }));
const indexes = tables.flatMap(t => (baseline ? ['PRIMARY'] : ['PRIMARY', 'ix_lookup', 'ix_other']).flatMap(index_name => [1, 2].map(seq => ({ ...t, index_name, column_name: `col_${seq}`, seq_in_index: seq, non_unique: 0, cardinality: 10, index_type: 'BTREE' }))));
async function mount(page: Page, file: string, tag: string, responses: Record<string, unknown>) {
  page.on('pageerror', e => { throw new Error(`Unexpected browser error: ${e.message}`); });
  await page.addInitScript(() => localStorage.setItem('token', 'controlled-test'));
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname;
    const data = responses[path] as any;
    return route.fulfill({ status: data?.__status ?? 200, json: data?.__status ? { error: 'controlled state' } : data ?? [] });
  });
  await page.route('**/max166-harness', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/app/styles/tokens.css"><style>body{margin:0;padding:16px;background:var(--bg);color:var(--text)}body>*{min-width:0;max-width:100%}</style></head><body><${tag}></${tag}><script type="module">import '/src/app/ui/views/${file}.ts';</script></body></html>` }));
  await page.goto('/max166-harness');
  return page.locator(tag);
}
test('schema 125 tables: baseline / representative search and pagination', async ({ page }) => {
  const view = await mount(page, 'schema-management', 'schema-management-page', {
    '/api/database/instances': [{ id: 1, name: '受控实例', db_type: 'mysql' }],
    '/api/schema/snapshot/1': { tables },
    '/api/schema/changes/1': { changes: [] },
  });
  await expect(view.locator('tbody tr')).toHaveCount(baseline ? 125 : 25);
  if (!baseline) {
    await view.getByRole('button', { name: '表结构：下一页', exact: true }).click();
    await expect(view).toContainText('第 2 / 5 页');
    await view.getByRole('searchbox', { name: '搜索表结构' }).fill('table_124');
    await expect(view.locator('tbody tr')).toHaveCount(1);
    await expect(view).toContainText('第 1 / 1 页');
    await expect(view).toContainText('table_124');
  }
  await page.screenshot({ path: `test-results/max166-schema-${baseline ? 'before' : 'after'}.png`, fullPage: true });
});
test('same index name across 125 tables stays distinct', async ({ page }) => {
  const view = await mount(page, 'index-management', 'index-management-page', {
    '/api/database/instances': [{ id: 1, name: '受控实例', db_type: 'mysql' }], '/api/indexes/1': indexes,
  });
  await expect(view.locator('tbody tr')).toHaveCount(baseline ? 1 : 25);
  if (baseline) await expect(view.locator('tbody tr').first()).toContainText('col_1, col_2, col_1');
  else {
    await view.getByRole('searchbox', { name: '搜索索引', exact: true }).fill('table_124');
    await expect(view.locator('tbody tr')).toHaveCount(3);
    await expect(view.locator('tbody tr').first()).toContainText('col_1, col_2');
    await view.getByLabel('筛选表', { exact: true }).selectOption('table_000');
    await expect(view).toContainText('无匹配结果');
    await view.getByRole('searchbox', { name: '搜索索引', exact: true }).fill('');
    await expect(view.locator('tbody tr')).toHaveCount(3);
  }
});

const metrics = tables.map((_, i) => ({ id: `metric_${String(i).padStart(3, '0')}`, name: `指标 ${String(i).padStart(3, '0')}`, db_types: i % 2 ? ['mysql'] : [], target_type: i % 2 ? undefined : 'server', aggregation: 'avg', default_interval: 30, is_collected: true }));
const permissions = tables.map((_, i) => ({ id: i, code: `fixture:perm_${String(i).padStart(3, '0')}`, name: `权限 ${i}`, resource: 'fixture', action: 'read' }));
const reports = tables.map((_, i) => ({ id: i, name: `报告 ${String(i).padStart(3, '0')}`, instance_name: `数据库 ${i}`, type: 'health', status: i === 124 ? 'legacy-unknown' : 'completed', created_at: '2026-10-15T00:00:00Z' }));
const definitions = [
  { file: 'schema-management', tag: 'schema-management-page', label: '表结构', endpoint: '/api/schema/snapshot/1', refresh: 'loadTableList', payload: { tables }, empty: { tables: [] }, target: 'table_124', extras: { '/api/database/instances': [{ id: 1, name: '受控实例', db_type: 'mysql' }], '/api/schema/changes/1': { changes: [] } } },
  { file: 'index-management', tag: 'index-management-page', label: '索引', endpoint: '/api/indexes/1', refresh: 'loadIndexes', payload: indexes, empty: [], target: 'table_124', extras: { '/api/database/instances': [{ id: 1, name: '受控实例', db_type: 'mysql' }] } },
  { file: 'metric-registry', tag: 'metric-registry-viewer', label: '指标', endpoint: '/api/metrics/registry', refresh: '_load', payload: metrics, empty: [], target: 'metric_124', extras: {} },
  { file: 'rbac-page', tag: 'permission-management-tab', label: '权限', endpoint: '/api/v1/rbac/permissions', refresh: '_loadPermissions', payload: permissions, empty: [], target: 'perm_124', extras: {} },
  { file: 'reports', tag: 'reports-page', label: '报表历史', endpoint: '/api/reports', refresh: 'loadReports', payload: reports.slice(0, 100), empty: [], target: '报告 099', extras: { '/api/reports/stats': { total: 125, completed: 124, failed: 0, running: 0 } } },
];
for (const d of definitions) test(`${d.label}: controlled empty/loading/error/permission/invalid recovery`, async ({ page }) => {
  test.skip(baseline);
  const view = await mount(page, d.file, d.tag, { ...d.extras, [d.endpoint]: d.payload });
  const search = view.getByRole('searchbox', { name: `搜索${d.label}`, exact: true });
  await expect(search).toBeVisible();
  await view.getByRole('button', { name: `${d.label}：下一页`, exact: true }).focus();
  await page.keyboard.press('Enter'); await expect(view).toContainText('第 2 /');
  await search.fill(d.target); await expect(view.locator('tbody tr')).toHaveCount(d.label === '索引' ? 3 : 1);
  await expect(view).toContainText('第 1 / 1 页');
  await search.fill('does-not-exist'); await expect(view).toContainText('无匹配结果');
  await search.fill('');
  const path = (url: URL) => url.pathname === d.endpoint;
  for (const status of [503, 403]) {
    await page.route(path, route => route.fulfill({ status, json: { error: 'controlled' } }));
    await view.evaluate((element: any, method) => element[method](), d.refresh);
    await expect(view.getByRole('alert')).toBeVisible(); await expect(view.locator('tbody tr')).toHaveCount(0);
    await page.unroute(path);
  }
  await page.route(path, route => route.fulfill({ json: { invalid: true } }));
  await view.evaluate((element: any, method) => element[method](), d.refresh);
  await expect(view.getByRole('alert')).toBeVisible(); await expect(view.locator('tbody tr')).toHaveCount(0);
  await page.unroute(path);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(path, async route => { await gate; await route.fulfill({ json: d.empty }); });
  await view.evaluate((element: any, method) => { void element[method](); }, d.refresh);
  await expect(view).toContainText(/加载|读取/); await expect(view.locator('tbody tr')).toHaveCount(0);
  release(); await expect(view).not.toContainText(/加载中|加载表结构/);
  await expect(view.locator('tbody tr')).toHaveCount(0); await expect(view.getByRole('alert')).toHaveCount(0);
});

test('metric resource/type filters survive search and paging; legacy target stays instance', async ({ page }) => {
  test.skip(baseline);
  const view = await mount(page, 'metric-registry', 'metric-registry-viewer', { '/api/metrics/registry': metrics });
  await view.getByLabel('资源类型', { exact: true }).selectOption('instance');
  await view.getByLabel('数据库类型', { exact: true }).selectOption('mysql');
  await view.getByRole('button', { name: '指标：下一页', exact: true }).click();
  await view.getByRole('searchbox').fill('metric_123'); await expect(view.locator('tbody tr')).toHaveCount(1);
  await expect(view.getByLabel('资源类型', { exact: true })).toHaveValue('instance');
  await expect(view.getByLabel('数据库类型', { exact: true })).toHaveValue('mysql');
  await expect(view.locator('tbody tr')).toContainText('数据库实例');
});

test('report name search is explicit about loaded scope and can read later history', async ({ page }) => {
  test.skip(baseline);
  const view = await mount(page, 'reports', 'reports-page', { '/api/reports': reports.slice(0, 100), '/api/reports/stats': { total: 125 } });
  await view.getByRole('searchbox').fill('报告 124'); await expect(view).toContainText('无匹配结果');
  await page.route(url => url.pathname === '/api/reports' && url.searchParams.get('page') === '2', route => route.fulfill({ json: reports.slice(100) }));
  await view.getByRole('button', { name: '读取下一批历史', exact: true }).click();
  await expect(view.locator('tbody tr')).toHaveCount(1); await expect(view).toContainText('legacy-unknown');
  await expect(view.getByRole('searchbox')).toHaveValue('报告 124');
  await expect(view.getByRole('button', { name: '读取下一批历史', exact: true })).toHaveCount(0);
});

for (const width of [1280, 768, 390]) for (const theme of ['light', 'dark']) test(`controlled visual ${width}px ${theme}`, async ({ page }) => {
  test.skip(baseline);
  await mkdir('test-results/max166-visual', { recursive: true });
  await page.setViewportSize({ width, height: 950 });
  for (const d of definitions) {
    const view = await mount(page, d.file, d.tag, { ...d.extras, [d.endpoint]: d.payload });
    await expect(view.getByRole('searchbox', { name: `搜索${d.label}`, exact: true })).toBeVisible();
    await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; document.documentElement.dataset.theme = 'claw'; }, theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/max166-visual/${d.file}-${width}-${theme}.png`, fullPage: true });
  }
});

test('unused and redundant indexes have independent bounded browsing', async ({ page }) => {
  test.skip(baseline);
  const unused = tables.flatMap(t => ['ix_unused_a', 'ix_unused_b'].map(index_name => ({ table_name: t.table_name, index_name, index_type: 'BTREE' })));
  const redundant = unused.map((row, id) => ({ id, table_name: row.table_name, redundant_index: row.index_name, covered_by_index: 'ix_cover', reason: 'controlled' }));
  const view = await mount(page, 'index-management', 'index-management-page', { '/api/database/instances': [{ id: 1, name: '受控实例' }], '/api/indexes/1': indexes, '/api/indexes/1/unused': unused, '/api/indexes/1/redundancy': redundant });
  const unusedControls = view.getByRole('group', { name: '未使用索引浏览', exact: true });
  const redundantControls = view.getByRole('group', { name: '冗余索引浏览', exact: true });
  await expect(unusedControls).toContainText('已载入 250 条');
  await view.getByRole('button', { name: '未使用索引：下一页', exact: true }).click(); await expect(unusedControls).toContainText('第 2 / 10 页');
  await expect(redundantControls).toContainText('第 1 / 10 页');
  await view.getByRole('searchbox', { name: '搜索冗余索引', exact: true }).fill('table_124'); await expect(view.locator('.redundant-card')).toHaveCount(2);
});
