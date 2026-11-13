import { expect, test } from '@playwright/test';

// #289: production Shadow DOM component; controlled HTTP data, no backend/LLM calls.
for (const [width, height] of [[1440, 900], [1366, 768], [1920, 1080]]) {
  test(`MAX-645 whitelist remains operable at ${width}x${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.route('**/api/ai/config', route => route.fulfill({ json: {
      enabled: true, cronExpression: '* * * * *', severityLevels: ['warning'],
      instanceWhitelist: [], timeWindowStart: '00:00', timeWindowEnd: '23:59',
    } }));
    await page.route('**/api/database/instances', route => route.fulfill({ json: [
      { id: 1, name: '主库 MySQL' }, { id: 2, name: '备库 PostgreSQL' },
    ] }));
    await page.goto('/e2e/fixtures/ai-settings.html');
    const view = page.locator('ai-settings-page');
    const toggle = view.locator('.inst-dropdown-toggle');
    const menu = view.locator('.inst-dropdown-menu');
    const search = view.getByPlaceholder('搜索实例名称或 ID...');
    await toggle.click();
    await search.click();
    await expect(menu).toBeVisible();
    await search.pressSequentially('MySQL');
    await expect(view.locator('.inst-dropdown-item')).toHaveCount(1);
    const checkbox = view.getByRole('checkbox', { name: '主库 MySQL #1' });
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await expect(menu).toBeVisible();
    await expect(toggle).toContainText('已选 1 个实例');
    await checkbox.press('Space');
    await expect(checkbox).not.toBeChecked();
    await expect(menu).toBeVisible();
    await search.fill('2');
    await expect(view.locator('.inst-dropdown-item')).toHaveText(/备库 PostgreSQL/);
    await view.locator('.inst-dropdown-item').click();
    await expect(view.getByRole('checkbox', { name: '备库 PostgreSQL #2' })).toBeChecked();
    await expect(menu).toBeVisible();
    await page.screenshot({ path: info.outputPath('whitelist-open.png') });
    await page.locator('#outside').click();
    await expect(menu).toHaveCount(0);
    await toggle.click();
    await expect(menu).toBeVisible();
    await toggle.click();
    await expect(menu).toHaveCount(0);

    // A leaked handler would close the detached component on the external click.
    await toggle.click();
    await view.evaluate(el => { (window as any).detachedSettings = el; el.remove(); });
    await page.locator('#outside').click();
    expect(await page.evaluate(async () => {
      const el = (window as any).detachedSettings;
      await el.updateComplete;
      return !!el.shadowRoot.querySelector('.inst-dropdown-menu');
    })).toBe(true);
    await page.evaluate(() => document.body.append((window as any).detachedSettings));
    await expect(menu).toBeVisible();
    await page.locator('#outside').click();
    await expect(menu).toHaveCount(0);
  });
}
