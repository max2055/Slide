import { expect, test, type Page } from '@playwright/test';
import { collectionStatus } from '../src/app/ui/components/metric-test-fixtures.js';

// Production Lit pages and table in a real browser; inventory, permissions and
// metric HTTP responses are isolated fixtures, not authenticated backend E2E.
const lists = [
  ['instances-page', 'instances-db', '/api/database/instances', 'instance'],
  ['servers-page', 'servers-page', '/api/servers', 'server'],
  ['network-devices-page', 'network-devices-page', '/api/network-devices', 'network_device'],
] as const;
const inventory = () => Array.from({ length: 25 }, (_, i) => ({
  id: 1001 + i, name: `${i < 3 ? 'Alpha' : 'Beta'}-${i}`, label: `${i < 3 ? 'Alpha' : 'Beta'}-${i}`,
  host: `192.0.2.${i + 1}`, port: 3306, db_type: 'mysql', db_version: '8.4.2',
  os_type: 'rhel', os_version: '9', model: 'C9300', site: i % 2 ? '西站' : '东站',
  status: i % 2 ? 'offline' : 'online', health_status: i % 2 ? 'warning' : 'healthy',
  last_health_check_at: new Date().toISOString(), hasCredential: true, username: 'readonly',
  vendor: 'cisco', snmp_port: 161, ssh_port: 22,
}));
async function mount(page: Page, list: typeof lists[number], menu?: string) {
  let entries = inventory();
  let forbidden = false;
  const permissions = ['instance:view', 'servers:view', 'network_devices:view'];
  await page.addInitScript(({ permissions, menu }) => {
    localStorage.setItem('permissions', JSON.stringify(permissions));
    if (menu) {
      localStorage.setItem('token', 'resource-inventory-fixture');
      localStorage.setItem('slide.control.session_token.v1', 'resource-inventory-fixture');
      localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', themeMode: 'light' }));
    }
  }, { permissions, menu });
  if (menu) {
    await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
    await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
      if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
    }));
  }
  await page.route('**/api/**', async route => {
    const p = new URL(route.request().url()).pathname;
    if (!p.startsWith('/api/')) return route.fallback();
    if (p === '/api/auth/permissions') return route.fulfill({ json: permissions });
    if (p === '/api/user/preferences') return route.fulfill({ json: { preferences: { locale: 'zh-CN' } } });
    if (p === list[2]) return route.fulfill({ json: entries });
    if (p === '/api/resources/overview') return route.fulfill({ json: { items: entries.map(e => ({ resource: { type: list[3], id: e.id }, status: e.health_status, gaps: [], unresolvedAlerts: 0, quality: 'good', freshness: 'fresh', observedAt: new Date().toISOString() })) } });
    if (p === '/api/metrics/query') {
      if (forbidden) return route.fulfill({ status: 403, json: {} });
      return route.fulfill({ json: { profile: { columns: [] }, window: {}, metrics: [] } });
    }
    if (p.endsWith('/status')) return route.fulfill({ json: collectionStatus() });
    if (p.endsWith('/hosts')) return route.fulfill({ json: { hosts: [] } });
    if (p.endsWith('/access')) return route.fulfill({ json: { can_manage: false } });
    return route.fulfill({ json: [] });
  });
  if (menu) {
    await page.goto('/feedback');
    const link = page.locator('.shell-nav').getByRole('link', { name: menu, exact: true });
    const path = await link.getAttribute('href');
    await link.click();
    await expect(page).toHaveURL(url => url.pathname === path);
  } else {
    await page.route('**/resource-search-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><${list[0]}></${list[0]}><script type="module">import '/src/app/styles.css';import '/src/app/ui/views/${list[1]}.ts';</script></body></html>` }));
    await page.goto('/resource-search-fixture');
  }
  const host = page.locator(list[0]);
  const input = host.locator('.resource-toolbar input');
  const count = host.locator('.resource-result-count');
  const table = host.locator('resource-metrics-table');
  const rows = table.locator('.desktop-resources tbody tr:not(:has(.data-table-empty))');
  await expect(rows).toHaveCount(20);
  await expect(host.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  return { host, input, count, table, rows, setEntries: (next: typeof entries) => { entries = next; }, denyMetrics: () => { forbidden = true; } };
}

for (const [list, menu, width, height] of [
  [lists[0], '数据库', 1440, 900],
  [lists[1], '服务器', 1366, 768],
  [lists[2], '网络设备', 1440, 900],
] as const) {
  test(`MAX-717 ${menu}切换授权范围后拒绝旧清单响应`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    const { host, input, rows } = await mount(page, list, menu);
    const [revoked, allowed] = inventory();
    await input.fill('Alpha');
    await expect(rows).toHaveCount(3);

    let releaseOld!: () => void;
    const oldResponse = new Promise<void>(resolve => { releaseOld = resolve; });
    let reads = 0;
    await page.route(`**${list[2]}`, async route => {
      expect(route.request().method()).toBe('GET');
      if (++reads === 1) {
        await oldResponse;
        return route.fulfill({ json: [revoked, allowed] });
      }
      return route.fulfill({ json: [allowed] });
    });
    try {
      await host.getByRole('button', { name: '刷新', exact: true }).click();
      await expect.poll(() => reads).toBe(1);
      await page.evaluate(permissions => {
        localStorage.setItem('permissions', JSON.stringify(permissions));
        window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions } }));
      }, ['instance:view', 'servers:view', 'network_devices:view']);

      await expect.poll(() => reads).toBe(2);
      await expect(rows).toHaveCount(1);
      const response = page.waitForResponse(`**${list[2]}`);
      releaseOld();
      await (await response).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText(allowed.name);
      await expect(host.getByText(revoked.host, { exact: true })).toHaveCount(0);
      await expect(input).toHaveValue('Alpha');
      await page.screenshot({ path: info.outputPath('inventory-after-revocation.png') });
    } finally {
      releaseOld();
    }
  });
}

