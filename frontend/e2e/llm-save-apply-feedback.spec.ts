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

async function open(
  page: any,
  putResponse: (attempt: number) => { status?: number; json: unknown },
  options: { provider?: typeof provider; postResponses?: Record<string, Array<{ status?: number; json: unknown }>> } = {},
) {
  let attempts = 0;
  const postCalls: Record<string, number> = {};
  await page.route('**/api/llm/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'PUT' && path.endsWith('/configs/1')) {
      const response = putResponse(++attempts);
      return route.fulfill({ status: response.status ?? 200, json: response.json });
    }
    if (request.method() === 'POST' && options.postResponses?.[path]) {
      const queue = options.postResponses[path];
      const index = postCalls[path] ?? 0;
      postCalls[path] = index + 1;
      const response = queue[Math.min(index, queue.length - 1)];
      return route.fulfill({ status: response.status ?? 200, json: response.json });
    }
    return route.fulfill({ json: path.endsWith('/configs') ? [options.provider ?? provider] : [] });
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

test('a later toggle that did not reach the runtime replaces the earlier save success', async ({ page }) => {
  await open(page, () => ({ json: { success: true, providerId: 1, applied: true } }), {
    postResponses: { '/api/llm/configs/1/toggle': [{ json: { success: true, applied: false, reloadError: 'LLM_CONFIGURATION_UNAVAILABLE' } }] },
  });

  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('button', { name: '✓ 已保存配置' })).toBeVisible();

  await page.getByRole('button', { name: /已启用/ }).click();
  const warning = page.getByRole('alert', { name: '运行时应用结果' });
  await expect(warning).toContainText('尚未应用到运行时');
  // Snapshot at the moment the warning shows: the earlier save success must already be gone.
  const saveButton = page.getByRole('button', { name: /保存配置/ });
  expect(await saveButton.textContent()).not.toContain('已保存配置');
  expect(await page.getByRole('status', { name: '操作结果' }).count()).toBe(0);
});

test('retrying a failed default switch clears the error and confirms the applied result', async ({ page }) => {
  const notDefault = { ...provider, is_default: false };
  await open(page, () => ({ json: { success: true, applied: true } }), {
    provider: notDefault,
    postResponses: {
      '/api/llm/configs/1/default': [
        { status: 500, json: { error: '默认切换失败：数据库不可用' } },
        { json: { success: true, applied: true } },
      ],
    },
  });

  await page.getByRole('button', { name: '设为默认' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '默认切换失败' })).toBeVisible();

  await page.getByRole('button', { name: '设为默认' }).click();
  await expect(page.getByRole('status', { name: '操作结果' })).toContainText('已应用到运行时');
  await expect(page.getByRole('alert').filter({ hasText: '默认切换失败' })).toHaveCount(0);
  await expect(page.getByRole('alert', { name: '运行时应用结果' })).toHaveCount(0);
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
