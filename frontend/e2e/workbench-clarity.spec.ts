import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const items = [1, 2].map(id => ({ id, title: '告警事件: performance on Instance 1', severity: 'warning', status: id === 1 ? 'open' : 'investigating', instance_id: 1, instance_name: '验收 MySQL', alert_count: id, root_cause: `待核对摘要 ${id}`, updated_at: `2026-10-2${id}T01:00:00Z`, created_at: '2026-10-20T00:00:00Z' }));
const sampleSection = (rows: unknown[], reason?: string) => ({ items: rows, source: ['SSH 固定只读命令（受控数据）'], collectedAt: '2026-10-21T00:00:00Z', quality: 'partial', reason });
const controlledEvidence = { collectedAt: '2026-10-21T00:00:00Z', quality: 'partial', sections: { topProcesses: sampleSection([{ pid: 1, command: 'systemd', cpuPercent: 0, memoryPercent: 0.2 }]), services: sampleSection([{ name: 'sshd.service', activeState: 'active', subState: 'running' }]), systemLogs: sampleSection([], 'SYSTEM_LOGS_EMPTY'), listeningPorts: sampleSection([{ address: '0.0.0.0', port: 22, protocol: 'tcp' }]), interfaceErrors: sampleSection([{ interface: 'eth0', rxErrors: 0, txDrops: 0 }]) } };
const diagnosticEvidence = process.env.SLIDE_DIAGNOSTIC_EVIDENCE ? JSON.parse(readFileSync(process.env.SLIDE_DIAGNOSTIC_EVIDENCE, 'utf8')) : controlledEvidence;
async function capture(page: Page, name: string) {
  if (process.env.SLIDE_EVIDENCE_DIR) {
    await page.screenshot({ path: join(process.env.SLIDE_EVIDENCE_DIR, `${name}.png`), fullPage: name.startsWith('diagnostics'), animations: 'disabled' });
    if (name.startsWith('palette-')) writeFileSync(join(process.env.SLIDE_EVIDENCE_DIR, `${name}.json`), JSON.stringify(await page.getByRole('dialog', { name: '全局搜索' }).evaluate(dialog => {
      const input = dialog.querySelector('input')!;
      return { source: 'Controlled component fixture; production locale/theme helpers and styles', viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme, themeMode: document.documentElement.dataset.themeMode, colorScheme: document.documentElement.style.colorScheme, locale: localStorage.getItem('slide.i18n.locale'), placeholder: input.placeholder, focused: document.activeElement === input, activeOption: input.getAttribute('aria-activedescendant'), background: getComputedStyle(dialog).backgroundColor, opacity: getComputedStyle(dialog).opacity, overlayOpacity: getComputedStyle(dialog.parentElement!).opacity, bounds: dialog.getBoundingClientRect().toJSON(), at: new Date().toISOString() };
    }), null, 2));
  }
}
async function load(page: Page, status = 200, data: unknown = { items }) {
  await page.route('**/api/branding/config', route => route.fulfill({ json: {} }));
  await page.addInitScript(() => { localStorage.setItem('token', 'controlled-browser-token'); });
  await page.route('**/api/alerts/events*', route => route.fulfill({ status, json: data }));
  await page.route('**/api/alerts/events/*', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/').pop());
    return route.fulfill({ json: { ...items.find(item => item.id === id), alerts: [{ id: id * 100, title: `事件 ${id} 专属告警` }] } });
  });
  await page.goto('/e2e/fixtures/workbench-clarity.html');
  await page.waitForFunction(() => !!(window as any).workbench);
}
for (const width of [1440, 375]) for (const theme of ['light', 'dark']) {
  test(`same-name events, filters, keyboard and diagnostic groups ${width} ${theme}`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 }); await load(page);
    await page.evaluate(({ theme, evidence }) => { (window as any).workbench.setTheme(theme); (window as any).workbench.panel.evidence = evidence; }, { theme, evidence: diagnosticEvidence });
    await expect(page.getByRole('button', { name: '查看事件 #1 详情' })).toBeVisible();
    await capture(page, `attention-${width}-${theme}`);
    const open = page.getByRole('button', { name: '查看事件 #2 详情' }); await open.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: items[1].title })).toBeVisible();
    await expect(page.getByText('事件 2 专属告警')).toBeVisible();
    await expect(page.getByText('事件 1 专属告警')).toHaveCount(0);
    await capture(page, `detail-keyboard-${width}-${theme}`);
    await page.keyboard.press('Escape'); await expect(open).toBeFocused();
    await page.getByLabel('搜索事项', { exact: true }).fill('#2');
    await expect(page.locator('attention-page tbody tr')).toHaveCount(1);
    await page.getByLabel('搜索事项', { exact: true }).fill('摘要 2');
    await expect(page.locator('attention-page tbody tr')).toHaveCount(1);
    await open.click(); await page.getByRole('button', { name: '返回关注事项' }).click();
    await expect(page.getByLabel('搜索事项', { exact: true })).toHaveValue('摘要 2');
    await page.getByLabel('事项状态', { exact: true }).selectOption('open');
    await expect(page.getByText('暂无匹配事项')).toBeVisible();
    await page.getByRole('button', { name: '全局搜索' }).click();
    const dialog = page.getByRole('dialog', { name: '全局搜索' });
    const input = page.getByRole('combobox', { name: '搜索产品入口' });
    await expect(dialog).toBeVisible(); await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('placeholder', '搜索命令和页面');
    await dialog.evaluate(async element => { await Promise.all(element.parentElement!.getAnimations({ subtree: true }).map(animation => animation.finished)); });
    await expect(dialog).toHaveCSS('opacity', '1');
    await expect(page.locator('.cmd-palette-overlay')).toHaveCSS('opacity', '1');
    await page.keyboard.press('ArrowDown');
    await expect(input).toHaveAttribute('aria-activedescendant', 'palette-nav-attention');
    await expect(page.locator('#palette-nav-attention')).toHaveAttribute('aria-selected', 'true');
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await capture(page, `palette-${width}-${theme}`);
    await page.getByRole('combobox', { name: '搜索产品入口' }).fill('服务器');
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1); await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).selectedTab)).toBe('servers');
    await expect(page.getByRole('button', { name: '全局搜索' })).toBeFocused();
    const panel = page.locator('server-diagnostic-panel');
    await expect(panel.locator('.evidence-section')).toHaveCount(5);
    await expect(panel.getByText('最近五分钟未取得警告及以上系统日志', { exact: false }).first()).toBeVisible();
    await panel.scrollIntoViewIfNeeded(); await capture(page, `diagnostics-${width}-${theme}`);
    expect(await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > innerWidth).map(el => el.tagName + '.' + el.className) }))).toEqual({ width, scrollWidth: width, overflow: [] });
    expect(errors).toEqual([]);
  });
}
for (const scenario of ['empty', 'error', 'forbidden', 'loading']) test(`attention ${scenario} state`, async ({ page }) => {
  if (scenario === 'loading') {
    await load(page); await page.route('**/api/alerts/events*', () => {});
    await page.getByRole('button', { name: '刷新事项' }).click();
    await expect(page.locator('attention-page .skeleton').first()).toBeVisible();
  } else await load(page, scenario === 'error' ? 500 : scenario === 'forbidden' ? 403 : 200, { items: [] });
  if (scenario === 'empty') await expect(page.getByText('暂无关注事项')).toBeVisible();
  if (scenario === 'error' || scenario === 'forbidden') { await expect(page.locator('attention-page [role="alert"]')).toBeVisible(); await expect(page.getByText('暂无关注事项')).toHaveCount(0); }
  await capture(page, `attention-${scenario}`);
});
test('revoking permissions closes detail and clears visible names', async ({ page }) => {
  await load(page); await page.getByRole('button', { name: '查看事件 #1 详情' }).click();
  await expect(page.getByText('事件 1 专属告警')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: [] } })));
  await expect(page.getByText('无访问权限')).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('验收 MySQL', { exact: false })).toHaveCount(0); await capture(page, 'attention-permission-revoked');
});
test('reads current real MySQL events over HTTP and opens an exact event with realtime JWT', async ({ page, request }) => {
  test.skip(!process.env.SLIDE_REAL_API || !process.env.SLIDE_REAL_TOKEN, 'Requires an explicit read-only authenticated HTTP harness');
  const headers = { Authorization: `Bearer ${process.env.SLIDE_REAL_TOKEN}` };
  await page.route('**/api/branding/config', route => route.fulfill({ json: {} }));
  await page.addInitScript(() => localStorage.setItem('token', 'browser-harness-token'));
  await page.route('**/api/alerts/**', async route => {
    const path = new URL(route.request().url());
    const response = await request.get(`${process.env.SLIDE_REAL_API}${path.pathname}${path.search}`, { headers });
    await route.fulfill({ response });
  });
  await page.goto('/e2e/fixtures/workbench-clarity.html');
  const first = page.locator('attention-page tbody button').first(); await expect(first).toBeVisible();
  const identity = await first.getAttribute('aria-label'); await first.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('app-dialog')).toContainText(identity!.replace('查看', '').replace(' 详情', ''));
  await expect(page.locator('app-dialog [role="alert"]')).toHaveCount(0);
  await capture(page, 'real-mysql-event-detail');
  expect((await request.get(`${process.env.SLIDE_REAL_API}/api/alerts/events`)).status()).toBe(401);
});
