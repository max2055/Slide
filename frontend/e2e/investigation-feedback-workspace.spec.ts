import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { startInvestigationServer } from './fixtures/investigation-server.ts';

let env: Awaited<ReturnType<typeof startInvestigationServer>>;
test.beforeAll(async () => { env = await startInvestigationServer(); });
test.afterAll(async () => { try { expect(env.workerErrors).toEqual([]); } finally { await env?.close(); } });
test('workspace feedback uses actual results, HTTP revisions and live WS revocation', async ({ page, request }) => {
  const created = await env.bridge.create(env.owner, { title: '反馈正式 workspace 链路', goal: '只读合成指标', profileId: 'ops', profileVersion: 1,
    resources: [{ type: 'instance', id: 101, role: 'primary' }], context: { subject: { kind: 'resource', resource: { type: 'instance', id: 101 } } }, idempotencyKey: randomUUID() },
    { message: '读取合成指标', idempotencyKey: randomUUID() });
  const id = created.investigation.id;
  await page.addInitScript(({ token, actor }) => {
    localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify({ id: actor.userId, username: actor.username }));
    localStorage.setItem('permissions', JSON.stringify(actor.permissions));
    localStorage.setItem('slide.control.settings.v1', JSON.stringify({ locale: 'zh-CN', navCollapsed: true }));
  }, { token: env.token(), actor: env.owner });
  await page.goto(`${env.url}/investigations?investigation=${id}`);
  const form = page.locator('investigation-feedback');
  await expect(form).toContainText('当前结果版本 1');
  await expect(form.getByRole('button', { name: '保存人工记录' })).toBeEnabled();
  await form.getByLabel('反馈评价', { exact: true }).selectOption('incorrect');
  await form.getByLabel('反馈与处理依据', { exact: true }).fill('保留反面证据，模型根因未经验证');
  await form.getByRole('button', { name: '保存人工记录' }).click();
  await expect(form.getByRole('list', { name: '人工记录' })).toContainText('判断有误');
  const [records] = await env.pool.query('SELECT accepted_version AS version,command_json FROM investigation_feedback WHERE investigation_id=?', [id]);
  expect(records).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => (document.querySelector('investigations-page') as any).controller.detail.version)).toBe(Number(records[0].version));
  const history = await request.get(`${env.apiUrl}/api/investigations/${id}/feedback`, { headers: { authorization: `Bearer ${env.token()}` } });
  expect(history.status()).toBe(200); expect((await history.json()).items[0].command.resultVersion).toBe(1);
  // Root and external handling records cannot manufacture a recovery claim.
  await form.getByLabel('记录类型', { exact: true }).selectOption('handling');
  await form.getByLabel('反馈与处理依据', { exact: true }).fill('人工在外部检查；平台未执行修复');
  await form.getByLabel('外部处理时间', { exact: true }).fill('2026-10-11T00:00');
  await form.getByRole('button', { name: '保存人工记录' }).click();
  await expect(form.getByRole('list', { name: '人工记录' })).toContainText('外部处理记录');
  await expect(page.locator('.investigation-states')).toContainText('未确认');
  await form.getByLabel('记录类型', { exact: true }).selectOption('close');
  await form.getByLabel('业务问题状态', { exact: true }).selectOption('resolved');
  await form.getByLabel('反馈与处理依据', { exact: true }).fill('没有恢复依据不能关闭');
  await form.getByRole('button', { name: '保存人工记录' }).click();
  await expect(form.getByRole('alert')).toContainText('证据 ID');
  expect((await env.pool.query('SELECT lifecycle,problem_status FROM investigations WHERE id=?', [id]))[0][0])
    .toMatchObject({ lifecycle: 'waiting', problem_status: 'unconfirmed' });
  await page.reload(); await expect(form.getByRole('list', { name: '人工记录' })).toContainText('判断有误');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('feedback-workspace.png'), fullPage: true });
  await env.pool.query('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=101');
  // Same token; the real observer's periodic authority check withdraws content.
  await expect(form).toHaveCount(0);
  const denied = await request.get(`${env.apiUrl}/api/investigations/${id}/feedback`, { headers: { authorization: `Bearer ${env.token()}` } });
  expect(denied.status()).toBe(404);
  expect(env.observationErrors).toEqual([]);
});