for (const list of lists) {
  test(`MAX389/MAX390 复现 ${list[3]}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { host, input, count, rows } = await mount(page, list);
    const icon = host.locator('.resource-toolbar .search-icon');
    await expect(icon).toBeVisible();
    const r = (await icon.boundingBox())!;
    await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    const focused = await input.evaluate(el => (el.getRootNode() as ShadowRoot).activeElement === el);
    await input.fill('aLpHa');
    await expect(rows).toHaveCount(3);
    const result = { focused, count: await count.innerText(), rows: await rows.count() };
    await info.attach('observed', { body: JSON.stringify(result), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('search.png'), fullPage: true });
    expect.soft(focused).toBe(true);
    await expect(count).toContainText('共 3 ');
  });
  for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
    test(`搜索过滤、分页、刷新 ${list[3]} ${width}x${height}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      const f = await mount(page, list);
      const check = async (count: number, visible = count) => {
        await expect(f.count).toContainText(`共 ${count} `);
        await expect(f.rows).toHaveCount(visible);
        if (await f.table.count()) await expect(f.table.locator('.pages').last()).toContainText(`筛选结果 ${count} /`);
      };
      await check(25, 20);
      await f.table.getByRole('button', { name: '下一页', exact: true }).click();
      await check(25, 5);
      const icon = (await f.host.locator('.resource-toolbar .search-icon').boundingBox())!;
      const input = (await f.input.boundingBox())!;
      // Actual hit testing at icon and surrounding input padding.
      for (const x of [icon.x + icon.width / 2, input.x + 3, icon.x + icon.width + 2]) {
        await f.input.blur();
        await page.mouse.click(x, input.y + input.height / 2);
        await expect(f.input).toBeFocused();
      }
      await page.keyboard.type('aLpHa');
      await check(3);
      await expect(f.table.locator('.pages').last()).toContainText('第 1 页');
      await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
      await expect(f.input).toBeFocused();
      await page.screenshot({ path: info.outputPath('focused-search.png'), fullPage: true });
      // AND terms, case-insensitivity, host/type/version/model and status aliases.
      for (const query of ['ALPHA 192.0.2.', ...(list[3] === 'instance' ? ['alpha mysql'] : list[3] === 'server' ? ['alpha rhel'] : []), ...(list[3] === 'instance' ? ['alpha 8.4.2'] : []), ...(list[3] === 'network_device' ? ['alpha C9300'] : [])]) {
        await f.input.fill(query); await check(3);
      }
      if (list[3] === 'network_device') {
        await f.input.fill('alpha 东站'); await check(2);
        await f.host.getByLabel('站点筛选').selectOption('西站'); await check(0);
        await f.input.fill(''); await check(12);
        await f.host.getByLabel('状态筛选').selectOption('online'); await check(0);
        await f.host.getByLabel('站点筛选').selectOption('all'); await check(13);
        await f.input.fill('alpha'); await check(2);
      } else if (list[3] === 'server') {
        await f.host.getByLabel('Status filter', { exact: true }).selectOption('online');
        await f.input.fill('alpha'); await check(2);
        await f.input.fill(''); await check(13);
      } else {
        await f.host.locator('.filter-btn').filter({ hasText: '健康' }).click();
        await f.input.fill('alpha'); await check(2);
        await f.input.fill(''); await check(13);
      }
      await f.input.fill('no-match-不存在'); await check(0);
      await page.screenshot({ path: info.outputPath('no-match.png'), fullPage: true });
      await f.host.getByRole('button', { name: '重置筛选', exact: true }).click();
      await check(25, 20);
      await f.input.fill('   '); await check(25, 20);
      // Collection search depends on asynchronous metric responses from the same table.
      await f.input.fill('采集状态未知'); await check(25, 20);
      f.denyMetrics();
      await f.host.getByRole('button', { name: '刷新', exact: true }).click();
      await expect(f.host.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
      await check(0);
      await f.input.fill('无查看权限'); await check(25, 20);
      await f.input.fill('alpha'); await check(3);
      f.setEntries(inventory().slice(0, 1));
      await f.host.getByRole('button', { name: '刷新', exact: true }).click();
      await check(1);
      // Removed inventory cannot survive in the count or rows after a scoped refresh.
      f.setEntries([]);
      await expect(f.host.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
      await f.host.getByRole('button', { name: '刷新', exact: true }).click();
      if (list[3] === 'server') {
        await expect(f.host.locator('app-empty-state[title="暂无服务器"]')).toBeVisible();
        await expect(f.count).toHaveCount(0); // Existing empty-inventory layout omits the toolbar count.
      } else await expect(f.count).toContainText('共 0 ');
      await expect(f.rows).toHaveCount(0);
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}
