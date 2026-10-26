import { expect, test } from '@playwright/test';

/**
 * Provider saves are persisted before they reach the runtime. The backend
 * responses here are fixtures: they exercise the real page, not a real provider.
 */
const provider = {
  id: 1, name: 'deepseek', display_name: 'DeepSeek', enabled: true, is_default: true,
  api_base_url: 'https://mock.example/v1', default_model: 'mock-model', context_window: 64000, max_tokens: 2048,
  models_supported: [{ id: 'mock-model', contextWindow: 64000, maxTokens: 2048 }],
};

async function open(page: any, putResponse: (attempt: number) => { status?: number; json: unknown }) {
  let attempts = 0;
  await page.route('**/api/llm/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'PUT' && path.endsWith('/configs/1')) {
      const response = putResponse(++attempts);
      return route.fulfill({ status: response.status ?? 200, json: response.json });
    }
    return route.fulfill({ json: path.endsWith('/configs') ? [provider] : [] });
  });
  await page.route('**/settings/ai/models?**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <settings-shell></settings-shell>
    <script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/settings-shell.ts'; import '/src/app/ui/views/llm-config.ts';</script>
    </body></html>` }));
  await page.goto('/settings/ai/models?view=providers');
  await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeEnabled();
}

test('a saved but unapplied provider is not shown as effective and can be retried from the keyboard', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await open(page, attempt => attempt === 1
    ? { json: { success: true, providerId: 1, applied: false, reloadError: 'LLM_CONFIGURATION_UNAVAILABLE' } }
    : { json: { success: true, providerId: 1, applied: true } });

  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  const warning = page.getByRole('alert', { name: '运行时应用结果' });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('配置已保存');
  await expect(warning).toContainText('尚未应用到运行时');
  await expect(warning).toContainText('LLM_CONFIGURATION_UNAVAILABLE');
  await expect(page.getByRole('button', { name: '✓ 已保存配置' })).toHaveCount(0);

  const retry = warning.getByRole('button', { name: '重试应用' });
  await expect(retry).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('saved-not-applied.png') });
  await retry.focus();
  await expect(retry).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(warning).toHaveCount(0);
  await expect(page.getByRole('button', { name: '✓ 已保存配置' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('an applied save reports success while a rejected save reports the failure', async ({ page }) => {
  await open(page, attempt => attempt === 1
    ? { json: { success: true, providerId: 1, applied: true } }
    : { status: 500, json: { error: '更新 LLM 配置失败：数据库不可用' } });

  const save = page.getByRole('button', { name: '保存配置', exact: true });
  await save.click();
  await expect(page.getByRole('button', { name: '✓ 已保存配置' })).toBeVisible();
  await expect(page.getByRole('alert', { name: '运行时应用结果' })).toHaveCount(0);

  await save.click();
  await expect(page.getByRole('alert').filter({ hasText: '数据库不可用' })).toBeVisible();
  await expect(page.getByRole('alert', { name: '运行时应用结果' })).toHaveCount(0);
});
