import { expect, test } from '@playwright/test';

test('qualification login authenticates through REST and enters the application', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('.login-gate')).toBeVisible();
  await page.locator('.login-gate input[autocomplete="username"]').fill('admin');
  await page.locator('.login-gate input[autocomplete="current-password"]').fill('Tpam1234');

  const response = page.waitForResponse((candidate) =>
    candidate.url().endsWith('/api/auth/login') && candidate.request().method() === 'POST',
  );
  await page.locator('.login-gate__connect').click();
  expect((await response).status()).toBe(200);
  await expect(page.locator('.login-gate')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('.nav-item').first()).toBeVisible({ timeout: 15_000 });
});

test('removed legacy routes resolve to the current chat workspace', async ({ page }) => {
  for (const legacyPath of ['/system', '/appearance']) {
    await page.goto(legacyPath);
    await page.locator('.login-gate input[autocomplete="username"]').fill('admin');
    await page.locator('.login-gate input[autocomplete="current-password"]').fill('Tpam1234');
    await page.locator('.login-gate__connect').click();
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.locator('.content--chat')).toBeVisible();
    await page.evaluate(() => localStorage.clear());
  }
});

test('resource readiness keeps an offline managed server visible and non-healthy', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: 'Tpam1234' },
  });
  expect(login.status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await login.json()).token}` };
  const created = await page.request.post('/api/servers', {
    headers,
    data: {
      host: `qualification-offline-${Date.now()}.invalid`,
      port: 22,
      label: 'Qualification offline readiness target',
      os_type: 'linux',
      credential_type: 'password',
      credential_username: 'qualification',
      credential_value: 'qualification-password',
    },
  });
  expect(created.status()).toBe(200);
  const { id } = await created.json();
  try {
    const readiness = await page.request.get('/api/health/readiness', { headers });
    expect(readiness.status()).toBe(200);
    const truth = await readiness.json();
    expect(truth.managedAvailability.status).not.toBe('healthy');
    expect(truth.managedAvailability.failedRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'server', id }),
    ]));
    expect(truth.overall).not.toBe('healthy');
  } finally {
    await page.request.delete(`/api/servers/${id}`, { headers });
  }
});

test('server alert RCA can be started from the browser without an instance id', async ({ page }) => {
  await page.goto('/alerts');
  await page.locator('.login-gate input[autocomplete="username"]').fill('admin');
  await page.locator('.login-gate input[autocomplete="current-password"]').fill('Tpam1234');
  await page.locator('.login-gate__connect').click();

  const row = page.locator('alert-list tr').filter({ hasText: 'Qualification server RCA browser alert' });
  await expect(row).toBeVisible({ timeout: 15_000 });
  const response = page.waitForResponse((candidate) =>
    candidate.url().endsWith('/api/ai/analysis') && candidate.request().method() === 'POST',
  );
  await row.getByRole('button', { name: 'AI' }).click();
  expect((await response).status()).toBe(200);
  await expect(row.getByText('已分析')).toBeVisible({ timeout: 15_000 });
});

test('notification recovery is reachable through the protected alerts workspace', async ({ page }) => {
  await page.goto('/dashboard');
  await page.locator('.login-gate input[autocomplete="username"]').fill('admin');
  await page.locator('.login-gate input[autocomplete="current-password"]').fill('Tpam1234');
  await page.locator('.login-gate__connect').click();
  await expect(page.locator('.login-gate')).toBeHidden({ timeout: 15_000 });

  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: 'Tpam1234' },
  });
  const headers = { Authorization: `Bearer ${(await login.json()).token}` };
  const deadLetters = await page.request.get('/api/notification/dead-letters', { headers });
  const deadLetterBody = await deadLetters.json();
  expect(deadLetters.status(), deadLetterBody.error).toBe(200);
  expect(deadLetterBody).toEqual(expect.arrayContaining([
    expect.objectContaining({ lastError: 'qualification delivery failure' }),
  ]));

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('slide-navigate', { detail: { tab: 'alerts' } })));
  const notificationTab = page.getByRole('button', { name: '通知恢复' });
  await expect(notificationTab).toBeVisible({ timeout: 15_000 });
  await notificationTab.click();
  await expect(page.getByText('通知死信队列')).toBeVisible();
  await expect(page.getByText('qualification delivery failure')).toBeVisible();
  await page.getByRole('button', { name: '重放' }).click();
  const reason = page.locator('#notification-replay-reason');
  await expect(reason).toBeVisible();
  await reason.fill('Qualification operator confirmed the destination is ready.');
  await page.getByRole('button', { name: '确认重放' }).click();
  await expect(page.getByText('qualification delivery failure')).toBeHidden();
});

test('Feishu settings saves a disabled channel without exposing its credentials', async ({ page }) => {
  await page.goto('/settings');
  await page.locator('.login-gate input[autocomplete="username"]').fill('admin');
  await page.locator('.login-gate input[autocomplete="current-password"]').fill('Tpam1234');
  await page.locator('.login-gate__connect').click();
  await expect(page.locator('settings-shell')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: '飞书通知' }).click();
  const settings = page.locator('feishu-notification-settings');
  await expect(settings.getByText('尚未配置通道')).toBeVisible();
  const webhookMarker = `qualification-webhook-path-${Date.now()}`;
  const webhook = `https://open.feishu.cn/open-apis/bot/v2/hook/${webhookMarker}`;
  await settings.locator('input[type="url"]').fill(webhook);
  await settings.locator('input[type="password"]').fill('qualification-signing-secret');
  const saved = page.waitForResponse((response) =>
    response.url().endsWith('/api/notification/channels') && response.request().method() === 'POST',
  );
  await settings.getByRole('button', { name: '保存配置' }).click();
  const savedResponse = await saved;
  expect(savedResponse.status()).toBe(200);
  const channelId = Number((await savedResponse.json()).id);
  expect(channelId).toBeGreaterThan(0);

  const token = await page.evaluate(() => localStorage.getItem('token'));
  const headers = { Authorization: `Bearer ${token}` };
  try {
    await expect(settings.getByText('签名密钥：已安全保存')).toBeVisible();
    const channels = await page.request.get('/api/notification/channels', { headers });
    expect(channels.status()).toBe(200);
    const savedChannel = (await channels.json()).find((channel: { id: number }) => channel.id === channelId);
    expect(savedChannel).toMatchObject({ id: channelId, enabled: false, config: { endpoint: 'https://open.feishu.cn', hasCredential: true } });
    expect(JSON.stringify(savedChannel)).not.toContain('qualification-signing-secret');
    expect(JSON.stringify(savedChannel)).not.toContain(webhookMarker);
  } finally {
    await page.request.delete(`/api/notification/channels/${channelId}`, { headers });
  }
});

