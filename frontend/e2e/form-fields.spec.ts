import { test, expect } from '@playwright/test';

async function harness(page: import('@playwright/test').Page, body: string, modules = 'components/app-form-field') {
  await page.route('**/form-field-harness', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/src/app/styles/tokens.css"></head><body>${body}<script type="module">import '/src/app/ui/${modules}.ts';</script></body></html>` }));
  await page.goto('/form-field-harness');
}

test('native accessible names, isolated labels, keyboard and changing error descriptions', async ({ page }, info) => {
  await harness(page, '<app-form-field label="用户名" hint="输入登录名"><input></app-form-field><app-form-field label="用户名"><input></app-form-field>');
  const fields = page.locator('app-form-field');
  const first = fields.nth(0).getByRole('textbox', { name: '用户名', exact: true });
  const second = fields.nth(1).getByRole('textbox', { name: '用户名', exact: true });
  await expect(first).toHaveAccessibleDescription('输入登录名');
  await fields.nth(1).locator('label.form-label').click(); await expect(second).toBeFocused();
  await fields.nth(0).locator('label.form-label').click(); await expect(first).toBeFocused();
  await page.keyboard.press('Tab'); await expect(second).toBeFocused();
  await fields.nth(0).evaluate((field: any) => { field.error = '用户名不能为空'; });
  await expect(first).toHaveAttribute('aria-invalid', 'true');
  await expect(first).toHaveAccessibleDescription('用户名不能为空');
  expect(await first.ariaSnapshot()).toContain('textbox "用户名"');
  const cdp = await page.context().newCDPSession(page);
  const tree = await cdp.send('Accessibility.getFullAXTree');
  const input = tree.nodes.find(node => node.role?.value === 'textbox' && node.name?.value === '用户名' && node.description?.value === '用户名不能为空');
  expect(input?.properties).toContainEqual(expect.objectContaining({ name: 'invalid', value: expect.objectContaining({ value: 'true' }) }));
  await info.attach('browser-accessibility-tree.json', { body: JSON.stringify(tree, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('field-error.png') });
  await fields.nth(0).evaluate((field: any) => { field.error = ''; });
  await expect(first).not.toHaveAttribute('aria-invalid');
  await expect(first).toHaveAccessibleDescription('输入登录名');
});

test('caller labels and descriptions survive, and replaced controls acquire associations', async ({ page }) => {
  await harness(page, '<span id="caller-description">现有说明</span><app-form-field label="容器标签" hint="补充说明"><input id="caller-control" aria-label="调用方名称" aria-describedby="caller-description" aria-invalid="grammar"></app-form-field>');
  const field = page.locator('app-form-field');
  let input = field.getByRole('textbox', { name: '调用方名称' });
  await expect(input).toHaveAccessibleDescription('现有说明 补充说明');
  await field.evaluate((el: any) => { el.error = '字段错误'; });
  await expect(input).toHaveAccessibleDescription('现有说明 字段错误');
  await field.evaluate((el: any) => { el.error = ''; });
  await expect(input).toHaveAttribute('aria-invalid', 'grammar');
  await field.evaluate(el => el.querySelector('input')!.replaceWith(document.createElement('textarea')));
  input = field.getByRole('textbox', { name: '容器标签' });
  await expect(input).toHaveAccessibleDescription('补充说明');
  await field.locator('label.form-label').click(); await expect(input).toBeFocused();
});

for (const status of [200, 403, 500]) {
  test(`audit filter names remain available during loading and response ${status} (controlled API)`, async ({ page }, info) => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    await page.route('**/api/audit/logs?**', async route => {
      await pending;
      await route.fulfill({ status, json: status === 200 ? { items: [], total: 0 } : { error: status === 403 ? '无权限' : '加载失败' } });
    });
    await harness(page, '<system-audit-page></system-audit-page>', 'views/system-audit');
    const view = page.locator('system-audit-page');
    await expect(view.getByRole('searchbox', { name: '关键字', exact: true })).toBeVisible();
    await expect(view.getByRole('combobox', { name: '操作类型', exact: true })).toBeVisible();
    for (const name of ['开始时间', '结束时间']) {
      const control = view.getByLabel(name, { exact: true });
      await expect(control).toHaveAccessibleName(name);
      await view.locator('label.form-label').filter({ hasText: name }).click(); await expect(control).toBeFocused();
    }
    finish();
    await expect(view.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    await expect(view.getByRole('searchbox', { name: '关键字', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`audit-${status}.png`), fullPage: true });
  });
}

for (const state of ['failed', 'forbidden', 'unknown']) {
  test(`scoring ${state} keeps names and loading state honest (controlled API)`, async ({ page }) => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    await page.route('**/api/scoring/config', async route => {
      await pending;
      if (route.request().method() === 'PUT') return route.fulfill({ status: state === 'forbidden' ? 403 : 500, json: { error: '受控保存失败' } });
      return route.fulfill({ json: state === 'unknown' ? null : { availability: .4, performance: .3, capacity: .2, security: .1 } });
    });
    await harness(page, '<scoring-settings-page></scoring-settings-page>', 'views/scoring-settings');
    await expect(page.getByText('加载中...')).toBeVisible();
    await expect(page.getByRole('slider')).toHaveCount(0);
    finish();
    if (state === 'unknown') {
      await expect(page.getByText('无法加载配置')).toBeVisible();
      await expect(page.getByRole('slider')).toHaveCount(0);
    } else {
      await expect(page.getByRole('slider', { name: '可用性', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '保存配置' }).click();
      await expect(page.getByText('受控保存失败')).toBeVisible();
      await expect(page.getByRole('slider', { name: '可用性', exact: true })).toHaveAccessibleName('可用性');
    }
  });
}

test('scoring sliders have names, native click focus and percentage values', async ({ page }) => {
  await page.route('**/api/scoring/config', route => route.fulfill({ json: { availability: .4, performance: .3, capacity: .2, security: .1 } }));
  await harness(page, '<scoring-settings-page></scoring-settings-page>', 'views/scoring-settings');
  for (const name of ['可用性', '性能', '容量', '安全性']) {
    const slider = page.getByRole('slider', { name, exact: true });
    await expect(slider).toBeVisible();
    await page.locator('label').filter({ hasText: name }).click(); await expect(slider).toBeFocused();
  }
  const slider = page.getByRole('slider', { name: '可用性', exact: true });
  await slider.focus(); await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveValue('0.45');
  await expect(slider).toHaveAttribute('aria-valuetext', '45%');
  await expect(slider).toHaveAccessibleDescription('实例在线时长与连接成功率');
});
