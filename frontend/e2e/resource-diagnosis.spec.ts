import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`resource evidence deep links and missing evidence at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/agent-ws', socket => {
      socket.onMessage(message => { if (JSON.parse(String(message)).type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' })); });
    });
    await page.addInitScript(() => {
      localStorage.setItem('token', 'fixture-token');
      localStorage.setItem('refreshToken', 'fixture-refresh');
      localStorage.setItem('permissions', JSON.stringify(['*']));
      localStorage.setItem('slide.control.session_token.v1', 'fixture-token');
      localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
    });
    const resource = { type: 'instance', id: 1 };
    const related = { type: 'network_device', id: 3 };
    const item = { schemaVersion: 1, id: 'ev-cpu-1', kind: 'fact', status: 'observed', subject: { resource }, quality: 'good', observedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 300_000).toISOString(), source: 'metrics', correlationId: 'corr-1', provenance: { adapter: 'collector' }, payload: { metricId: 'cpu', value: 0 } };
    let diagnosed = false;
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/api/')) return route.fallback();
      let body: unknown = {};
      if (path === '/api/auth/permissions') body = ['*'];
      if (path === '/api/user/preferences') body = { preferences: { locale: 'zh-CN' } };
      if (path === '/api/version') body = { version: 'test' };
      if (path === '/api/resources') body = { items: [
        { resource, label: 'Orders database', status: 'online', attributes: {} },
        { resource: { type: 'server', id: 2 }, label: 'Host', status: 'online', attributes: {} },
        { resource: related, label: 'Edge switch', status: 'unknown', attributes: {} },
      ] };
      if (path.endsWith('/evidence')) body = { schemaVersion: 1, resource: path.includes('network_device') ? related : resource, generatedAt: item.observedAt, facts: path.includes('network_device') ? [] : [item], inferences: [], hypotheses: [], gaps: path.includes('network_device') ? ['OBSERVATIONS_EMPTY'] : [], truncated: false };
      if (path.endsWith('/diagnose')) {
        expect(route.request().method()).toBe('POST');
        body = { relations: [{ source: resource, target: related, relationType: 'depends_on', provenance: 'operator' }], relatedEvidence: [{ resource: { resource: related, label: 'Edge switch', status: 'unknown', attributes: {} } }], gaps: [], truncated: false };
      }
      if (path.endsWith('/diagnose-agent')) { diagnosed = true; body = { success: true, analysisId: 42, status: 'queued' }; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('/resource-diagnosis?resourceType=instance&resourceId=1');
    const view = page.locator('resource-diagnosis-page');
    await expect(view.getByRole('heading', { name: '跨资源诊断' })).toBeVisible();
    await expect(view.getByRole('combobox', { name: '资源', exact: true })).toHaveValue('instance:1');
    await view.locator('[data-evidence-id="ev-cpu-1"] summary').click();
    await expect(view.locator('[data-evidence-id="ev-cpu-1"]')).toContainText('corr-1');
    await expect(view.locator('[data-evidence-id="ev-cpu-1"]')).toContainText('新鲜');
    await view.getByRole('button', { name: 'Agent 诊断', exact: true }).click();
    await expect.poll(() => diagnosed).toBe(true);
    await view.getByRole('button', { name: '获取关联证据' }).click();
    await view.getByRole('link', { name: '网络设备 · Edge switch' }).click();
    await expect(page).toHaveURL(/resourceType=network_device.*returnResource=instance%3A1/);
    await expect(view).toContainText('OBSERVATIONS_EMPTY');
    await expect(view.getByRole('combobox', { name: '资源', exact: true })).toHaveValue('network_device:3');
    await expect(view.locator('[data-kind="facts"] app-empty-state')).toBeVisible();
    await expect(view.locator('[data-evidence-id]')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`resource-diagnosis-${viewport.width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await view.getByRole('button', { name: '返回 instance:1' }).click();
    await expect(view.locator('[data-evidence-id="ev-cpu-1"]')).toBeVisible();
    await view.getByRole('combobox', { name: '资源', exact: true }).selectOption('server:2');
    await expect(page).toHaveURL(/resourceType=server&resourceId=2/);
    expect(errors).toEqual([]);
  });
}
