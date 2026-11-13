import { expect, test } from '@playwright/test';
import { collectionStatus } from '../src/app/ui/components/metric-test-fixtures.js';

// Real production Lit page, dialogs, table and authFetch in desktop Edge.
// HTTP inventory/permissions/deletion are fixtures: no JWT or real DB deletion.
for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`MAX387/MAX388 delayed deletion, recovery and keyboard ${width}x${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    let entries = [
      { id: 387001, name: 'MAX387独占样本', host: '192.0.2.87', port: 3306, db_type: 'mysql', username: 'test', health_status: 'healthy' },
      { id: 387002, name: '保留样本', host: '192.0.2.88', port: 3306, db_type: 'mysql', username: 'test', health_status: 'healthy' },
    ];
    const deletes: string[] = [];
    let reads = 0;
    let release!: () => void;
    let gate = new Promise<void>(done => { release = done; });
    let failure = true;
    await page.addInitScript(() => localStorage.setItem('permissions', JSON.stringify(['instance:view', 'instance:delete', 'instance:update'])));
    await page.route('**/api/**', async route => {
      const p = new URL(route.request().url()).pathname;
      if (!p.startsWith('/api/')) return route.fallback();
      if (route.request().method() === 'DELETE') {
        deletes.push(p); await gate;
        if (failure) return route.fulfill({ status: 409, json: { error: '实例仍在使用' } });
        entries = entries.filter(e => !p.endsWith(`/${e.id}`));
        return route.fulfill({ json: { success: true } });
      }
      if (p === '/api/database/instances') { reads++; return route.fulfill({ json: entries }); }
      if (p === '/api/resources/overview') return route.fulfill({ json: { items: [] } });
      if (p === '/api/metrics/query') return route.fulfill({ json: { profile: { columns: [] }, window: {}, metrics: [] } });
      if (p.endsWith('/status')) return route.fulfill({ json: collectionStatus() });
      return route.fulfill({ json: [] });
    });
    await page.route('**/max387-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><body><instances-page></instances-page><app-toast-container></app-toast-container><script type="module">import "/src/app/styles.css";import "/src/app/ui/views/instances-db.ts";</script></body></html>' }));
    try {
      await page.goto('/max387-fixture');
      const host = page.locator('instances-page');
      const rowDelete = host.getByRole('button', { name: '删除', exact: true }).first();
      await rowDelete.focus(); await page.keyboard.press('Enter');
      const dialog = host.locator('app-dialog[title="确认删除实例？"]');
      await expect(dialog.getByRole('dialog', { name: '确认删除实例？' })).toBeVisible();
      // Native modal initial focus, Tab and cancellation restore the invoking button.
      await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0); await expect(rowDelete).toBeFocused();
      await page.keyboard.press('Enter');
      const confirm = dialog.getByRole('button', { name: '确认删除', exact: true });
      const firstBox = (await confirm.boundingBox())!;
      await page.mouse.dblclick(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
      // Even manually dispatched duplicate events must be rejected.
      await dialog.getByRole('button', { name: '删除中...' }).evaluate(el => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await expect.poll(() => deletes.length).toBe(1);
      await expect(dialog.getByRole('button', { name: '删除中...' })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(dialog.getByRole('dialog', { name: '确认删除实例？' })).toBeVisible();
      // Direct re-entry and target replacement cannot affect the pending delete.
      await host.evaluate((el: any) => { void el._handleDelete(); el._deleteInstance({ id: 387002, name: '保留样本' }); el._closeDialogs(); });
      await expect(dialog).toContainText('MAX387独占样本');
      expect(deletes).toEqual(['/api/database/instances/387001']);
      await page.screenshot({ path: info.outputPath('busy.png') });
      release();
      await expect(dialog.getByRole('alert')).toContainText('删除失败：实例仍在使用');
      await expect(confirm).toBeEnabled();
      await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeEnabled();
      expect(deletes).toHaveLength(1);
      await page.screenshot({ path: info.outputPath('failure.png') });
      failure = false; gate = new Promise<void>(done => { release = done; });
      await confirm.focus(); await page.keyboard.press('Enter');
      await expect.poll(() => deletes.length).toBe(2);
      const busy = dialog.getByRole('button', { name: '删除中...' });
      // Real pointer double click while the response is delayed.
      const box = (await busy.boundingBox())!;
      await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
      expect(deletes).toHaveLength(2);
      const beforeSuccessReads = reads;
      release();
      await expect(dialog).toHaveCount(0);
      await expect(host.locator('.resource-result-count')).toContainText('共 1 ');
      await expect.poll(() => reads).toBeGreaterThan(beforeSuccessReads);
      await expect(page.locator('app-toast-container')).toContainText('实例删除成功');
      await expect(host.locator('.resource-toolbar input')).toBeFocused();
      await host.locator('.resource-toolbar input').fill('MAX387');
      await expect(host.locator('.resource-result-count')).toContainText('共 0 ');
      await host.locator('.resource-toolbar input').fill('保留');
      await expect(host.locator('.resource-result-count')).toContainText('共 1 ');
      expect(deletes).toEqual(['/api/database/instances/387001', '/api/database/instances/387001']);
      await page.screenshot({ path: info.outputPath('success.png') });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await info.attach('requests', { body: JSON.stringify({ deletes, reads }), contentType: 'application/json' });
    } finally {
      release(); await page.close();
    }
  });
}
