import { qualificationPassword, qualificationMysqlTarget } from './qualification-credentials.js';
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from '../../apps/db-ops-api/node_modules/pg/lib/index.js';

test('qualification security boundary rejects unauthenticated administration and invalid login', async ({ page }) => {
  const privileged = await page.request.get('/api/users');
  expect(privileged.status()).toBe(401);

  const invalidLogin = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: 'incorrect-password' },
  });
  expect(invalidLogin.status()).toBe(401);
  expect(await invalidLogin.json()).toMatchObject({ error: expect.any(String) });
});

test('viewer cannot read, modify or delete an administrator private chat session', async ({ page }) => {
  const viewerLogin = await page.request.post('/api/auth/login', {
    data: { username: 'qualification-viewer', password: qualificationPassword() },
  });
  const adminLogin = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: qualificationPassword() },
  });
  expect(viewerLogin.status()).toBe(200);
  expect(adminLogin.status()).toBe(200);
  const viewerHeaders = { Authorization: `Bearer ${(await viewerLogin.json()).token}` };
  const adminHeaders = { Authorization: `Bearer ${(await adminLogin.json()).token}` };
  const forbidden = await page.request.get('/api/chat/history?sessionKey=qualification-admin-private-session', { headers: viewerHeaders });
  const missing = await page.request.get('/api/chat/history?sessionKey=qualification-no-such-session', { headers: viewerHeaders });
  expect(forbidden.status()).toBe(404);
  expect(missing.status()).toBe(404);
  expect(await forbidden.json()).toEqual(await missing.json());

  const session = '/api/sessions/qualification-admin-private-session';
  const update = await page.request.patch(session, { headers: viewerHeaders, data: { model: 'forged-model' } });
  const remove = await page.request.delete(session, { headers: viewerHeaders });
  expect(update.status()).toBe(404);
  expect(remove.status()).toBe(404);
  const ownerHistory = await page.request.get('/api/chat/history?sessionKey=qualification-admin-private-session', { headers: adminHeaders });
  expect(ownerHistory.status()).toBe(200);
  expect((await ownerHistory.json()).messages).toHaveLength(1);
});

test('viewer WebSocket cannot watch or load an administrator private chat session', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'qualification-viewer', password: qualificationPassword() },
  });
  const { token } = await login.json();
  const errors = await page.evaluate(async ({ token }) => new Promise<string[]>((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:28890/ws');
    const received: string[] = [];
    const timeout = window.setTimeout(() => { ws.close(); reject(new Error('WebSocket response timeout')); }, 5_000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'auth_ok') {
        ws.send(JSON.stringify({ type: 'chat.watch', sessionKey: 'qualification-admin-private-session' }));
      } else if (message.type === 'error') {
        received.push(message.error);
        if (received.length === 1) ws.send(JSON.stringify({ type: 'chat.history', sessionKey: 'qualification-admin-private-session' }));
        if (received.length === 2) { window.clearTimeout(timeout); ws.close(); resolve(received); }
      }
    };
    ws.onerror = () => reject(new Error('WebSocket error'));
  }), { token });
  expect(errors).toEqual(['Chat session not found', 'Failed to load chat history']);
});

