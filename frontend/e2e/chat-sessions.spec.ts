import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

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
  await page.getByRole('button', { name: '移除队列消息' }).click();
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

type ChatSend = { messageId: string; idempotencyKey: string; message: string; sessionKey?: string };

async function enterChatFromMenu(page: Page, greetingFails = true, existingSession = false) {
  const sockets: WebSocketRoute[] = [];
  const sends: ChatSend[] = [];
  const session = 'receipt-session';
  const history: Array<{ role: string; content: string; runId: string }> = [];
  await page.addInitScript(() => {
    localStorage.setItem('token', 'receipt-fixture');
    localStorage.setItem('permissions', JSON.stringify(['*']));
    localStorage.setItem('slide.control.settings.v1:default', JSON.stringify({ locale: 'zh-CN' }));
  });
  await page.route('**/__slide/control-ui-config.json', route => route.fulfill({ json: {} }));
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname;
    switch (path) {
      case '/api/chat/greeting':
        return route.fulfill(greetingFails ? { status: 503, json: {} } : { json: { greeting: '欢迎使用 Slide' } });
      case '/api/auth/permissions':
        return route.fulfill({ json: ['*'] });
      case '/api/device/register':
        return route.fulfill({ status: 404, json: {} });
      case '/api/sessions':
        return route.fulfill({ json: {
          ok: true,
          sessions: existingSession || sends.length ? [{ key: session, label: '回执会话' }] : [],
          defaults: { model: 'fixture-model', modelProvider: 'fixture-provider' },
        } });
      case '/api/agents':
        return route.fulfill({ json: { agents: [{ id: 'main', name: '运维助手' }], defaultId: 'main' } });
      case '/api/models':
        return route.fulfill({ json: [{ id: 'fixture-model', name: 'Fixture Model', provider: 'fixture-provider' }] });
      case '/api/chat/history':
        return route.fulfill({ json: { messages: history, nextBefore: null } });
      case '/api/user/preferences':
        return route.fulfill({ json: { preferences: { locale: 'zh-CN' } } });
      default:
        return route.fulfill({ json: {} });
    }
  });
  await page.routeWebSocket('**/agent-ws', socket => socket.onMessage(message => {
    const frame = JSON.parse(String(message));
    if (frame.type === 'auth') sockets.push(socket);
    if (frame.type === 'chat.send') sends.push(frame);
  }));
  await page.goto('/feedback');
  const chatLink = page.getByRole('link', { name: '对话', exact: true });
  await chatLink.focus();
  await chatLink.press('Enter');
  await expect(page).toHaveURL(/\/chat(?:\?|$)/);
  const input = page.getByRole('textbox', { name: '对话消息', exact: true });
  const send = page.getByRole('button', { name: '发送消息', exact: true });
  const welcome = page.locator('.agent-chat__welcome');
  const uncertainty = page.getByText('发送结果尚未确认。', { exact: false });
  const authenticate = async (attempt: number) => {
    await expect.poll(() => sockets.length).toBe(attempt);
    sockets[attempt - 1].send(JSON.stringify({ type: 'auth_ok' }));
    await expect(input).toBeEnabled();
  };
  const allocateSession = (socket: WebSocketRoute) => {
    socket.send(JSON.stringify({ type: 'session.created', sessionKey: session, messageId: sends[0].messageId }));
  };
  const confirm = (socket: WebSocketRoute) => {
    history.push({ role: 'user', content: sends[0].message, runId: 'confirmed-run' });
    socket.send(JSON.stringify({ type: 'run.started', sessionKey: session, runId: 'confirmed-run', messageId: sends[0].messageId }));
  };
  return { sockets, sends, session, input, send, welcome, uncertainty, authenticate, allocateSession, confirm };
}

