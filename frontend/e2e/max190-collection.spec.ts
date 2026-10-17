import { expect, test, type Page } from '@playwright/test';
import { collectionStatus } from '../src/app/ui/components/metric-test-fixtures.js';

// Controlled exceptional-state evidence. Normal live collection is validated separately.
const pack = { package: { id: 'mysql-basic', version: '2.0.0', digest: 'mysql96', resource_type: 'instance', applicability: [] },
  documentation: [], derived: [], recommendations: { enabled: true, interval_ms: 60000 } };
const old = { ...pack, package: { ...pack.package, digest: 'mysql8', version: '1.1.0' } };
const recommendations = { resource: { type: 'instance', id: 1 }, evaluated_at: '2026-10-16T00:00:00Z', packages: [old, pack].map((release, i) => ({
  release, compatibility: i ? 'compatible' : 'incompatible', recommended: !!i,
  checks: [{ attribute: 'db.version', value: '9.6.0', supported_values: i ? ['9.6'] : ['5.7', '8.0', '8.4'], status: i ? 'supported' : 'unsupported' }],
  coverage: [{ id: 'db.uptime_seconds', semantic_version: '1.0.0' }], missing_core_metrics: [],
})) };
const resolved = { settings: { enabled: true, interval_ms: 60000 }, sources: {}, metric_sources: {}, metric_templates: [] };
const scenarios = ['normal', 'unbound', 'loading', 'failed', 'forbidden', 'partial', 'unknown', 'global-paused'] as const;
type Scenario = typeof scenarios[number];

async function setup(page: Page, scenario: Scenario, theme: string) {
  const status = collectionStatus(scenario === 'unbound' ? 'unbound' : 'bound');
  status.binding.package = scenario === 'unbound' ? null : pack.package;
  status.coverage = [{ metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, state: 'covered', reason: null }];
  if (scenario === 'partial') status.coverage.push({ metric: { id: 'mysql.tables.estimated_allocated_bytes', semantic_version: '1.0.0' }, state: 'not_covered', reason: 'PACKAGE_NOT_COVERED' });
  if (scenario === 'unknown') { status.formal_visibility.state = 'pending'; status.blockers = ['CAPABILITY_UNKNOWN', 'AWAITING_SAMPLE']; status.collection.state = 'unknown'; }
  if (scenario === 'global-paused') { status.effective_enabled.enabled = false; status.effective_enabled.global_enabled = false; status.effective_enabled.source = 'global'; status.blockers = ['GLOBAL_COLLECTION_DISABLED']; }
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/metrics/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) {
      if (scenario === 'loading') await gate;
      if (scenario === 'failed' || scenario === 'forbidden') return route.fulfill({ status: scenario === 'forbidden' ? 403 : 503, json: {} });
      return route.fulfill({ json: status });
    }
    if (path.endsWith('/catalog')) return route.fulfill({ json: { packages: [old, pack], metrics: [] } });
    if (path.endsWith('/recommendations')) return route.fulfill({ json: recommendations });
    if (path.endsWith('/groups')) return route.fulfill({ json: { groups: [{ id: 'production-east', revision: 1 }, { id: 'development', revision: 2 }] } });
    if (path.endsWith('/access')) return route.fulfill({ json: { can_manage: true } });
    if (path.endsWith('/attempts') || path.endsWith('/audit')) return route.fulfill({ json: [] });
    if (path.endsWith('/preview')) return route.fulfill({ json: { affected_resources: 1, requests_per_hour_before: 0, requests_per_hour_after: 60, resources: [{ resolved }] } });
    if (path.endsWith('/trial')) return route.fulfill({ json: { decision: 'attempted', samples: [{ value: 1000, quality: { status: 'good' } }], attempts: [{ status: 'succeeded' }] } });
    if (path.endsWith('/activate')) return route.fulfill({ json: { published: true, status } });
    if (path.endsWith('/effective')) return route.fulfill({ json: { resolved } });
    return scenario === 'unbound' ? route.fulfill({ status: 404, json: { error: 'POLICY_NOT_FOUND' } })
      : route.fulfill({ json: { binding: { package: pack.package, revision: 1, group_id: null, overrides: { interval_ms: { mode: 'set', value: 30000 } } }, resolved, application: { status: 'applied', applied_revision: 1 } } });
  });
  await page.route('**/max190-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN" data-theme="claw" data-theme-mode="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:16px;background:var(--bg);color:var(--text)">
    <main style="max-width:1100px;margin:auto"><resource-collection-section resourceid="1"></resource-collection-section></main><app-toast-container></app-toast-container>
    <script type="module">import '/src/app/styles.css';import '/src/app/ui/components/resource-collection-section.ts';import '/src/app/ui/components/app-toast-container.ts';</script></body></html>` }));
  await page.goto('/max190-fixture');
  return release;
}

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`summary and editor ${width}px ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  for (const scenario of scenarios) {
    const release = await setup(page, scenario, theme);
    const section = page.locator('resource-collection-section');
    if (scenario === 'loading') await expect(section.getByRole('status')).toContainText('正在读取采集状态');
    else if (['failed', 'forbidden'].includes(scenario)) {
      await expect(section.getByRole('alert')).toBeVisible();
      await expect(section).not.toContainText('未绑定');
    } else await expect(section.locator('.fact-strip')).toBeVisible();
    if (scenario === 'global-paused') await expect(section).toContainText('全局采集已关闭');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${scenario}.png`), fullPage: true });
    release();

  }
  expect(errors).toEqual([]);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`audit ${width}px ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  let state: 'normal' | 'empty' | 'forbidden' = 'normal';
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/resources') return route.fulfill({ json: { items: [{ resource: { type: 'instance', id: 1 }, label: 'MySQL 采集验收', attributes: { host: 'db.example' } }] } });
    if (path.endsWith('/audit')) return route.fulfill({ status: state === 'forbidden' ? 403 : 200, json: state === 'normal'
      ? [{ action: 'binding.publish', revision: 7, at: '2026-10-16T08:00:00Z', configuration: { package: { id: 'mysql-basic', version: '2.0.0' }, overrides: { enabled: 'enable' } } }]
      : state === 'empty' ? [] : {} });
    return route.fulfill({ json: path.endsWith('/groups') ? { groups: [] } : { packages: [], metrics: [] } });
  });
  await page.route('**/max190-audit', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN" data-theme="claw" data-theme-mode="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:16px;background:var(--bg);color:var(--text)"><main style="max-width:1100px;margin:auto"><metric-settings view="audit"></metric-settings></main><script type="module">import '/src/app/styles.css';import '/src/app/ui/views/metric-settings.ts';</script></body></html>` }));
  await page.goto('/max190-audit');
  await page.getByLabel('资源', { exact: true }).selectOption('1');
  await expect(page.getByText('发布资源配置', { exact: true })).toBeVisible();
  await page.getByText('配置与覆盖', { exact: true }).click();
  await expect(page.locator('pre')).toContainText('mysql-basic');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('audit-normal.png'), fullPage: true });
  state = 'empty'; await page.getByRole('button', { name: '刷新审计' }).click();
  await expect(page.getByText('暂无配置变更记录', { exact: true })).toBeVisible();
  state = 'forbidden'; await page.getByRole('button', { name: '刷新审计' }).click();
  await expect(page.getByRole('alert')).toContainText('没有此资源的操作权限');
  await expect(page.getByText('暂无配置变更记录', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('audit-forbidden.png'), fullPage: true });
});
