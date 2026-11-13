import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
const backend = 'http://127.0.0.1:3198';
const auth = { Authorization: 'Bearer extension-fixture' };
async function access(page: Page, permissions: string[], refresh = true) {
  await page.request.post(`${backend}/fixture/access`, { data: { permissions } });
  if (refresh) await page.evaluate(value => { localStorage.setItem('permissions', JSON.stringify(value)); window.dispatchEvent(new Event('slide-permissions-loaded')); }, permissions);
}
async function fixture(page: Page) {
  await access(page, ['*'], false);
  await page.addInitScript(() => { localStorage.setItem('token', 'extension-fixture'); localStorage.setItem('permissions', '["*"]'); });
  await page.route('**/extension-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><body><agent-extension-manager kind="skill"></agent-extension-manager><script type="module">import '/src/app/styles.css'; import '/src/app/ui/components/agent-extension-manager.ts';</script></body></html>` }));
  await page.route('**/api/agent/extensions**', async route => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: backend + url.pathname + url.search }); await route.fulfill({ response });
  });
  await page.goto('/extension-fixture'); await expect(page.getByRole('button', { name: '新增', exact: true })).toBeVisible();
}
function digest(record: any) { const { kind, name, description, definition, sourceText } = record; return createHash('sha256').update(JSON.stringify({ kind, name, description, definition, sourceText })).digest('hex'); }
for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`#645 browser saves once, failure retries and SQL persists at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height }); await fixture(page);
    let requests = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    await page.route('**/api/agent/extensions', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      requests++; if (requests === 1) { await gate; return route.fulfill({ status: 403, json: { error: 'fixture rejection' } }); }
      return route.fallback();
    });
    await page.getByRole('button', { name: '新增', exact: true }).click();
    const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: '新增', exact: true })).toBeFocused();
    await page.keyboard.press('Enter'); await expect(dialog).toBeVisible();
    await page.screenshot({ path: info.outputPath('editor.png') });
    await page.getByLabel('名称', { exact: true }).fill(`sample${width}`);
    await page.getByLabel('描述', { exact: true }).fill('actual persisted description');
    await page.getByRole('button', { name: '保存草稿', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(() => requests).toBe(1); await expect(page.getByRole('button', { name: '保存中...' })).toBeDisabled();
    release(); await expect(page.getByRole('button', { name: '保存草稿' })).toBeEnabled(); await expect(dialog).toBeVisible();
    await page.getByRole('button', { name: '保存草稿' }).click(); await expect(dialog).toBeHidden(); expect(requests).toBe(2);
    const manager = page.locator('agent-extension-manager'); const row = manager.locator('.item').filter({ hasText: `sample${width}` });
    await expect(row).toContainText('actual persisted description');
    const rows = await (await page.request.get(`${backend}/fixture/rows`)).json();
    expect(rows.filter((item: any) => item.name === `sample${width}`)).toHaveLength(1);
    await row.getByRole('button', { name: '编辑', exact: true }).click();
    let updates = 0; let unblock!: () => void; const updateGate = new Promise<void>(resolve => unblock = resolve);
    await page.route('**/api/agent/extensions/*', async route => { if (route.request().method() !== 'PUT') return route.fallback(); updates++; await updateGate; return route.fallback(); });
    await page.getByLabel('描述', { exact: true }).fill('edited description');
    await page.getByRole('button', { name: '保存草稿' }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(() => updates).toBe(1); unblock(); await expect(dialog).toBeHidden();
    await expect(row).toContainText('edited description'); await page.reload(); await expect(row).toContainText('edited description');
    const buttonBox = await row.getByRole('button', { name: '编辑', exact: true }).boundingBox(); expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath('saved.png') });
  });
}
test('#415 refresh, read-only permissions, stale cache 403, and protected writes', async ({ page }) => {
  await fixture(page);
  expect((await page.request.post(`${backend}/api/agent/extensions`, { headers: auth, data: { kind: 'skill', name: 'permissionFixture', definition: {} } })).status()).toBe(201);
  for (const permissions of [['ai:view'], ['ai:*'], ['*:view']]) {
    await access(page, permissions); await expect(page.locator('.item').first()).toBeVisible();
    for (const name of ['新增', '编辑', '发布', '归档']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    for (const [method, path] of [['POST', ''], ['PUT', '/1'], ['POST', '/1/publish'], ['DELETE', '/1']]) {
      const response = await page.request.fetch(`${backend}/api/agent/extensions${path}`, { method, headers: auth, ...(method === 'POST' || method === 'PUT' ? { data: {} } : {}) }); expect(response.status()).toBe(403);
    }
  }
  await access(page, []); await expect(page.locator('.item')).toHaveCount(0);
  // Cached ai:view remains a hint; a server-side revocation still rejects the list.
  await page.evaluate(() => { localStorage.setItem('permissions', '["ai:view"]'); window.dispatchEvent(new Event('slide-permissions-loaded')); });
  await expect(page.locator('.item')).toHaveCount(0);
  await access(page, ['*']); await expect(page.getByRole('button', { name: '新增', exact: true })).toBeVisible(); await expect(page.locator('.item').first()).toBeVisible();
});
test('#477 real API and SQL digest for create/update 2000/2001, empty and omitted fields', async ({ page }) => {
  await fixture(page);
  for (const length of [2000, 2001]) {
    const response = await page.request.post(`${backend}/api/agent/extensions`, { headers: auth, data: { kind: 'skill', name: `boundary${length}`, description: 'x'.repeat(length), definition: { frontmatter: {} }, sourceText: 'retained' } }); expect(response.status()).toBe(201);
    let record = (await response.json()).extension; expect(record.description).toHaveLength(2000); expect(record.digest).toBe(digest(record));
    for (const patch of [{ description: 'y'.repeat(length) }, {}, { description: null }, { description: '', sourceText: null }]) {
      const update = await page.request.put(`${backend}/api/agent/extensions/${record.id}`, { headers: auth, data: patch }); expect(update.status()).toBe(200);
      record = (await update.json()).extension; expect(record.digest).toBe(digest(record)); expect(record.name).toBe(`boundary${length}`); expect(record.definition).toEqual({ frontmatter: {} });
      const sqlRows = await (await page.request.get(`${backend}/fixture/rows`)).json(); const stored = sqlRows.find((item: any) => Number(item.id) === record.id); expect(stored.digest).toBe(record.digest); expect(stored.description).toBe(record.description);
    }
    expect(record.description).toBe(''); expect(record.sourceText).toBeNull();
  }
});