for (const [width, height, greetingFails] of [[1440, 900, true], [1366, 768, true], [1920, 1080, false]] as const) {
  test(`MAX-723 idle chat through menu at ${width}×${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    const { sockets, sends, input, send, welcome, uncertainty, authenticate } = await enterChatFromMenu(page, greetingFails);
    const suggestion = welcome.getByRole('button', { name: '查看实例运行状态' });
    const attach = page.getByRole('button', { name: '添加附件' });
    const model = page.getByRole('combobox', { name: '模型', exact: true });
    const ready = greetingFails ? '可以开始对话' : '欢迎使用 Slide';
    await expect(input).toBeDisabled();
    await expect(model.locator('option[value=""]')).toHaveText('默认模型');
    await expect(input).toHaveAttribute('placeholder', '正在连接');
    await expect(welcome.getByRole('heading', { name: '运维助手' })).toBeVisible();
    await expect(welcome).toContainText('正在连接');
    await expect(send).toBeDisabled();
    await expect(suggestion).toBeDisabled();
    await expect(uncertainty).toHaveCount(0);
    if (width === 1440) await page.screenshot({ path: info.outputPath('首次连接.png') });

    await authenticate(1);
    await expect(welcome).toContainText(ready);
    await expect(model.locator('option[value=""]')).toHaveText(/默认模型（.*Fixture Model.*）/);
    await expect(attach).toBeEnabled();
    await expect(input).toHaveAttribute('placeholder', '输入消息，按 Enter 发送');
    await input.focus();
    await expect(input).toBeFocused();
    await input.fill('保留这段未发送草稿');

    await sockets[0].close({ code: 1006 });
    await expect(page.getByText('连接已中断，正在重新连接', { exact: true })).toBeVisible();
    await expect(input).toBeDisabled();
    await expect(input).toHaveValue('保留这段未发送草稿');
    await expect(input).toHaveAttribute('placeholder', '正在重新连接');
    await expect(welcome).toContainText('正在重新连接');
    await expect(welcome).not.toContainText(/Ready to chat|可以开始对话|欢迎使用 Slide/);
    await expect(suggestion).toBeDisabled();
    await expect(send).toBeDisabled();
    await expect(attach).toBeDisabled();
    await expect(uncertainty).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('空闲断线.png') });

    await authenticate(2);
    await expect(welcome).toContainText(ready);
    await expect(input).toHaveValue('保留这段未发送草稿');
    await expect(send).toBeEnabled();
    await expect(suggestion).toBeEnabled();
    await expect(uncertainty).toHaveCount(0);
    expect(sends).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('空闲恢复.png') });
  });
}

test('MAX-723 unconfirmed chat keeps the draft after session allocation and retries the original frame only by request', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { sockets, sends, input, send, uncertainty, session, authenticate, allocateSession, confirm } = await enterChatFromMenu(page);
  await authenticate(1);
  await input.fill('核对本条原始消息');
  await input.press('Enter');
  await expect.poll(() => sends.length).toBe(1);
  allocateSession(sockets[0]);
  await expect(page).toHaveURL(new RegExp(`session=${session}$`));
  await sockets[0].close({ code: 1006 });
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue(sends[0].message);
  await expect(uncertainty).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('发送回执未知.png') });

  await authenticate(2);
  await expect(uncertainty).toHaveCount(1);
  expect(sends).toHaveLength(1);
  await send.click();
  await expect.poll(() => sends.length).toBe(2);
  expect(sends[1]).toMatchObject({ ...sends[0], sessionKey: session });
  confirm(sockets[1]);
  await expect(uncertainty).toHaveCount(0);
  await expect(input).toHaveValue('');
  const stop = page.getByRole('button', { name: '停止生成' });
  await expect(stop).toBeEnabled();
  await sockets[1].close({ code: 1006 });
  await expect(page.getByText('连接已中断，正在重新连接', { exact: true })).toBeVisible();
  await expect(stop).toBeDisabled();
  await expect(uncertainty).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('已确认后断线.png') });
  await authenticate(3);
  expect(sends).toHaveLength(2);
  await info.attach('receipt-frames.json', {
    body: JSON.stringify({ closeCode: 1006, sendsAfterFirstReconnect: 1, sendsAfterConfirmedReconnect: 2, sends }, null, 2),
    contentType: 'application/json',
  });
});

test('MAX-723 late acceptance retires the pending draft with zero replay', async ({ page }, info) => {
  const { sockets, sends, input, uncertainty, authenticate, confirm } = await enterChatFromMenu(page);
  await authenticate(1);
  await input.fill('等待迟到回执');
  await input.press('Enter');
  await expect.poll(() => sends.length).toBe(1);
  await sockets[0].close({ code: 1006 });
  await expect(input).toHaveValue(sends[0].message);
  await expect(uncertainty).toHaveCount(1);
  await authenticate(2);
  confirm(sockets[1]);
  await expect(uncertainty).toHaveCount(0);
  await expect(input).toHaveValue('');
  await input.press('Enter');
  expect(sends).toHaveLength(1);
  await info.attach('receipt-frames.json', {
    body: JSON.stringify({ closeCode: 1006, restoredDraftAfterConfirmation: await input.inputValue(), sends }, null, 2),
    contentType: 'application/json',
  });
});

for (const existingSession of [true, false]) {
  test(`MAX-723 4008 preserves the original request in an ${existingSession ? 'existing' : 'allocated'} session`, async ({ page }, info) => {
    const { sockets, sends, session, input, uncertainty, authenticate, allocateSession, confirm } =
      await enterChatFromMenu(page, true, existingSession);
    await authenticate(1);
    if (existingSession) {
      const sessionSelect = page.locator('.content-header select').filter({ has: page.locator(`option[value="${session}"]`) });
      await sessionSelect.selectOption(session);
      await expect(page).toHaveURL(new RegExp(`session=${session}$`));
    }
    await input.fill('等待限流断线前的确认');
    await input.press('Enter');
    await expect.poll(() => sends.length).toBe(1);
    expect(sends[0].sessionKey).toBe(existingSession ? session : undefined);
    if (!existingSession) {
      allocateSession(sockets[0]);
      await expect(page).toHaveURL(new RegExp(`session=${session}$`));
    }

    await sockets[0].close({ code: 4008, reason: 'controlled rate limit' });
    await expect(page.getByText('请求过于频繁，请稍后再试。', { exact: true })).toBeVisible();
    await expect(input).toBeDisabled();
    await expect(input).toHaveValue(sends[0].message);
    await expect(uncertainty).toHaveCount(1);
    await authenticate(2);
    await expect(uncertainty).toHaveCount(1);
    expect(sends).toHaveLength(1);

    await input.press('Enter');
    await expect.poll(() => sends.length).toBe(2);
    expect(sends[1]).toMatchObject({ ...sends[0], sessionKey: session });
    confirm(sockets[1]);
    await expect(uncertainty).toHaveCount(0);
    await expect(input).toHaveValue('');
    await info.attach('receipt-frames.json', {
      body: JSON.stringify({ existingSession, closeCode: 4008, sendsAfterReconnect: 1, sends }, null, 2),
      contentType: 'application/json',
    });
  });
}

for (const editTime of ['before disconnect', 'after restoration'] as const) {
  test(`MAX-723 late confirmation preserves a same-text draft edited ${editTime}`, async ({ page }, info) => {
    const { sockets, sends, session, input, uncertainty, authenticate, allocateSession } = await enterChatFromMenu(page);
    const editedDraft = editTime === 'before disconnect' ? '  等待原消息确认  ' : '等待原消息确认';
    await authenticate(1);
    await input.fill('等待原消息确认');
    await input.press('Enter');
    await expect.poll(() => sends.length).toBe(1);
    allocateSession(sockets[0]);
    await expect(page).toHaveURL(new RegExp(`session=${session}$`));
    if (editTime === 'before disconnect') await input.fill(editedDraft);
    await sockets[0].close({ code: 1006 });
    await expect(uncertainty).toHaveCount(1);
    await authenticate(2);
    if (editTime === 'after restoration') {
      await expect(input).toHaveValue(editedDraft);
      await input.press('End');
      await input.press('Space');
      await input.press('Backspace');
    }
    const { messageId, idempotencyKey } = sends[0];
    const recovered = { type: 'run.snapshot', sessionKey: session, messageId,
      run: { id: 'recovered-run', sessionId: session, state: 'running', messageId, idempotencyKey } };
    sockets[1].send(JSON.stringify(recovered));
    await expect(uncertainty).toHaveCount(0);
    await expect(input).toHaveValue(editedDraft);
    expect(sends).toHaveLength(1);
    await info.attach('receipt-frames.json', {
      body: JSON.stringify({ editTime, closeCode: 1006, editedDraft, sends, recovered }, null, 2),
      contentType: 'application/json',
    });
  });
}

test('MAX-723 empty history refresh keeps the unresolved receipt until confirmation', async ({ page }, info) => {
  const { sockets, sends, session, input, uncertainty, authenticate, allocateSession, confirm } = await enterChatFromMenu(page);
  await authenticate(1);
  await input.fill('空历史不能确认此消息');
  await input.press('Enter');
  await expect.poll(() => sends.length).toBe(1);
  allocateSession(sockets[0]);
  await expect(page).toHaveURL(new RegExp(`session=${session}$`));
  await sockets[0].close({ code: 1006 });
  await expect(uncertainty).toHaveCount(1);
  await authenticate(2);

  const refresh = page.getByRole('button', { name: '刷新聊天数据', exact: true });
  await expect(refresh).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/chat/history'),
    refresh.press('Enter'),
  ]);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ messages: [], nextBefore: null });
  await expect(refresh).toBeEnabled();
  await expect(uncertainty).toHaveCount(1);
  await expect(input).toHaveValue(sends[0].message);
  expect(sends).toHaveLength(1);

  await input.press('Enter');
  await expect.poll(() => sends.length).toBe(2);
  expect(sends[1]).toMatchObject({ ...sends[0], sessionKey: session });
  confirm(sockets[1]);
  await expect(uncertainty).toHaveCount(0);
  await expect(input).toHaveValue('');
  await info.attach('receipt-frames.json', {
    body: JSON.stringify({ closeCode: 1006, historyStatus: response.status(), messages: [], sendsAfterRefresh: 1, sends }, null, 2),
    contentType: 'application/json',
  });
});
