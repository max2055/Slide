import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { startInvestigationServer } from './fixtures/investigation-server.ts';
import { configuredProvider, budgetState } from './max174-provider.ts';

let env: Awaited<ReturnType<typeof startInvestigationServer>>, real: Awaited<ReturnType<typeof configuredProvider>> | undefined;
let actor: typeof env.owner, id = '';
const output = process.env.MAX174_OUTPUT_DIR ?? 'test-results/max174';
const resourceName = '生产订单库 · 北京核心业务与跨区订单延迟调查的长名称验收资源';
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  await mkdir(output, { recursive: true });
  if (process.env.MAX174_REAL_PROVIDER === '1') real = await configuredProvider(output);
  env = await startInvestigationServer({ uiAcceptance: true, realProvider: real?.provider });
  await env.pool.query('INSERT IGNORE INTO role_permissions (role_id,permission_id) SELECT 101,id FROM permissions');
  await env.pool.query('UPDATE database_instances SET name=? WHERE id=101', [resourceName]);
  await env.pool.query("INSERT INTO servers (id,host,label,port,os_type,credential_type,credential_encrypted,status) VALUES (102,'max174.fixture.invalid','订单应用节点',22,'linux','password','unused','offline')");
  await env.pool.query("INSERT INTO network_devices (id,name,host,vendor,status) VALUES (103,'核心网络设备','max174-network.fixture.invalid','huawei','unknown')");
  actor = await env.contexts.loadActiveActor(101);
});
test.afterAll(async () => {
  try { if (env) { expect(env.workerErrors).toEqual([]); await env.close(); } }
  finally { if (real) await writeFile(`${output}/model-budget-final.json`, JSON.stringify(real.finish(), null, 2)); }
});
async function login(page: Page, theme = 'light', currentActor = actor) {
  await page.addInitScript(({ token, actor, theme }) => {
    localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify({ id: actor.userId, username: actor.username }));
    localStorage.setItem('permissions', JSON.stringify(actor.permissions)); localStorage.setItem('slide.i18n.locale', 'zh-CN');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', theme: 'claw', themeMode: theme, navCollapsed: true }));
  }, { token: env.token(currentActor), actor: currentActor, theme });
}
async function capture(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true, animations: 'disabled' });
  await writeFile(`${output}/${name}.json`, JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), viewport: page.viewportSize(), theme: await page.evaluate(() => document.documentElement.dataset.themeMode), source: name.includes('controlled') ? 'controlled response/state' : real ? 'real JWT/SQL/HTTP/WS and deepseek-flash; synthetic resource/tool data' : 'real JWT/SQL/HTTP/WS; controlled provider and synthetic resource/tool data', page: new URL(page.url()).pathname + new URL(page.url()).search }, null, 2));
}
async function theme(page: Page, mode: string) { await page.evaluate(mode => { document.documentElement.dataset.themeMode = mode; }, mode); }
async function observed(page: Page) { await expect.poll(() => page.evaluate(() => (document.querySelector('investigations-page') as any)?.controller?.online)).toBe(true); }

