import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const output = 'test-results/MAX-179-evidence';
const defaults = { product_name: 'Slide', cli_name: 'slide', env_prefix: 'SLIDE', state_dir: '.slide' };
let session: any;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ request }) => {
  if (!process.env.MAX179_ISOLATED_MYSQL) throw new Error('Use scripts/qualification/run-MAX-179.sh (disposable MySQL only)');
  await mkdir(output, { recursive: true });
  const login = await request.post('/api/auth/login', { data: { username: 'admin', password: process.env.QUALIFICATION_ADMIN_PASSWORD } });
  expect(login.status()).toBe(200); session = await login.json();
  await writeFile(`${output}/metadata.json`, JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceSha256: createHash('sha256').update(await readFile('src/app/ui/views/branding-settings.ts')).digest('hex'), source: 'Current production Fastify server, password login/JWT/live permission checks, disposable MySQL only. Supplemental states explicitly intercepted. No product inference.', designSha256: '112502a0ad6dbadc7eea35efda027ccfb079fed756bf0ed51956ac6fd71347fe', viewports: [1440, 768, 390], themes: ['light', 'dark'] }, null, 2));
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript(session => {
    localStorage.setItem('token', session.token); localStorage.setItem('refreshToken', session.refreshToken);
    localStorage.setItem('user', JSON.stringify(session.user)); localStorage.setItem('permissions', JSON.stringify(['*']));
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
  }, session);
});
async function capture(page: Page, name: string) {
  const view = page.locator('branding-settings');
  const measurement = await view.evaluate(element => ({
    pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
    cardCount: element.shadowRoot!.querySelectorAll('app-card').length,
    fields: Array.from(element.shadowRoot!.querySelectorAll('input')).map(input => {
      const rect = input.getBoundingClientRect(); return { label: input.labels?.[0]?.textContent, x: rect.x, width: rect.width, right: rect.right };
    }),
  }));
  expect(measurement.pageWidth).toBeLessThanOrEqual(measurement.viewportWidth);
  for (const field of measurement.fields) { expect(field.right).toBeLessThanOrEqual(measurement.viewportWidth); expect(field.width).toBeGreaterThan(150); }
  if (measurement.fields.length) expect(new Set(measurement.fields.map(f => Math.round(f.x))).size).toBe(1);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true, animations: 'disabled' });
  await writeFile(`${output}/${name}.json`, JSON.stringify({ viewport: page.viewportSize(), theme: await page.evaluate(() => document.documentElement.dataset.themeMode), source: name.startsWith('controlled-') ? 'Controlled HTTP supplemental state' : 'Real authenticated API and isolated MySQL', measurement }, null, 2));
}
async function harness(page: Page) {
  await page.route('**/MAX-179-harness', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/app/styles/tokens.css"><style>body{margin:0;padding:24px 16px;background:var(--bg);color:var(--text);font:14px var(--font-body)}</style><body><script type="module">import '/src/app/ui/views/branding-settings.ts';document.body.append(document.createElement('branding-settings'));</script></body></html>` }));
  await page.goto('/MAX-179-harness');
  return page.locator('branding-settings');
}

test('representative product group: real read, preview, save, cache and reload; then runtime group', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const writes: any[] = [];
  page.on('request', r => { if (r.url().endsWith('/api/branding/config') && r.method() === 'PUT') writes.push(r.postDataJSON()); });
  await page.goto('/settings/platform/branding');
  const view = page.locator('branding-settings');
  const product = view.getByRole('textbox', { name: '产品名称', exact: true });
  await expect(product).toHaveValue('Slide');
  await page.setViewportSize({ width: 1440, height: 960 });
  await capture(page, 'real-default-desktop');
  await expect(product).toHaveAccessibleDescription('产品显示名称，如 Slide');
  const longName = 'MAX179 隔离品牌名称' + '长名称核对表单与预览。'.repeat(12);
  await product.fill(longName);
  await expect(view.getByLabel('产品名称预览')).toContainText(longName);
  await expect(view.getByText('有未保存的修改', { exact: true })).toBeVisible();
  await expect(view.getByRole('button', { name: '重新读取' })).toBeDisabled();
  const saved = page.waitForResponse(r => r.url().endsWith('/api/branding/config') && r.request().method() === 'PUT');
  await view.getByRole('button', { name: '保存品牌' }).click(); expect((await saved).status()).toBe(200);
  await expect(view.getByText('品牌配置已保存', { exact: true })).toBeVisible();
  expect(writes[0]).toEqual({ ...defaults, product_name: longName });
  const cache = await page.evaluate(async () => (await import('/src/app/src/branding.ts')).getBrandingSnapshot());
  expect(cache.product_name).toBe(longName);
  await page.reload(); await expect(product).toHaveValue(longName);
  await capture(page, 'representative-product-real-save-refresh');
  await view.getByRole('textbox', { name: 'CLI 命令名称', exact: true }).fill('max179');
  await view.getByRole('textbox', { name: '环境变量前缀', exact: true }).fill('MAX179');
  await view.getByRole('textbox', { name: '数据目录名称', exact: true }).fill('.max179');
  await view.getByRole('button', { name: '保存品牌' }).click();
  await expect(view.getByText('品牌配置已保存', { exact: true })).toBeVisible();
  await page.reload();
  for (const [name, value] of [['CLI 命令名称', 'max179'], ['环境变量前缀', 'MAX179'], ['数据目录名称', '.max179']]) {
    await expect(view.getByRole('textbox', { name, exact: true })).toHaveValue(value);
  }
  for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; }, theme);
    await view.getByRole('heading', { name: '品牌设置' }).scrollIntoViewIfNeeded();
    await capture(page, `real-long-shell-${width}-${theme}`);
    await view.getByRole('button', { name: '保存品牌' }).scrollIntoViewIfNeeded();
    await capture(page, `real-long-shell-footer-${width}-${theme}`);
  }
  await product.fill('未保存草稿'); await view.getByRole('button', { name: '撤销修改' }).click(); await expect(product).toHaveValue(longName);
  await view.locator('app-form-field').first().locator('label.form-label').click(); await expect(product).toBeFocused();
  await page.keyboard.press('Tab'); await expect(view.getByRole('textbox', { name: 'CLI 命令名称', exact: true })).toBeFocused();
  await product.fill('Slide');
  await view.getByRole('button', { name: '保存品牌' }).click();
  await expect(view.getByText('品牌配置已保存', { exact: true })).toBeVisible();
  await page.reload(); await expect(product).toHaveValue('Slide');
  for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate(theme => { document.documentElement.dataset.themeMode = theme; }, theme);
    await view.getByRole('heading', { name: '品牌设置' }).scrollIntoViewIfNeeded();
    await capture(page, `real-shell-${width}-${theme}`);
    await view.getByRole('button', { name: '保存品牌' }).scrollIntoViewIfNeeded();
    await capture(page, `real-shell-footer-${width}-${theme}`);
  }
  const tree = await (await page.context().newCDPSession(page)).send('Accessibility.getFullAXTree');
  expect(tree.nodes.filter(n => n.role?.value === 'textbox' && ['产品名称', 'CLI 命令名称', '环境变量前缀', '数据目录名称'].includes(n.name?.value)).length).toBe(4);
  await writeFile(`${output}/accessibility.json`, JSON.stringify(tree, null, 2));
  expect(errors).toEqual([]);
});