test('disabling a user revokes REST, refresh, and WebSocket access immediately', async ({ page }) => {
  const adminLogin = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: qualificationPassword() },
  });
  expect(adminLogin.status()).toBe(200);
  const adminHeaders = { Authorization: `Bearer ${(await adminLogin.json()).token}` };
  const username = `qualification-revocation-${Date.now()}`;
  const created = await page.request.post('/api/users', {
    headers: adminHeaders,
    data: { username, password: 'qualification-password', email: `${username}@example.test` },
  });
  expect(created.status()).toBe(201);
  const createdBody = await created.json();
  const userId = Number(createdBody.userId ?? createdBody.user_id ?? createdBody.id);
  expect(userId).toBeGreaterThan(0);

  try {
    const login = await page.request.post('/api/auth/login', {
      data: { username, password: 'qualification-password' },
    });
    expect(login.status()).toBe(200);
    const { token, refreshToken } = await login.json();
    const wsAuthenticated = page.evaluate(async ({ token }) => new Promise<boolean>((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:28890/ws');
      const timeout = window.setTimeout(() => { ws.close(); reject(new Error('WebSocket revocation timeout')); }, 5_000);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
      ws.onmessage = (event) => {
        if (JSON.parse(event.data).type === 'auth_ok') {
          window.clearTimeout(timeout);
          (window as any).__qualificationRevocationSocket = ws;
          resolve(true);
        }
      };
      ws.onerror = () => reject(new Error('WebSocket error'));
    }), { token });
    expect(await wsAuthenticated).toBe(true);

    const disabled = await page.request.put(`/api/users/${userId}`, {
      headers: adminHeaders,
      data: { status: 'inactive' },
    });
    expect(disabled.status()).toBe(200);
    const deniedRest = await page.request.get('/api/auth/permissions', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(deniedRest.status()).toBe(401);
    const deniedRefresh = await page.request.post('/api/auth/refresh', { data: { refreshToken } });
    expect(deniedRefresh.status()).toBe(401);
    const closedAfterDisable = await page.evaluate(async () => new Promise<number>((resolve, reject) => {
      const ws = (window as any).__qualificationRevocationSocket as WebSocket | undefined;
      if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('WebSocket was not retained'));
      const timeout = window.setTimeout(() => { ws.close(); reject(new Error('WebSocket revocation timeout')); }, 5_000);
      ws.onclose = (event) => { window.clearTimeout(timeout); resolve(event.code); };
      ws.send(JSON.stringify({ type: 'chat.history', sessionKey: 'qualification-admin-private-session' }));
    }));
    expect(closedAfterDisable).toBe(4001);
  } finally {
    await page.request.delete(`/api/users/${userId}`, { headers: adminHeaders });
  }
});

test('notification channels reject private targets and redact stored credentials', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: qualificationPassword() },
  });
  expect(login.status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await login.json()).token}` };
  const privateTarget = await page.request.post('/api/notification/channels', {
    headers,
    data: {
      name: `qualification-private-${Date.now()}`,
      type: 'dingtalk',
      config: { webhook_url: 'http://127.0.0.1/private-token', secret: 'private-secret' },
    },
  });
  expect(privateTarget.status()).toBe(400);

  const name = `qualification-redaction-${Date.now()}`;
  const created = await page.request.post('/api/notification/channels', {
    headers,
    data: {
      name,
      type: 'dingtalk',
      enabled: false,
      config: { webhook_url: 'https://hooks.example.com/private-token', secret: 'private-secret' },
    },
  });
  expect(created.status()).toBe(200);
  const { id } = await created.json();
  try {
    const channels = await page.request.get('/api/notification/channels', { headers });
    expect(channels.status()).toBe(200);
    const channel = (await channels.json()).find((item: { id: number }) => item.id === id);
    expect(channel).toMatchObject({ name, config: { endpoint: 'https://hooks.example.com', hasCredential: true } });
    expect(JSON.stringify(channel)).not.toContain('private-token');
    expect(JSON.stringify(channel)).not.toContain('private-secret');
  } finally {
    await page.request.delete(`/api/notification/channels/${id}`, { headers });
  }
});

test('direct SQL execution rejects write, DDL, and multi-statement input before the target driver', async ({ page }) => {
  const target = qualificationMysqlTarget();
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: qualificationPassword() },
  });
  expect(login.status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await login.json()).token}` };
  const name = `qualification-sql-boundary-${Date.now()}`;
  const created = await page.request.post('/api/database/instances', {
    headers,
    data: {
      name,
      environment: 'testing',
      db_type: 'mysql',
      ...target,
    },
  });
  expect(created.status()).toBe(200);
  const createdBody = await created.json();
  const { id } = createdBody;
  const assertNoCredential = (value: unknown) => {
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain(qualificationPassword());
    if (target.password) expect(serialized).not.toContain(target.password);
    expect(serialized).not.toContain('password_encrypted');
    expect(serialized).not.toContain('connection_string');
  };
  assertNoCredential(createdBody);
  try {
    const detail = await page.request.get(`/api/database/instances/${id}`, { headers });
    expect(detail.status()).toBe(200);
    assertNoCredential(await detail.json());
    const listed = await page.request.get('/api/database/instances', { headers });
    expect(listed.status()).toBe(200);
    assertNoCredential(await listed.json());
    for (const sql of [
      'UPDATE users SET username = username WHERE 1 = 0',
      'CREATE TABLE qualification_must_not_exist (id INT)',
      'SELECT 1; DELETE FROM users WHERE 1 = 0',
    ]) {
      const response = await page.request.post(`/api/database/instances/${id}/execute`, {
        headers,
        data: { sql },
      });
      expect(response.status()).toBe(409);
      expect(await response.json()).toMatchObject({ reasonCode: 'NEEDS_APPROVAL' });
    }
  } finally {
    await page.request.delete(`/api/database/instances/${id}`, { headers });
  }
});

