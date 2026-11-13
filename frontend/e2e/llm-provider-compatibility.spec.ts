import { expect, test } from '@playwright/test';

const provider = {
  id: 1, name: 'google', display_name: '历史 Google 配置', api_format: 'google-generative-ai',
  enabled: true, is_default: true, api_base_url: 'https://legacy.example/v1',
  default_model: 'fixture', context_window: 64000, max_tokens: 2048, models_supported: [],
};

test('historical protocol requires explicit migration in the real configuration form (#471)', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('token', 'fixture-token'));
  await page.route('**/api/auth/permissions', route => route.fulfill({ json: ['llm:view'] }));
  const writes: any[] = [];
  let saved = { ...provider };
  await page.route('**/api/llm/**', async route => {
    const request = route.request();
    if (request.method() === 'PUT') {
      const body = request.postDataJSON(); writes.push(body);
      saved = { ...saved, api_format: body.apiFormat, api_base_url: body.baseURL };
      return route.fulfill({ json: { success: true, applied: true } });
    }
    return route.fulfill({ json: new URL(request.url()).pathname.endsWith('/configs') ? [saved] : [] });
  });
  await page.route('**/settings/ai/models?**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <settings-shell></settings-shell>
    <script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/settings-shell.ts'; import '/src/app/ui/views/llm-config.ts';</script>
    </body></html>` }));
  await page.goto('/settings/ai/models?view=providers');
  const format = page.getByLabel('API 兼容格式');
  await expect(format).toHaveValue('google-generative-ai');
  await expect(format.locator('option:checked')).toBeDisabled();
  await expect(page.getByRole('alert').filter({ hasText: '请迁移' })).toBeVisible();
  for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await expect(format).toBeVisible();
    const save = page.getByRole('button', { name: '保存配置', exact: true });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    await format.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`historical-${width}.png`) });
  }
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  expect(writes).toEqual([]);
  await expect(format).toHaveValue('google-generative-ai');
  await format.focus(); await expect(format).toBeFocused();
  await format.selectOption('openai-completions');
  await page.getByRole('textbox', { name: 'Base URL', exact: true }).fill('https://compatible.example/v1');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ apiFormat: 'openai-completions', baseURL: 'https://compatible.example/v1' });
  await expect(format).toHaveValue('openai-completions');
  await expect(page.getByRole('alert').filter({ hasText: '请迁移' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const action of ['toggle', 'default'] as const) {
  test(`late list refresh cannot undo ${action} or scene drafts (#665)`, async ({ page }) => {
    const initial = { ...provider, name: 'custom', api_format: 'openai-completions', is_default: false };
    const fresh = { ...initial, enabled: action !== 'toggle', is_default: action === 'default' };
    let listReads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.addInitScript(() => localStorage.setItem('token', 'fixture-token'));
    await page.route('**/api/llm/**', async route => {
      const request = route.request();
      if (request.method() === 'POST') return route.fulfill({ json: { success: true, applied: true } });
      if (new URL(request.url()).pathname.endsWith('/configs')) {
        const read = ++listReads;
        if (read === 2) await gate;
        return route.fulfill({ json: [read >= 3 ? fresh : initial] });
      }
      return route.fulfill({ json: [] });
    });
    await page.route('**/provider-race-fixture', route => route.fulfill({ contentType: 'text/html',
      body: '<llm-config-page></llm-config-page><script type="module">import "/src/app/ui/views/llm-config.ts";</script>' }));
    try {
      await page.goto('/provider-race-fixture');
      await expect(page.getByRole('button', { name: '设为默认', exact: true })).toBeVisible();
      await page.evaluate(() => {
        (window as any).oldRefresh = (document.querySelector('llm-config-page') as any)._load(true);
      });
      await expect.poll(() => listReads).toBe(2);
      await page.getByRole('button', { name: action === 'toggle' ? '已启用' : '设为默认', exact: true }).click();
      await expect.poll(() => listReads).toBe(3);
      await expect(page.getByRole('status', { name: '操作结果' })).toBeVisible();
      await page.evaluate(() => {
        (document.querySelector('llm-config-page') as any).sceneDrafts = { chat: { provider_id: 1, model: 'unsaved' } };
      });
      release();
      await page.evaluate(() => (window as any).oldRefresh);
      const state = await page.evaluate(() => {
        const el = document.querySelector('llm-config-page') as any;
        return { providers: el.providers, editing: el.editing, enabled: el.form.enabled,
          is_default: el.form.is_default, sceneDrafts: el.sceneDrafts };
      });
      expect(state.providers).toEqual([fresh]);
      expect(state.editing).toEqual(fresh);
      expect(state.enabled).toBe(fresh.enabled);
      expect(state.is_default).toBe(fresh.is_default);
      expect(state.sceneDrafts.chat.model).toBe('unsaved');
    } finally {
      release();
      // Release the delayed route and settle its client before Playwright closes the page.
      await page.evaluate(() => (window as any).oldRefresh).catch(() => {});
    }
  });
}

test('#300 display name keeps 100 characters and rejects 101 in the browser', async ({ page }, testInfo) => {
  const writes: any[] = [];
  let saved = { ...provider, name: 'custom', api_format: 'openai-completions', display_name: '名'.repeat(100) };
  await page.route('**/api/llm/**', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON(); writes.push(body); saved = { ...saved, display_name: body.displayName };
      return route.fulfill({ json: { success: true, applied: true } });
    }
    return route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/configs') ? [saved] : [] });
  });
  await page.route('**/name-contract-fixture', route => route.fulfill({ contentType: 'text/html',
    body: '<llm-config-page></llm-config-page><script type="module">import "/src/app/styles.css";import "/src/app/ui/views/llm-config.ts";</script>' }));
  await page.goto('/name-contract-fixture');
  const input = page.getByLabel('显示名称', { exact: true });
  const save = page.getByRole('button', { name: '保存配置', exact: true });
  await expect(input).toHaveValue('名'.repeat(100));
  await expect(input).toHaveAccessibleDescription('最多 100 个字符');
  for (const [width, height] of [[1440,900],[1366,768],[1920,1080]]) {
    await page.setViewportSize({ width,height }); await input.scrollIntoViewIfNeeded();
    await input.focus(); await expect(input).toBeFocused();
    await input.press('Tab'); await expect(input).not.toBeFocused();
    await save.scrollIntoViewIfNeeded(); await expect(save).toBeInViewport();
    await input.scrollIntoViewIfNeeded(); await page.screenshot({path:testInfo.outputPath(`name-${width}.png`)});
  }
  for (const name of ['名'.repeat(51), '名'.repeat(100), '😀'.repeat(100)]) {
    await input.fill(name); await save.click();
    await expect.poll(() => writes.at(-1)?.displayName).toBe(name);
    await page.waitForFunction(() => !(document.querySelector('llm-config-page') as any).saving);
    await expect(input).toHaveValue(name);
  }
  await input.fill('名'.repeat(101)); await save.click();
  await expect(page.getByText('显示名称最多 100 个字符', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(3); await expect(input).toHaveValue('名'.repeat(101));
});
