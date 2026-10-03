import { expect, test } from '@playwright/test';

test('qualification Cron browser tracks a real persisted run through refresh', async ({ page }, testInfo) => {
  test.skip(process.env.QUALIFICATION_CRON_E2E !== '1', 'requires isolated managed API/MySQL');
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: process.env.QUALIFICATION_ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  const { token } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };
  let scriptId: number | undefined;
  let jobId: number | undefined;
  try {
    const script = await page.request.post('/api/cron/scripts', { headers,
      data: { name: 'W14 isolated read', content: 'SELECT 7 AS qualified_value', target_db_type: 'mysql' } });
    expect(script.status()).toBe(201); scriptId = (await script.json()).id;
    const job = await page.request.post('/api/cron/jobs', { headers, data: {
      name: 'W14 real Cron run', task_description: 'isolated qualification', task_type: 'script',
      script_id: scriptId, target_instance_id: null, cron_expr: '0 0 1 1 *', enabled: false,
    } });
    expect(job.status()).toBe(201); jobId = (await job.json()).id;
    await page.addInitScript(value => localStorage.setItem('token', value), token);
    // Only the host HTML is a fixture. Every API request hits the real service.
    await page.route('**/cron-live-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
      <cron-jobs-settings></cron-jobs-settings>
      <script type="module">import '/src/app/styles.css'; import '/src/app/ui/views/cron-jobs-settings.ts';</script>
      </body></html>` }));
    const posts: string[] = [];
    const polled: string[] = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path === `/api/cron/jobs/${jobId}/run`) posts.push(path);
      if (path.includes(`/api/cron/jobs/${jobId}/runs/`)) polled.push(path);
    });
    await page.goto('/cron-live-fixture');
    const row = page.locator('.table-row').filter({ hasText: 'W14 real Cron run' });
    await expect(row).toBeVisible();
    const acceptance = page.waitForResponse(response => response.url().endsWith(`/api/cron/jobs/${jobId}/run`) && response.request().method() === 'POST');
    await row.getByRole('button', { name: '执行', exact: true }).click();
    await page.getByRole('button', { name: '确认执行', exact: true }).click();
    const accepted = await acceptance;
    expect(accepted.status()).toBe(202);
    const { runId } = await accepted.json();
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(row).toContainText('成功', { timeout: 20_000 });
    const persisted = await page.request.get(`/api/cron/jobs/${jobId}/runs/${runId}`, { headers });
    expect(persisted.status()).toBe(200);
    const result = await persisted.json();
    expect(result).toMatchObject({ runId, jobId, status: 'success', completion: { status: 'success' } });
    expect(result.completedAt).toBeTruthy();
    expect(result.runnerFinishedAt).toBeTruthy();
    await page.reload();
    await expect(row).toContainText('成功');
    expect(posts).toHaveLength(1);
    expect(polled.length).toBeGreaterThan(0);
    expect(polled.every(path => path.endsWith(`/runs/${runId}`))).toBe(true);
    await testInfo.attach('persisted-run', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath('cron-live-run.png'), fullPage: true });
  } finally {
    if (jobId) expect((await page.request.delete(`/api/cron/jobs/${jobId}`, { headers })).status()).toBe(200);
    if (scriptId) expect((await page.request.delete(`/api/cron/scripts/${scriptId}`, { headers })).status()).toBe(200);
  }
});
