import { expect, test, type Page } from '@playwright/test';
import { collectionStatus } from '../src/app/ui/components/metric-test-fixtures.js';

// R1 layout/interaction evidence uses controlled API responses; live business
// acceptance is deliberately kept in max190-real-collection.spec.ts.
const pack = { package: { id: 'mysql-basic', version: '2.0.0', digest: 'mysql96', resource_type: 'instance',
  applicability: [{ attribute: 'db.version', values: ['9.6'] }], collectors: [{ mappings: [{ metric: { id: 'db.uptime_seconds' } }] }] },
  documentation: [], derived: [], recommendations: { enabled: true, interval_ms: 60000 } };
const resolved = { settings: { enabled: true, interval_ms: 60000 }, sources: {}, metric_sources: {}, metric_templates: [] };
async function setup(page: Page, theme: string, tag = '<instances-page></instances-page>') {
  const status = collectionStatus(); status.binding.package = pack.package; status.formal_visibility.state = 'pending';
  status.blockers = ['AWAITING_SAMPLE']; status.coverage = [
    { metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, state: 'covered', reason: null },
    { metric: { id: 'mysql.tables.estimated_allocated_bytes', semantic_version: '1.0.0' }, state: 'unsupported', reason: 'VERSION_UNSUPPORTED' },
  ];
  const writes: unknown[] = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/database/instances') return route.fulfill({ json: [{ id: 1, name: 'mysql-3306', db_type: 'mysql', db_version: '9.6.0', host: '192.0.2.30', port: 3306, username: 'collector', health_status: 'unknown' }] });
    if (path.endsWith('/hosts')) return route.fulfill({ json: { hosts: [] } });
    if (path === '/api/resources') return route.fulfill({ json: { items: [] } });
    if (path.endsWith('/catalog')) return route.fulfill({ json: { packages: [pack], metrics: [] } });
    if (path.endsWith('/recommendations')) return route.fulfill({ json: { packages: [{ release: pack, compatibility: 'compatible', recommended: true,
      checks: [{ attribute: 'db.version', value: '9.6.0', supported_values: ['9.6'], status: 'supported' }], coverage: [{ id: 'db.uptime_seconds' }], missing_core_metrics: ['mysql.tables.estimated_allocated_bytes'] }] } });
    if (path.endsWith('/status')) return route.fulfill({ json: status });
    if (path.endsWith('/groups')) return route.fulfill({ json: { groups: [{ id: 'production', label: '核心数据库', revision: 1 }] } });
    if (path.endsWith('/access')) return route.fulfill({ json: { can_manage: true } });
    if (path.endsWith('/audit')) return route.fulfill({ json: [{ action: 'binding.publish', revision: 1, at: '2026-10-16T10:40:00Z' }] });
    if (path.endsWith('/attempts')) return route.fulfill({ json: [] });
    if (path.endsWith('/effective')) return route.fulfill({ json: { resolved } });
    if (path.endsWith('/preview')) return route.fulfill({ json: { affected_resources: 1, requests_per_hour_before: 60, requests_per_hour_after: 60, resources: [{ resolved }] } });
    if (path.endsWith('/trial')) return route.fulfill({ json: { decision: 'attempted', attempts: [{ status: 'succeeded' }], samples: [{ value: 600, quality: { status: 'good' } }] } });
    if (path.endsWith('/activate')) { writes.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); }
    if (/\/policy\/resources\/instance\/1$/.test(path)) return route.fulfill({ json: { binding: { package: pack.package, revision: 1, group_id: 'production', overrides: {} }, resolved, application: { status: 'applied', applied_revision: 1 } } });
    return route.fulfill({ json: [] });
  });
  await page.route('**/max190-r1', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN" data-theme="claw" data-theme-mode="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:24px;background:var(--bg);color:var(--text)"><main style="max-width:1180px;margin:auto">${tag}</main><app-toast-container></app-toast-container><script type="module">localStorage.setItem('permissions','["*"]');import '/src/app/styles.css';import '/src/app/ui/views/instances-db.ts';import '/src/app/ui/views/metric-settings.ts';import '/src/app/ui/components/app-toast-container.ts';</script></body></html>` }));
  await page.goto('/max190-r1');
  return writes;
}

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`R1 MySQL editor and detail ${width} ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const writes = await setup(page, theme);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByRole('heading', { name: '编辑资源', exact: true })).toBeFocused();
  await page.getByRole('tab', { name: '监控与采集', exact: true }).click();
  const editor = page.locator('metric-configuration');
  await expect(editor.getByLabel('采集包 / 模板版本')).toHaveValue('mysql96');
  await expect(editor.locator('.state-card')).toContainText('MySQL 基础采集');
  await expect(editor.locator('.coverage-table')).toContainText('版本不支持');
  const grid = await editor.locator('.edit-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(grid).toBe(width > 1100 ? 2 : 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('edit-r1.png'), fullPage: true });
  await editor.getByRole('switch', { name: '启用此对象采集' }).uncheck();
  await page.getByRole('tab', { name: '基本信息', exact: true }).click();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(editor.getByRole('dialog', { name: '放弃未发布的修改？' })).toBeVisible();
  await editor.getByRole('button', { name: '继续编辑', exact: true }).click();
  await page.getByRole('tab', { name: '基本信息', exact: true }).click();
  await page.locator('app-form-field[label="实例名称"] input').fill('mysql-3306-updated');
  await page.getByRole('button', { name: '保存连接并配置采集', exact: true }).click();
  await expect(page.getByRole('tab', { name: '监控与采集', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(editor.getByRole('switch')).not.toBeChecked();
  await editor.getByRole('switch').check();
  await editor.getByRole('button', { name: '检查并启用', exact: true }).click();
  await editor.getByRole('button', { name: '预检与影响预览' }).click();
  await editor.getByRole('button', { name: '试采', exact: true }).click();
  await expect(editor.getByRole('button', { name: '发布', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('activation-r1.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(editor.getByRole('dialog', { name: '检查并启用采集' })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: '检查并启用', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '返回资源列表', exact: true }).click();
  await expect(editor.getByRole('dialog', { name: '放弃未发布的修改？' })).toBeVisible();
  await editor.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(editor.getByRole('switch')).toBeChecked();
  await page.getByRole('button', { name: '返回资源列表', exact: true }).click();
  await editor.getByRole('button', { name: '放弃修改并继续', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeFocused();
  expect(writes).toEqual([]);
  await setup(page, theme, '<resource-collection-section resourceid="1"></resource-collection-section>');
  await expect(page.getByText('配置与运行证据', { exact: true })).toBeVisible();
  await expect(page.locator('.detail-intro app-badge')).toHaveText('等待正式数据');
  await expect(page.getByText('发布资源配置', { exact: false })).toBeVisible();
  await page.screenshot({ path: info.outputPath('detail-r1.png'), fullPage: true });
  expect(errors).toEqual([]);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`R1 template catalog ${width} ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  await setup(page, theme, '<metric-settings view="packages"></metric-settings>');
  await expect(page.getByRole('cell', { name: 'MySQL 基础采集', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('templates-r1.png'), fullPage: true });
  await page.getByRole('button', { name: '查看模板', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '采集模板详情' })).toBeVisible();
  await expect(page.locator('app-dialog[title="采集模板详情"]')).toContainText('数据库运行时长');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '查看模板', exact: true })).toBeFocused();
  await page.getByLabel('搜索采集包').fill('不存在');
  await expect(page.getByText('没有符合条件的采集包', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`R1 mixed trial warning and unknown gate ${width} ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 }); await setup(page, theme);
  let unknownOnly = false;
  await page.route('**/api/metrics/**/trial', route => route.fulfill({ json: {
    decision: 'attempted', lifecycle_evidence: 'unavailable',
    attempts: unknownOnly ? [{ collector_id: 'mysql.status', status: 'unknown' }] : [
      { collector_id: 'mysql.custom.connections', status: 'succeeded' },
      { collector_id: 'mysql.status', status: 'failed', error: 'counter_epoch_unknown' },
      { collector_id: 'mysql.diagnostics', status: 'partial' },
    ],
    samples: [...(unknownOnly ? [] : [{ metric: { id: 'custom.mysql.processlist_connections' }, value: { value: '0' }, quality: { status: 'good' } }]),
      { metric: { id: 'mysql.qps' }, value: null, quality: { status: 'unknown', reason: 'counter_epoch_unknown' } }],
  } }));
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('tab', { name: '监控与采集', exact: true }).click();
  const editor = page.locator('metric-configuration');
  await editor.getByRole('button', { name: '检查并启用', exact: true }).click();
  await editor.getByRole('button', { name: '预检与影响预览' }).click();
  await editor.getByRole('button', { name: '试采', exact: true }).click();
  await expect(editor.getByRole('button', { name: '发布', exact: true })).toBeEnabled();
  await expect(editor).toContainText('可发布有效指标，部分指标仍失败/待验证');
  await expect(editor).not.toContainText('试采成功，可以发布');
  const results = editor.getByRole('list', { name: '逐项采集结果' });
  await expect(results).toContainText('mysql.status：采集失败');
  await expect(results).toContainText('counter_epoch_unknown');
  await expect(results).toContainText('mysql.diagnostics：部分成功');
  await page.screenshot({ path: info.outputPath('mixed-trial.png'), fullPage: true });
  unknownOnly = true;
  await editor.getByRole('button', { name: '试采', exact: true }).click();
  await expect(editor.getByRole('button', { name: '发布', exact: true })).toBeDisabled();
  await expect(editor).toContainText('试采缺少有效样本或成功采集尝试，不能发布');
  await expect(results).toContainText('mysql.status：待验证');
  await page.screenshot({ path: info.outputPath('unknown-trial-blocked.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(editor.getByRole('button', { name: '检查并启用', exact: true })).toBeFocused();
});
