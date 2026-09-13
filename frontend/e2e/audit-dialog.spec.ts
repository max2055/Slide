import { expect, test } from '@playwright/test';

async function fixture(page: import('@playwright/test').Page) {
  await page.route('**/audit-dialog-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <button id="trigger">Open dialog</button><button id="background">Background</button>
    <app-dialog id="outer" title="Outer"><input aria-label="Slotted input"><div id="nested-control"></div>
      <app-dialog id="inner" title="Inner"><input aria-label="Inner input"></app-dialog>
      <button slot="footer" id="last">Last action</button>
    </app-dialog>
    <script type="module">
      import '/src/app/styles.css';
      import '/src/app/ui/components/app-dialog.ts';
      const outer = document.querySelector('#outer'); const inner = document.querySelector('#inner');
      document.querySelector('#trigger').onclick = () => { outer.open = true; };
      const shadow = document.querySelector('#nested-control').attachShadow({mode:'open'});
      shadow.innerHTML = '<button>Nested control</button>';
      shadow.querySelector('button').onclick = () => { inner.open = true; };
    </script></body></html>` }));
  await page.goto('/audit-dialog-fixture');
  await page.getByRole('button', { name: 'Open dialog' }).click();
  await expect(page.locator('#outer').getByRole('dialog', { name: 'Outer', exact: true })).toBeVisible();
}

for (const theme of ['light', 'dark']) for (const width of [390, 1280]) {
  test(`modal contains keyboard focus and fits ${theme} ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 }); await fixture(page);
    await page.evaluate(t => document.documentElement.dataset.themeMode = t, theme);
    const outer = page.locator('#outer'); const first = outer.getByRole('button', { name: 'Close dialog', exact: true }).first();
    await expect(first).toBeFocused();
    await page.keyboard.press('Tab'); await expect(page.getByLabel('Slotted input')).toBeFocused();
    await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Nested control' })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Last action' })).toBeFocused();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => { let el: Element | null = document.activeElement; while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement; return el?.id === 'background' || el?.id === 'trigger'; })).toBe(false);
    await first.focus(); await page.keyboard.press('Shift+Tab'); await expect(page.getByRole('button', { name: 'Last action' })).toBeFocused();
    const rect = await outer.locator('.dialog').boundingBox(); expect(rect!.width).toBeLessThanOrEqual(width); expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath('dialog.png') });
    await page.keyboard.press('Escape'); await expect(outer.getByRole('dialog')).toBeHidden(); await expect(page.locator('#trigger')).toBeFocused();
  });
}

test('nested dialogs restore deep focus and closable=false blocks Escape', async ({ page }) => {
  await fixture(page); await page.getByRole('button', { name: 'Nested control' }).click();
  const inner = page.locator('#inner'); await expect(inner.getByRole('dialog')).toBeVisible();
  await inner.evaluate(el => { (el as any).closable = false; });
  await page.keyboard.press('Escape'); await expect(inner.getByRole('dialog')).toBeVisible();
  await inner.evaluate(el => { (el as any).closable = true; });
  await page.keyboard.press('Escape'); await expect(inner.getByRole('dialog')).toBeHidden(); await expect(page.getByRole('button', { name: 'Nested control' })).toBeFocused();
  await page.locator('#outer').evaluate(el => el.remove()); await expect(page.locator('#trigger')).toBeFocused();
});

test('alerts shared dialogs preserve validation, submission and close behavior', async ({ page }) => {
  const writes: Array<{ url: string; body: any }> = [];
  await page.route('http://127.0.0.1:5186/api/**', route => {
    if (route.request().method() === 'POST') writes.push({ url: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return route.fulfill({ json: route.request().url().includes('/database/instances') ? [{ id: 7, name: 'test-db', db_type: 'mysql' }] : [] });
  });
  await page.route('**/alerts-dialog-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <alerts-page mode="rules"></alerts-page>
    <script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/alerts.ts';</script>
    </body></html>` }));
  await page.goto('/alerts-dialog-fixture');
  await page.getByRole('button', { name: '升级规则', exact: true }).click();
  await page.getByRole('button', { name: '新建规则', exact: true }).click();
  let modal = page.locator('app-dialog').filter({ has: page.getByRole('dialog', { name: '新建升级规则' }) });
  await modal.locator('input').fill('45');
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(writes.at(-1)).toMatchObject({ url: '/api/alerts/escalation/rules', body: { trigger_value: 45, from_level: 'warning', to_level: 'error' } });

  await page.getByRole('button', { name: '维护窗口', exact: true }).click();
  await page.getByRole('button', { name: '新建窗口', exact: true }).click();
  modal = page.locator('app-dialog').filter({ has: page.getByRole('dialog', { name: '新建维护窗口' }) });
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect(modal.getByText('名称不能为空')).toBeVisible();
  await modal.getByPlaceholder('例如：每周例行维护').fill('Weekly');
  await modal.getByRole('button', { name: '周一', exact: true }).click();
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(writes.at(-1)).toMatchObject({ url: '/api/maintenance-windows', body: { name: 'Weekly', day_of_week: '0,1' } });

  await page.getByRole('button', { name: '静默期', exact: true }).click();
  await page.getByRole('button', { name: '新建静默', exact: true }).click();
  modal = page.locator('app-dialog').filter({ has: page.getByRole('dialog', { name: '新建静默期' }) });
  await modal.locator('select').selectOption('7');
  await modal.getByPlaceholder('例如：cpu_usage').fill('cpu_usage');
  await modal.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(writes.at(-1)).toMatchObject({ url: '/api/silence', body: { instance_id: 7, metric_name: 'cpu_usage', duration_minutes: 30 } });
});
