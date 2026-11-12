import { expect, test } from '@playwright/test';

// MAX-359: production Lit components + HTTP fault injection in Chromium.
// This fixture does not claim real backend, authentication or production coverage.
for (const kind of ['roles', 'permissions'] as const) {
  for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
    test(`${kind} delete failure retains list and retries at ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      const item = { id: 9, name: '可重试对象', code: 'test:read', resource: 'test', action: 'read', description: '删除失败保留列表' };
      let removed = false, deletes = 0, loads = 0;
      await page.route(`**/api/v1/rbac/${kind}**`, async route => {
        if (route.request().method() === 'DELETE') {
          deletes++;
          if (deletes === 1) return route.fulfill({ status: 409, json: { error: '对象仍被引用' } });
          removed = true;
          return route.fulfill({ json: { success: true } });
        }
        loads++;
        return route.fulfill({ json: removed ? [] : [item] });
      });
      await page.route('**/rbac-delete-fixture', route => route.fulfill({ contentType: 'text/html', body:
        `<html><body><app-toast-container></app-toast-container><${kind === 'roles' ? 'role-management-tab' : 'permission-management-tab'}></${kind === 'roles' ? 'role-management-tab' : 'permission-management-tab'}><script type="module">import "/src/app/styles.css"; import "/src/app/ui/components/app-toast-container.ts"; import "/src/app/ui/views/rbac-page.ts";</script></body></html>` }));
      await page.goto('/rbac-delete-fixture');
      const row = page.getByRole('row').filter({ hasText: '可重试对象' });
      const remove = row.getByRole('button', { name: '删除', exact: true });
      await expect(remove).toBeVisible();
      // Cancel retains both the list and the server state.
      page.once('dialog', dialog => dialog.dismiss());
      await remove.click();
      expect(deletes).toBe(0);
      page.once('dialog', dialog => dialog.accept());
      await remove.click();
      await expect(page.locator('.toast--error')).toContainText('删除失败');
      await expect(page.locator('.toast--error')).toContainText('对象仍被引用');
      await expect(row).toBeVisible();
      await expect(remove).toBeEnabled();
      expect(loads).toBe(1);
      expect(deletes).toBe(1);
      await page.screenshot({ path: info.outputPath('delete-failure.png') });
      // Transient notification expires without replacing the table.
      await expect(page.locator('.toast--error')).toHaveCount(0, { timeout: 6000 });
      await expect(row).toBeVisible();
      // Retry via the keyboard, including the existing destructive confirmation.
      await remove.focus();
      await expect(remove).toBeFocused();
      page.once('dialog', dialog => dialog.accept());
      await page.keyboard.press('Enter');
      await expect(row).toHaveCount(0);
      await expect(page.locator('app-empty-state')).toBeVisible();
      expect(deletes).toBe(2);
      expect(loads).toBe(2);
    });
  }
}
