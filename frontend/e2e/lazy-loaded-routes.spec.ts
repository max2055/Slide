import { expect, test, type Page } from '@playwright/test';

const routes = [
  { path: '/dashboard', element: 'dashboard-page', chunk: /(?:dashboard-|views\/dashboard\.ts)/ },
  { path: '/instance-detail?id=1', element: 'instance-detail-page', chunk: /(?:instance-detail-|views\/instance-detail\.ts)/ },
  { path: '/cron-jobs', element: 'cron-jobs-settings', chunk: /(?:cron-jobs-settings-|views\/cron-jobs-settings\.ts)/ },
  { path: '/sql-console', element: 'sql-console-page', chunk: /(?:sql-console-|views\/sql-console\.ts)/ },
  { path: '/approval', element: 'approval-dashboard', chunk: /(?:approval-dashboard-|views\/approval-dashboard\.ts)/ },
] as const;

async function authenticate(page: Page, locale = 'en') {
  const response = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: 'Tpam1234' },
  });
  expect(response.ok()).toBe(true);
  const auth = await response.json() as { token: string; refreshToken: string };
  await page.addInitScript(({ token, refreshToken, locale }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('refreshToken', refreshToken);
    localStorage.setItem('slide.control.session_token.v1', token);
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale }));
  }, { ...auth, locale });
  return auth;
}

test('lazy-loaded operational routes render their split chunks without runtime errors', async ({ page }) => {
  await authenticate(page);
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
  });

  for (const route of routes) {
    const chunkResponse = page.waitForResponse((response) => route.chunk.test(response.url()) && response.status() === 200);
    await page.goto(route.path);
    await expect(page.locator(route.element)).toBeVisible({ timeout: 10_000 });
    await chunkResponse;
  }

  expect(pageErrors).toEqual([]);
  expect(serverErrors).toEqual([]);
});

test('persisted locale switches live navigation copy', async ({ page }) => {
  const auth = await authenticate(page, 'en');
  const headers = { Authorization: `Bearer ${auth.token}` };
  const currentResponse = await page.request.get('/api/user/preferences', { headers });
  expect(currentResponse.ok()).toBe(true);
  const current = await currentResponse.json() as { preferences: Record<string, unknown> };
  try {
    const switched = await page.request.put('/api/user/preferences', {
      headers,
      data: { preferences: { ...current.preferences, locale: 'zh-CN' } },
    });
    expect(switched.ok()).toBe(true);
    await page.goto('/dashboard');
    await expect(page.getByText('运维总览', { exact: true }).first()).toBeVisible();
  } finally {
    await page.request.put('/api/user/preferences', {
      headers,
      data: { preferences: current.preferences },
    });
  }
});
