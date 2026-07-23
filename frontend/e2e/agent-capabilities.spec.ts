import { expect, test } from '@playwright/test';

const baseUrl = process.env.AGENT_CAPABILITIES_E2E_BASE_URL || 'http://127.0.0.1:5175';

test('DirectAdapter capabilities hide management controls without handlers', async ({ page }) => {
  await page.goto(`${baseUrl}/agents`);
  const connect = page.locator('.login-gate__connect, button:has-text("Connect"), button:has-text("连接")').first();
  if (await connect.count()) {
    await page.locator('input[type="text"], input[name="username"]').first().fill('admin');
    await page.locator('input[type="password"]').first().fill('Tpam1234');
    await connect.click();
  }
  await expect.poll(() => page.evaluate(() => localStorage.getItem('token'))).not.toBeNull();
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const response = await page.request.get(`${baseUrl}/api/agents`, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.ok()).toBeTruthy();
  const agents = await response.json();
  expect(agents.capabilities.files.state).toBe('unsupported');
  expect(agents.capabilities.modelSelection.state).toBe('unsupported');

  await expect(page.locator('.agent-tab')).toHaveCount(1);
  await expect(page.locator('.agent-tab')).toHaveText('Overview');
  await expect(page.getByText('Model Selection', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Files', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Tools', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Skills', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cron Jobs', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Set Default', exact: true })).toHaveCount(0);
});
