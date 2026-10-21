import { expect, test, type Page } from '@playwright/test';
import { collectionStatus } from '../src/app/ui/components/metric-test-fixtures.js';
const fixture = async (page: Page, tag: string, file: string) => {
  await page.route('**/resource-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${tag}<script type="module">import '/src/app/styles.css'; import '/src/app/ui/${file}.ts';</script></body></html>` }));
  await page.goto('/resource-fixture');
};
for (const width of [375, 768, 1440, 1920]) for (const theme of ['light', 'dark']) test(`three lists ${width} ${theme}`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/**', route => {
    const p = new URL(route.request().url()).pathname; if (!p.startsWith('/api/')) return route.fallback();
    return route.fulfill({ json: p === '/api/database/instances' ? [{ id: 1, name: '订单数据库长名称用于布局检查', db_type: 'mysql', db_version: '8.4', host: '192.0.2.1', port: 3306, health_status: 'unknown', data_size_gb: 0 }] : p === '/api/servers' ? [{ id: 2, label: '应用服务器', host: '192.0.2.2', os_type: 'linux', os_version: '24.04', status: 'online' }] : p === '/api/servers/metrics/summary' ? { servers: {} } : p === '/api/network-devices' ? [{ id: 3, name: '核心交换机', host: '192.0.2.3', vendor: 'cisco', model: 'C9300', os_version: '17.9', status: 'unknown' }] : p.endsWith('/query') ? { profile: { columns: [] }, window: { from: '2026-09-20T00:00:00Z', to: '2026-09-20T00:01:00Z' }, metrics: [] } : [] });
  });
  for (const [tag, file, name, type, version] of [['instances-page', 'instances-db', '订单数据库长名称用于布局检查', 'mysql', '8.4'], ['servers-page', 'servers-page', '应用服务器', 'linux', '24.04'], ['network-devices-page', 'network-devices-page', '核心交换机', '未知', '17.9']]) {
    await fixture(page, `<${tag}></${tag}>`, `views/${file}`); await page.evaluate(t => { document.documentElement.dataset.themeMode = t; }, theme);
    const table = page.locator('resource-metrics-table');
    const mobile = width <= 640;
    const activeLayout = table.locator(mobile ? '.mobile-resources' : '.desktop-resources');
    const desktopTable = table.locator('.desktop-resources');
    await expect(table).toHaveCount(1);
    await expect(activeLayout).toBeVisible();
    await expect(table.locator(mobile ? '.desktop-resources' : '.mobile-resources')).toBeHidden();
    await expect(activeLayout.getByText(name, { exact: true })).toBeVisible();
    await expect(page.locator('semantic-core-list')).toHaveCount(0);
    await expect(desktopTable.locator('table')).toHaveCount(1);
    await expect(table.getByRole('button', { name: '批量绑定采集模板', exact: true })).toHaveCount(0);
    const detailButton = activeLayout.getByRole('button', { name: '详情', exact: true });
    await expect(detailButton).toBeVisible();
    if (mobile) {
      // A user-selected accent can have low contrast on dark surfaces. Check the
      // actual keyboard indicator rather than relying on axe's contrast scan.
      await page.evaluate(() => document.documentElement.style.setProperty('--accent', '#265f99'));
      const checkbox = activeLayout.getByRole('checkbox');
      for (let i = 0; i < 30 && !(await checkbox.evaluate(el => el.matches(':focus-visible'))); i++) await page.keyboard.press('Tab');
      const focus = await checkbox.evaluate(el => {
        const style = getComputedStyle(el);
        let ancestor: Element | null = el.parentElement, background = '';
        while (ancestor) {
          const color = getComputedStyle(ancestor).backgroundColor;
          if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') { background = color; break; }
          ancestor = ancestor.assignedSlot ?? ancestor.parentElement ?? (ancestor.getRootNode() as ShadowRoot).host;
        }
        const luminance = (color: string) => {
          const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(value => {
            const channel = Number(value) / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const a = luminance(style.outlineColor), b = luminance(background);
        return { visible: el.matches(':focus-visible'), width: parseFloat(style.outlineWidth), contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      });
      expect(focus.visible).toBe(true);
      expect(focus.width).toBeGreaterThanOrEqual(2);
      expect(focus.contrast).toBeGreaterThanOrEqual(3);
    }
    if (mobile) {
      await expect(activeLayout.getByText(/^(当前观测健康 \/ 连接配置|连接状态|设备状态)$/)).toBeVisible();
      await expect(activeLayout.getByText('采集状态 / 最近成功时间', { exact: true })).toBeVisible();
      await expect(activeLayout.getByText('当前采集状态暂不可用', { exact: true })).toBeVisible();
      for (const control of [activeLayout.getByText(name, { exact: true }), detailButton, activeLayout.locator('.resource-status')]) {
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      }
    }
    const search = page.locator('input.search-input, input.resource-search-input');
    await search.fill(`${type} ${version} 采集状态未知`);
    await expect(activeLayout.getByText(name, { exact: true })).toBeVisible();
    await expect(table.locator('select')).toHaveCount(0);
    await search.fill('不存在的资源');
    await expect(activeLayout.getByText('没有符合条件的资源', { exact: true })).toBeVisible();
    await search.fill('');
    await activeLayout.locator('.actions summary').click();
    const deleteButton = activeLayout.getByRole('button', { name: '删除', exact: true });
    await expect(deleteButton).toBeVisible();
    await expect(deleteButton).toHaveClass('btn-sm danger');
    const buttonStyle = await deleteButton.evaluate(el => ({ color: getComputedStyle(el).color, border: getComputedStyle(el).borderTopColor }));
    expect(buttonStyle.color).toBe(buttonStyle.border);
    if (mobile) {
      await expect(activeLayout.locator('table')).toBeHidden();
      await activeLayout.getByText('指标与资源明细', { exact: true }).click();
      await expect(activeLayout.getByText('左右滑动查看全部明细', { exact: true })).toBeVisible();
    }
    await expect(activeLayout.locator('table')).toBeVisible();
    const layout = () => activeLayout.locator('.scroll').evaluate(el => ({ top: (el as HTMLElement).offsetTop, height: (el as HTMLElement).offsetHeight }));
    const before = await layout();
    const settings = page.locator(tag).locator('.resource-toolbar').getByRole('button', { name: '列设置', exact: true });
    await settings.click();
    const dialog = table.getByRole('dialog', { name: '列设置' });
    await expect(dialog).toBeVisible();
    expect(await layout()).toEqual(before);
    const versionChoice = table.getByRole('checkbox', { name: /版本/ });
    await expect(versionChoice).not.toBeChecked();
    await versionChoice.check();
    await table.getByRole('button', { name: '完成' }).click();
    await expect(desktopTable.locator('th').filter({ hasText: /版本/ })).toHaveCount(1);
    await settings.click();
    await versionChoice.uncheck();
    await table.getByRole('button', { name: '完成' }).click();
    await expect(desktopTable.locator('th').filter({ hasText: /版本/ })).toHaveCount(0);
    await expect(settings).toBeFocused();
    await settings.click();
    await versionChoice.check();
    await table.getByRole('button', { name: '恢复默认' }).click();
    await expect(versionChoice).not.toBeChecked();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(settings).toBeFocused();
    await expect(desktopTable.locator('th').filter({ hasText: /版本/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${file}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});
test('preview, failed and empty trials, invalidation, publish and application', async ({ page }) => {
  let published = false, applied = false, succeed = false, hasSamples = false; const writes: string[] = []; const pack = { id: 'mysql-basic', version: '1.0.0', digest: 'pin', resource_type: 'instance' }; const resolved = { settings: {}, sources: {}, metric_templates: [], metric_sources: {} };
  await page.route('**/api/**', route => {
    const p = new URL(route.request().url()).pathname; if (!p.startsWith('/api/')) return route.fallback();
    if (p.endsWith('/catalog')) return route.fulfill({ json: { packages: [{ package: pack, recommendations: {}, documentation: [] }], metrics: [] } });
    if (p.endsWith('/recommendations')) return route.fulfill({ json: { packages: [{ release: { package: pack }, compatibility: 'compatible', recommended: true, checks: [], coverage: [], missing_core_metrics: [] }] } });
    if (p.endsWith('/groups')) return route.fulfill({ json: { groups: [] } });
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