test('adapter capability contract rejects unsupported database types before persistence', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: qualificationPassword() },
  });
  expect(login.status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await login.json()).token}` };
  const capabilities = await page.request.get('/api/adapters/capabilities', { headers });
  expect(capabilities.status()).toBe(200);
  const adapters = (await capabilities.json()).adapters;
  expect(adapters).toEqual(expect.arrayContaining([
    expect.objectContaining({ dbType: 'mysql', creatable: true }),
    expect.objectContaining({ dbType: 'mongodb', creatable: false, state: 'unsupported' }),
    expect.objectContaining({ dbType: 'redis', creatable: false, state: 'unsupported' }),
    expect.objectContaining({ dbType: 'elasticsearch', creatable: false, state: 'unsupported' }),
  ]));
  const rejected = await page.request.post('/api/database/instances', {
    headers,
    data: {
      name: `qualification-unsupported-${Date.now()}`,
      environment: 'testing',
      db_type: 'mongodb',
      host: 'example.invalid',
      port: 27017,
      username: 'qualification',
      password: 'qualification-password',
      database_name: 'qualification',
    },
  });
  expect(rejected.status()).toBe(400);
  expect((await rejected.json()).error).toBe('DATABASE_TYPE_UNSUPPORTED:mongodb');
});

test('concurrent approval reviews execute a write exactly once', async ({ page }) => {
  const target = qualificationMysqlTarget();
  test.setTimeout(30_000);
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: qualificationPassword() },
  });
  expect(login.status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await login.json()).token}` };
  const name = `qualification-approval-${Date.now()}`;
  const created = await page.request.post('/api/database/instances', {
    headers,
    data: {
      name,
      environment: 'testing',
      db_type: 'mysql',
      ...target,
    },
  });
  expect(created.status()).toBe(200);
  const { id } = await created.json();
  try {
    const reloaded = await page.request.post(`/api/database/instances/${id}/reload`, { headers });
    expect(reloaded.status()).toBe(200);
    const submitted = await page.request.post('/api/approval/submit', {
      headers: { ...headers, 'Idempotency-Key': `qualification-approval-${Date.now()}` },
      data: {
        instance_id: id,
        sql_text: 'UPDATE qualification_approval_counter SET value = value + 1 WHERE id = 1',
        database_name: target.database_name,
      },
    });
    const submittedBody = await submitted.json();
    expect(submitted.status(), submittedBody.error).toBe(200);
    const approvalId = Number(submittedBody.request_id);
    const operationId = String(submittedBody.operationId);
    expect(approvalId).toBeGreaterThan(0);
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/i);
    const reviews = await Promise.all([0, 1].map(() => page.request.post(`/api/approval/${approvalId}/review`, {
      headers,
      data: { action: 'approve', notes: 'qualification concurrent review', execute_after_approve: true },
    })));
    const results = await Promise.all(reviews.map((response) => response.json()));
    expect(results.filter((result: { success?: boolean }) => result.success).length).toBe(1);
    const operationResponse = await page.request.get(`/api/operations/${operationId}`, { headers });
    expect(operationResponse.status()).toBe(200);
    expect((await operationResponse.json()).state).toBe('succeeded');
    const eventsResponse = await page.request.get(`/api/operations/${operationId}/events`, { headers });
    expect(eventsResponse.status()).toBe(200);
    expect((await eventsResponse.json()).events.map((event: { reasonCode: string }) => event.reasonCode)).toEqual([
      'CREATED', 'NEEDS_APPROVAL', 'APPROVAL_CLAIMED', 'APPROVAL_EXECUTION_STARTED', 'APPROVAL_EXECUTION_SUCCEEDED',
    ]);
    const read = await page.request.post(`/api/database/instances/${id}/execute`, {
      headers: { ...headers, 'Idempotency-Key': `qualification-read-${Date.now()}` },
      data: { sql: 'SELECT value FROM qualification_approval_counter WHERE id = 1' },
    });
    expect(read.status()).toBe(200);
    expect((await read.json()).rows).toEqual([{ value: 1 }]);
    const association = await page.request.post(`/api/database/instances/${id}/execute`, {
      headers: { ...headers, 'Idempotency-Key': `qualification-association-${Date.now()}` },
      data: {
        sql: `SELECT h.approval_request_id, a.rollback_info
              FROM sql_execution_history h
              JOIN approval_requests a ON a.id = h.approval_request_id
              WHERE h.approval_request_id = ${approvalId}
                AND h.sql_text LIKE 'UPDATE qualification_approval_counter%'
              ORDER BY h.id DESC LIMIT 1`,
      },
    });
    expect(association.status()).toBe(200);
    const associationRows = (await association.json()).rows;
    expect(associationRows).toHaveLength(1);
    expect(Number(associationRows[0].approval_request_id)).toBe(approvalId);
    const rollbackInfo = typeof associationRows[0].rollback_info === 'string'
      ? JSON.parse(associationRows[0].rollback_info)
      : associationRows[0].rollback_info;
    expect(rollbackInfo).toMatchObject({
      available: false,
      reason: 'ROLLBACK_SQL_NOT_PROVIDED',
      executed_at: expect.any(String),
    });
  } finally {
    await page.request.delete(`/api/database/instances/${id}`, { headers });
  }
});