test('representative: real inventory → mixed-resource create → refresh → continue, then design comparison', async ({ page }) => {
  await login(page); await page.goto(`${env.url}/investigations`);
  const view = page.locator('investigations-page');
  await expect(view).toContainText('让资源证据，汇成可追溯的调查。'); await expect(view.getByRole('tab')).toHaveCount(0);
  for (const width of [1440, 768, 390]) for (const mode of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 950 }); await theme(page, mode); await capture(page, `first-use-${width}-${mode}-real-service`);
  }
  await page.setViewportSize({ width: 1440, height: 950 }); await theme(page, 'light');
  const trigger = page.getByRole('button', { name: '创建手动调查', exact: true }); await trigger.click();
  await page.getByLabel('调查标题', { exact: true }).fill('订单延迟：真实资源选择闭环');
  await page.getByLabel('调查目标', { exact: true }).fill('仅使用已选择的合成验收资源：请调用 get_instance_summary，instance_id=101，读取一次合成只读指标并给出简短中文摘要，标注根因待验证，不推断真实业务恢复。');
  await page.getByLabel('搜索资源', { exact: true }).fill('订单');
  await page.getByRole('checkbox', { name: `${resourceName} · 数据库实例`, exact: true }).check();
  await page.getByRole('checkbox', { name: '订单应用节点 · 服务器', exact: true }).check();
  await capture(page, 'resource-picker-1440-light-real-service');
  await page.setViewportSize({ width: 390, height: 950 }); await theme(page, 'dark'); await capture(page, 'resource-picker-390-dark-real-service');
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused(); await trigger.click();
  await page.getByRole('button', { name: '提交调查', exact: true }).click();
  await expect(page.locator('.investigation-states')).toContainText('执行完成', { timeout: 90_000 });
  id = new URL(page.url()).searchParams.get('investigation')!; expect(id).toBeTruthy();
  const [bindings] = await env.pool.query('SELECT resource_type,resource_id,role FROM investigation_resources WHERE investigation_id=? ORDER BY role', [id]);
  expect(bindings).toEqual([{ resource_type: 'instance', resource_id: 101, role: 'primary' }, { resource_type: 'server', resource_id: 102, role: 'related' }]);
  await page.reload(); await expect(page.locator('.investigation-states')).toContainText('执行完成'); await observed(page);
  await page.getByLabel('继续调查', { exact: true }).fill('请不要再次调用工具；仅依据上次已经返回的合成只读指标，用一句中文说明证据不足以确认根因。');
  await page.getByRole('button', { name: '提交新 Run', exact: true }).click();
  await expect.poll(async () => { const [rows] = await env.pool.query('SELECT COUNT(*) AS n FROM investigation_results WHERE investigation_id=?', [id]); return Number(rows[0].n); }, { timeout: 90_000 }).toBe(2);
  await expect(page.locator('.investigation-states')).toContainText('执行完成');
  for (const width of [1440, 768, 390]) for (const mode of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 950 }); await theme(page, mode); await capture(page, `existing-${width}-${mode}-real-service`);
  }
  await writeFile(`${output}/normal-flow.json`, JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), mode: real ? 'real deepseek-flash; synthetic tool data' : 'controlled provider; synthetic tool data', url: `/investigations?investigation=${id}`, bindings, model: real?.configuration, budget: real ? budgetState() : null, normalFlow: ['resource inventory', 'create', 'read', 'refresh', 'continue', 'two persisted results'] }, null, 2));
});

test('existing data, resource filtering, no-match, back/refresh, evidence focus and Profile clearing', async ({ page }) => {
  await login(page); await page.goto(`${env.url}/investigations`);
  await expect(page.getByRole('button', { name: /订单延迟：真实资源选择闭环/ })).toBeVisible();
  await page.getByText('按资源名称 / 类型筛选', { exact: false }).click();
  await page.getByRole('checkbox', { name: `${resourceName} · 数据库实例` }).check();
  await page.getByRole('checkbox', { name: '订单应用节点 · 服务器' }).check();
  await expect(page.locator('.workspace-list-count')).toContainText('已加载 1 项');
  await page.getByLabel('搜索调查', { exact: true }).fill('没有这样的调查'); await page.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.locator('investigations-page')).toContainText('暂无匹配调查');
  await capture(page, 'no-match-1280-light-real-service'); await page.reload(); await expect(page.getByLabel('搜索调查', { exact: true })).toHaveValue('没有这样的调查');
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await page.getByRole('button', { name: /订单延迟：真实资源选择闭环/ }).click(); await observed(page);
  await page.goBack(); await expect(page.getByLabel('继续调查', { exact: true })).toHaveCount(0);
  await page.goForward(); await expect(page.getByLabel('继续调查', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 768, height: 950 }); const evidence = page.getByRole('button', { name: '查看证据与成果' });
  await evidence.click(); await expect(page.getByRole('dialog', { name: '证据与成果' })).toBeVisible(); await page.keyboard.press('Escape'); await expect(evidence).toBeFocused();
  await page.getByRole('button', { name: '创建手动调查' }).click();
  await page.locator('investigation-create').getByRole('checkbox', { name: `${resourceName} · 数据库实例` }).check();
  await page.getByLabel('调查 Profile', { exact: true }).selectOption('system'); await expect(page.locator('investigation-create')).toContainText('已清除资源选择');
  await page.getByLabel('调查 Profile', { exact: true }).selectOption('ops'); await expect(page.locator('investigation-create').getByRole('checkbox').first()).not.toBeChecked();
  await page.keyboard.press('Escape');
});

