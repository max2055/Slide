import { test, expect } from '@playwright/test';

async function harness(page: import('@playwright/test').Page, body: string, modules = 'components/app-form-field') {
  await page.route('**/form-field-harness', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/src/app/styles/tokens.css"></head><body>${body}<script type="module">import '/src/app/ui/${modules}.ts';</script></body></html>` }));
  await page.goto('/form-field-harness');
}

test('native accessible names, isolated labels, keyboard and changing error descriptions', async ({ page }) => {
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
  await fields.nth(0).evaluate((field: any) => { field.error = ''; });
  await expect(first).not.toHaveAttribute('aria-invalid');
  await expect(first).toHaveAccessibleDescription('输入登录名');
});

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
