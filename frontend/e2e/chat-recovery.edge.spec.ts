import { expect, test, type Page, type WebSocket as PlaywrightWebSocket } from '@playwright/test';

type Frame = Record<string, unknown>;

function parseFrame(payload: string | Buffer): Frame | null {
  try {
    const value = JSON.parse(payload.toString());
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function waitFor(
  readFrames: () => Frame[],
  predicate: (frame: Frame) => boolean,
  message: string,
  timeoutMs = 120_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = readFrames().find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function login(page: Page): Promise<void> {
  const username = process.env.SLIDE_EDGE_USERNAME;
  const password = process.env.SLIDE_EDGE_PASSWORD;
  if (!username || !password) throw new Error('SLIDE_EDGE_USERNAME and SLIDE_EDGE_PASSWORD are required');

  await page.goto('/?tab=chat');
  expect(page.url()).toMatch(/^https:\/\//);
  const login = page.locator('.login-gate');
  if (await login.isVisible().catch(() => false)) {
    await login.locator('input[autocomplete="username"]').fill(username);
    await login.locator('input[autocomplete="current-password"]').fill(password);
    await login.locator('button.login-gate__connect').click();
  }
  await expect(page.locator('chat-compose-area textarea')).toBeEnabled({ timeout: 30_000 });
}

function observeAgentSocket(page: Page, sent: Frame[], received: Frame[], urls: string[]): void {
  page.on('websocket', (socket: PlaywrightWebSocket) => {
    if (!socket.url().endsWith('/agent-ws')) return;
    urls.push(socket.url());
    socket.on('framesent', (event) => {
      const frame = parseFrame(event.payload);
      if (frame) sent.push(frame);
    });
    socket.on('framereceived', (event) => {
      const frame = parseFrame(event.payload);
      if (frame) received.push(frame);
    });
  });
}

async function sendAndAwaitCompletion(page: Page, sent: Frame[], received: Frame[], text: string): Promise<Frame> {
  const sentStart = sent.length;
  const receivedStart = received.length;
  const composer = page.locator('chat-compose-area');
  await composer.locator('textarea').fill(text);
  await composer.locator('button[aria-label="Send message"]').click();
  const request = await waitFor(
    () => sent.slice(sentStart),
    (frame) => frame.type === 'chat.send' && frame.message === text,
    `chat.send was not observed for ${text}`,
  );
  const messageId = request.messageId;
  await waitFor(
    () => received.slice(receivedStart),
    (frame) => frame.type === 'run.started' && frame.messageId === messageId,
    `run.started was not observed for ${String(messageId)}`,
  );
  await waitFor(() => received.slice(receivedStart), (frame) => frame.type === 'complete', `completion was not observed for ${String(messageId)}`);
  return request;
}

test('trusted same-origin WSS survives session churn and an interrupted durable send', async ({ page, context }) => {
  const sent: Frame[] = [];
  const received: Frame[] = [];
  const socketUrls: string[] = [];
  observeAgentSocket(page, sent, received, socketUrls);
  await login(page);

  const origin = new URL(page.url()).origin;
  await expect.poll(() => socketUrls.length).toBeGreaterThan(0);
  expect(socketUrls.every((url) => url === `${origin.replace(/^https:/, 'wss:')}/agent-ws`)).toBe(true);

  const rounds = Number(process.env.SLIDE_EDGE_ROUNDS ?? '30');
  expect(Number.isSafeInteger(rounds) && rounds >= 30).toBe(true);
  for (let round = 0; round < rounds; round += 1) {
    const sessionSelect = page.locator('[data-chat-session-select]');
    if (round % 3 === 0) {
      await page.locator('chat-compose-area button[aria-label="New session"]').click();
    } else if (await sessionSelect.isEnabled().catch(() => false)) {
      const values = await sessionSelect.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
      if (values.length) await sessionSelect.selectOption(values[round % values.length]);
    }
    await sendAndAwaitCompletion(page, sent, received, `edge-reliability-${Date.now()}-${round}`);
    await expect(page.getByText('网络连接中断', { exact: false })).toHaveCount(0);
  }

  const recoveryText = `edge-recovery-${Date.now()}`;
  const sentStart = sent.length;
  const receivedStart = received.length;
  await page.locator('chat-compose-area textarea').fill(recoveryText);
  await page.locator('chat-compose-area button[aria-label="Send message"]').click();
  const original = await waitFor(() => sent.slice(sentStart), (frame) => frame.type === 'chat.send' && frame.message === recoveryText, 'durable chat.send was not observed');
  await context.setOffline(true);
  await page.waitForTimeout(5_000);
  await context.setOffline(false);

  await expect(page.locator('chat-compose-area textarea')).toBeEnabled({ timeout: 120_000 });
  await waitFor(
    () => sent.slice(sentStart + 1),
    (frame) => frame.type === 'chat.send' && frame.messageId === original.messageId && frame.idempotencyKey === original.idempotencyKey,
    'reconnect did not replay the original durable identity',
  );
  await waitFor(() => received.slice(receivedStart), (frame) => frame.type === 'complete' || frame.type === 'run.snapshot', 'recovered run did not reach a durable state');
  const runIds = new Set(received.slice(receivedStart)
    .filter((frame) => frame.type === 'run.started' && frame.messageId === original.messageId)
    .map((frame) => String(frame.runId)));
  expect(runIds.size).toBeLessThanOrEqual(1);
  await expect(page.getByText('网络连接中断', { exact: false })).toHaveCount(0);
});