test('approval cancellation and retry keep the request attached to the current attempt', async ({ page }) => {
  const target = qualificationMysqlTarget();
  test.setTimeout(30_000);
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: qualificationPassword() },
  });
  expect(login.status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await login.json()).token}` };
  const instance = await page.request.post('/api/database/instances', {
    headers,
    data: {
      name: `qualification-approval-retry-${Date.now()}`,
      environment: 'testing',
      db_type: 'mysql',
      ...target,
    },
  });
  expect(instance.status()).toBe(200);
  const { id: instanceId } = await instance.json();
  let retryInstanceId: number | undefined;
  let retryTarget: InstanceType<typeof pg.Pool> | undefined;
  const table = `qualification_retry_${randomUUID().replaceAll('-', '')}`;
  try {
    const reloaded = await page.request.post(`/api/database/instances/${instanceId}/reload`, { headers });
    expect(reloaded.status()).toBe(200);
    const sqlText = 'UPDATE qualification_approval_counter SET value = value + 1 WHERE id = 1';
    const submitted = await page.request.post('/api/approval/submit', {
      headers: { ...headers, 'Idempotency-Key': `qualification-approval-retry-${Date.now()}` },
      data: {
        instance_id: instanceId,
        sql_text: sqlText,
        database_name: target.database_name,
      },
    });
    const body = await submitted.json();
    expect(submitted.status(), body.error).toBe(200);
    const approvalId = Number(body.request_id);
    const originalOperationId = String(body.operationId);

    await page.goto('/dashboard');
    await page.locator('.login-gate input[autocomplete="username"]').fill('admin');
    await page.locator('.login-gate input[autocomplete="current-password"]').fill(qualificationPassword());
    await page.locator('.login-gate__connect').click();
    await expect(page.locator('.login-gate')).toBeHidden({ timeout: 15_000 });
    await page.goto('/approval');
    const dashboard = page.locator('approval-dashboard');
    const card = dashboard.locator('app-card.approval-card').filter({
      has: page.getByRole('checkbox', { name: `选择审批 ${approvalId}`, exact: true }),
    });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText(sqlText);
    await card.getByRole('button', { name: '查看完整证据', exact: true }).click();
    await expect(dashboard.getByText('审批详情')).toBeVisible();
    const cancelResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/api/operations/${originalOperationId}/cancel`) && response.request().method() === 'POST',
    );
    await dashboard.getByRole('button', { name: '取消 Operation' }).click();
    expect((await cancelResponse).status()).toBe(200);
    await expect(dashboard.getByText('cancelled', { exact: true })).toBeVisible();
    await expect(dashboard.getByRole('button', { name: '创建重试尝试' })).toHaveCount(0);
    const cancelledRetry = await page.request.post(`/api/operations/${originalOperationId}/retry`, { headers });
    expect(cancelledRetry.status()).toBe(409);
    expect(await cancelledRetry.json()).toMatchObject({ reasonCode: 'RETRY_NOT_AVAILABLE' });

    // PostgreSQL reports a transaction rollback receipt for the failed write.
    const pgHost = process.env.QUALIFICATION_PG_HOST;
    const pgPort = Number(process.env.QUALIFICATION_PG_PORT);
    const pgUser = process.env.QUALIFICATION_PG_USER;
    const pgDatabase = process.env.QUALIFICATION_PG_DATABASE;
    const pgPassword = process.env.QUALIFICATION_PG_PASSWORD;
    if (!pgHost || !Number.isSafeInteger(pgPort) || pgPort < 1 || pgPort > 65535 ||
      !pgUser || pgDatabase !== 'slide_qualification_pg' || !pgPassword) {
      throw new Error('Isolated PostgreSQL qualification database is required');
    }
    retryTarget = new pg.Pool({ host: pgHost, port: pgPort, user: pgUser, database: pgDatabase, password: pgPassword });
    await retryTarget.query(`CREATE TABLE ${table} (id int PRIMARY KEY, value int NOT NULL)`);
    await retryTarget.query(`INSERT INTO ${table} VALUES (1, 0)`);
    const retryInstance = await page.request.post('/api/database/instances', {
      headers,
      data: {
        name: `qualification-confirmed-rollback-${Date.now()}`, environment: 'testing', db_type: 'postgresql',
        host: pgHost, port: pgPort, username: pgUser, database_name: pgDatabase, password: pgPassword,
      },
    });
    expect(retryInstance.status()).toBe(200);
    retryInstanceId = Number((await retryInstance.json()).id);
    const retryReload = await page.request.post(`/api/database/instances/${retryInstanceId}/reload`, { headers });
    expect(retryReload.status()).toBe(200);
    const rejectedSql = `UPDATE ${table} SET value = NULL WHERE id = 1`;
    const failedSubmission = await page.request.post('/api/approval/submit', {
      headers: { ...headers, 'Idempotency-Key': `qualification-rollback-retry-${Date.now()}` },
      data: { instance_id: retryInstanceId, sql_text: rejectedSql, database_name: pgDatabase },
    });
    expect(failedSubmission.status()).toBe(200);
    const failedRequest = await failedSubmission.json();
    const failedApprovalId = Number(failedRequest.request_id);
    const failedOperationId = String(failedRequest.operationId);
    const review = await page.request.post(`/api/approval/${failedApprovalId}/review`, {
      headers,
      data: { action: 'approve', execute_after_approve: true },
    });
    expect(review.status()).toBe(200);
    expect(await review.json()).toMatchObject({
      success: false,
      execution_result: { executionState: 'rolled_back' },
    });
    expect((await retryTarget.query(`SELECT value FROM ${table} WHERE id = 1`)).rows).toEqual([{ value: 0 }]);

    await dashboard.getByRole('button', { name: '返回列表' }).click();
    await dashboard.getByRole('button', { name: '审批历史', exact: true }).click();
    await dashboard.locator(`[data-sql-approval-id="${failedApprovalId}"]`).click();
    const retryResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/api/operations/${failedOperationId}/retry`) && response.request().method() === 'POST',
    );
    await dashboard.getByRole('button', { name: '创建重试尝试' }).click();
    const retried = await retryResponse;
    expect(retried.status()).toBe(202);
    const { operation: newAttempt } = await retried.json();
    const retryId = String(newAttempt.id);
    const retryApprovalId = Number(newAttempt.approvalId);
    expect(retryId).not.toBe(failedOperationId);
    expect(retryApprovalId).not.toBe(failedApprovalId);
    await expect(dashboard.getByRole('status').filter({ hasText: `已创建审批 #${retryApprovalId}` })).toBeVisible();
    const retry = await page.request.get(`/api/operations/${retryId}`, { headers });
    expect(retry.status()).toBe(200);
    expect(await retry.json()).toMatchObject({ id: retryId, state: 'waiting_approval', attempt: 2, approvalId: retryApprovalId });

    const detail = await page.request.get(`/api/approval/${failedApprovalId}`, { headers });
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toMatchObject({ operation_id: failedOperationId, status: 'execution_failed' });
    const newDetail = await page.request.get(`/api/approval/${retryApprovalId}`, { headers });
    expect(newDetail.status()).toBe(200);
    expect(await newDetail.json()).toMatchObject({ operation_id: retryId, status: 'pending' });
  } finally {
    try {
      if (retryTarget) await retryTarget.query(`DROP TABLE IF EXISTS ${table}`);
    } finally {
      await retryTarget?.end();
      if (retryInstanceId) await page.request.delete(`/api/database/instances/${retryInstanceId}`, { headers });
      await page.request.delete(`/api/database/instances/${instanceId}`, { headers });
    }
  }
});

