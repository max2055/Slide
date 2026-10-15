import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import { startFeedbackFixture } from '../../apps/db-ops-api/src/investigations/feedback-test-fixture.ts';

async function localObservedTime(page: Page, value: string): Promise<string> {
  return page.evaluate(value => {
    const d = new Date(value);
    // Chromium normalizes trailing fractional zeros and zero seconds. Fill
    // requires this canonical value; retain the exact instant in browser time.
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.value = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, -1);
    return input.value;
  }, value);
}

let fixture: Awaited<ReturnType<typeof startFeedbackFixture>>, vite: ViteDevServer, url: string;
test.beforeAll(async () => {
  fixture = await startFeedbackFixture(Number(process.env.T11_TEST_MYSQL_PORT));
  const api = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
  vite = await createServer({ root: resolve('.'), configFile: false, server: { host: '127.0.0.1', port: 0, proxy: { '/api': api } },
    plugins: [{ name: 'feedback-test-page', configureServer(server) {
      server.middlewares.use('/t11-feedback', (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/app/styles/tokens.css"></head><body><main style="max-width:800px;margin:auto"><investigation-feedback></investigation-feedback></main><script type="module" src="/src/app/ui/components/investigation-feedback.ts"></script></body></html>');
      });
    } }] });
  await vite.listen(); url = vite.resolvedUrls!.local[0];
});
test.afterAll(async () => { await vite?.close(); await fixture?.close(); });

test('observed datetime-local inputs preserve exact milliseconds across browser timezones', async ({ browser }) => {
  for (const timezoneId of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
    const context = await browser.newContext({ timezoneId });
    try {
      const page = await context.newPage();
      await page.setContent('<input type="datetime-local" step="0.001" aria-label="观察开始时间">');
      for (const suffix of ['00.000', '00.570', '34.000', '34.100', '34.180', '34.001', '34.007', '34.181', '34.570', '34.999']) {
        const observed = `2026-10-14T15:55:${suffix}Z`;
        await page.getByLabel('观察开始时间', { exact: true }).fill(await localObservedTime(page, observed));
        expect(await page.locator('input').evaluate((input: HTMLInputElement) => new Date(input.value).toISOString())).toBe(observed);
      }
    } finally { await context.close(); }
  }
});

test('real JWT/HTTP/SQL feedback, human confirmation, closure and revoked read', async ({ page }) => {
  const seed = await fixture.seed();
  await page.goto(`${url}t11-feedback`);
  await page.evaluate(async ({ token, id, resultId, resultVersion, version }) => {
    await customElements.whenDefined('investigation-feedback');
    localStorage.setItem('token', token);
    const form = document.querySelector('investigation-feedback') as any;
    Object.assign(form, { investigationId: id, resultId, resultVersion, investigationVersion: version }); await form.updateComplete;
  }, { token: fixture.tokens.owner, id: seed.inv.id, resultId: seed.result.id, resultVersion: seed.result.version, version: seed.base.expectedVersion });
  await expect(page.getByText('暂无人工记录')).toBeVisible();
  await page.getByLabel('反馈评价', { exact: true }).selectOption('incorrect');
  await page.getByLabel('反馈与处理依据', { exact: true }).fill('模型判断有误，人工保留反面证据。');
  await page.getByRole('button', { name: '保存人工记录' }).click();
  await expect(page.getByRole('list', { name: '人工记录' })).toContainText('判断有误');
  expect((await fixture.rows('SELECT command_json FROM investigation_feedback WHERE investigation_id=?', [seed.inv.id])).length).toBe(1);
  await page.getByLabel('记录类型', { exact: true }).selectOption('root_cause');
  await page.getByLabel('反馈与处理依据', { exact: true }).fill('人工确认根因，恢复另行验证。');
  await page.getByLabel('验证方法', { exact: true }).fill('核对有界合成指标');
  // Datetime-local intentionally includes milliseconds so it stays within the
  // exact synthetic observed window regardless of local browser timezone.
  await page.getByLabel('观察开始时间', { exact: true }).fill(await localObservedTime(page, seed.verification.from));
  await page.getByLabel('观察结束时间', { exact: true }).fill(await localObservedTime(page, seed.verification.to));
  await page.getByLabel('证据 ID（逗号分隔）', { exact: true }).fill(seed.proof.id);
  await page.getByRole('button', { name: '保存人工记录' }).click();
  await expect(page.getByRole('list', { name: '人工记录' })).toContainText('确认人 101');
  expect((await fixture.rows('SELECT problem_status FROM investigations WHERE id=?', [seed.inv.id]))[0].problem_status).toBe('unconfirmed');
  await page.getByLabel('记录类型', { exact: true }).selectOption('close');
  await page.getByLabel('业务问题状态', { exact: true }).selectOption('resolved');
  await page.getByLabel('反馈与处理依据', { exact: true }).fill('有界恢复观察已完成。');
  await page.getByRole('button', { name: '保存人工记录' }).click();
  await expect(page.getByRole('alert')).toContainText('证据 ID');
  await page.getByLabel('验证方法', { exact: true }).fill('观察所有关联资源');
  await page.getByLabel('观察开始时间', { exact: true }).fill(await localObservedTime(page, seed.verification.from));
  await page.getByLabel('观察结束时间', { exact: true }).fill(await localObservedTime(page, seed.verification.to));
  await page.getByLabel('证据 ID（逗号分隔）', { exact: true }).fill(seed.proof.id);
  await page.getByRole('button', { name: '保存人工记录' }).click();
  await expect(page.getByRole('list', { name: '人工记录' })).toContainText('关闭时业务状态：已验证恢复');
  expect((await fixture.rows('SELECT lifecycle,problem_status FROM investigations WHERE id=?', [seed.inv.id]))[0]).toMatchObject({ lifecycle: 'closed', problem_status: 'resolved' });
  await page.screenshot({ path: 'test-results-feedback/feedback-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole('button', { name: '保存人工记录' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results-feedback/feedback-mobile.png', fullPage: true });
  await fixture.rows('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=102');
  const response = await page.evaluate(async id => fetch(`/api/investigations/${id}/feedback`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }).then(r => r.status), seed.inv.id);
  expect(response).toBe(404);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('slide-permissions-loaded')));
  await expect(page.getByText('反馈内容已清空，请重新核验访问权限。')).toBeVisible();
  await expect(page.getByRole('list', { name: '人工记录' })).toHaveCount(0);
});
