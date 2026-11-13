import { expect, test } from '@playwright/test';
import { collectionStatus } from '../src/app/ui/components/metric-test-fixtures.js';

// Real production Lit page, dialogs, table and authFetch in desktop Edge.
// HTTP inventory/permissions/deletion are fixtures: no JWT or real DB deletion.
for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`MAX391 delayed deletion, recovery and keyboard ${width}x${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    let entries = [
      { id: 391001, label: 'MAX391独占样本', host: '192.0.2.87', port: 22, os_type: 'unrecognized-os', credential_type: 'password', status: 'offline', health_status: 'healthy' },
      { id: 391002, label: '保留样本', host: '192.0.2.88', port: 22, os_type: 'unrecognized-os', credential_type: 'password', status: 'offline', health_status: 'healthy' },
    ];
    const deletes: string[] = [];
    const updates: Record<string, unknown>[] = [];
    let reads = 0;
    let release!: () => void;
    let gate = new Promise<void>(done => { release = done; });
    let failure = true;
    await page.addInitScript(() => localStorage.setItem('permissions', JSON.stringify(['servers:view', 'servers:manage'])));
    await page.route('**/api/**', async route => {
      const p = new URL(route.request().url()).pathname;
      if (!p.startsWith('/api/')) return route.fallback();
      if (route.request().method() === 'DELETE') {
        deletes.push(p); await gate;
        if (failure) return route.fulfill({ status: 409, json: { error: '服务器仍在使用' } });
        entries = entries.filter(e => !p.endsWith(`/${e.id}`));
        return route.fulfill({ json: { success: true } });
      }
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON();
        updates.push(body);
        entries = entries.map(e => p.endsWith('/' + e.id) ? { ...e, ...body } : e);
        return route.fulfill({ json: { success: true } });
      }
      if (/^\/api\/servers\/\d+$/.test(p)) return route.fulfill({ json: { credential_username: 'ops' } });
      if (p === '/api/servers') { reads++; return route.fulfill({ json: entries }); }
      if (p === '/api/resources/overview') return route.fulfill({ json: { items: [] } });
      if (p === '/api/metrics/query') return route.fulfill({ json: { profile: { columns: [] }, window: {}, metrics: [] } });
      if (p.endsWith('/status')) return route.fulfill({ json: collectionStatus() });
      return route.fulfill({ json: [] });
    });
    await page.route('**/max391-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><body><servers-page></servers-page><app-toast-container></app-toast-container><script type="module">import "/src/app/styles.css";import "/src/app/ui/views/servers-page.ts";</script></body></html>' }));
    try {
      await page.goto('/max391-fixture');
      const host = page.locator('servers-page');
      const rowDelete = host.getByRole('button', { name: '删除', exact: true }).first();
      await rowDelete.focus(); await page.keyboard.press('Enter');
      const dialog = host.locator('app-dialog[title="确认删除"]');
      await expect(dialog.getByRole('dialog', { name: '确认删除' })).toBeVisible();
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
      await expect.poll(() => deletes.length).toBe(1);
      // Even manually dispatched duplicate events must be rejected.
      await dialog.getByRole('button', { name: '删除中...' }).evaluate(el => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await expect.poll(() => deletes.length).toBe(1);
      await expect(dialog.getByRole('button', { name: '删除中...' })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(dialog.getByRole('dialog', { name: '确认删除' })).toBeVisible();
      // Direct re-entry and target replacement cannot affect the pending delete.
      await host.evaluate((el: any) => { void el._handleDelete(); el._confirmDelete({ id: 391002, label: '保留样本' }); el._closeDeleteDialog(); });
      await expect(dialog).toContainText('192.0.2.87');
      expect(deletes).toEqual(['/api/servers/391001']);
      await page.screenshot({ path: info.outputPath('busy.png') });
      release();
      await expect(dialog.getByRole('alert')).toContainText('删除失败：服务器仍在使用');
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
      await expect(page.locator('app-toast-container')).toContainText('服务器已删除');
      await expect(host.locator('.resource-toolbar input')).toBeFocused();
      await host.locator('.resource-toolbar input').fill('MAX391');
      await expect(host.locator('.resource-result-count')).toContainText('共 0 ');
      await host.locator('.resource-toolbar input').fill('保留');
      await expect(host.locator('.resource-result-count')).toContainText('共 1 ');
      expect(deletes).toEqual(['/api/servers/391001', '/api/servers/391001']);
      await page.screenshot({ path: info.outputPath('success.png') });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // MAX380: a surviving server's unknown OS must not become CentOS.
      await host.locator('.resource-toolbar input').fill('');
      await host.getByRole('button', { name: '编辑', exact: true }).click();
      const os = host.locator('app-form-field[label="操作系统"] select');
      await expect(os).toHaveValue('unrecognized-os');
      await host.locator('input[placeholder="例如：生产环境主服务器"]').fill('保留样本改标签');
      await host.getByRole('button', { name: '保存', exact: true }).click();
      await expect.poll(() => updates.length).toBe(1);
      expect(updates[0]).not.toHaveProperty('os_type');
      expect(entries[0].os_type).toBe('unrecognized-os');
      await expect(host.locator('resource-editor-shell')).toHaveCount(0);
      await info.attach('requests', { body: JSON.stringify({ deletes, reads, updates }), contentType: 'application/json' });
    } finally {
      release(); await page.close();
    }
  });
}

test('MAX391 unknown network outcome never replays and cancellation isolates the next target', async ({ page }, info) => {
  const deletes: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  await page.addInitScript(() => localStorage.setItem('permissions', JSON.stringify(['servers:view', 'servers:manage'])));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    if (route.request().method() === 'DELETE') {
      deletes.push(path);
      await gate;
      return route.abort('failed');
    }
    if (path === '/api/servers') return route.fulfill({ json: [
      { id: 391001, label: '未知结果样本', host: '192.0.2.87', port: 22, os_type: 'alpine' },
      { id: 391002, label: '下一目标样本', host: '192.0.2.88', port: 22, os_type: '' },
    ] });
    if (path === '/api/resources/overview') return route.fulfill({ json: { items: [] } });
    if (path === '/api/metrics/query') return route.fulfill({ json: { profile: { columns: [] }, window: {}, metrics: [] } });
    if (path.endsWith('/status')) return route.fulfill({ json: collectionStatus() });
    return route.fulfill({ json: [] });
  });
  await page.route('**/max391-unknown-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><body><servers-page></servers-page><app-toast-container></app-toast-container><script type="module">import "/src/app/styles.css";import "/src/app/ui/views/servers-page.ts";</script></body></html>' }));
  try {
    await page.goto('/max391-unknown-fixture');
    const host = page.locator('servers-page');
    await host.getByRole('button', { name: '删除', exact: true }).first().click();
    const dialog = host.locator('app-dialog[title="确认删除"]');
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect.poll(() => deletes.length).toBe(1);
    // A late network failure must still refer to the original target.
    await host.evaluate((el: any) => { el._confirmDelete({ id: 391002, host: '192.0.2.88' }); el._closeDeleteDialog(); void el._handleDelete(); });
    release();
    await expect(dialog.getByRole('alert')).toContainText('请刷新列表核对后再重试');
    await expect(dialog).toContainText('192.0.2.87');
    await expect(dialog.getByRole('button', { name: '确认删除', exact: true })).toBeFocused();
    expect(deletes).toEqual(['/api/servers/391001']);
    await page.screenshot({ path: info.outputPath('unknown.png') });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await host.getByRole('button', { name: '删除', exact: true }).nth(1).click();
    await expect(dialog).toContainText('192.0.2.88');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    expect(deletes).toEqual(['/api/servers/391001']);
    await info.attach('requests', { body: JSON.stringify(deletes), contentType: 'application/json' });
  } finally {
    release(); await page.close();
  }
});
