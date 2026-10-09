import { expect, test } from '@playwright/test';

for (const width of [1440, 390]) {
  for (const [name, result] of [
    ['success', { success: true, message: '连接成功' }],
    ['authentication', { success: false, error: '认证失败：HTTP 401，请检查 API Key。' }],
    ['balance', { success: false, error: '余额不足：HTTP 402，请充值后重试。' }],
    ['network', { success: false, error: '网络失败：ECONNRESET，请检查网络及 Base URL。' }],
  ] as const) {
    test(`connection feedback stays below the button: ${name} at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      let finish!: () => void;
      const response = new Promise<void>(resolve => { finish = resolve; });
      const requests: unknown[] = [];
      await page.route('**/api/llm/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/test')) {
          requests.push(route.request().postDataJSON()); await response;
          return route.fulfill({ json: result });
        }
        return route.fulfill({ json: path.endsWith('/configs') ? [{
          id: 1, name: 'deepseek', display_name: 'DeepSeek', enabled: true, is_default: true,
          api_base_url: 'https://mock.example/v1', default_model: 'mock-model', context_window: 64000, max_tokens: 2048,
          models_supported: Array.from({ length: 5 }, (_, i) => ({ id: `mock-${i}` })),
        }] : [] });
      });
      await page.route('**/settings/ai/models?**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
        <settings-shell></settings-shell>
        <script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/settings-shell.ts'; import '/src/app/ui/views/llm-config.ts';</script>
        </body></html>` }));
      await page.goto('/settings/ai/models?view=providers');
      const button = page.getByRole('button', { name: '测试连接', exact: true });
      await button.scrollIntoViewIfNeeded();
      await page.clock.install();
      await button.click();
      const region = page.getByRole('status', { name: '连接测试结果' });
      await expect(region).toContainText('正在测试连接');
      await expect(page.getByRole('button', { name: '测试中...' })).toBeDisabled();
      await expect(region).toBeInViewport({ ratio: 0.99 });
      finish();
      await expect(region).toContainText(result.success ? result.message : result.error);
      await expect(region).toHaveCount(1);
      await expect(region).toHaveAttribute('aria-live', 'polite');
      await expect(region).toHaveAttribute('aria-atomic', 'true');
      await expect(region).toBeInViewport({ ratio: 0.99 });
      const buttonBox = (await button.boundingBox())!;
      const resultBox = (await region.boundingBox())!;
      expect(resultBox.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height);
      expect(resultBox.y - buttonBox.y - buttonBox.height).toBeLessThan(40);
      expect(resultBox.x + resultBox.width).toBeLessThanOrEqual(width);
      expect(resultBox.y + resultBox.height).toBeLessThanOrEqual(901); // Allow subpixel scroll rounding.
      await page.clock.runFor(9000);
      await expect(region).toContainText(result.success ? result.message : result.error);
      expect(requests).toEqual([{ providerName: 'deepseek', baseURL: 'https://mock.example/v1', model: 'mock-model', deploymentType: 'api' }]);
      expect(errors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`) });
      await testInfo.attach('geometry', { body: JSON.stringify({ width, buttonBox, resultBox }), contentType: 'application/json' });
      await page.getByLabel('Base URL', { exact: true }).fill('https://changed.example/v1');
      await expect(region).toBeEmpty();
    });
  }
}
