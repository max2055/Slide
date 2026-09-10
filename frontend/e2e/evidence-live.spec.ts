import { test, expect } from '@playwright/test';

test.skip(process.env.EVIDENCE_LIVE_QUALIFICATION !== '1', 'Requires the isolated evidence qualification database and API');
for (const width of [1440, 390]) {
  test(`real evidence API and persisted decisions at ${width}px`, async ({ page }, info) => {
    const username = process.env.EVIDENCE_QA_USER;
    const password = process.env.EVIDENCE_QA_PASSWORD;
    if (!username || !password) throw new Error('Qualification credentials required');
    await page.setViewportSize({ width, height: 900 });
    const response = await page.request.post('/api/auth/login', { data: { username, password } });
    expect(response.status()).toBe(200);
    const session = await response.json();
    await page.addInitScript(({ token, refreshToken }) => {
      localStorage.setItem('token', token); localStorage.setItem('refreshToken', refreshToken);
      localStorage.setItem('slide.control.session_token.v1', token);
      localStorage.setItem('permissions', JSON.stringify(['*']));
      localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
    }, session);
    const resources = await page.request.get('/api/resources', { headers: { Authorization: `Bearer ${session.token}` } });
    expect(resources.status()).toBe(200);
    const items = (await resources.json()).items;
    for (const type of ['instance', 'server', 'network_device']) {
      const item = items.find((item: any) => item.resource.type === type && item.label.includes('evidence-qualification'));
      expect(item).toBeTruthy();
      await page.goto(`/resource-diagnosis?resourceType=${type}&resourceId=${item.resource.id}`);
      const view = page.locator('resource-diagnosis-page');
      await expect(view.getByRole('combobox', { name: '资源', exact: true })).toHaveValue(`${type}:${item.resource.id}`);
      await expect(view.locator('[data-evidence-id]').first()).toBeVisible();
      await expect(view.locator('resource-invariants')).toContainText('cpu-range');
      await expect(view.locator('resource-decisions')).toContainText('Qualification hypothesis, not a runtime fact');
      const recovery = view.locator('resource-recovery');
      await expect(recovery.getByRole('checkbox', { name: '启用恢复策略' })).not.toBeChecked();
      if (type === 'server' && process.env.EVIDENCE_QA_OPERATION_ID) {
        await recovery.getByRole('textbox', { name: '操作 ID', exact: true }).fill(process.env.EVIDENCE_QA_OPERATION_ID);
        await recovery.getByRole('button', { name: '查询恢复状态' }).click();
        await expect(recovery.locator('[data-recovery-result]')).toContainText('RECOVERY_WINDOW_SATISFIED');
        await recovery.locator('[data-recovery-result]').scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath(`recovery-live-${width}.png`), fullPage: true });
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.screenshot({ path: info.outputPath(`evidence-live-${width}.png`), fullPage: true });
    await page.goto('/settings/platform/source');
    await expect(page.locator('source-settings')).toBeVisible();
    await expect(page.locator('source-settings').getByRole('checkbox', { name: '允许模型读取源码内容' })).not.toBeChecked();
  });
}
