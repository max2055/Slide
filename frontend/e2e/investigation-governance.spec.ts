import { test, expect, type Page } from '@playwright/test';
import type { ResultSetHeader } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { startInvestigationServer } from './fixtures/investigation-server.ts';
import { MysqlInvestigationBudgetLedger } from '../../apps/db-ops-api/src/investigations/budget-ledger.js';
import { investigationBudgetConfiguration } from '../../apps/db-ops-api/src/investigations/session-bridge.js';
import { INVESTIGATION_PROFILES, investigationProfileHash } from '../../apps/db-ops-api/src/investigations/profiles.js';
import { provisionInvestigationServiceIdentity } from '../../apps/db-ops-api/src/investigations/authorization.js';

let env: Awaited<ReturnType<typeof startInvestigationServer>>;
let manager: Awaited<ReturnType<typeof env.contexts.loadActiveActor>>;
let pageErrors: string[] = [];
const basePermissions = ['config:view', 'chat:view'];
const fullPermissions = [...basePermissions, 'ai:view', 'config:manage'];
async function grant(codes = fullPermissions) {
  await env.pool.query('DELETE FROM role_permissions WHERE role_id=103');
  for (const code of codes) await env.pool.query('INSERT INTO role_permissions (role_id,permission_id) SELECT 103,id FROM permissions WHERE code=?', [code]);
}
test.beforeAll(async () => {
  env = await startInvestigationServer();
  await env.pool.query("INSERT INTO users (id,username,password_hash) VALUES (103,'governance-manager','no-login')");
  await env.pool.query("INSERT INTO roles (id,name) VALUES (103,'governance-management')");
  await env.pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (103,103)');
  await grant(); manager = await env.contexts.loadActiveActor(103);
});
test.afterAll(async () => { if (env) { try { expect(env.workerErrors).toEqual([]); expect(env.observationErrors).toEqual([]); expect(env.counts()).toEqual({ toolCalls: 0, providerCalls: 0 }); } finally { await env.close(); } } });
test.beforeEach(async ({ page }, info) => {
  pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await env.pool.query('UPDATE users SET session_version=1 WHERE id=103');
  await grant(); env.governanceStorage(true);
  // Each scenario owns its fixture independently, including focused selections
  // and Playwright's fresh worker after a failure. Never rely on an earlier test.
  for (const table of ['investigation_budget_resources', 'investigation_budget_ledger', 'investigation_budget_domains', 'investigation_requests', 'investigation_resources', 'investigations', 'chat_sessions']) await env.pool.query(`DELETE FROM ${table}`);
  if (!info.title.startsWith('real unconfigured')) {
    await reserve('settled'); await reserve('cancelled'); await reserve('settled', false);
    await reserve('unknown'); await reserve('sent'); await reserve('reserved', true, 'EUR'); await reserve('settled', true, 'EUR');
  }
});
test.afterEach(async () => { env.governanceStorage(true); await grant(); expect(pageErrors).toEqual([]); });
test.setTimeout(60_000);
async function login(page: Page, permissions = fullPermissions, theme = 'light') {
  // Keep the exact same JWT during SQL revoke/restore. UI permissions are only
  // the initial caller ceiling; real routes reload live SQL authorization.
  await page.addInitScript(({ token, permissions, theme }) => {
    localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify({ id: 103, username: 'governance-manager' }));
    localStorage.setItem('permissions', JSON.stringify(permissions));
    localStorage.setItem('slide.i18n.locale', 'zh-CN'); localStorage.setItem('app-theme-mode', theme);
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', navCollapsed: true, themeMode: theme }));
  }, { token: env.token(manager), permissions, theme });
}
const view = (page: Page) => page.locator('investigation-governance-page');
async function read(page: Page, kind: string) {
  await page.goto(`${env.url}/settings/ai/${kind}`);
  await expect(view(page).getByRole('heading', { name: { policies: '调查策略', budget: '有效预算', usage: '用量与成本' }[kind], exact: true })).toBeVisible();
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of ['investigation_alert_owners', 'investigation_budget_domains', 'investigation_budget_ledger', 'investigation_budget_resources', 'investigation_requests', 'investigations', 'investigation_resources', 'chat_sessions', 'chat_messages', 'workflow_jobs', 'outbox_events', 'operational_events']) {
    result[table] = (await env.pool.query(`SELECT * FROM ${table}`))[0];
  }
  return result;
}
async function reserve(state: 'reserved' | 'sent' | 'unknown' | 'settled' | 'cancelled', prices = true, currency = 'USD') {
  const investigation = randomUUID(), request = randomUUID(), config = investigationBudgetConfiguration();
  await env.pool.query("INSERT INTO chat_sessions (session_id,user_id,title) VALUES (?,101,'private governance fixture')", [investigation]);
  await env.pool.query("INSERT INTO investigations (id,title,goal,profile_id,profile_version,session_id,owner_kind,owner_id,scope_version) VALUES (?,'private fact','private goal','ops',1,?,'user',101,?)", [investigation, investigation, 'a'.repeat(64)]);
  await env.pool.query("INSERT INTO investigation_resources VALUES (?,'instance',9181,'primary')", [investigation]);
  await env.pool.query("INSERT INTO investigation_requests (id,investigation_id,actor_kind,actor_id,idempotency_key,request_hash,request_snapshot,job_id,accepted_version) VALUES (?,?,'user',101,?,?,?,?,1)",
    [request, investigation, request, 'b'.repeat(64), JSON.stringify({ profileId: 'ops', profileVersion: 1, authority: { profileHash: investigationProfileHash(INVESTIGATION_PROFILES.ops) } }), randomUUID()]);
  const ledger = new MysqlInvestigationBudgetLedger(() => env.pool, { ...config.policy, currency });
  const allocation = await ledger.reserve({ requestId: request, operationId: 'governance-browser-fixture', domain: currency === 'USD' ? config.domain : `t06-${currency}`, mode: 'manual',
    profile: INVESTIGATION_PROFILES.ops, reserveTokens: 1000, reserveCostMicros: 2000,
    ...(prices ? { prices: { input: 1_000_000, cachedInput: 100_000, output: 2_000_000 } } : {}) });
  expect(allocation.accepted).toBe(true); if (!allocation.accepted) throw new Error('Fixture reservation denied');
  if (state === 'cancelled') await ledger.cancelUnsent(allocation.reservation.id);
  if (['sent', 'unknown', 'settled'].includes(state)) await ledger.markSent(allocation.reservation.id);
  if (state === 'unknown') await ledger.settle(allocation.reservation.id, null);
  if (state === 'settled') await ledger.settle(allocation.reservation.id, { inputTokens: 100, cachedInputTokens: 40, outputTokens: 50 });
}

