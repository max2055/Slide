import { expect, test } from '@playwright/test';
import { createCredentialProbeFixture } from '../../apps/db-ops-api/tests/fixtures/llm-credential-probe.js';

for (const [name, modelId] of [['deepseek', 'deepseek-flash'], ['stepfun', 'step-3.5-flash-2603'], ['mimo', 'mimo-v2-flash']]) {
  test(`${name} credential binding: rejected URL change, draft key, saved test`, async ({ page }, testInfo) => {
    const fixture = await createCredentialProbeFixture(name, modelId);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/llm/**', async route => {
      const response = await fixture.app.inject({ method: route.request().method() as any,
        url: new URL(route.request().url()).pathname, headers: { authorization: 'fake-manager', 'content-type': 'application/json' },
        payload: route.request().postData() || undefined });
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await page.route('**/settings/ai/models?**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
      <settings-shell></settings-shell>
      <script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/settings-shell.ts'; import '/src/app/ui/views/llm-config.ts';</script>
      </body></html>` }));
    try {
      await page.goto('/settings/ai/models?view=providers');
      const key = page.locator('input[autocomplete="new-password"]');
      await expect(key).toHaveValue('');
      await page.getByRole('button', { name: '加载模型', exact: true }).click();
      await expect(page.getByLabel('选择模型', { exact: true })).toContainText(modelId);
      await page.getByRole('button', { name: '测试连接', exact: true }).click();
      await expect(page.locator('.msg').filter({ hasText: /连接成功|LLM_CREDENTIAL_DESTINATION_MISMATCH/ })).toContainText('连接成功');
      expect(fixture.keyReads()).toBe(2);
      await page.getByLabel('Base URL', { exact: true }).fill(fixture.origin + '/draft/v1');
      await page.getByRole('button', { name: '测试连接', exact: true }).click();
      await expect(page.locator('.msg').filter({ hasText: /连接成功|LLM_CREDENTIAL_DESTINATION_MISMATCH/ })).toContainText('LLM_CREDENTIAL_DESTINATION_MISMATCH');
      await page.getByRole('button', { name: '加载模型', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('LLM_CREDENTIAL_DESTINATION_MISMATCH');
      expect(fixture.keyReads()).toBe(2); expect(fixture.calls).toHaveLength(2);
      await key.fill('fake-draft-key');
      await page.getByRole('button', { name: '加载模型', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('已加载 1 个模型');
      await page.getByRole('button', { name: '测试连接', exact: true }).click();
      await expect(page.locator('.msg').filter({ hasText: /连接成功|LLM_CREDENTIAL_DESTINATION_MISMATCH/ })).toContainText('连接成功');
      expect(fixture.keyReads()).toBe(2);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByRole('button', { name: '✓ 已保存' })).toBeVisible();
      await expect(key).toHaveValue('');
      await page.getByRole('button', { name: '测试连接', exact: true }).click();
      await expect(page.locator('.msg').filter({ hasText: /连接成功|LLM_CREDENTIAL_DESTINATION_MISMATCH/ })).toContainText('连接成功');
      expect(fixture.keyReads()).toBe(3);
      expect(fixture.calls.slice(2).every(call => call.path.startsWith('/draft/v1/') && call.credential?.includes('fake-draft-key'))).toBe(true);
      expect(errors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('credential-binding.png'), fullPage: true });
    } finally { await fixture.close(); }
  });
}

for (const width of [390, 1280]) test(`loads models, applies parameters and saves the selected model at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const model = { id: 'step-3.5-flash-2603', name: 'Step 3.5 Flash 2603', contextWindow: 256000, maxTokens: 256000, supportsFunctionCall: true, supportsVision: false, parameterProvider: 'stepfun', parameterSource: 'catalog' };
  const provider = { id: 11, name: 'step', display_name: 'StepFun', enabled: true, is_default: true,
    api_base_url: 'https://api.stepfun.com/step_plan/v1', default_model: model.id, context_window: 4096, max_tokens: 2048, supports_function_call: true, models_supported: [] as any[] };
  const writes: any[] = [];
  let fail = false;
  await page.route('**/api/llm/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/models')) {
      expect(route.request().method()).toBe('POST');
      expect(route.request().postDataJSON()).toMatchObject({ providerName: 'step', baseURL: provider.api_base_url });
      return route.fulfill(fail ? { status: 502, json: { error: 'MODEL_DISCOVERY_HTTP_401' } } : { json: { source: 'api', models: [model, { id: 'unknown-next', parameterSource: 'unknown' }] } });
    }
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON(); writes.push(body);
      Object.assign(provider, { context_window: body.contextWindow, max_tokens: body.maxTokens, default_model: body.model, supports_function_call: body.supportsFunctionCall, models_supported: body.modelsSupported });
      return route.fulfill({ json: { success: true } });
    }
    return route.fulfill({ json: path.endsWith('/configs') ? [provider] : [] });
  });
  await page.route('**/settings/ai/models?**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <settings-shell></settings-shell>
    <script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/settings-shell.ts'; import '/src/app/ui/views/llm-config.ts';</script>
    </body></html>` }));
  await page.goto('/settings/ai/models?view=providers');
  await expect(page.getByLabel('上下文窗口', { exact: true })).toHaveValue('4096');
  await page.getByRole('button', { name: '加载模型', exact: true }).click();
  await expect(page.getByLabel('选择模型', { exact: true })).toContainText(model.name);
  await page.getByLabel('选择模型', { exact: true }).selectOption(model.id);
  await expect(page.getByLabel('上下文窗口', { exact: true })).toHaveValue('256000');
  await expect(page.getByLabel('Max Tokens', { exact: true })).toHaveValue('4096');
  await expect(page.getByLabel('支持工具调用', { exact: true })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('model-parameters.png'), fullPage: true });
  const contextBox = await page.getByLabel('上下文窗口', { exact: true }).boundingBox();
  const panelBox = await page.locator('llm-config-page').boundingBox();
  expect(contextBox!.x + contextBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '✓ 已保存' })).toBeVisible();
  expect(writes.at(-1)).toMatchObject({ contextWindow: 256000, maxTokens: 4096, supportsFunctionCall: true, model: model.id });
  await page.reload();
  await expect(page.getByLabel('上下文窗口', { exact: true })).toHaveValue('256000');
  fail = true;
  await page.getByRole('button', { name: '加载模型', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('MODEL_DISCOVERY_HTTP_401');
  await expect(page.getByLabel('选择模型', { exact: true })).toHaveValue(model.id);
  await page.getByLabel('选择模型', { exact: true }).selectOption('unknown-next');
  await expect(page.getByRole('status')).toContainText('未知模型参数');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.msg-err')).toContainText('上下文窗口');
  expect(writes).toHaveLength(1);
  expect(errors).toEqual([]);
});

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
