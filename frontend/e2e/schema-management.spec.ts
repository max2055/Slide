import { expect, test } from '@playwright/test';
// Production UI/authFetch with controlled API responses; no real database/JWT.
const hint = '需要至少两次快照才能进行变更检测';
for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`#676/#677/#678 schema navigation and change presentation ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(() => { localStorage.setItem('token', 'max555-controlled'); localStorage.setItem('permissions', '["*"]'); });
    let old: string | null = '0', next: string | null = null;
    let insufficient = true;
    await page.route('**/__slide/**', route => route.fulfill({ json: {} }));
    await page.routeWebSocket('**/agent-ws', () => {});
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/api/')) return route.fallback();
      const id = Number(path.match(/\/(\d+)$/)?.[1] || 1);
      const instance = { id, name: `实例-${id}`, db_type: 'mysql', status: 'connected', host: 'fixture.invalid', port: 3306, database_name: `db-${id}` };
      let data: unknown = [];
      if (path === '/api/auth/permissions') data = ['*'];
      if (path === '/api/auth/me') data = { id: 1, username: 'max555' };
      if (path === '/api/database/instances') data = [1, 2].map(id => ({ ...instance, id, name: `实例-${id}` }));
      if (/\/api\/database\/instances\/\d+$/.test(path)) data = instance;
      if (/\/api\/schema\/snapshot\/\d+$/.test(path)) data = { tables: [{ table_name: `table-${id}`, column_count: 1, table_rows: 0, data_length: null }] };
      if (path.includes('/api/schema/changes/')) data = insufficient ? { success: true, changes: [], hint } : { success: true, changes: [{ type: 'modified', target: 'column', table_name: `table-${id}`, column_name: 'c', detected_at: new Date().toISOString(), details: { column_default: { old, new: next } } }] };
      return route.fulfill({ json: data });
    });
    // Two history entries, then browser back while the schema tab is active.
    await page.goto('/instance-detail?id=1');
    await page.getByRole('tab', { name: '表结构', exact: true }).click();
    await expect(page.locator('schema-management-page')).toContainText('table-1');
    await page.evaluate(() => { history.pushState({}, '', '/instance-detail?id=2'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await expect(page.locator('schema-management-page')).toContainText('table-2');
    await page.goBack();
    const view = page.locator('schema-management-page');
    await expect(view).toContainText('table-1'); await expect(view).not.toContainText('table-2');
    const detect = view.getByRole('button', { name: '检测变更', exact: true });
    await detect.focus(); await page.keyboard.press('Enter');
    await expect(view.locator('p[role="status"]')).toContainText(hint);
    await page.screenshot({ path: info.outputPath('hint.png') });
    insufficient = false;
    for ([old, next] of [['0', null], [null, '0'], ['value', ''], ['', 'value'], [null, ''], ['', null]]) {
      await detect.click();
      await view.getByRole('button', { name: '变更历史', exact: true }).click();
      const format = (v: string | null) => v === null ? 'NULL' : v === '' ? '""' : v;
      await expect(view.locator('.change-detail')).toHaveText(`column_default: ${format(old)} → ${format(next)}`);
      await expect(view).not.toContainText(hint);
    }
    await detect.focus(); await expect(detect).toBeFocused();
    const box = await detect.boundingBox();
    expect(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height).toBe(true);
    await page.screenshot({ path: info.outputPath('default-change.png') });
  });
}
