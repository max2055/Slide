import { createServer } from 'vite';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { createVerifyToken } from '../../apps/db-ops-api/src/auth-middleware.ts';
import { signAccessToken } from '../../apps/db-ops-api/src/auth/actor-context.ts';
import { dbConnection } from '../../apps/db-ops-api/src/db-connection.ts';
import { startFeedbackFixture } from '../../apps/db-ops-api/src/investigations/feedback-test-fixture.ts';
import { registerInvestigationRoutes } from '../../apps/db-ops-api/src/investigations/routes.ts';
import { LegacyAnalysisBridge } from '../../apps/db-ops-api/src/investigations/legacy-analysis-bridge.ts';
import { operationsFlags } from '../../apps/db-ops-api/src/operations/feature-flags.ts';
import { registerKnowledgeRoutes } from '../../apps/db-ops-api/src/operations/knowledge/routes.ts';
import { CaseCursorCodec } from '../../apps/db-ops-api/src/operations/knowledge/search.ts';
import { KnowledgeService } from '../../apps/db-ops-api/src/operations/knowledge/service.ts';
import { KnowledgeStore } from '../../apps/db-ops-api/src/operations/knowledge/store.ts';
import { registerResourceRoutes } from '../../apps/db-ops-api/src/resources/resource-routes.ts';

test.skip(!process.env.MAX725_MYSQL_PORT, 'Requires MAX-725 task-owned MySQL');

