import { test, expect } from '@playwright/test';

test('MAX-127 snapshot replaces full projection and hidden-page reset/terminal close logically without rAF', async ({ page }) => {
  await page.goto('/e2e/fixtures/chat-history.html');
  await page.waitForFunction(() => Boolean((window as any).historyFixture));
  const state = await page.evaluate(async () => {
    const { DirectGatewayClient, handleDirectAdapterEvent } = await import('/src/app/ui/direct-gateway.ts');
    const { getChatProjection } = await import('/src/app/ui/chat/message-projection.ts');
    // Background rendering cannot gate the logical reducer.
    window.requestAnimationFrame = () => 0;
    const fixture = (window as any).historyFixture;
    const host: any = { chatRunId: 'run', sessionKey: fixture.props.sessionKey, chatStream: '', chatMessages: [], chatSending: true,
      chatQueue: [], chatThinkingText: '', settings: {}, applySettings() {}, chatToolMessages: [], chatStreamSegments: [], toolStreamById: new Map(), toolStreamOrder: [], client: null };
    const sends: any[] = [];
    const gateway: any = new DirectGatewayClient({ onEvent: (event: any) => handleDirectAdapterEvent(host, event), onStateChange() {} });
    gateway.ws = { readyState: WebSocket.OPEN, send: (s: string) => sends.push(JSON.parse(s)) };
    gateway.partsStream = true; gateway.streamSubscriptions.set(host.sessionKey, 'sub');
    const durable = { kind: 'mysql', reference: 'saved' };
    const snapshot = { version: 1, runId: 'run', attempt: 2, sequence: 4, phase: 'tools', runState: 'running', anchorId: 'anchor', parts: [
      { messageId: 'model', part: { id: 'text', type: 'text', text: '确认正文', source: 'fact', status: 'completed', durable, generation: 'ended' } },
      { messageId: 'model', part: { id: 'tool', type: 'tool_call', source: 'fact', status: 'completed', durable, generation: 'ended',
        call: { id: 'call', type: 'function', function: { name: 'mysql_query', arguments: '{}' } },
        tool: { toolCallId: 'call', name: 'mysql_query', phase: 'persisted', outcome: 'ok', occurredAt: 5, startedAt: 1, settledAt: 4, persistedAt: 5,
          preview: { kind: 'text', text: '1 row', truncated: false } } } } ] };
    const stream = { version: 1, streamEpoch: 'epoch', runId: 'run', turnId: 'turn', subscriptionId: 'sub', fromSeq: 5, toSeq: 5 };
    gateway.dispatchEvent({ type: 'stream.snapshot', sessionKey: host.sessionKey, stream, snapshot });
    const restored = structuredClone(getChatProjection(host));
    const send = (operations: any[], sequence: number, cursor: number) => gateway.dispatchEvent({ type: 'stream.delta', sessionKey: host.sessionKey,
      stream: { ...stream, fromSeq: cursor, toSeq: cursor }, projection: { version: 1, runId: 'run', attempt: 3, sequence, operations } });
    send([{ type: 'part.start', messageId: 'next', part: { id: 'invalid', type: 'text', text: '撤回尾部', source: 'fact', status: 'partial' } }], 5, 6);
    send([{ type: 'stream.reset', anchor: { id: 'anchor', parts: snapshot.parts } }], 6, 7);
    // Duplicate and an old subscription must not append a second copy.
    send([{ type: 'part.start', messageId: 'next', part: { id: 'duplicate', type: 'text', text: '污染', source: 'fact', status: 'partial' } }], 6, 7);
    gateway.dispatchEvent({ type: 'stream.snapshot', sessionKey: host.sessionKey, stream: { ...stream, subscriptionId: 'old' }, snapshot: { ...snapshot, parts: [] } });
    send([{ type: 'run.status', phase: 'saving' }, { type: 'run.terminal', outcome: 'failed', error: '保存未确认' }], 7, 8);
    const terminal = structuredClone(getChatProjection(host, 'run'));
    Object.assign(fixture.props, { messages: [], sending: true, stream: host.chatStream, thinkingText: host.chatThinkingText,
      streamSegments: host.chatStreamSegments, toolMessages: host.chatToolMessages }); fixture.update();
    return { restored, terminal, sends, tools: host.toolStreamOrder };
  });
  expect(state.restored).toMatchObject({ phase: 'tools', runState: 'running', attempt: 2, anchorId: 'anchor' });
  expect(state.restored.parts[1].part.tool).toMatchObject({ phase: 'persisted', startedAt: 1, settledAt: 4, persistedAt: 5 });
  expect(state.terminal).toMatchObject({ terminal: 'failed', runState: 'failed', phase: 'saving', attempt: 3, anchorId: 'anchor' });
  expect(state.terminal.parts.map((p: any) => p.part.id)).toEqual(['text', 'tool']);
  expect(state.tools).toEqual(['call']);
  expect(state.sends).toEqual([]);
  await expect(page.getByText('撤回尾部', { exact: true })).toHaveCount(0);
  await expect(page.getByText('污染', { exact: true })).toHaveCount(0);
});

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

