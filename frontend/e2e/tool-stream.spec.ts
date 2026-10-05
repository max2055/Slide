import { test, expect } from '@playwright/test';

test('MAX-125 tool lifecycle and explicit text boundaries render in actual chat order', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/chat-history.html');
  await page.waitForFunction(() => Boolean((window as any).historyFixture));
  await page.evaluate(async () => {
    const { handleDirectAdapterEvent } = await import('/src/app/ui/direct-gateway.ts');
    const { flushToolStreamSync } = await import('/src/app/ui/app-tool-stream.ts');
    const fixture = (window as any).historyFixture;
    const host = { chatRunId: 'run', sessionKey: fixture.props.sessionKey, chatStream: '', chatStreamStartedAt: null,
      chatMessages: [], chatSending: true, chatQueue: [], chatThinkingText: '', settings: {}, applySettings() {},
      chatToolMessages: [], chatStreamSegments: [], toolStreamById: new Map(), toolStreamOrder: [], toolStreamSyncTimer: null };
    const send = (event: object) => handleDirectAdapterEvent(host, { runId: 'run', ...event });
    send({ type: 'text_delta', delta: '正文甲', partId: 'p1', partText: '正文甲' });
    send({ type: 'tool_state', toolCallId: 'a', toolName: 'mysql_query', phase: 'planned', occurredAt: 1, args: { sql: 'SELECT 1' } });
    send({ type: 'tool_start', toolCallId: 'a', toolName: 'mysql_query', occurredAt: 2, args: {} });
    send({ type: 'tool_start', toolCallId: 'b', toolName: 'mysql_query', occurredAt: 3, args: {} });
    send({ type: 'tool_error', toolCallId: 'a', toolName: 'mysql_query', occurredAt: 12, outcome: 'unknown', error: '结算尚未确认' });
    send({ type: 'tool_result', toolCallId: 'b', toolName: 'mysql_query', occurredAt: 13, result: '1 row' });
    send({ type: 'tool_state', toolCallId: 'b', toolName: 'mysql_query', occurredAt: 14, phase: 'persisted' });
    send({ type: 'text_delta', delta: '正文甲正文乙', partId: 'p2', partText: '正文乙' });
    send({ type: 'tool_state', toolCallId: 'c', toolName: 'mysql_query', phase: 'planned', occurredAt: 15, args: {} });
    send({ type: 'tool_state', toolCallId: 'c', toolName: 'mysql_query', phase: 'queued', occurredAt: 16 });
    send({ type: 'tool_start', toolCallId: 'd', toolName: 'mysql_query', occurredAt: 17, args: {} });
    send({ type: 'tool_error', toolCallId: 'd', toolName: 'mysql_query', occurredAt: 18, outcome: 'cancelled', error: '已取消' });
    send({ type: 'text_delta', delta: '正文甲正文乙正文丙', partId: 'p3', partText: '正文丙' });
    send({ type: 'thinking_end' });
    flushToolStreamSync(host);
    Object.assign(fixture.props, { messages: [], sending: true, stream: host.chatStream,
      streamSegments: host.chatStreamSegments, toolMessages: host.chatToolMessages });
    fixture.update();
  });
  await expect(page.locator('.chat-tool-msg-collapse')).toHaveCount(4);
  const order = await page.locator('#fixture').evaluate(root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const entries: string[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const element = node as Element;
      if (element.matches('.chat-tool-msg-collapse')) entries.push('tool');
      else if (element.matches('p') && /^正文[甲乙丙]$/.test(element.textContent ?? '')) entries.push(element.textContent!);
    }
    return entries;
  });
  expect(order).toEqual(['正文甲', 'tool', 'tool', '正文乙', 'tool', 'tool', '正文丙']);
  await expect(page.getByText('结算未知 · 10 ms', { exact: true })).toBeVisible();
  await expect(page.getByText('已保存 · 10 ms', { exact: true })).toBeVisible();
  await expect(page.getByText('排队中', { exact: true })).toBeVisible();
  await expect(page.getByText('已取消 · 1 ms', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('MAX-125-tool-stream.png'), fullPage: true, animations: 'disabled' });
});