test('real unconfigured policies, uninitialized effective budget and empty persistent usage are read-only', async ({ page }) => {
  const before = await snapshot(); await login(page);
  await read(page, 'policies'); await expect(view(page)).toContainText('尚未配置'); await expect(view(page)).toContainText('尚未接入');
  await read(page, 'budget'); await expect(view(page)).toContainText('尚未初始化冻结预算');
  await expect(view(page)).toContainText('有效预算（可编辑）');
  await expect(view(page)).toContainText('当前默认值');
  await expect(view(page).locator('[data-budget="editor"]')).toContainText('运行时分配');
  await expect(view(page).getByRole('button', { name: '保存有效预算' })).toBeDisabled();
  await expect(view(page).locator('[data-budget="loader"]')).toContainText(String(investigationBudgetConfiguration().policy.maxConcurrent));
  await read(page, 'usage'); await expect(view(page).locator('app-empty-state')).toHaveAttribute('title', '暂无持久用量');
  expect(await snapshot()).toEqual(before);
});
test('real durable five-state/mixed-rate/two-currency facts use grouped paging and inclusive cached input', async ({ page }) => {
  const before = await snapshot(); await login(page); await read(page, 'usage');
  await view(page).getByRole('button', { name: '查看汇总口径' }).click();
  const totals = view(page).locator('[data-usage="totals"]');
  await expect(totals).toContainText('Reservation 总数7'); await expect(totals).toContainText('分组总数6');
  await expect(totals).toContainText('已知用量数3'); await expect(totals).toContainText('未知用量数1'); await expect(totals).toContainText('待返回用量数1');
  await view(page).getByText('精确成本值', { exact: true }).click();
  await expect(view(page).locator('[data-currency="USD"]')).toContainText('USD 0.000164（164 micro）');
  await expect(view(page).locator('[data-currency="USD"]')).toContainText('USD 0.006000（6000 micro）');
  await expect(view(page).locator('[data-currency="EUR"]')).toContainText('EUR 0.000164（164 micro）');
  await page.keyboard.press('Escape');
  await view(page).locator('[data-usage-group="USD/settled/manual"]').click();
  const settled = view(page).locator('app-dialog');
  await expect(settled).toContainText('已知输入 Token 小计200'); await expect(settled).toContainText('其中缓存输入80');
  await expect(settled).toContainText('已知输出 Token 小计100'); await expect(settled).toContainText('未知成本数（含缺费率）1');
  await page.keyboard.press('Escape');
  await expect(view(page)).toContainText('非供应商实收'); await expect(view(page)).toContainText('不能当作零费用');
  await view(page).getByRole('combobox', { name: '每页分组' }).selectOption('5');
  await expect(view(page).locator('[data-usage-group]')).toHaveCount(5); await expect(view(page)).toContainText('当前分组 1–5 / 6');
  await view(page).getByRole('button', { name: '下一组页' }).click();
  await expect(view(page).locator('[data-usage-group]')).toHaveCount(1); await expect(view(page)).toContainText('当前分组 6–6 / 6');
  await expect(view(page).getByRole('button', { name: '下一组页' })).toBeDisabled();
  await view(page).getByRole('button', { name: '上一组页' }).click(); await expect(view(page).locator('[data-usage-group]')).toHaveCount(5);
  await page.reload(); await view(page).getByRole('button', { name: '查看汇总口径' }).click(); await expect(totals).toContainText('Reservation 总数7'); await page.keyboard.press('Escape'); await expect(view(page).locator('[data-usage-group]')).toHaveCount(6);
  expect(await snapshot()).toEqual(before);
});
test('effective budget matching and real frozen hash conflict never become a remaining balance', async ({ page }) => {
  await login(page); await read(page, 'budget'); await expect(view(page)).toContainText('当前配置与冻结预算匹配');
  const domain = investigationBudgetConfiguration().domain;
  const [rows] = await env.pool.query('SELECT policy_hash FROM investigation_budget_domains WHERE domain_key=?', [domain]);
  try {
    await env.pool.query('UPDATE investigation_budget_domains SET policy_hash=? WHERE domain_key=?', ['c'.repeat(64), domain]);
    await view(page).getByRole('button', { name: '刷新有效预算' }).click();
    await expect(view(page).getByRole('alert')).toContainText('冲突，不能视为可准入');
    await expect(view(page).locator('[data-budget="frozen"]')).toBeVisible(); await expect(view(page)).toContainText('额度不等于余额');
  } finally { await env.pool.query('UPDATE investigation_budget_domains SET policy_hash=? WHERE domain_key=?', [rows[0].policy_hash, domain]); }
});
test('R2 real durable governance visual evidence at both widths and themes', async ({ page }) => {
  const output = process.env.MAX157_OUTPUT_DIR ?? 'test-results/max157-ui-acceptance';
  await mkdir(output, { recursive: true });
  await login(page);
  for (const width of [1280, 390]) for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width, height: 950 });
    for (const kind of ['policies', 'budget', 'usage']) {
      await read(page, kind); await expect.poll(() => view(page).evaluate((e: any) => e.facts !== null)).toBe(true);
      await page.locator('slide-app').evaluate((e: any, theme) => e.applySettings({ ...e.settings, themeMode: theme }), theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme-mode', theme);
      await expect(view(page).getByRole('button', { name: /^刷新/ })).toBeEnabled();
      if (kind === 'budget') await expect(view(page).locator('[data-budget="editor"]')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${output}/${kind}-durable-${width}-${theme}-real-service.png`, fullPage: true, animations: 'disabled' });
      if (kind === 'budget') {
        await view(page).locator('[data-budget="editor"]').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/budget-editor-${width}-${theme}-real-service.png`, fullPage: true, animations: 'disabled' });
        await view(page).locator('[data-budget="frozen"]').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/budget-frozen-${width}-${theme}-real-service.png`, fullPage: true, animations: 'disabled' });
      }
      if (kind === 'usage') {
        await view(page).getByRole('heading', { name: '成本与额度' }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/usage-costs-${width}-${theme}-real-service.png`, fullPage: true, animations: 'disabled' });
        await view(page).locator('[data-usage-group="USD/unknown/manual"]').click();
        await expect(view(page).locator('app-dialog')).toContainText('未计量');
        await page.screenshot({ path: `${output}/usage-detail-${width}-${theme}-real-service.png`, fullPage: true, animations: 'disabled' });
        await page.keyboard.press('Escape');
      }
    }
  }
});
for (const permissions of [basePermissions, [...basePermissions, 'ai:view'], [...basePermissions, 'config:manage']]) {
  test(`navigation and direct management deep links do zero reads without intersection: ${permissions.join(',')}`, async ({ page }) => {
    await grant(permissions); await login(page, permissions);
    const reads: string[] = [];
    page.on('request', request => { if (/\/api\/investigation-(budget|usage)/.test(request.url())) reads.push(request.url()); });
    for (const kind of ['budget', 'usage']) {
      await page.goto(`${env.url}/settings/ai/${kind}`);
      await expect(page.locator('settings-shell').locator('app-empty-state').first()).toHaveAttribute('title', '无权访问');
      await expect(view(page)).toHaveCount(0);
    }
    expect(reads).toEqual([]);
    if (permissions.includes('ai:view')) { await read(page, 'policies'); await expect(view(page)).toContainText('尚未配置'); }
  });
}
for (const kind of ['policies', 'budget', 'usage']) {
  test(`${kind}: same JWT SQL revocation returns real HTTP403, erases facts and restores only after explicit read`, async ({ page }) => {
    await login(page); await read(page, kind); await expect.poll(() => view(page).evaluate((e: any) => e.facts !== null)).toBe(true);
    await grant(kind === 'policies' ? basePermissions : [...basePermissions, 'ai:view']);
    const response = page.waitForResponse(r => r.url().includes(`/api/investigation-${kind}`) && r.status() === 403);
    await view(page).getByRole('button', { name: `刷新${{ policies: '调查策略', budget: '有效预算', usage: '用量与成本' }[kind]}` }).click(); await response;
    await expect(view(page).getByRole('alert')).toContainText('无权访问'); expect(await view(page).evaluate((e: any) => e.facts)).toBeNull();
    await grant(); await view(page).getByRole('button', { name: /^刷新/ }).click();
    await expect.poll(() => view(page).evaluate((e: any) => e.facts !== null)).toBe(true);
  });
}
test('real storage unavailability HTTP503 removes old costs and retry recovers', async ({ page }) => {
  await login(page); await read(page, 'usage'); await expect(view(page).getByRole('button', { name: '查看汇总口径' })).toBeVisible();
  env.governanceStorage(false);
  const failed = page.waitForResponse(r => r.url().includes('/api/investigation-usage') && r.status() === 503);
  await view(page).getByRole('button', { name: '刷新用量与成本' }).click(); await failed;
  await expect(view(page).getByRole('alert')).toContainText('暂不可用'); await expect(view(page).locator('[data-currency]')).toHaveCount(0);
  expect(await view(page).evaluate((e: any) => e.facts)).toBeNull(); env.governanceStorage(true);
  await view(page).getByRole('button', { name: '刷新用量与成本' }).click(); await expect(view(page).locator('[data-usage-group]')).toHaveCount(6);
});
test('SQL Session revocation sends real HTTP401 and erases displayed facts', async ({ page }) => {
  await login(page); await read(page, 'usage'); await expect(view(page).locator('[data-usage-group]')).toHaveCount(6);
  await page.evaluate(() => { (window as any).governanceOriginal = document.querySelector('settings-shell')?.shadowRoot?.querySelector('investigation-governance-page'); });
  await env.pool.query('UPDATE users SET session_version=session_version+1 WHERE id=103');
  const rejected = page.waitForResponse(r => r.url().includes('/api/investigation-usage') && r.status() === 401);
  await view(page).getByRole('button', { name: '刷新用量与成本' }).click(); await rejected;
  await expect.poll(() => page.evaluate(() => (window as any).governanceOriginal.facts)).toBeNull();
  await expect(view(page).locator('[data-currency]')).toHaveCount(0);
});
for (const boundary of ['revocation', 'http-rejection', 'refresh', 'selection', 'disconnect', 'pagination'] as const) {
  test(`delayed real HTTP200 cannot restore facts after ${boundary}`, async ({ page }) => {
    await login(page); await read(page, 'usage'); await expect(view(page).getByRole('button', { name: '查看汇总口径' })).toBeVisible();
    let release!: () => void, arrived!: () => void, delivered!: () => void;
    const held = new Promise<void>(r => release = r), fetched = new Promise<void>(r => arrived = r), done = new Promise<void>(r => delivered = r);
    let first = true;
    await page.evaluate(() => {
      const element = document.querySelector('settings-shell')?.shadowRoot?.querySelector('investigation-governance-page') as any;
      (window as any).governanceOriginal = element; (window as any).governanceReads = [];
      const load = element.load.bind(element);
      element.load = (...args: unknown[]) => { const pending = load(...args); (window as any).governanceReads.push(pending); return pending; };
    });
    // Hold a genuine authorized response; do not fabricate facts.
    await page.route('**/api/investigation-usage?*', async route => {
      if (!first) return route.continue(); first = false;
      const response = await route.fetch(); expect(response.status()).toBe(200); arrived(); await held;
      try { await route.fulfill({ response }); } finally { delivered(); }
    });
    try {
      const button = boundary === 'pagination' ? view(page).getByRole('combobox', { name: '每页分组' }) : view(page).getByRole('button', { name: '刷新用量与成本' });
      if (boundary === 'pagination') await button.selectOption('5'); else await button.click(); await fetched;
      if (boundary === 'revocation') {
        await grant(basePermissions);
        const response = await page.request.get(`${env.url}/api/auth/permissions`, { headers: { Authorization: `Bearer ${env.token(manager)}` } });
        expect(response.status()).toBe(200); const permissions = await response.json();
        await page.evaluate(permissions => window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions } })), permissions);
      } else if (boundary === 'http-rejection') {
        await grant([...basePermissions, 'ai:view']);
        const rejected = page.waitForResponse(r => r.url().includes('/api/investigation-usage') && r.status() === 403);
        await page.evaluate(() => (window as any).governanceOriginal.load()); await rejected;
        await expect(view(page).getByRole('alert')).toContainText('无权访问');
      } else if (boundary === 'selection') {
        await page.locator('settings-shell').getByRole('button', { name: '调查策略', exact: true }).click();
        await expect(view(page)).toContainText('尚未配置');
      } else if (boundary === 'disconnect') {
        await page.evaluate(() => (window as any).governanceOriginal.remove());
      } else if (boundary === 'pagination') {
        await page.evaluate(() => (window as any).governanceOriginal.load(5));
        await expect(view(page)).toContainText('当前分组 6–6 / 6');
      } else {
        // Supersede the pending 200 with a genuinely unavailable newer read.
        env.governanceStorage(false);
        await page.evaluate(() => (window as any).governanceOriginal.load());
        await expect(view(page).getByRole('alert')).toContainText('暂不可用');
      }
      release(); await done;
      await page.evaluate(async () => { await (window as any).governanceReads[0]; });
      const facts = await page.evaluate(() => (window as any).governanceOriginal.facts);
      if (boundary === 'selection') { expect(facts).toMatchObject({ configurationStatus: 'not_configured' }); }
      else if (boundary === 'pagination') { expect(facts.items).toHaveLength(1); await expect(view(page)).toContainText('当前分组 6–6 / 6'); }
      else expect(facts).toBeNull();
      if (boundary !== 'pagination') await expect(view(page).locator('[data-currency]')).toHaveCount(0);
    } finally { release(); await done; }
  });
}
for (const width of [1600, 1024, 390]) {
  test(`governance settings ${width}px fit and retain keyboard access`, async ({ page }) => {
    await login(page); await page.setViewportSize({ width, height: 950 });
    for (const kind of ['policies', 'budget', 'usage']) {
      await read(page, kind); await expect.poll(() => view(page).evaluate((e: any) => e.facts !== null)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await view(page).evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
      const refresh = view(page).getByRole('button', { name: /^刷新/ }); await refresh.focus(); await expect(refresh).toBeFocused();
      const response = page.waitForResponse(r => r.url().includes(`/api/investigation-${kind}`) && r.status() === 200);
      await page.keyboard.press('Enter'); await response;
      await expect.poll(() => view(page).evaluate((e: any) => e.facts !== null)).toBe(true);
    }
    await page.screenshot({ path: `test-results/t06-governance-${width}.png`, fullPage: true });
  });
}

test('real durable wiring, execution outcomes and receipt history stay separate under live revocation', async ({ page }) => {
  let serviceId = 0, roleId = 0;
  const investigation = randomUUID(), request = randomUUID(), job = randomUUID();
  try {
    // A dedicated service principal, never the interactive manager.
    serviceId = await provisionInvestigationServiceIdentity(env.pool as never, 't06-wiring');
    const [role] = await env.pool.query("INSERT INTO roles (name) VALUES ('t06-wiring-service')");
    roleId = Number((role as ResultSetHeader).insertId);
    await env.pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (?,?)', [serviceId, roleId]);
    for (const code of ['chat:view', 'instance:view']) await env.pool.query(
      'INSERT INTO role_permissions (role_id,permission_id) SELECT ?,id FROM permissions WHERE code=?', [roleId, code]);
    await env.pool.query("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (?,101,'read-only')", [serviceId]);
    Object.assign(process.env, { INVESTIGATION_OPS_AUTO_ENABLED: 'true', INVESTIGATION_OPS_SERVICE_USER_ID: String(serviceId),
      INVESTIGATION_OPS_INSTANCE_IDS: '101' });
    delete process.env.INVESTIGATION_OPS_SERVER_IDS; delete process.env.INVESTIGATION_OPS_NETWORK_DEVICE_IDS;
    await env.pool.query("REPLACE INTO system_config (config_key,config_value) VALUES ('auto_analysis_config',?)", [JSON.stringify({
      enabled: true, cronExpression: '*/30 * * * *', severityLevels: ['warning', 'error', 'critical'],
      instanceWhitelist: [], timeWindowStart: '00:00', timeWindowEnd: '23:59' })]);
    // Durable automatic ownership, an accepted request and a real workflow job.
    await env.pool.query("INSERT INTO chat_sessions (session_id,user_id,title) VALUES (?,101,'wiring fixture')", [investigation]);
    await env.pool.query(`INSERT INTO investigations (id,title,goal,profile_id,profile_version,session_id,owner_kind,owner_id,
      scope_version,active_request_id) VALUES (?, 'wiring fixture','wiring goal','ops',1,?,'service',?,?,?)`,
    [investigation, investigation, serviceId, 'c'.repeat(64), request]);
    await env.pool.query("INSERT INTO investigation_resources VALUES (?,'instance',101,'primary')", [investigation]);
    await env.pool.query(`INSERT INTO investigation_requests (id,investigation_id,actor_kind,actor_id,idempotency_key,
      request_hash,request_snapshot,job_id,accepted_version) VALUES (?,?,'service',?,?,?,?,?,1)`,
    [request, investigation, serviceId, request, 'd'.repeat(64), JSON.stringify({ profileId: 'ops', profileVersion: 1 }), job]);
    await env.pool.query(`INSERT INTO workflow_jobs (id,job_type,schema_version,payload,idempotency_key,state)
      VALUES (?, 'investigation.execute',1,?,?,'completed')`, [job, JSON.stringify({ investigationId: investigation, requestId: request }), `wiring:${request}`]);
    await env.pool.query("DELETE FROM alerts WHERE id = 9501");
    await env.pool.query(`INSERT INTO alerts (id,instance_id,alert_type,level,title,message,source,tags)
      VALUES (9501,101,'performance','warning','wiring alert','fixture','alert-engine',?)`,
    [JSON.stringify({ auto_analysis: { status: 'accepted', reason: null, attemptedAt: '2026-10-25T00:00:00.000Z' } })]);
    await env.pool.query("INSERT INTO investigation_alert_owners (alert_id,lane,command_snapshot,investigation_id) VALUES (9501,'investigation',?,?)",
      [JSON.stringify({ trigger: 'auto' }), investigation]);

    const before = await snapshot();
    await login(page); await read(page, 'policies');
    await expect.poll(() => view(page).evaluate((e: any) => e.facts !== null)).toBe(true);
    await expect(view(page)).toContainText('已确认入口接线');
    await expect(view(page)).toContainText('历史回执（全部告警）');
    await expect(view(page)).toContainText('最近执行结果');
    await expect(view(page)).toContainText('已完成');
    await expect(view(page)).toContainText('已观察接线的资源类型');
    await expect(view(page)).toContainText('数据库');
    // Keyboard refresh is side-effect free across every durable table.
    const refresh = view(page).getByRole('button', { name: '刷新调查策略' });
    await refresh.focus(); await expect(refresh).toBeFocused();
    const refreshed = page.waitForResponse(r => r.url().includes('/api/investigation-policies') && r.status() === 200);
    await page.keyboard.press('Enter'); await refreshed;
    await expect.poll(() => view(page).evaluate((e: any) => e.facts?.execution?.completed)).toBe(1);
    expect(await snapshot()).toEqual(before);

    // Live service-principal revocation removes availability, not just text.
    await env.pool.query('DELETE FROM instance_permissions WHERE user_id=? AND instance_id=101', [serviceId]);
    const revoked = page.waitForResponse(r => r.url().includes('/api/investigation-policies') && r.status() === 200);
    await refresh.click(); await revoked;
    await expect(view(page)).toContainText('缺少实例级授权');
    await expect.poll(() => view(page).evaluate((e: any) => e.facts?.automaticAnalysisStatus)).toBe('blocked');
    await expect(view(page)).toContainText('自动分析尚不可用');
    await env.pool.query("INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (?,101,'read-only')", [serviceId]);

    // An old suppressed receipt without durable ownership never becomes wired.
    await env.pool.query('DELETE FROM investigation_alert_owners WHERE alert_id=9501');
    await env.pool.query('DELETE FROM investigation_requests WHERE investigation_id=?', [investigation]);
    await env.pool.query('DELETE FROM investigation_resources WHERE investigation_id=?', [investigation]);
    await env.pool.query('DELETE FROM investigations WHERE id=?', [investigation]);
    await env.pool.query('DELETE FROM chat_sessions WHERE session_id=?', [investigation]);
    await env.pool.query('DELETE FROM workflow_jobs WHERE id=?', [job]);
    await env.pool.query('UPDATE alerts SET tags=? WHERE id=9501', [JSON.stringify({
      auto_analysis: { status: 'suppressed', reason: 'RESOURCE_ALERT_PILOT_UNCONFIGURED', attemptedAt: '2020-01-01T00:00:00.000Z' } })]);
    const stale = page.waitForResponse(r => r.url().includes('/api/investigation-policies') && r.status() === 200);
    await refresh.click(); await stale;
    await expect(view(page)).toContainText('未观察到持久入口证据');
    await expect(view(page)).toContainText('尚无持久执行');
    await expect(view(page).getByRole('alert')).toContainText('自动分析待验证入口');
    await expect(view(page)).not.toContainText('已确认入口接线');
    const [remainingAlerts] = await env.pool.query('SELECT id FROM alerts WHERE id = 9501');
    expect(remainingAlerts).toHaveLength(1);
  } finally {
    for (const key of ['INVESTIGATION_OPS_AUTO_ENABLED', 'INVESTIGATION_OPS_SERVICE_USER_ID', 'INVESTIGATION_OPS_INSTANCE_IDS',
      'INVESTIGATION_OPS_SERVER_IDS', 'INVESTIGATION_OPS_NETWORK_DEVICE_IDS']) delete process.env[key];
    await env.pool.query("DELETE FROM system_config WHERE config_key='auto_analysis_config'");
    await env.pool.query('DELETE FROM investigation_alert_owners');
    await env.pool.query('DELETE FROM alerts WHERE id=9501');
    await env.pool.query('DELETE FROM investigation_requests WHERE investigation_id=?', [investigation]);
    await env.pool.query('DELETE FROM investigation_resources WHERE investigation_id=?', [investigation]);
    await env.pool.query('DELETE FROM investigations WHERE id=?', [investigation]);
    await env.pool.query('DELETE FROM chat_sessions WHERE session_id=?', [investigation]);
    await env.pool.query('DELETE FROM workflow_jobs WHERE id=?', [job]);
    if (serviceId) {
      await env.pool.query('DELETE FROM instance_permissions WHERE user_id=?', [serviceId]);
      await env.pool.query('DELETE FROM user_roles WHERE user_id=?', [serviceId]);
      await env.pool.query('DELETE FROM users WHERE id=?', [serviceId]);
    }
    if (roleId) await env.pool.query('DELETE FROM roles WHERE id=?', [roleId]);
    await grant();
  }
});