test('MAX-126 native parts reset atomically and hydrate the same durable history', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/chat-history.html');
  await page.waitForFunction(() => Boolean((window as any).historyFixture));
  const before = await page.evaluate(async () => {
    const { handleDirectAdapterEvent } = await import('/src/app/ui/direct-gateway.ts');
    const { getChatProjection } = await import('/src/app/ui/chat/message-projection.ts');
    const fixture = (window as any).historyFixture;
    const host = { chatRunId: 'native-run', sessionKey: fixture.props.sessionKey, chatStream: '', chatStreamStartedAt: 1,
      chatMessages: [], chatSending: true, chatQueue: [], chatThinkingText: '', settings: {}, applySettings() {},
      chatToolMessages: [], chatStreamSegments: [], toolStreamById: new Map(), toolStreamOrder: [], toolStreamSyncTimer: null };
    let sequence = 0;
    const send = (operations: object[], attempt = 1) => handleDirectAdapterEvent(host, { type: 'message_parts', runId: 'native-run',
      sessionKey: host.sessionKey, projection: { version: 1, runId: 'native-run', attempt, sequence: ++sequence, operations } });
    const part = (id: string, type: string, text: string) => ({ id, type, text, source: 'fact', status: 'partial',
      ...(type === 'reasoning' ? { format: 'reasoning_content' } : {}),
      ...(type === 'tool_input' ? { toolCallId: 'partial-call', name: 'mysql_query' } : {}) });
    const update = () => {
      Object.assign(fixture.props, { messages: [], sending: true, showThinking: true, stream: host.chatStream,
        thinkingText: host.chatThinkingText, thinkingComplete: host.chatThinkingComplete,
        streamSegments: host.chatStreamSegments, toolMessages: host.chatToolMessages }); fixture.update();
    };
    send([{ type: 'part.start', messageId: 'model-1', part: part('first', 'text', '已确认前文') }, { type: 'part.end', partId: 'first' }]);
    const durable = { kind: 'mysql', reference: 'saved-prefix' };
    const prefix = { version: 1, id: 'saved-prefix', projectionMessageId: 'model-1', role: 'assistant', runId: 'native-run', source: 'fact',
      status: 'completed', durable, parts: [{ ...part('first', 'text', '已确认前文'), status: 'completed', durable, generation: 'ended' }],
      legacy: { id: 'saved-prefix', role: 'assistant', content: '已确认前文' } };
    send([{ type: 'parts.persisted', documents: [prefix] }, { type: 'tool.state', messageId: 'model-1', partId: 'tool-part',
      event: { toolCallId: 'committed-call', name: 'mysql_query', phase: 'settled', outcome: 'ok', occurredAt: 2,
        preview: { kind: 'text', text: '1 row', truncated: false } } }]);
    const anchor = { id: 'saved-anchor', parts: structuredClone(getChatProjection(host).parts) };
    send([{ type: 'part.start', messageId: 'model-2', part: part('invalid-text', 'text', '待撤回正文') },
      { type: 'part.start', messageId: 'model-2', part: part('invalid-thinking', 'reasoning', '待撤回思考') },
      { type: 'part.start', messageId: 'model-2', part: part('invalid-input', 'tool_input', '{"sql":') }]);
    update();
    (window as any).nativeFixture = { host, send, update, part, anchor, prefix };
    return { types: getChatProjection(host).parts.map((p: any) => p.part.type) };
  });
  expect(before.types).toEqual(['text', 'tool_call', 'text', 'reasoning', 'tool_input']);
  await expect(page.getByText('待撤回正文', { exact: true })).toBeVisible();
  const reset = await page.evaluate(async () => {
    const { getChatProjection } = await import('/src/app/ui/chat/message-projection.ts');
    const f = (window as any).nativeFixture;
    f.send([{ type: 'stream.reset', anchor: f.anchor }], 2);
    f.send([{ type: 'stream.reset', anchor: f.anchor }], 2);
    f.update();
    return { thinking: f.host.chatThinkingText, parts: getChatProjection(f.host).parts.map((p: any) => p.part.id) };
  });
  expect(reset).toEqual({ thinking: '', parts: ['first', 'tool-part'] });
  await expect(page.getByText('待撤回正文', { exact: true })).toHaveCount(0);
  await expect(page.getByText('正在生成参数', { exact: false })).toHaveCount(0);
  await expect(page.locator('.chat-tool-msg-collapse')).toHaveCount(1);
  await expect(page.getByText('已确认前文', { exact: true })).toBeVisible();
  const equivalence = await page.evaluate(async () => {
    const { getChatProjection, hydrateChatProjections } = await import('/src/app/ui/chat/message-projection.ts');
    const f = (window as any).nativeFixture;
    f.send([{ type: 'part.start', messageId: 'model-3', part: f.part('last', 'text', '最终答复') }, { type: 'part.end', partId: 'last' }], 3);
    const durable = { kind: 'mysql', reference: 'saved-final' };
    const doc = { version: 1, id: 'saved-final', projectionMessageId: 'model-3', role: 'assistant', runId: 'native-run',
      source: 'fact', status: 'completed', durable, runTerminal: 'completed', parts: getChatProjection(f.host).parts
        .filter((p: any) => p.part.id !== 'first').map((p: any) => ({ ...p.part, sourceMessageId: p.messageId, status: 'completed', durable,
          ...(p.part.tool ? { tool: { ...p.part.tool, phase: 'persisted' } } : {}) })),
      legacy: { id: 'saved-final', role: 'assistant', content: '最终答复' } };
    f.send([{ type: 'parts.persisted', documents: [doc] }, { type: 'run.terminal', outcome: 'completed', durable }], 3);
    const live = structuredClone(getChatProjection(f.host).parts);
    const messages = [{ id: 'saved-prefix', role: 'assistant', messageParts: f.prefix }, { id: 'saved-final', role: 'assistant', messageParts: doc }];
    hydrateChatProjections(f.host, messages);
    const history = structuredClone(getChatProjection(f.host).parts);
    // Late data cannot contaminate a hydrated terminal run.
    f.send([{ type: 'part.start', messageId: 'late', part: f.part('late', 'text', '迟到污染') }], 3);
    Object.assign((window as any).historyFixture.props, { messages, sending: false, stream: null, thinkingText: '',
      streamSegments: [], toolMessages: [] }); (window as any).historyFixture.update();
    return { live, history, afterLate: getChatProjection(f.host).parts };
  });
  expect(equivalence.history).toEqual(equivalence.live);
  expect(equivalence.afterLate).toEqual(equivalence.live);
  await expect(page.getByText('已确认前文', { exact: true })).toBeVisible();
  await expect(page.getByText('最终答复', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-tool-msg-collapse')).toHaveCount(1);
  await expect(page.getByText('迟到污染', { exact: true })).toHaveCount(0);
  const historyOrder = await page.locator('#fixture').evaluate(root => {
    const entries: string[] = [];
    for (const element of root.querySelectorAll('p, .chat-tool-msg-collapse')) {
      if (element.matches('.chat-tool-msg-collapse')) entries.push('tool');
      else if (['已确认前文', '最终答复'].includes(element.textContent ?? '')) entries.push(element.textContent!);
    }
    return entries;
  });
  expect(historyOrder).toEqual(['已确认前文', 'tool', '最终答复']);
  await page.screenshot({ path: testInfo.outputPath('MAX-126-message-parts-history.png'), fullPage: true, animations: 'disabled' });
});