test('an incident cannot close until recovery has been verified', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: 'Tpam1234' },
  });
  expect(login.status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await login.json()).token}` };
  const eventIdValue = `qualification-event-${Date.now()}`;
  const created = await page.request.post('/api/alerts/events', {
    headers,
    data: {
      event_id: eventIdValue,
      title: 'Qualification recovery gate',
      description: 'Temporary qualification event',
      instance_id: null,
      severity: 'warning',
      source_type: 'qualification',
    },
  });
  expect(created.status()).toBe(201);
  const { eventId } = await created.json();
  try {
    const resolved = await page.request.post(`/api/alerts/events/${eventId}/resolve`, {
      headers,
      data: { resolution_notes: 'The alert condition is resolved.' },
    });
    expect(resolved.status()).toBe(200);
    const resolvedBody = await resolved.json();
    expect(resolvedBody.success, resolvedBody.error).toBe(true);
    const prematureClose = await page.request.post(`/api/alerts/events/${eventId}/close`, { headers });
    expect(prematureClose.status()).toBe(409);
    expect(await prematureClose.json()).toMatchObject({ success: false });

    const verified = await page.request.post(`/api/alerts/events/${eventId}/verify-recovery`, {
      headers,
      data: { reason: 'Qualification probe confirms normal metrics.' },
    });
    expect(verified.status()).toBe(200);
    const closed = await page.request.post(`/api/alerts/events/${eventId}/close`, { headers });
    expect(closed.status()).toBe(200);
    expect(await closed.json()).toMatchObject({ success: true });
    const detail = await page.request.get(`/api/alerts/events/${eventId}`, { headers });
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toMatchObject({ status: 'closed', verification_reason: 'Qualification probe confirms normal metrics.' });
  } finally {
    await page.request.delete(`/api/alerts/events/${eventId}`, { headers });
  }
});

test('a scheduled server report is persisted and downloadable', async ({ page }) => {
  test.setTimeout(90_000);
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: 'Tpam1234' },
  });
  expect(login.status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await login.json()).token}` };
  const suffix = Date.now();
  const createdServer = await page.request.post('/api/servers', {
    headers,
    data: {
      host: `qualification-report-${suffix}.invalid`,
      port: 22,
      label: 'Qualification report target',
      os_type: 'linux',
      credential_type: 'password',
      credential_username: 'qualification',
      credential_value: 'qualification-password',
    },
  });
  expect(createdServer.status()).toBe(200);
  const { id: serverId } = await createdServer.json();
  let configId: number | undefined;
  let reportId: number | undefined;
  let channelId: number | undefined;
  try {
    const channel = await page.request.post('/api/notification/channels', {
      headers,
      data: {
        name: `Qualification report delivery ${suffix}`,
        type: 'webhook',
        enabled: true,
        config: { webhook_url: 'https://hooks.example.com/qualification-secret-path', secret: 'qualification-secret' },
      },
    });
    expect(channel.status()).toBe(200);
    channelId = Number((await channel.json()).id);
    expect(channelId).toBeGreaterThan(0);
    const config = await page.request.post('/api/reports/configs', {
      headers,
      data: {
        name: `Qualification scheduled report ${suffix}`,
        cron: '* * * * * *',
        type: 'server_health',
        server_id: serverId,
        format: 'html',
        notification_channel_ids: [channelId],
        enabled: true,
      },
    });
    expect(config.status()).toBe(200);
    configId = Number((await config.json()).id);
    expect(configId).toBeGreaterThan(0);

    let matchedReport: { id: number; server_id: number; status: string } | undefined;
    await expect.poll(async () => {
      const response = await page.request.get('/api/reports?target_type=server&limit=100', { headers });
      const reports = await response.json();
      matchedReport = reports.find((item: { id: number; server_id: number; status: string }) => item.server_id === serverId && item.status === 'completed');
      return Boolean(matchedReport);
    }, { timeout: 75_000, intervals: [1_000, 2_000, 5_000] }).toBe(true);
    reportId = Number(matchedReport?.id);
    expect(reportId).toBeGreaterThan(0);
    const download = await page.request.get(`/api/reports/${reportId}/download`, { headers });
    expect(download.status()).toBe(200);
    expect(download.headers()['content-type']).toContain('text/html');
    expect(await download.text()).toContain('服务器健康巡检报告');
    await expect.poll(async () => {
      const response = await page.request.get(`/api/reports/${reportId}/notifications`, { headers });
      const deliveries = await response.json();
      return deliveries.find((delivery: { channelId: number; status: string }) => delivery.channelId === channelId && delivery.status === 'failed');
    }, { timeout: 20_000, intervals: [500, 1_000, 2_000] }).toBeTruthy();
  } finally {
    if (reportId) await page.request.delete(`/api/reports/${reportId}`, { headers });
    if (configId) await page.request.delete(`/api/reports/configs/${configId}`, { headers });
    if (channelId) await page.request.delete(`/api/notification/channels/${channelId}`, { headers });
    await page.request.delete(`/api/servers/${serverId}`, { headers });
  }
});
