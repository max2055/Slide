import { expect, test } from '@playwright/test';

// #438: normal application route and authFetch; HTTP responses are controlled,
// without a real JWT, database collection or provider call.
for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`collection errors release loading and permit keyboard retry ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(() => {
      localStorage.setItem('token', 'max401-controlled');
      localStorage.setItem('permissions', '["*"]');
      localStorage.setItem('app-theme-mode', 'light');
    });
    let calls = 0;
    let mode = 'success';
    let release!: () => void;
    let gate = Promise.resolve();
    await page.route('**/__slide/**', route => route.fulfill({ json: {} }));
    await page.routeWebSocket('**/agent-ws', () => {});
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/api/')) return route.fallback();
      if (path === '/api/schema/collect/1') {
        calls++;
        expect(route.request().method()).toBe('POST');
        await gate;
        if (mode === 'network') return route.abort('failed');
        if (mode === 'invalid JSON') return route.fulfill({ body: '{', contentType: 'application/json' });
        if (mode === 'HTTP invalid JSON') return route.fulfill({ status: 503, body: '<html>' });
        if (mode === '403' || mode === '503') return route.fulfill({ status: Number(mode), json: { error: `受控错误 ${mode}` } });
        return route.fulfill({ json: { success: true, data: { tables: 1, columns: 2, collected: 2 } } });
      }
      let data: unknown = [];
      if (path === '/api/auth/permissions') data = ['*'];
      if (path === '/api/auth/me') data = { id: 1, username: 'max401' };
      if (path === '/api/database/instances') data = [{ id: 1, name: '受控实例', db_type: 'mysql', database_name: 'fixture' }];
      if (path === '/api/schema/snapshot/1') data = { tables: [{ table_name: 'existing_table', table_rows: 1, data_length: 10, column_count: 2 }] };
      if (path === '/api/schema/changes/1') data = { changes: [] };
      return route.fulfill({ json: data });
    });
    await page.goto('/schema');
    const view = page.locator('schema-management-page');
    const button = view.getByRole('button', { name: '采集快照', exact: true });
    await expect(button).toBeEnabled();
    await expect(view).toContainText('existing_table');
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(view).toContainText('采集成功：1 张表，2 个列');
    expect(calls).toBe(1);
    for (const failure of ['503', '403', 'HTTP invalid JSON', 'network', 'invalid JSON']) {
      mode = failure;
      gate = new Promise<void>(done => { release = done; });
      const before = calls;
      try {
        await button.focus();
        await page.keyboard.press('Enter');
        await expect(view.getByRole('button', { name: '采集中...' })).toBeDisabled();
        await expect.poll(() => calls).toBe(before + 1);
      } finally { release(); }
      await expect(button).toBeEnabled();
      await expect(view).not.toContainText('采集成功：');
      await expect(view).toContainText('existing_table');
      await expect(view.locator('.card').first()).toContainText(
        failure === '503' || failure === '403' ? `受控错误 ${failure}` : failure === 'HTTP invalid JSON' ? 'HTTP 503' : /fetch|JSON/i,
      );
      await page.screenshot({ path: info.outputPath(`${failure.replaceAll(' ', '-')}-failure.png`) });
      // Allow application rendering/read activity to settle; no automatic POST.
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      expect(calls).toBe(before + 1);
      mode = 'success';
      gate = Promise.resolve();
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(view).toContainText('采集成功：1 张表，2 个列');
      await expect(button).toBeEnabled();
      expect(calls).toBe(before + 2);
    }
    await button.focus();
    await expect(button).toBeFocused();
    const box = await button.boundingBox();
    expect(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height).toBe(true);
    await page.screenshot({ path: info.outputPath('recovered.png') });
  });
}