test('AI analysis result renders malicious structured and Markdown payloads as inert content', async ({ page }) => {
  await page.goto('/dashboard');
  const result = await page.evaluate(async () => {
    (window as any).__qualificationXss = 0;
    await import('/src/app/ui/views/ai-analysis-result.ts');
    const structured = document.createElement('ai-analysis-result') as any;
    structured.result = {
      summary: '<img src=x onerror="window.__qualificationXss = 1">',
      nested: { payload: '<script>window.__qualificationXss = 2</script>' },
    };
    document.body.appendChild(structured);
    await structured.updateComplete;
    const markdown = document.createElement('ai-analysis-result') as any;
    markdown.result = { schemaVersion: 1, displayMarkdown: '<img src=x onerror="window.__qualificationXss = 3">' };
    document.body.appendChild(markdown);
    await markdown.updateComplete;
    return {
      xss: (window as any).__qualificationXss,
      structuredImages: structured.shadowRoot?.querySelectorAll('img').length ?? -1,
      markdownImages: markdown.shadowRoot?.querySelectorAll('img').length ?? -1,
      structuredText: structured.shadowRoot?.textContent ?? '',
    };
  });
  expect(result.xss).toBe(0);
  expect(result.structuredImages).toBe(0);
  expect(result.markdownImages).toBe(0);
  expect(result.structuredText).toContain('<img src=x onerror=');
});
