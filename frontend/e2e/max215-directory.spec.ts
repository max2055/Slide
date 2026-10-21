import { expect, test, type Page } from '@playwright/test';
import { createConfigurationRegistry } from '../../apps/db-ops-api/src/metrics/config/registry.js';
import { canonicalDefinitions } from '../../apps/db-ops-api/src/metrics/packages/builtins.js';
import { collectionStatus } from '../src/app/ui/components/metric-test-fixtures.js';

const packages = createConfigurationRegistry().list();
const catalog = { packages, metrics: canonicalDefinitions };
// Controlled resource evidence: the largest release is deliberately incompatible.
const recommended = packages.find(p => p.package.id === 'mysql-basic' && p.package.version === '1.1.0')!;
const recommendations = { packages: packages.map(release => ({ release,
  compatibility: release.package.digest === recommended.package.digest ? 'compatible' : 'incompatible',
  recommended: release.package.digest === recommended.package.digest,
  checks: [{ attribute: 'db.version', value: '8.4', supported_values: ['8.*'], status: 'supported' }], coverage: [{ id: 'db.uptime_seconds', semantic_version: '1.0.0' }], missing_core_metrics: ['host.network.bytes_total'],
})) };
async function setup(page: Page, theme: string) {
  const requests: string[] = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    requests.push(`${route.request().method()} ${path}`);
    return route.fulfill({ json: path.endsWith('/catalog') ? catalog
      : path === '/api/resources' ? { items: [{ resource: { type: 'instance', id: 1 }, label: '受控 MySQL 8.4' }] }
      : path.endsWith('/recommendations') ? recommendations
      : path.endsWith('/status') ? collectionStatus() : path.endsWith('/groups') ? { groups: [] } : [] });
  });
  await page.route('**/max215-directory', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN" data-theme="claw" data-theme-mode="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:24px;background:var(--bg);color:var(--text)"><main style="max-width:1180px;margin:auto"><metric-settings view="packages"></metric-settings></main><app-toast-container></app-toast-container><script type="module">localStorage.setItem('permissions','["*"]');import '/src/app/styles.css';import '/src/app/ui/views/metric-settings.ts';import '/src/app/ui/components/app-toast-container.ts';</script></body></html>` }));
  await page.goto('/max215-directory');
  return requests;
}
const mysqlRow = (page: Page) => page.locator('metric-settings app-data-table tbody tr').filter({ has: page.getByText('MySQL 基础采集', { exact: true }) });
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`grouped compatibility and historical detail ${width} ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const requests = await setup(page, theme), row = mysqlRow(page);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('v2.0.0');
  await expect(row).toContainText('兼容性待确认');
  await expect(row.getByText('查看此版本', { exact: true }).first()).not.toBeVisible();
  const heights = await page.locator('metric-settings app-data-table tbody tr').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height));
  if (width > 720) expect(Math.max(...heights)).toBeLessThan(360);
  await page.screenshot({ path: info.outputPath('global-grouped.png'), fullPage: true });
  await row.locator('.version-list > summary').focus(); await page.keyboard.press('Enter');
  await expect(row.getByText('查看此版本', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('history-expanded.png'), fullPage: true });
  const oldButton = row.getByRole('button', { name: '查看 MySQL 基础采集 1.0.0', exact: true });
  await oldButton.click();
  const dialog = page.locator('app-dialog[title="采集模板详情"]');
  await expect(dialog).toContainText('v1.0.0');
  await expect(dialog.locator('pre')).not.toBeVisible();
  await dialog.getByText('技术标识（可复制）', { exact: true }).click();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await dialog.getByRole('button', { name: '复制模板标识' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('mysql-basic@1.0.0');
  await page.screenshot({ path: info.outputPath('historical-detail.png'), fullPage: true });
  await page.keyboard.press('Escape'); await expect(oldButton).toBeFocused();
  await page.getByLabel('兼容性参考资源', { exact: true }).selectOption('instance:1');
  await expect(row.locator('td').nth(1)).toContainText('v1.1.0');
  await expect(row.locator('td').nth(1)).toContainText('此资源推荐 · 已验证兼容');
  await expect(row).toContainText('核心缺口 1 项');
  await expect(row).toContainText('数据库版本：8.4；支持 8.*；符合');
  await page.screenshot({ path: info.outputPath('resource-recommendation.png'), fullPage: true });
  if (width < 600) {
    const region = page.getByRole('region', { name: '采集模板目录' });
    expect(await region.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await row.getByRole('button', { name: '查看模板', exact: true }).scrollIntoViewIfNeeded();
    await expect(row.getByRole('button', { name: '查看模板', exact: true })).toBeInViewport();
    await row.getByText(/可见资源绑定/).last().scrollIntoViewIfNeeded();
    await expect(row.getByText(/可见资源绑定/).last()).toBeInViewport();
    await page.screenshot({ path: info.outputPath('narrow-coverage-actions.png'), fullPage: true });
    await region.evaluate(el => { el.scrollLeft = 0; });
  }
  await row.getByRole('button', { name: '查看模板', exact: true }).click();
  await expect(dialog).toContainText('v1.1.0');
  await expect(dialog.getByRole('button', { name: '复制模板标识' })).not.toBeVisible();
  await dialog.getByRole('button', { name: '管理此资源的采集配置' }).click();
  await expect(page.getByLabel('资源', { exact: true })).toHaveValue('1');
  await expect(page.getByRole('button', { name: '修改监控与采集 →' })).toBeVisible();
  expect(requests.every(r => r.startsWith('GET '))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('compatibility loading/error/unknown, retry, clearing and revoked permissions never invent a recommendation', async ({ page }, info) => {
  await setup(page, 'dark');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/metrics/**/recommendations', async route => { await pending; await route.fulfill({ status: 503, json: {} }); });
  await page.getByLabel('兼容性参考资源', { exact: true }).selectOption('instance:1');
  await expect(page.getByText('正在检查资源兼容性，暂不提供推荐', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('compatibility-loading.png'), fullPage: true });
  release(); await expect(page.getByRole('alert')).toContainText('兼容性检查失败');
  await expect(mysqlRow(page)).toContainText('兼容性待确认');
  await page.screenshot({ path: info.outputPath('compatibility-error.png'), fullPage: true });
  await page.route('**/api/metrics/**/recommendations', route => route.fulfill({ json: { packages: recommendations.packages.map(p => ({ ...p, compatibility: 'unknown', recommended: true })) } }));
  await page.getByRole('button', { name: '重试兼容检查' }).click();
  await expect(mysqlRow(page)).toContainText('资源能力待验证');
  await expect(mysqlRow(page)).not.toContainText('此资源推荐');
  await page.screenshot({ path: info.outputPath('compatibility-unknown.png'), fullPage: true });
  await page.getByLabel('兼容性参考资源', { exact: true }).selectOption('');
  await expect(mysqlRow(page)).toContainText('兼容性待确认');
  await page.evaluate(() => window.dispatchEvent(new Event('slide-permissions-loaded')));
  await expect(page.getByRole('alert')).toContainText('权限或登录状态已变更');
  await expect(page.getByRole('button', { name: '查看模板', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('permission-revoked.png'), fullPage: true });
});

test('shared focus ring stays readable with the existing custom blue in light and shadow DOM', async ({ page }) => {
  await setup(page, 'light');
  await page.evaluate(async () => {
    const { applyAccentColor } = await import('/src/app/ui/app-settings.ts');
    applyAccentColor('#265f99');
    const button = document.createElement('button'); button.className = 'btn'; button.id = 'plain-focus'; button.textContent = '普通按钮'; document.body.append(button);
  });
  for (const mode of ['light', 'dark']) {
    await page.evaluate(mode => { document.documentElement.dataset.themeMode = mode; }, mode);
    for (const button of [page.locator('#plain-focus'), mysqlRow(page).getByRole('button', { name: '查看模板', exact: true })]) {
      await button.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      const sample = await button.evaluate(el => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d')!;
        const rgba = (color: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); const c = [...ctx.getImageData(0, 0, 1, 1).data]; return [c[0], c[1], c[2], c[3] / 255]; };
        const chain: Element[] = []; let node: Element | null = el;
        while (node) { chain.push(node); node = (node as HTMLElement).assignedSlot ?? node.parentElement ?? (node.getRootNode() as ShadowRoot).host; }
        let bg = [255, 255, 255]; for (const n of chain.reverse()) { const c = rgba(getComputedStyle(n).backgroundColor); bg = bg.map((v, i) => c[i] * c[3] + v * (1 - c[3])); }
        const lum = (c: number[]) => c.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        const color = rgba(getComputedStyle(el).outlineColor), a = lum(color), b = lum(bg);
        return { focused: el.matches(':focus-visible'), contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      });
      expect(sample.focused).toBe(true); expect(sample.contrast).toBeGreaterThanOrEqual(3);
    }
  }
});
