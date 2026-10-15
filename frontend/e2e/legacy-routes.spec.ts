import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { startInvestigationServer } from './fixtures/investigation-server.ts';
import { MysqlInvestigationBudgetLedger } from '../../apps/db-ops-api/src/investigations/budget-ledger.js';
import { investigationBudgetConfiguration } from '../../apps/db-ops-api/src/investigations/session-bridge.js';
import { INVESTIGATION_PROFILES, investigationProfileHash } from '../../apps/db-ops-api/src/investigations/profiles.js';

// Real isolated MySQL/JWT/HTTP/WS; no product model or target tool calls.
let env: Awaited<ReturnType<typeof startInvestigationServer>>;
let manager: Awaited<ReturnType<typeof env.contexts.loadActiveActor>>;
test.beforeAll(async () => {
  env = await startInvestigationServer();
  await env.pool.query("INSERT INTO users (id,username,password_hash) VALUES (103,'legacy-reader','no-login')");
  await env.pool.query("INSERT INTO roles (id,name) VALUES (103,'legacy-reader')");
  await env.pool.query('INSERT INTO user_roles (user_id,role_id) VALUES (103,103)');
  await env.pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT 103,id FROM permissions WHERE code IN ('ai:view','config:manage')");
  manager = await env.contexts.loadActiveActor(103);
});
test.afterAll(async () => {
  if (env) try { expect(env.counts()).toEqual({ toolCalls: 0, providerCalls: 0 }); }
  finally { await env.close(); }
});
async function login(page: Page, permissions = manager.permissions) {
  await page.addInitScript(({ token, permissions }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('permissions', JSON.stringify(permissions));
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN', themeMode: 'light' }));
  }, { token: env.token(manager), permissions });
}
const notice = (page: Page) => page.locator('[data-legacy-route]');
const usage = (page: Page) => page.locator('investigation-governance-page');

for (const route of ['config', 'llm-usage']) {
  test(`direct /${route}, refresh, keyboard and back/forward preserve a usable page`, async ({ page }, info) => {
    await login(page);
    await page.goto(`${env.url}/${route}?bookmark=old`);
    await expect(notice(page)).toContainText('已停用');
    await page.reload();
    await expect(notice(page)).toBeVisible();
    const link = notice(page).getByRole('link');
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('settings-shell')).toBeVisible();
    await expect(page).toHaveURL(route === 'config' ? /\/settings\/platform\/branding/ : /\/settings\/ai\/usage/);
    await page.goBack();
    await expect(notice(page)).toContainText('已停用');
    await expect(page).toHaveURL(new RegExp(`/${route}\\?bookmark=old$`));
    await page.goForward();
    await expect(page.locator('settings-shell')).toBeVisible();
    await page.goBack();
    await page.screenshot({ path: info.outputPath(`${route}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.dataset.themeMode = 'dark'; document.documentElement.dataset.theme = 'claw-dark'; });
    await expect(notice(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${route}-mobile-dark.png`), fullPage: true });
  });
}

test('usage destination: real empty/data/unknown/failure, controlled loading, live SQL denial', async ({ page }, info) => {
  await login(page);
  await page.goto(`${env.url}/llm-usage`);
  await notice(page).getByRole('link').click();
  await expect(usage(page)).toContainText('暂无持久用量');
  await page.screenshot({ path: info.outputPath('usage-real-empty.png'), fullPage: true });

  const investigation = randomUUID(), request = randomUUID(), config = investigationBudgetConfiguration();
  await env.pool.query("INSERT INTO chat_sessions (session_id,user_id,title) VALUES (?,101,'legacy fixture')", [investigation]);
  await env.pool.query("INSERT INTO investigations (id,title,goal,profile_id,profile_version,session_id,owner_kind,owner_id,scope_version) VALUES (?,'legacy fixture','read only','ops',1,?,'user',101,?)", [investigation, investigation, 'a'.repeat(64)]);
  await env.pool.query("INSERT INTO investigation_requests (id,investigation_id,actor_kind,actor_id,idempotency_key,request_hash,request_snapshot,job_id,accepted_version) VALUES (?,?,'user',101,?,?,?,?,1)",
    [request, investigation, request, 'b'.repeat(64), JSON.stringify({ profileId: 'ops', profileVersion: 1, authority: { profileHash: investigationProfileHash(INVESTIGATION_PROFILES.ops) } }), randomUUID()]);
  const ledger = new MysqlInvestigationBudgetLedger(() => env.pool, config.policy);
  const allocation = await ledger.reserve({ requestId: request, operationId: 'legacy-read-test', domain: config.domain, mode: 'manual', profile: INVESTIGATION_PROFILES.ops, reserveTokens: 1000, reserveCostMicros: 2000 });
  if (!allocation.accepted) throw new Error('Fixture reservation denied');
  await ledger.markSent(allocation.reservation.id);
  await ledger.settle(allocation.reservation.id, null);
  await usage(page).getByRole('button', { name: '刷新用量与成本' }).click();
  await expect(usage(page)).toContainText('1 条用量未知');
  await expect(usage(page).locator('[data-usage-group]')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('usage-real-unknown.png'), fullPage: true });

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/investigation-usage?**', async route => { await gate; await route.continue(); });
  await usage(page).getByRole('button', { name: '刷新用量与成本' }).click();
  await expect(usage(page).getByRole('status')).toContainText('正在加载');
  await page.screenshot({ path: info.outputPath('usage-controlled-loading.png'), fullPage: true });
  release();
  await expect(usage(page)).toContainText('1 条用量未知');
  await page.unroute('**/api/investigation-usage?**');

  env.governanceStorage(false);
  await usage(page).getByRole('button', { name: '刷新用量与成本' }).click();
  await expect(usage(page).getByRole('alert')).toContainText('暂不可用');
  env.governanceStorage(true);
  await usage(page).getByRole('button', { name: '刷新用量与成本' }).click();
  await expect(usage(page)).toContainText('1 条用量未知');

  await env.pool.query('DELETE FROM role_permissions WHERE role_id=103');
  await usage(page).getByRole('button', { name: '刷新用量与成本' }).click();
  await expect(usage(page).getByRole('alert')).toContainText('无权访问');
  await page.goto(`${env.url}/llm-usage`);
  await expect(notice(page)).toContainText('当前账号无权访问调查用量与成本');
  await expect(notice(page).getByRole('link')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('usage-real-denied.png'), fullPage: true });
});
