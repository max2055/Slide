import { expect, test } from '@playwright/test';

// Opt-in only: uses actual inventory, evidence, persisted results and configured Agent.
// Never seed hardware or replace model responses to satisfy this acceptance gate.
test.skip(!process.env.SLIDE_REAL_PASSWORD, 'Real environment credentials are required');
for (const resourceType of ['instance', 'server', 'network_device']) {
  test(`real overview → ${resourceType} → evidence → explicit diagnosis → result → return`, async ({ page, request }, testInfo) => {
    test.setTimeout(150_000);
    const base = process.env.SLIDE_REAL_API_BASE_URL ?? 'http://127.0.0.1:3006';
    const login = await request.post(`${base}/api/auth/login`, { data: { username: process.env.SLIDE_REAL_USERNAME ?? 'admin', password: process.env.SLIDE_REAL_PASSWORD } });
    expect(login.ok()).toBe(true);
    const session = await login.json(); const token = session.token ?? session.accessToken ?? session.access_token;
    const resourcesResponse = await request.get(`${base}/api/resources`, { headers: { Authorization: `Bearer ${token}` } });
    expect(resourcesResponse.ok()).toBe(true);
    const inventory = await resourcesResponse.json(); console.info(resourceType, 'inventory read');
    const resource = inventory.items.find((item: any) => item.resource.type === resourceType);
    test.skip(!resource, `No actual managed ${resourceType}; external acceptance dependency`);
    await page.addInitScript(({ token }) => {
      localStorage.setItem('token', token); localStorage.setItem('slide.control.session_token.v1', token);
      localStorage.setItem('permissions', '["*"]'); localStorage.setItem('slide.i18n.locale', 'zh-CN');
    }, { token });
    await page.goto(`/dashboard?scope=${resourceType}`); console.info(resourceType, 'overview loaded');
    await page.evaluate(async () => { const { i18n } = await import('/src/app/i18n/index.ts'); await i18n.setLocale('zh-CN'); });
    const overview = page.locator('dashboard-page'); await expect(overview.locator('stat-card')).toHaveCount(4);
    const row = overview.locator(`[data-resource="${resourceType}:${resource.resource.id}"]`);
    const target = await row.count() ? row.getByRole('link', { name: '查看资源', exact: true }) : overview.locator('app-data-table').getByRole('link', { name: '查看资源', exact: true }).first();
    console.info(resourceType, 'opening detail'); await target.click();
    await expect(page).toHaveURL(new RegExp(`(?:id|networkDeviceId)=${resource.resource.id}`));
    // The existing detail back control must return to the original overview.
    const detail = page.locator(resourceType === 'instance' ? 'instance-detail-page' : resourceType === 'server' ? 'server-detail' : 'network-device-detail');
    await expect(detail).toBeAttached(); console.info(resourceType, 'detail loaded');
    await detail.getByRole('button', { name: /返回列表|返回原运维总览|Back|Network devices/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`dashboard\\?scope=${resourceType}`));
    await page.evaluate(async () => { const { i18n } = await import('/src/app/i18n/index.ts'); await i18n.setLocale('zh-CN'); });
    await overview.locator(`[data-resource="${resourceType}:${resource.resource.id}"]`).getByRole('link', { name: '查看证据', exact: true }).click();
    console.info(resourceType, 'evidence opened'); const diagnosis = page.locator('resource-diagnosis-page');
    await expect(diagnosis.getByRole('combobox', { name: '资源', exact: true })).toHaveValue(`${resourceType}:${resource.resource.id}`);
    await expect(diagnosis.locator('[data-kind="facts"]')).toBeVisible();
    console.info(resourceType, 'submitting read-only diagnosis'); await diagnosis.getByRole('button', { name: '开始只读诊断', exact: true }).click();
    await expect(diagnosis.locator('[data-analysis-id]')).toBeVisible();
    await expect(diagnosis.locator('[data-analysis-id]')).toContainText('历史诊断上下文', { timeout: 125_000 });
    const analysisId = await diagnosis.locator('[data-analysis-id]').getAttribute('data-analysis-id');
    await page.screenshot({ path: testInfo.outputPath(`real-${resourceType}-analysis-${analysisId}.png`), fullPage: true });
    await testInfo.attach('real-analysis', { body: JSON.stringify({ resource: resource.resource, analysisId, resultPath: `/api/resources/${resourceType}/${resource.resource.id}/analyses/${analysisId}` }), contentType: 'application/json' });
    await diagnosis.getByRole('link', { name: '返回原运维总览' }).click();
    await expect(page).toHaveURL(new RegExp(`dashboard\\?scope=${resourceType}`));
  });
}
