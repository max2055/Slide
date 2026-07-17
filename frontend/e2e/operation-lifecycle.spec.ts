import { expect, test } from '@playwright/test';

const baseUrl = process.env.OPERATION_E2E_BASE_URL || 'http://127.0.0.1:5175';

test('operation lifecycle survives a browser login and API refresh', async ({ page }) => {
  await page.goto(`${baseUrl}/dashboard`);
  const connect = page.locator('.login-gate__connect, button:has-text("Connect"), button:has-text("连接")').first();
  if (await connect.count()) {
    await page.locator('input[type="text"], input[name="username"]').first().fill('admin');
    await page.locator('input[type="password"]').first().fill('Tpam1234');
    await connect.click();
  }
  await expect(page.locator('slide-app')).toBeVisible();
  const token = await page.evaluate(() => localStorage.getItem('token'));
  expect(token).toBeTruthy();

  const response = await page.request.post(`${baseUrl}/api/database/instances/1/execute`, {
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'phase133-browser-lifecycle' },
    data: { sql: 'SELECT 1' },
  });
  expect(response.status()).toBe(400);
  const operationId = (await response.json()).operationId;
  expect(operationId).toBeTruthy();
  const operation = await page.request.get(`${baseUrl}/api/operations/${operationId}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(operation.ok()).toBeTruthy();
  const events = await page.request.get(`${baseUrl}/api/operations/${operationId}/events`, { headers: { Authorization: `Bearer ${token}` } });
  expect((await events.json()).events.map((event: any) => event.toState)).toEqual(['queued', 'claimed', 'running', 'failed']);
});