test('unknown receipt verifies the original accepted request without duplicate investigation or Run', async ({ page }) => {
  test.skip(!!real, 'fault injection uses the controlled provider only');
  await login(page); await page.goto(`${env.url}/investigations`);
  await page.getByRole('button', { name: '创建手动调查' }).click();
  await page.getByLabel('调查标题', { exact: true }).fill('MAX174 未知回执核查'); await page.getByLabel('调查目标', { exact: true }).fill('只读核对合成指标');
  await page.getByRole('checkbox', { name: `${resourceName} · 数据库实例` }).check();
  let key: string | undefined; let created = '';
  await page.route('**/api/investigations', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    key = route.request().headers()['idempotency-key']; const response = await route.fetch(); created = (await response.json()).id;
    await route.fulfill({ status: 503, json: { error: 'INVESTIGATION_QUEUE_UNAVAILABLE' } });
  });
  await page.getByRole('button', { name: '提交调查', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对原请求', exact: true })).toBeVisible(); await expect(page.getByLabel('调查标题', { exact: true })).toBeDisabled();
  for (const width of [1440, 768, 390]) for (const mode of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 950 }); await theme(page, mode); await capture(page, `unknown-receipt-${width}-${mode}-controlled`);
  }
  await page.unroute('**/api/investigations');
  const receipt = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/investigations');
  await page.getByRole('button', { name: '核对原请求', exact: true }).click(); expect((await receipt).headers()['idempotency-key']).toBe(key);
  await expect(page).toHaveURL(new RegExp(`investigation=${created}`));
  const [rows] = await env.pool.query("SELECT COUNT(*) AS n FROM investigations WHERE title='MAX174 未知回执核查'"); expect(Number(rows[0].n)).toBe(1);
  const [runs] = await env.pool.query('SELECT COUNT(*) AS n FROM investigation_requests WHERE investigation_id=?', [created]); expect(Number(runs[0].n)).toBe(1);
});

test('controlled loading/failure/partial/permission states remain distinct and never create a fake success', async ({ page }) => {
  await login(page); await page.route('**/api/investigations?*', route => route.fulfill({ status: 503, json: { error: 'INVESTIGATION_QUEUE_UNAVAILABLE' } }));
  await page.goto(`${env.url}/investigations`); await expect(page.locator('.workspace-error')).toBeVisible(); await expect(page.getByText('让资源证据，汇成可追溯的调查。')).toHaveCount(0);
  await capture(page, 'list-failed-controlled'); await page.unroute('**/api/investigations?*');
  await page.route('**/api/resources', async route => { await new Promise(resolve => setTimeout(resolve, 600)); await route.fulfill({ status: 503, json: { error: 'UNAVAILABLE' } }); });
  await page.getByRole('button', { name: '创建手动调查' }).click(); await expect(page.getByText('正在加载有权限的资源…')).toBeVisible(); await capture(page, 'resources-loading-controlled');
  await expect(page.getByText('资源列表读取失败，请重试。')).toBeVisible(); await capture(page, 'resources-failed-controlled');
  await page.unroute('**/api/resources'); await page.route('**/api/resources', route => route.fulfill({ json: { items: [], dataQuality: 'partial', truncated: true, unavailableTypes: ['server'] } }));
  await page.getByRole('button', { name: '重试资源列表' }).click(); await expect(page.getByText(/仅检索已返回的前 500 项/)).toBeVisible(); await capture(page, 'resources-partial-controlled');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: [] } })));
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.locator('investigations-page')).toContainText('无访问权限'); await capture(page, 'permissions-revoked-controlled');
});