test('normal knowledge menu discovers authorized exact results and recovers after source access is revoked', async ({ page }, info) => {
  test.setTimeout(90_000);
  const fixture = await startFeedbackFixture(Number(process.env.MAX725_MYSQL_PORT));
  const { app, pool, rows, secret, contexts, bridge, seed, results } = fixture;
  const originalPool = dbConnection.getPool;
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  dbConnection.getPool = () => pool;
  try {
    await rows(`INSERT IGNORE INTO role_permissions (role_id, permission_id)
      SELECT 101, id FROM permissions WHERE code IN ('operations:cases:view','operations:cases:manage','instance:manage')`);
    await rows("UPDATE instance_permissions SET access_level='admin' WHERE user_id=102");
    await rows("UPDATE database_instances SET name='交易演练库' WHERE id=101");
    await rows("UPDATE database_instances SET name='报表演练库' WHERE id=102");
    const actor = await contexts.loadActiveActor(102);
    const verify = createVerifyToken(secret, contexts);
    const knowledge = new KnowledgeService(new KnowledgeStore(() => pool, new CaseCursorCodec(randomBytes(32))),
      () => ({ ...operationsFlags({}), cases: true }));
    await registerInvestigationRoutes(app, verify, bridge, bridge.observationServices(), new LegacyAnalysisBridge(() => pool, undefined, bridge));
    await registerKnowledgeRoutes(app, verify, knowledge);
    await registerResourceRoutes(app, verify);

    const first = await seed(), second = await seed(), privateSource = await seed();
    const testValue = { ...second.value, provenance: { ...second.value.provenance, toolVersions: { readonly_fixture: '1' } },
      facts: [{ statement: '第二版样本。password=synthetic-case-marker', evidenceIds: [second.proof.id] }] };
    const secondVersion = await results.put(fixture.owner, second.binding, randomUUID(), second.result.version, testValue);
    await rows("UPDATE investigation_results SET result_json=JSON_SET(result_json, '$.provenance.toolVersions', JSON_OBJECT('readonly_fixture','1')) WHERE id=?", [first.result.id]);
    await rows("UPDATE investigations SET lifecycle='closed', title='合成同名调查', created_at='2026-11-22 05:00:00.123' WHERE id IN (?,?)",
      [first.inv.id, second.inv.id]);
    await rows("UPDATE investigations SET lifecycle='closed', title='不可见的私有调查' WHERE id=?", [privateSource.inv.id]);
    await rows('DELETE FROM investigation_members WHERE investigation_id=? AND user_id=?', [privateSource.inv.id, actor.userId]);

    const preparations: { id: string | null; version: string | null }[] = [];
    const writes: string[] = [];
    app.addHook('onRequest', async request => {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/operations/knowledge/prepare') {
        preparations.push({ id: url.searchParams.get('investigationId'), version: url.searchParams.get('resultVersion') });
      }
      if (request.method !== 'GET' && /^\/api\/(operations|investigations)\b/.test(url.pathname)) writes.push(url.pathname);
    });
    const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    vite = await createServer({ root: resolve('.'), configFile: resolve('vite.config.js'),
      define: { 'import.meta.env.VITE_AGENT_WS_URL': '""' },
      server: { host: '127.0.0.1', port: 0, strictPort: false,
        proxy: { '/api': apiUrl, '/__slide': apiUrl, '/agent-ws': { target: apiUrl, ws: true } } } });
    await vite.listen();
    const url = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
    await page.addInitScript(({ token, actor }) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify({ id: actor.userId, username: actor.username }));
      localStorage.setItem('permissions', JSON.stringify(actor.permissions));
      localStorage.setItem('slide.i18n.locale', 'zh-CN');
    }, { token: signAccessToken(actor, secret), actor });
    await page.setViewportSize({ width: 1440, height: 900 });
    page.setDefaultTimeout(10_000);
    // Start from a different product page to exercise the real navigation.
    await page.goto(`${url}/workbench`);
    await page.locator('.shell-nav').getByRole('link', { name: '可信运维知识', exact: true }).click();
    await expect(page).toHaveURL(location => location.pathname === '/operations-knowledge');
    const view = page.locator('operations-knowledge');
    const entry = view.getByRole('button', { name: '选择来源调查', exact: true });
    await entry.click();
    await expect(view.getByRole('dialog', { name: '从调查整理案例' })).toBeVisible();
    const dialog = view.locator('app-dialog');
    const titleQuery = dialog.getByRole('textbox', { name: '调查标题' });
    const prepare = dialog.getByRole('button', { name: '读取来源生成脱敏草稿' });
    const title = dialog.getByRole('textbox', { name: '案例标题' });
    const source = (id: string) => dialog.getByRole('button', { name: new RegExp(`选择结果 V\\d+.*${id}`) });
    const change = dialog.getByRole('button', { name: '重新选择来源' });
    await expect(source(first.inv.id)).toHaveAccessibleName(/交易演练库/);
    await expect(source(second.inv.id)).toHaveAccessibleName(/报表演练库/);
    await expect(dialog).not.toContainText('不可见的私有调查');
    await expect(title).toHaveCount(0);
    await expect(prepare).toHaveCount(0);
    expect(preparations).toEqual([]);
    await titleQuery.fill('没有这个故障');
    await titleQuery.press('Enter');
    await expect(dialog).toContainText('没有匹配的调查');
    await titleQuery.fill('同名调查');
    await titleQuery.press('Enter');
    await dialog.getByRole('combobox', { name: '调查对象' }).selectOption({ label: '交易演练库 · 数据库实例 #101' });
    await expect(source(second.inv.id)).toBeVisible();
    for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      await expect(titleQuery).toBeInViewport();
      await expect(source(second.inv.id)).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`source-picker-${width}.png`) });
    }
    await source(second.inv.id).focus();
    await page.keyboard.press('Enter');
    await expect(prepare).toBeFocused();
    await prepare.press('Enter');
    await expect(title).toHaveValue('合成同名调查');
    await expect(dialog.getByRole('textbox', { name: '问题现象' })).toHaveValue(/第二版样本。password=\[REDACTED\]/);
    await expect(dialog.getByRole('textbox', { name: '问题现象' })).not.toHaveValue(/synthetic-case-marker/);
    await expect(dialog.getByRole('button', { name: '保存案例草稿' })).toBeDisabled();
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    expect(preparations).toEqual([{ id: second.inv.id, version: String(secondVersion.version) }]);
    await page.screenshot({ path: info.outputPath('redacted-prefill.png') });
    await page.keyboard.press('Escape');
    await expect(entry).toBeFocused();

    await page.goto(`${url}/workbench?investigation=${second.inv.id}`);
    const exactLink = page.getByRole('link', { name: '从当前结果整理案例', exact: true });
    await expect(exactLink).toHaveAttribute('href', `/operations-knowledge?sourceInvestigation=${second.inv.id}&resultVersion=2`);
    await exactLink.click();
    await expect(title).toHaveValue('合成同名调查');
    expect(preparations.at(-1)).toEqual({ id: second.inv.id, version: '2' });

    const urlOf = (id: string, version: number) => `${url}/operations-knowledge?sourceInvestigation=${id}&resultVersion=${version}`;
    await page.goto(urlOf(second.inv.id, 1));
    await expect(dialog).toContainText('该来源或结果版本已不可引用');
    await expect(source(second.inv.id)).toBeVisible();
    await expect(title).toHaveCount(0);
    expect(preparations.at(-1)).toEqual({ id: second.inv.id, version: '1' });
    expect(preparations).toHaveLength(3);

    await source(second.inv.id).click();
    await rows('DELETE FROM investigation_members WHERE investigation_id=? AND user_id=?', [second.inv.id, actor.userId]);
    await prepare.click();
    await expect(dialog).toContainText('该来源或结果版本已不可引用');
    await expect(source(first.inv.id)).toBeVisible();
    await expect(source(second.inv.id)).toHaveCount(0);
    await expect(dialog).not.toContainText(second.inv.id);
    await expect(title).toHaveCount(0);
    await source(first.inv.id).click();
    await prepare.click();
    await expect(title).toHaveValue('合成同名调查');
    await rows('DELETE FROM investigation_members WHERE investigation_id=? AND user_id=?', [first.inv.id, actor.userId]);
    await change.click();
    await expect(dialog).toContainText('暂无可用的来源调查');
    await expect(title).toHaveCount(0);
    expect(preparations.slice(3)).toEqual([{ id: second.inv.id, version: '2' }, { id: first.inv.id, version: '1' }]);
    expect(writes).toEqual([]);
    expect(Number((await rows('SELECT COUNT(*) AS n FROM trusted_cases'))[0].n)).toBe(0);
    expect(Number((await rows('SELECT COUNT(*) AS n FROM action_executions'))[0].n)).toBe(0);
  } finally {
    try {
      await page.context().close();
    } finally {
      try { await vite?.close(); }
      finally {
        try { await fixture.close(); }
        finally { dbConnection.getPool = originalPool; }
      }
    }
  }
});
