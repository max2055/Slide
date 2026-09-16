import { expect, test } from '@playwright/test';

for (const width of [390, 1280]) test(`scene assignments persist and report invalid bindings at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const providers = [{ id: 1, name: 'primary', display_name: 'Primary', enabled: true, is_default: true,
    default_model: 'base', models_supported: [{ id: 'fast' }], supports_function_call: true }];
  let binding: { provider_id: number; model: string } | null = null;
  let invalid = false;
  const writes: unknown[] = [];
  await page.route('**/api/llm/**', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON(); writes.push(body);
      binding = body.provider_id === null ? null : body;
      return route.fulfill({ json: { success: true } });
    }
    if (route.request().url().endsWith('/configs')) return route.fulfill({ json: providers });
    return route.fulfill({ json: ['default', 'chat', 'sql_analysis', 'fault_diagnosis', 'health_check'].map(scene => ({
      scene, binding: scene === 'chat' ? binding : null,
      effective: invalid && scene === 'chat' ? null : { provider_id: 1, provider_name: 'Primary', model: scene === 'chat' && binding ? binding.model : 'base', source: scene === 'chat' && binding ? 'scene' : 'default' },
      error: invalid && scene === 'chat' ? 'LLM 配置错误：绑定提供商已禁用' : null,
    })) });
  });
  await page.route('**/settings/ai/models?**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <settings-shell></settings-shell>
    <script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/settings-shell.ts'; import '/src/app/ui/views/llm-config.ts';</script>
    </body></html>` }));
  await page.goto('/settings/ai/models?view=providers');
  await expect(page.getByRole('tab', { name: '模型配置', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('input[list="model-suggestions"]')).toHaveValue('base');
  await page.locator('input[list="model-suggestions"]').fill('draft');
  await page.getByRole('tab', { name: '场景分配', exact: true }).click();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await page.getByRole('tab', { name: '模型配置', exact: true }).click();
  await expect(page.locator('input[list="model-suggestions"]')).toHaveValue('draft');
  await page.screenshot({ path: testInfo.outputPath('models.png'), fullPage: true });
  await page.getByRole('tab', { name: '场景分配', exact: true }).click();
  const chat = page.locator('app-card').filter({ has: page.getByText('智能对话', { exact: true }) });
  await expect(chat).toContainText('Primary / base（全局默认）');
  await page.getByLabel('智能对话提供商', { exact: true }).selectOption('1');
  await page.getByLabel('智能对话模型', { exact: true }).selectOption('fast');
  await chat.getByRole('button', { name: '保存分配' }).click();
  await expect(chat).toContainText('Primary / fast');
  expect(writes.at(-1)).toEqual({ provider_id: 1, model: 'fast' });
  await page.reload();
  await page.getByRole('tab', { name: '场景分配', exact: true }).click();
  await expect(page.getByLabel('智能对话模型', { exact: true })).toHaveValue('fast');
  invalid = true;
  await page.reload();
  await page.getByRole('tab', { name: '场景分配', exact: true }).click();
  await expect(chat).toContainText('绑定提供商已禁用');
  await page.screenshot({ path: testInfo.outputPath('scenes.png'), fullPage: true });
  const selectBox = await page.getByLabel('智能对话提供商', { exact: true }).boundingBox();
  expect(selectBox!.width).toBeGreaterThan(200);
  expect(selectBox!.x + selectBox!.width).toBeLessThanOrEqual(width);
  invalid = false;
  await page.getByLabel('智能对话提供商', { exact: true }).selectOption('');
  await chat.getByRole('button', { name: '保存分配' }).click();
  await expect(chat).toContainText('Primary / base（全局默认）');
  expect(writes.at(-1)).toEqual({ provider_id: null });
  expect(errors).toEqual([]);
});
