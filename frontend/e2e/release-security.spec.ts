import { expect, test } from '@playwright/test';

test('qualification security boundary rejects unauthenticated administration and invalid login', async ({ page }) => {
  const privileged = await page.request.get('/api/users');
  expect(privileged.status()).toBe(401);

  const invalidLogin = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: 'incorrect-password' },
  });
  expect(invalidLogin.status()).toBe(401);
  expect(await invalidLogin.json()).toMatchObject({ error: expect.any(String) });
});

test('viewer cannot distinguish or read an administrator private chat session', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'qualification-viewer', password: 'Tpam1234' },
  });
  expect(login.status()).toBe(200);
  const { token } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };
  const forbidden = await page.request.get('/api/chat/history?sessionKey=qualification-admin-private-session', { headers });
  const missing = await page.request.get('/api/chat/history?sessionKey=qualification-no-such-session', { headers });
  expect(forbidden.status()).toBe(404);
  expect(missing.status()).toBe(404);
  expect(await forbidden.json()).toEqual(await missing.json());
});

test('viewer cannot modify or delete an administrator private chat session', async ({ page }) => {
  const viewerLogin = await page.request.post('/api/auth/login', {
    data: { username: 'qualification-viewer', password: 'Tpam1234' },
  });
  const adminLogin = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: 'Tpam1234' },
  });
  const viewerHeaders = { Authorization: `Bearer ${(await viewerLogin.json()).token}` };
  const adminHeaders = { Authorization: `Bearer ${(await adminLogin.json()).token}` };
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
    data: { username: 'qualification-viewer', password: 'Tpam1234' },
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
    data: { username: 'admin', password: 'Tpam1234' },
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
    data: { username: 'admin', password: 'Tpam1234' },
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
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: 'Tpam1234' },
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
      host: '127.0.0.1',
      port: 3306,
      username: 'root',
      password: 'Tpam1234',
      database_name: 'db_ops_ai_qualification',
    },
  });
  expect(created.status()).toBe(200);
  const createdBody = await created.json();
  const { id } = createdBody;
  const assertNoCredential = (value: unknown) => {
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain('Tpam1234');
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

test('concurrent approval reviews execute a write exactly once', async ({ page }) => {
  test.setTimeout(30_000);
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: 'Tpam1234' },
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
      host: '127.0.0.1',
      port: 3306,
      username: 'root',
      password: 'Tpam1234',
      database_name: 'db_ops_ai_qualification',
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
        database_name: 'db_ops_ai_qualification',
      },
    });
    const submittedBody = await submitted.json();
    expect(submitted.status(), submittedBody.error).toBe(200);
    const approvalId = Number(submittedBody.request_id);
    expect(approvalId).toBeGreaterThan(0);
    const reviews = await Promise.all([0, 1].map(() => page.request.post(`/api/approval/${approvalId}/review`, {
      headers,
      data: { action: 'approve', notes: 'qualification concurrent review', execute_after_approve: true },
    })));
    const results = await Promise.all(reviews.map((response) => response.json()));
    expect(results.filter((result: { success?: boolean }) => result.success).length).toBe(1);
    const read = await page.request.post(`/api/database/instances/${id}/execute`, {
      headers: { ...headers, 'Idempotency-Key': `qualification-read-${Date.now()}` },
      data: { sql: 'SELECT value FROM qualification_approval_counter WHERE id = 1' },
    });
    expect(read.status()).toBe(200);
    expect((await read.json()).rows).toEqual([{ value: 1 }]);
  } finally {
    await page.request.delete(`/api/database/instances/${id}`, { headers });
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
