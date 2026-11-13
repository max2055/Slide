import { expect, test, type Page } from '@playwright/test';

const item = {
  id: 3, title: '连接页报错', description: '说明', source: 'manual', status: 'pending',
  createdBy: 7, createdByUsername: 'test', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
};

async function openPage(page: Page, descriptions = [item.description]) {
  await page.route('**/api/feedback', route => route.fulfill({ json: {
    feedback: descriptions.map((description, index) => ({ ...item, id: index + 3, description })),
  } }));
  await page.route('**/feedback-regression', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
    <link rel="stylesheet" href="/src/app/styles.css"></head><body>
    <feedback-page></feedback-page><app-toast-container></app-toast-container>
    <script type="module" src="/src/app/ui/views/feedback-page.ts"></script></body></html>` }));
  await page.goto('/feedback-regression');
  await expect(page.locator('select.status-select')).toHaveCount(descriptions.length);
}

for (const failure of ['rejected', 'network']) {
  test(`MAX-430: ${failure} restores confirmed status, retry uses returned status`, async ({ page }) => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let writes = 0;
    await page.route('**/api/feedback/3', async route => {
      writes++;
      if (writes === 1) {
        await gate;
        if (failure === 'network') return route.abort('failed');
        return route.fulfill({ status: 403, json: { error: 'FORBIDDEN' } });
      }
      // Server normalization deliberately differs from the requested value.
      return route.fulfill({ json: { feedback: { ...item, status: 'accepted' } } });
    });
    await openPage(page);
    const select = page.getByRole('combobox', { name: '更新 连接页报错 的状态' });
    try {
      await select.selectOption('resolved');
      await expect(select).toBeDisabled();
      await select.evaluate(el => el.dispatchEvent(new Event('change')));
      expect(writes).toBe(1);
    } finally { finish(); }
    await expect(page.getByText('更新问题状态失败', { exact: true })).toBeVisible();
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue('pending');
    await select.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(select).toBeFocused();
    await select.selectOption('resolved');
    await expect(select).toHaveValue('accepted');
    await expect(select).toBeEnabled();
    expect(writes).toBe(2);
  });
}

for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
  test(`MAX-451: measured clipping and keyboard expansion at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await openPage(page, [`${'中'.repeat(20)}\n${'中'.repeat(20)}\n末`, 'i'.repeat(60), '短说明', '第一行\n第二行\n第三行', '中'.repeat(80)]);
    const rows = page.locator('tbody tr');
    // Cover short multiline content and wrapping in a narrow desktop column.
    await page.addStyleTag({ content: 'feedback-page { width: 1100px; display: block; }' });
    const text = rows.nth(0).locator('.feedback-description__text');
    expect(await text.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const toggle = rows.nth(0).locator('.description-toggle');
    await expect(toggle).toHaveAccessibleName('展开 连接页报错 的问题描述');
    await expect(toggle).toBeVisible();
    await expect(rows.nth(1).locator('.description-toggle')).toHaveCount(0);
    await expect(rows.nth(2).locator('.description-toggle')).toHaveCount(0);
    await expect(rows.nth(3).locator('.description-toggle')).toBeVisible();
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await text.evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await page.screenshot({ path: info.outputPath(`feedback-${width}.png`), fullPage: true });
    // Re-evaluate after layout changes without reloading data.
    await page.addStyleTag({ content: 'feedback-page { width: 1800px; }' });
    await expect(rows.nth(4).locator('.description-toggle')).toHaveCount(0);
    await page.addStyleTag({ content: 'feedback-page { width: 1100px; }' });
    await expect(rows.nth(4).locator('.description-toggle')).toBeVisible();
  });
}
