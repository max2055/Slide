import { expect, test, type WebSocketRoute } from '@playwright/test';

for (const width of [1440, 390]) test(`MAX-134 A/B slow runs, late events and reconnect at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const frames: any[] = [];
  const runs = new Map<string, any>();
  const subscriptions = new Map<string, string>();
  let socket!: WebSocketRoute;
  const snapshot = (key: string, recovery?: any) => {
    const run = runs.get(key);
    socket.send(JSON.stringify({ type: 'stream.snapshot', sessionKey: key,
      stream: { version: 1, streamEpoch: `epoch-${key}`, runId: run.id, turnId: 'turn',
        subscriptionId: subscriptions.get(key), fromSeq: run.seq, toSeq: run.seq },
      snapshot: { version: 1, runId: run.id, sequence: run.seq, attempt: 1, phase: 'generating',
        ...(run.done ? { terminal: 'completed', runState: 'completed', durable: { kind: 'mysql', reference: `saved-${key}` } } : {}), parts: [
          { messageId: `model-${key}`, part: { id: `text-${key}`, type: 'text', text: run.text,
            ...(run.done ? { durable: { kind: 'mysql', reference: `saved-${key}` } } : {}),
            source: 'fact', status: run.done ? 'completed' : 'partial', generation: run.done ? 'ended' : 'open' } },
        ] }, ...(recovery ? { recovery } : {}) }));
  };
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/sessions') return route.fulfill({ json: { ok: true, sessions: [...runs.keys()].map(key => ({ key, label: `会话 ${key}` })), defaults: {} } });
    if (url.pathname === '/api/chat/history') {
      const run = runs.get(url.searchParams.get('sessionKey')!);
      return route.fulfill({ json: { messages: run ? [
        { role: 'user', content: run.question, runId: run.id },
        ...(run.done ? [{ role: 'assistant', content: run.text, runId: run.id }] : []),
      ] : [] } });
    }
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket('**/session-fixture', ws => {
    socket = ws;
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw)); frames.push(frame);
      if (frame.type === 'auth') ws.send(JSON.stringify({ type: 'auth_ok', capabilities: ['parts-stream-v1'] }));
      if (frame.type === 'chat.send') {
        const key = frame.sessionKey || (runs.size ? 'B' : 'A');
        const run = { id: `run-${key}`, question: frame.message, text: `${key} 初始输出`, seq: 1, done: false, messageId: frame.messageId };
        runs.set(key, run); subscriptions.set(key, frame.subscriptionId);
        if (!frame.sessionKey) ws.send(JSON.stringify({ type: 'session.created', sessionKey: key, messageId: frame.messageId }));
        ws.send(JSON.stringify({ type: 'run.started', sessionKey: key, runId: run.id, messageId: frame.messageId }));
        snapshot(key);
      }
      if (frame.type === 'chat.watch' && runs.has(frame.sessionKey)) {
        subscriptions.set(frame.sessionKey, frame.subscriptionId); snapshot(frame.sessionKey);
      }
    });
  });
  await page.goto('/e2e/fixtures/chat-sessions.html');
  const draft = page.locator('textarea');
  await expect(draft).toBeEnabled();
  const newButton = page.getByRole('button', { name: '新建对话', exact: true }).filter({ visible: true });
  await expect(newButton).toBeEnabled();
  if (width === 1440) {
    const order = await newButton.evaluate(el => (el.nextElementSibling as HTMLElement).title);
    expect(order).toMatch(/Refresh|刷新/);
  }
  await draft.fill('慢任务 A'); await draft.press('Enter');
  await expect(page.getByText('A 初始输出', { exact: false })).toBeVisible();
  await draft.fill('A 待发送消息'); await draft.press('Enter');
  await expect(page.locator('.chat-queue')).toContainText('A 待发送消息');
  await draft.fill('A 保留草稿');
  await newButton.focus(); await page.keyboard.press('Enter');
  await expect(draft).toHaveValue('');
  expect(frames.filter(f => f.type === 'chat.cancel')).toHaveLength(0);
  await expect(page.locator('.chat-runtime-status')).toHaveCount(0);
  await draft.fill('独立任务 B'); await draft.press('Enter');
  await expect(page.getByText('B 初始输出', { exact: false })).toBeVisible();
  expect(frames.filter(f => f.type === 'chat.send').map(f => f.sessionKey)).toEqual([undefined, undefined]);
  const sends = frames.filter(f => f.type === 'chat.send');
  expect(sends[0].idempotencyKey).not.toBe(sends[1].idempotencyKey);
  runs.get('A').seq++; runs.get('A').text = 'A 在后台持续输出'; snapshot('A', { truncated: true });
  socket.send(JSON.stringify({ type: 'run.started', sessionKey: 'A', runId: 'run-A', messageId: runs.get('A').messageId }));
  socket.send(JSON.stringify({ type: 'run.snapshot', sessionKey: 'A', run: {
    id: 'run-A', sessionId: 'A', messageId: runs.get('A').messageId, idempotencyKey: sends[0].idempotencyKey, state: 'running',
  } }));
  await expect(page.getByText('B 初始输出', { exact: false })).toBeVisible();
  await expect(page.locator('app-notice')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).sessionsFixture.app.sessionKey)).toBe('B');
  await page.screenshot({ path: info.outputPath(`MAX-134-B-independent-${width}.png`) });

  const selectSession = async (key: string) => {
    if (width === 390) await page.getByRole('button', { name: 'Chat settings', exact: true }).click();
    const selector = width === 390 ? '.chat-controls-dropdown .chat-controls__session select'
      : '.content-header .chat-controls__session-row > .chat-controls__session:not(.chat-controls__agent) select';
    await page.locator(selector).first().selectOption(key);
    if (width === 390) await draft.click();
  };
  await selectSession('A');
  await expect(page.getByText('A 在后台持续输出', { exact: false })).toBeVisible();
  await expect(draft).toHaveValue('A 保留草稿');
  await expect(page.locator('.chat-queue')).toContainText('A 待发送消息');
  await expect(page.locator('.chat-runtime-status')).toBeVisible();
  await page.screenshot({ path: info.outputPath(`MAX-134-A-restored-${width}.png`) });
  await page.getByRole('button', { name: 'Remove queued message' }).click();
  await selectSession('B');
  const authCount = frames.filter(f => f.type === 'auth').length;
  socket.close({ code: 1012, reason: 'controlled reconnect' });
  await expect.poll(() => frames.filter(f => f.type === 'auth').length).toBeGreaterThan(authCount);
  await expect(draft).toBeEnabled();
  await expect.poll(() => frames.filter(f => f.type === 'chat.watch').slice(-2).map(f => f.sessionKey).sort()).toEqual(['A', 'B']);
  runs.get('A').seq++; runs.get('A').text = 'A 最终结果，后台任务未取消'; runs.get('A').done = true;
  snapshot('A');
  await expect(page.getByText('B 初始输出', { exact: false })).toBeVisible();
  await selectSession('A');
  await expect(page.getByText('A 最终结果，后台任务未取消', { exact: false })).toBeVisible();
  await expect(page.locator('.chat-runtime-status')).toHaveCount(0);
  expect(frames.filter(f => f.type === 'chat.cancel')).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`MAX-134-A-completed-${width}.png`) });
  await info.attach('A-B-protocol-evidence.json', { body: JSON.stringify({ width, frames, runs: [...runs] }, null, 2), contentType: 'application/json' });
});
