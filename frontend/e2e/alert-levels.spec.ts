import { test, expect, type Page } from '@playwright/test';
import { startAlertLevelsServer } from './fixtures/alert-levels-server.ts';

let env: Awaited<ReturnType<typeof startAlertLevelsServer>>;
test.beforeAll(async () => { env = await startAlertLevelsServer(); });
test.afterAll(async () => { await env?.close(); });
test.beforeEach(async ({ page }) => {
  await env.pool.query('DELETE FROM alerts');
  await page.addInitScript(({ token, permissions }) => {
    localStorage.setItem('token', token); localStorage.setItem('slide.control.session_token.v1', token);
    localStorage.setItem('permissions', JSON.stringify(permissions));
    localStorage.setItem('user', JSON.stringify({ id: 101, username: 'max164-reader' }));
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', navCollapsed: true }));
  }, { token: env.token, permissions: env.owner.permissions });
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
  }));
});
async function capture(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(name + '.png'), fullPage: true });
}
async function seed(level: string, title: string, instance = 101, date = '2026-10-15 00:00:00', status = 'acknowledged') {
  await env.pool.query('INSERT INTO alerts (instance_id,target_type,alert_type,level,title,message,status,created_at) VALUES (?,\'instance\',\'performance\',?,?,\'等级验收数据\',?,?)', [instance, level, title, status, date]);
}

test('real SQL/JWT list, cross-page P0 filter, full counts, details and escalation persistence', async ({ page }) => {
  // P0 is older than 50 warning rows, so client-only filtering cannot find it.
  await seed('p0', '历史P0');
  for (let i = 0; i < 51; i++) await seed('warning', `新警告 ${i}`, 101, '2026-10-15 01:00:00');
  await seed('error', '错误级'); await seed('critical', '严重级'); await seed('info', '提示级');
  await seed('p0', '不可见P0', 102); await seed('p0', '已恢复P0', 101, '2026-10-15 00:00:00', 'resolved');
  await page.goto(`${env.url}/events?view=active`);
  const view = page.locator('alerts-page'); const list = view.locator('alert-list');
  await expect(list.locator('tbody tr')).toHaveCount(50);
  await expect(list.locator('[aria-label="等级统计"]')).toContainText('紧急（P0）：1');
  await expect(list.locator('[aria-label="等级统计"]')).toContainText('错误：1');
  await expect(list.locator('[aria-label="等级统计"]')).toContainText('警告：51');
  await capture(page, 'real-all-levels');
  await list.getByRole('button', { name: '下一页' }).click();
  const response = page.waitForResponse(r => r.url().includes('level=p0') && r.status() === 200);
  await list.getByRole('combobox', { name: '告警等级', exact: true }).selectOption('p0');
  const body = await (await response).json();
  expect(body.total).toBe(1); expect(body.level_counts).toEqual({ p0: 1, critical: 1, error: 1, warning: 51, info: 1 });
  await expect(list.locator('tbody tr')).toHaveCount(1);
  await expect(list.locator('tbody')).toContainText('历史P0');
  await expect(list.locator('tbody app-badge[variant="danger"]').first()).toHaveText('紧急（P0）');
  await list.getByRole('button', { name: '详情', exact: true }).click();
  const modal = view.locator('alert-detail-modal');
  await expect(modal.locator('app-badge').first()).toHaveText('紧急（P0）');
  await capture(page, 'real-p0-detail');
  await page.keyboard.press('Escape');
  await expect(modal.locator('app-dialog')).toHaveCount(0);
  await list.getByRole('button', { name: '已恢复', exact: false }).click();
  await expect(list.locator('tbody')).toContainText('已恢复P0');
  await expect(list.locator('[aria-label="等级统计"]')).toContainText('紧急（P0）：1');

  // Exercise an existing persisted critical→P0 rule, as seeded by the product.
  await env.pool.query("INSERT INTO escalation_rules (name,from_level,to_level,trigger_condition,trigger_value,enabled) VALUES ('Critical → P0 (60min)','critical','p0','timeout_minutes',60,1)");
  await page.goto(`${env.url}/events?view=rules`);
  await view.getByRole('button', { name: '升级规则', exact: true }).click();
  await expect(view.locator('tbody')).toContainText('紧急（P0）');
  await view.getByRole('button', { name: '编辑', exact: true }).first().click();
  const edit = view.locator('app-dialog[title="编辑升级规则"]');
  await expect(edit.locator('select').nth(1)).toHaveValue('p0');
  const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/api/alerts/escalation/rules/'));
  await edit.getByRole('button', { name: '保存', exact: true }).focus(); await page.keyboard.press('Enter');
  expect((await (await saved).json()).success).toBe(true);
  const [rules] = await env.pool.query('SELECT from_level,to_level FROM escalation_rules ORDER BY id DESC LIMIT 1');
  expect(rules[0]).toMatchObject({ from_level: 'critical', to_level: 'p0' });
  await capture(page, 'real-escalation-p0');
});

test('real empty, live permission revocation, controlled loading/failure/unknown and keyboard retry', async ({ page }) => {
  await page.goto(`${env.url}/events?view=active`); const list = page.locator('alert-list');
  await expect(list.getByText('暂无活跃告警', { exact: true })).toBeVisible(); await capture(page, 'real-empty');
  await env.pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='alert:view'");
  try {
    await list.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(list.getByRole('alert')).toContainText('无权查看告警');
    await expect(list.getByText('暂无活跃告警', { exact: true })).toHaveCount(0); await capture(page, 'real-403');
  } finally { await env.pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions WHERE code='alert:view'"); }
  let state: 'loading' | 'failed' | 'unknown' = 'loading';
  let release!: () => void;
  await page.route('**/api/alerts?*', async route => {
    if (state === 'loading') await new Promise<void>(resolve => release = resolve);
    return route.fulfill({ status: state === 'failed' ? 503 : 200, json: state === 'failed' ? {} : {
      items: [{ id: 1, severity: 'future', title: '受控未知等级', message: '受控兼容状态', status: 'acknowledged', created_at: '2026-10-15T00:00:00Z' }], total: 1, level_counts: { future: 1 } } });
  });
  await list.getByRole('button', { name: '重试', exact: true }).click();
  await expect(list.getByRole('status')).toBeVisible(); await capture(page, 'controlled-loading');
  state = 'failed'; release();
  await expect(list.getByRole('alert')).toContainText('HTTP 503'); await capture(page, 'controlled-503');
  state = 'unknown'; await list.getByRole('button', { name: '重试', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(list.locator('tbody app-badge[variant="muted"]').first()).toHaveText('未知等级（future）');
  await expect(list.locator('[aria-label="等级统计"]')).toContainText('未知等级（future）：1');
  await list.getByRole('combobox', { name: '告警等级', exact: true }).selectOption('future');
  await expect(list.locator('tbody tr')).toHaveCount(1);
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; document.documentElement.style.colorScheme = theme; }, theme);
    await capture(page, `controlled-unknown-${width}-${theme}`);
  }
});
