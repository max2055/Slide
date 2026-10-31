import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Actual Lit, Fastify and a controlled seeded snapshot in owned non-3306 MySQL.
const api = `http://127.0.0.1:${process.env.MAX238_API_PORT ?? 51869}`;
const handle = fileURLToPath(new URL(`.max238-unbind-handle-${process.env.MAX238_API_PORT ?? 51869}.json`, import.meta.url));
test.afterAll(async () => {
  expect((await fetch(`${api}/__test/shutdown`, { method: 'POST' })).ok).toBe(true);
  await expect.poll(() => existsSync(handle), { timeout: 30000 }).toBe(false);
});
test('real page previews and cancels without changing persistent data', async ({ page }) => {
  const before = await (await fetch(`${api}/__test/snapshot`)).json();
  expect(before.metric_observations).toHaveLength(1);
  expect(before.alert_events).toHaveLength(1);
  for (const path of ['/api/metrics/template-bindings/instance/1', '/api/metrics/config/resources/instance/1/status']) {
    const response = await fetch(`${api}${path}`);
    expect(response.status, `${path}: ${await response.text()}`).toBe(200);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/fixtures/max238-collect-now.html');
  const host = page.locator('native-template-configuration');
  const section = host.locator('app-card').filter({ hasText: '预览移除模板的影响' });
  await expect(section).toBeVisible();
  const choices = section.locator('input[type=checkbox]');
  await expect(choices).toHaveCount(2);
  await choices.first().check();
  const action = section.getByRole('button', { name: '查看影响' });
  await expect(action).toBeEnabled(); await action.focus(); await expect(action).toBeFocused(); await action.click();
  await expect(section.getByText('其他固定模板引用：', { exact: false })).toBeVisible();
  await expect(section.getByText('具体序列及当前能力是否保持未知', { exact: false })).toBeVisible();
  await section.getByText('当前显式设置与策略组').click();
  await expect(section.getByText('preview-group', { exact: false })).toBeVisible();
  await expect(section.getByText('sample_batch', { exact: false })).toBeVisible();
  await section.getByRole('button', { name: '取消预览' }).click();
  await expect(choices.first()).not.toBeChecked();
  await expect(section.getByText('其他固定模板引用：', { exact: false })).toHaveCount(0);
  await action.click(); await expect(section.getByText('没有选中移除的监控项。')).toBeVisible();
  await choices.nth(0).check(); await choices.nth(1).check(); await action.click();
  await expect(section.getByText('没有剩余固定模板引用此指标', { exact: false }).first()).toBeVisible();
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport); await expect(section.getByRole('button', { name: '取消预览' })).toBeVisible();
  }
  expect(await (await fetch(`${api}/__test/snapshot`)).json()).toEqual(before);
});

test('late real response cannot restore a cancelled selection', async ({ page }) => {
  await page.goto('/e2e/fixtures/max238-collect-now.html');
  const section = page.locator('native-template-configuration').locator('app-card').filter({ hasText: '预览移除模板的影响' });
  const choices = section.locator('input[type=checkbox]');
  await expect(choices).toHaveCount(2);
  await choices.first().check();
  expect((await fetch(`${api}/__test/delay`, { method: 'POST' })).ok).toBe(true);
  await section.getByRole('button', { name: '查看影响' }).click();
  await expect.poll(async () => (await (await fetch(`${api}/__test/delay`)).json()).delayed).toBe(true);
  await section.getByRole('button', { name: '取消预览' }).click();
  const response = page.waitForResponse(r => r.url().endsWith('/unbind-preview'));
  expect((await fetch(`${api}/__test/resume`, { method: 'POST' })).ok).toBe(true);
  expect((await response).status()).toBe(200);
  await expect(choices.first()).not.toBeChecked();
  await expect(section.getByText('其他固定模板引用：', { exact: false })).toHaveCount(0);
  await choices.first().check();
  expect((await fetch(`${api}/__test/delay`, { method: 'POST' })).ok).toBe(true);
  await section.getByRole('button', { name: '查看影响' }).click();
  await expect.poll(async () => (await (await fetch(`${api}/__test/delay`)).json()).delayed).toBe(true);
  const otherResponse = page.waitForResponse(r => r.url().endsWith('/unbind-preview'));
  await page.locator('native-template-configuration').evaluate((node: any) => { node.resourceId = 2; });
  expect((await fetch(`${api}/__test/resume`, { method: 'POST' })).ok).toBe(true);
  expect((await otherResponse).status()).toBe(200);
  await expect(section.getByText('其他固定模板引用：', { exact: false })).toHaveCount(0);
});

