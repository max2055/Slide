import { expect, test } from '@playwright/test';

for (const width of [1366, 1440, 1920]) {
  test(`GH #647: editable numeric policy at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1366 ? 768 : width === 1440 ? 900 : 1080 });
    await page.goto('/e2e/fixtures/metric-policy.html');
    await page.getByLabel('采集间隔（秒）覆盖方式', { exact: true }).selectOption('set');
    const interval = page.getByRole('spinbutton', { name: '采集间隔（秒）', exact: true });
    await expect(interval).toHaveValue('60');
    await interval.fill('');
    await expect(interval).toHaveValue('');
    expect(await page.evaluate(() => (window as any).policyEvents.length)).toBe(1);
    await interval.pressSequentially('12');
    await expect(interval).toHaveValue('12');
    expect(await page.evaluate(() => (window as any).policyEvents.at(-1).interval_ms.value)).toBe(12000);
    for (const value of ['0', '86401', '1e309']) {
      await interval.fill(value);
      expect(await page.evaluate(() => (window as any).policyEvents.at(-1).interval_ms.value)).toBe(12000);
    }
    for (const value of ['1', '86400']) {
      await interval.fill(value);
      expect(await page.evaluate(() => (window as any).policyEvents.at(-1).interval_ms.value)).toBe(Number(value) * 1000);
    }
    await page.getByText('高级参数', { exact: true }).click();
    await page.getByLabel('超时（秒）覆盖方式', { exact: true }).selectOption('set');
    const timeout = page.getByRole('spinbutton', { name: '超时（秒）', exact: true });
    await timeout.fill('0.25');
    expect(await page.evaluate(() => (window as any).policyEvents.at(-1).timeout_ms.value)).toBe(250);
    await page.getByLabel('行数上限覆盖方式', { exact: true }).selectOption('set');
    await page.getByRole('spinbutton', { name: '行数上限', exact: true }).fill('42');
    expect(await page.evaluate(() => (window as any).policyEvents.at(-1).max_rows.value)).toBe(42);
    await page.screenshot({ path: test.info().outputPath('policy.png') });
  });
}
