import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

// Read-only visual acceptance against existing inventory; never create devices or analyses.
test.skip(!process.env.SLIDE_REAL_PASSWORD, 'Real environment credentials are required');
test('compact overview uses actual inventory in four views and both themes', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const login = await request.post(`${process.env.SLIDE_REAL_API_BASE_URL ?? 'http://127.0.0.1:3000'}/api/auth/login`, { data: { username: process.env.SLIDE_REAL_USERNAME ?? 'admin', password: process.env.SLIDE_REAL_PASSWORD } });
  expect(login.ok()).toBe(true);
  const session = await login.json(); const token = session.token ?? session.accessToken ?? session.access_token;
  const permissionResponse = await request.get(`${process.env.SLIDE_REAL_API_BASE_URL ?? 'http://127.0.0.1:3000'}/api/auth/permissions`, { headers: { Authorization: `Bearer ${token}` } });
  expect(permissionResponse.ok()).toBe(true);
  const permissionBody = await permissionResponse.json();
  const permissions = Array.isArray(permissionBody) ? permissionBody : permissionBody.permissions;
  expect(Array.isArray(permissions)).toBe(true);
  await page.addInitScript(({ token, permissions }) => {
    localStorage.setItem('permissions', JSON.stringify(permissions));
    localStorage.setItem('token', token); localStorage.setItem('slide.control.session_token.v1', token);
    localStorage.setItem('slide.i18n.locale', 'zh-CN');
  }, { token, permissions });
  let posts = 0;
  page.on('request', request => { if (request.url().includes('/diagnose-agent') && request.method() === 'POST') posts++; });
  const snapshotPromise = page.waitForResponse(response => response.url().includes('/api/resources/overview'));
  await page.goto('/dashboard');
  const snapshot = await snapshotPromise; expect(snapshot.ok()).toBe(true);
  const body = await snapshot.json();
  const ids = body.items.filter((item: any) => item.resource.type === 'instance').map((item: any) => item.resource.id);
  const headers = { Authorization: `Bearer ${token}` };
  const api = process.env.SLIDE_REAL_API_BASE_URL ?? 'http://127.0.0.1:3000';
  const totalResponse = await request.get(`${api}/api/dashboard/capacity-trend?instance_ids=${ids.join(',')}&hours=168`, { headers });
  expect(totalResponse.ok()).toBe(true); const total = await totalResponse.json();
  const sums = new Map<string, number>();
  for (const id of ids) {
    const singleResponse = await request.get(`${api}/api/dashboard/capacity-trend?instance_id=${id}&hours=168`, { headers });
    expect(singleResponse.ok()).toBe(true);
    for (const point of (await singleResponse.json()).trend) if (point.total_size_gb !== null) sums.set(point.time, (sums.get(point.time) ?? 0) + point.total_size_gb);
  }
  for (const point of total.trend) if (point.total_size_gb !== null) expect(point.total_size_gb).toBeCloseTo(sums.get(point.time)!, 6);
  const invalid = await request.get(`${api}/api/dashboard/capacity-trend?instance_ids=`, { headers }); expect(invalid.status()).toBe(400);
  const conflicting = await request.get(`${api}/api/dashboard/capacity-trend?instance_id=1&instance_ids=1`, { headers }); expect(conflicting.status()).toBe(400);
  const view = page.locator('dashboard-page');
  await expect(view.locator('stat-card')).toHaveCount(4);
  await page.evaluate(async () => { const { i18n } = await import('/src/app/i18n/index.ts'); await i18n.setLocale('zh-CN'); });
  const styles = await view.evaluate(element => ({ accent: getComputedStyle(element).getPropertyValue('--accent').trim(), theme: document.documentElement.getAttribute('data-theme'), mode: document.documentElement.getAttribute('data-theme-mode') }));
  for (const mode of ['light', 'dark']) {
    await page.evaluate(mode => document.documentElement.setAttribute('data-theme-mode', mode), mode);
    for (const [name, scope] of [['综合态势', 'all'], ['数据库', 'instance'], ['服务器', 'server'], ['网络设备', 'network_device']]) {
      await view.getByRole('tab', { name, exact: true }).click();
      await expect(view.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
      const count = body.items.filter((item: any) => scope === 'all' || item.resource.type === scope).length;
      if (count) await expect(view.locator('stat-card')).toHaveCount(4);
      else await expect(view.locator('app-empty-state')).toHaveAttribute('title', `尚未纳管 ${name}`);
      if (scope === 'instance' && total.trend.length) {
        await expect(view.locator('.trend-chart-container svg')).toBeVisible();
        await expect(view.getByRole('combobox', { name: '统计范围', exact: true })).toHaveValue('');
        await view.locator('.database-panels').screenshot({ path: testInfo.outputPath(`real-charts-${mode}.png`), animations: 'disabled' });
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await view.evaluate((element: any) => { element.scrollingParent().scrollTop = 0; });
      await page.screenshot({ path: testInfo.outputPath(`real-${scope}-${mode}.png`), fullPage: true, animations: 'disabled' });
    }
  }
  expect(posts).toBe(0);
  const evidencePath = testInfo.outputPath('actual-inventory.json');
  await writeFile(evidencePath, JSON.stringify({ snapshotStatus: snapshot.status(), collectedAt: body.collectedAt, counts: Object.fromEntries(['instance', 'server', 'network_device'].map(type => [type, body.items.filter((item: any) => item.resource.type === type).length])), styles, capacity: { scope: ids, points: total.trend.length, last: total.trend.at(-1), matchesSumOfSingleInstances: true, invalidScopeStatus: invalid.status(), conflictingScopeStatus: conflicting.status() }, automaticAnalysisPosts: posts }, null, 2));
  await testInfo.attach('actual-inventory', { path: evidencePath, contentType: 'application/json' });
});