test('stale preview displays an error and can be refreshed without applying', async ({ page }) => {
  await page.goto('/e2e/fixtures/max238-collect-now.html');
  const host = page.locator('native-template-configuration');
  const section = host.locator('app-card').filter({ hasText: '预览移除模板的影响' });
  await expect(section.locator('input[type=checkbox]')).toHaveCount(2);
  await section.locator('input[type=checkbox]').first().check();
  try {
    expect((await fetch(`${api}/__test/revision/2`, { method: 'POST' })).ok).toBe(true);
    const before = await (await fetch(`${api}/__test/snapshot`)).json();
    await section.getByRole('button', { name: '查看影响' }).click();
    await expect(section.getByRole('alert')).toContainText('重新加载后预览');
    await host.getByRole('button', { name: '重新加载配置' }).click();
    await expect(section.locator('input[type=checkbox]')).toHaveCount(2);
    await section.locator('input[type=checkbox]').first().check();
    await section.getByRole('button', { name: '查看影响' }).click();
    await expect(section.getByText('发布版本 2', { exact: false })).toBeVisible();
    expect(await (await fetch(`${api}/__test/snapshot`)).json()).toEqual(before);
  } finally { await fetch(`${api}/__test/revision/1`, { method: 'POST' }); }
});

test('real handler rejects stale revision, revocation during lock wait and missing or retired pins', async () => {
  const { pins, identity } = await (await fetch(`${api}/__test/pins`)).json();
  const call = (revision: number) => fetch(`${api}/api/metrics/template-bindings/instance/1/unbind-preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_revision: revision, expected_identity: identity, remove_pins: [pins[0]] }),
  });
  const before = await (await fetch(`${api}/__test/snapshot`)).json();
  expect((await call(2)).status).toBe(409);
  expect((await fetch(`${api}/__test/hold`, { method: 'POST' })).ok).toBe(true);
  let released = false;
  try {
    const pending = call(1);
    await expect.poll(async () => (await (await fetch(`${api}/__test/waiters/policy`)).json()).count).toBeGreaterThan(0);
    expect((await fetch(`${api}/__test/session/2`, { method: 'POST' })).ok).toBe(true);
    expect((await fetch(`${api}/__test/release`, { method: 'POST' })).ok).toBe(true); released = true;
    expect((await pending).status).toBe(401);
  } finally {
    if (!released) await fetch(`${api}/__test/release`, { method: 'POST' });
    await fetch(`${api}/__test/session/1`, { method: 'POST' });
  }
  expect(await (await fetch(`${api}/__test/snapshot`)).json()).toEqual(before);
  expect((await fetch(`${api}/__test/hold-version`, { method: 'POST' })).ok).toBe(true);
  released = false;
  try {
    const pending = call(1);
    await expect.poll(async () => (await (await fetch(`${api}/__test/waiters/version`)).json()).count).toBeGreaterThan(0);
    const revoke = fetch(`${api}/__test/session/2`, { method: 'POST' });
    await expect.poll(async () => (await (await fetch(`${api}/__test/waiters/user`)).json()).count).toBeGreaterThan(0);
    expect((await fetch(`${api}/__test/release`, { method: 'POST' })).ok).toBe(true); released = true;
    expect((await pending).status).toBe(200);
    expect((await revoke).ok).toBe(true);
  } finally {
    if (!released) await fetch(`${api}/__test/release`, { method: 'POST' });
    await fetch(`${api}/__test/session/1`, { method: 'POST' });
  }
  expect(await (await fetch(`${api}/__test/snapshot`)).json()).toEqual(before);
  expect((await fetch(`${api}/__test/version/retire`, { method: 'POST' })).ok).toBe(true);
  expect((await call(1)).status).toBe(422);
  expect((await fetch(`${api}/__test/version/remove`, { method: 'POST' })).ok).toBe(true);
  expect((await call(1)).status).toBe(409);
  expect(await (await fetch(`${api}/__test/snapshot`)).json()).toEqual(before);
});