test('controlled validation, save pending, failure, permission and unknown preserve truth', async ({ page }) => {
  let mode = 'normal', writes = 0;
  let finish!: () => void;
  await page.route('**/api/branding/config', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: defaults });
    writes++;
    if (mode === 'pending') await new Promise<void>(resolve => { finish = resolve; });
    if (mode === 'unknown') return route.abort('failed');
    return route.fulfill({ status: mode === 'forbidden' ? 403 : 500, json: { error: '受控保存失败，修改尚未保存' } });
  });
  const view = await harness(page);
  const product = view.getByRole('textbox', { name: '产品名称', exact: true });
  await expect(product).toHaveValue('Slide');
  for (const name of ['产品名称', 'CLI 命令名称', '环境变量前缀', '数据目录名称']) await view.getByRole('textbox', { name, exact: true }).fill('');
  await view.getByRole('button', { name: '保存品牌' }).click();
  for (const name of ['产品名称', 'CLI 命令名称', '环境变量前缀', '数据目录名称']) {
    await expect(view.getByRole('textbox', { name, exact: true })).toHaveAccessibleDescription('此项不能为空');
  }
  await expect(product).toBeFocused();
  expect(writes).toBe(0); await capture(page, 'controlled-empty-validation');
  await view.getByRole('button', { name: '撤销修改' }).click();
  const cli = view.getByRole('textbox', { name: 'CLI 命令名称', exact: true });
  await cli.fill('Invalid');
  await expect(cli).toHaveAccessibleDescription('仅允许小写字母开头，包含小写字母、数字和连字符');
  await view.getByRole('button', { name: '保存品牌' }).click(); expect(writes).toBe(0);
  await cli.fill('max179');
  const prefix = view.getByRole('textbox', { name: '环境变量前缀', exact: true });
  await prefix.fill('invalid');
  await view.getByRole('button', { name: '保存品牌' }).click(); expect(writes).toBe(0);
  await expect(prefix).toHaveAttribute('aria-invalid', 'true'); await prefix.fill('MAX179');
  await product.fill('待保存品牌'); mode = 'pending';
  await view.getByRole('button', { name: '保存品牌' }).click();
  await expect(view.getByRole('button', { name: '保存中…' })).toBeDisabled(); await expect(product).toBeDisabled();
  await capture(page, 'controlled-save-pending'); finish();
  await expect(view.getByText('受控保存失败，修改尚未保存', { exact: true })).toBeVisible();
  await expect(product).toHaveValue('待保存品牌'); await capture(page, 'controlled-save-failed');
  mode = 'forbidden'; await view.getByRole('button', { name: '保存品牌' }).click();
  await expect(view.getByText('无权限保存品牌配置，修改尚未保存', { exact: true })).toBeVisible(); await capture(page, 'controlled-save-forbidden');
  mode = 'unknown'; await view.getByRole('button', { name: '保存品牌' }).click();
  await expect(view.getByText('保存结果未确认。请重新读取配置核对后再编辑。', { exact: true })).toBeVisible();
  await expect(view.getByRole('button', { name: '保存品牌' })).toBeDisabled(); await capture(page, 'controlled-save-unknown');
  await view.getByRole('button', { name: '重新读取' }).click(); await expect(product).toHaveValue('Slide');
});

for (const scenario of ['failed', 'forbidden', 'empty', 'partial']) {
  test(`controlled loading and ${scenario} never enable editing unconfirmed config`, async ({ page }) => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    await page.route('**/api/branding/config', async route => {
      await gate;
      return route.fulfill({ status: scenario === 'failed' ? 500 : scenario === 'forbidden' ? 403 : 200, json: scenario === 'empty' ? null : scenario === 'partial' ? { product_name: '部分配置' } : { error: '受控错误' } });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const view = await harness(page);
    await expect(view.getByText('正在读取品牌配置…')).toBeVisible(); await expect(view.getByRole('textbox')).toHaveCount(0);
    await capture(page, `controlled-loading-${scenario}`); finish();
    await expect(view.getByRole('alert')).toBeVisible(); await expect(view.getByRole('textbox')).toHaveCount(0);
    await expect(view.getByRole('button', { name: '重新读取' })).toBeEnabled(); await capture(page, `controlled-read-${scenario}`);
  });
}
