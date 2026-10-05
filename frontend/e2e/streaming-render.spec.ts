import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';

test('MAX-128 browser incremental parsing and receipt-to-paint baseline', async ({ page, browser }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8.execute,blink.user_timing', transferMode: 'ReturnAsStream' });
  await page.goto('/e2e/fixtures/chat-history.html');
  await page.waitForFunction(() => Boolean((window as any).historyFixture));
  const result = await page.evaluate(async () => {
    const { StreamingMarkdown } = await import('/src/app/ui/chat/streaming-markdown.ts');
    const { toSanitizedMarkdownHtml } = await import('/src/app/ui/markdown.ts');
    const { render, html } = await import('/node_modules/lit/index.js');
    const { streamingMarkdown } = await import('/src/app/ui/chat/streaming-markdown.ts');
    const next = () => new Promise<void>(resolve => setTimeout(resolve, 0));
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const percentile = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1];
    const unit = '正文 English **重点** [reference][id]。\n\n```sql\nSELECT id, name FROM instances WHERE active = 1;\n```\n\n- 列表甲\n- list two\n\n| 数据 | result |\n| --- | --- |\n| 中 | ok |\n\n> 引用 quote\n\n';
    const longTasks: { start: number; duration: number }[] = [];
    const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime, duration: entry.duration }); });
    observer.observe({ type: 'longtask', buffered: false });
    const scenarios = [];
    for (const kind of ['mixed', 'plain', 'fence', 'list', 'table']) for (const size of [20_000, 40_000, 100_000]) {
      const source = kind === 'mixed' ? unit.repeat(Math.ceil(size / unit.length)).slice(0, size) + '\n\n[id]: https://example.com\n'
        : kind === 'plain' ? '中 English plain text '.repeat(5000).slice(0, size)
        : kind === 'fence' ? ('```sql\n' + 'SELECT * FROM instances;\n'.repeat(4200)).slice(0, size)
        : kind === 'list' ? '- 中 English **bold**\n'.repeat(5200).slice(0, size)
        : ('| 中 | en |\n| --- | --- |\n' + '| 甲 | data |\n'.repeat(8000)).slice(0, size);
      const step = kind === 'mixed' ? 100 : 1000;
      const old: number[] = [], parse: number[] = [], intervals: [number, number][] = [], paint: number[] = [], apply: number[] = [];
      // Same text prefixes, browser and hardware. Legacy 40k fallback is retained in the baseline.
      for (let i = step; i < source.length + step; i += step) {
        await next(); const at = performance.now(); toSanitizedMarkdownHtml(source.slice(0, i)); old.push(performance.now() - at);
      }
      const parser = new StreamingMarkdown();
      for (let i = step; i < source.length + step; i += step) {
        await next(); const at = performance.now(); parser.update(source.slice(0, i)); const end = performance.now();
        parse.push(end - at); intervals.push([at, end]);
        performance.measure(`MAX128 parse ${kind}/${size}`, { start: at, end });
      }
      const root = document.createElement('div'); root.className = 'chat-text'; document.body.replaceChildren(root);
      for (let i = 1000; i < source.length + 1000; i += 1000) {
        await frame(); const at = performance.now(); render(html`${streamingMarkdown(source.slice(0, i))}`, root);
        const end = performance.now(); apply.push(end - at); intervals.push([at, end]);
        performance.measure(`MAX128 apply ${kind}/${size}`, { start: at, end });
        if (kind === 'table') { if (!root.querySelector('table th')) throw new Error('table semantics lost'); }
        if (kind === 'list') { if (!root.querySelector('ul li')) throw new Error('list semantics lost'); }
        // The next rAF follows the intervening browser paint; same browser monotonic clock.
        await frame(); await frame(); paint.push(performance.now() - at);
      }
      await next();
      const relevant = longTasks.filter(task => intervals.some(([start, end]) => task.start <= start && task.start + task.duration >= end));
      scenarios.push({ kind, size, characters: source.length, baselineP95: percentile(old), parseP95: percentile(parse), applyP95: percentile(apply),
        paintP95: percentile(paint), longTasks: relevant, raw: { baseline: old, parse, apply, paint } });
      root.remove();
    }
    observer.disconnect();
    return { scenarios, userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, timing: 'browser performance.now; 2 rAF conservative paint upper bound; no server/client clock subtraction' };
  });
  const evidence = { ...result, browserVersion: browser.version(), hardware: { cpu: cpus()[0].model, cores: cpus().length, memoryBytes: totalmem(), platform: platform(), release: release() } };
  writeFileSync(test.info().outputPath('MAX-128-browser-metrics.json'), JSON.stringify(evidence, null, 2));
  const complete = new Promise<any>(resolve => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end'); const { stream } = await complete;
  const chunks: Buffer[] = [];
  for (;;) { const value = await cdp.send('IO.read', { handle: stream }); chunks.push(Buffer.from(value.data, value.base64Encoded ? 'base64' : 'utf8')); if (value.eof) break; }
  await cdp.send('IO.close', { handle: stream });
  writeFileSync(test.info().outputPath('MAX-128-browser-trace.json'), Buffer.concat(chunks));
  for (const scenario of result.scenarios) {
    expect(scenario.parseP95, `${scenario.kind}/${scenario.size} parse`).toBeLessThanOrEqual(16);
    expect(scenario.applyP95, `${scenario.kind}/${scenario.size} apply`).toBeLessThanOrEqual(16);
    expect(scenario.paintP95, `${scenario.kind}/${scenario.size} paint`).toBeLessThanOrEqual(100);
    expect(scenario.longTasks, `${scenario.kind}/${scenario.size} long tasks`).toEqual([]);
  }
});

test('MAX-128 accepted and 100 tool boundaries paint actual state within 100ms', async ({ page }) => {
  await page.goto('/e2e/fixtures/chat-history.html');
  await page.waitForFunction(() => Boolean((window as any).historyFixture));
  const result = await page.evaluate(async () => {
    const { handleDirectAdapterEvent } = await import('/src/app/ui/direct-gateway.ts');
    const f = (window as any).historyFixture;
    const host: any = { chatRunId: null, sessionKey: f.props.sessionKey, chatStream: '', chatMessages: [], chatSending: false,
      chatQueue: [], settings: {}, applySettings() {}, chatToolMessages: [], chatStreamSegments: [], toolStreamById: new Map(), toolStreamOrder: [] };
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    f.props.messages = []; f.props.canAbort = true; f.props.onAbort = () => {}; f.props.stream = null;
    const update = () => { Object.assign(f.props, { messageProjection: host.chatMessageProjection, runtimePhase: host.chatRuntimePhase, runId: host.chatRunId }); f.update(); };
    const acceptedAt = performance.now();
    handleDirectAdapterEvent(host, { type: 'run.started', runId: 'tools-run', sessionKey: host.sessionKey, messageId: 'admitted' });
    update(); await frame(); await frame();
    const acceptedPaint = performance.now() - acceptedAt;
    if (!document.querySelector('.chat-runtime-status')?.textContent?.includes('准备诊断上下文')) throw new Error('accepted did not show actual preparing');
    const parts: any[] = [], apply: number[] = [], paint: number[] = [];
    for (let i = 0; i < 100; i++) {
      parts.push({ messageId: 'model', part: { id: `tool-${i}`, type: 'tool_call', source: 'fact', status: 'partial', generation: 'ended',
        call: { id: `call-${i}`, type: 'function', function: { name: 'mysql_query', arguments: '{"sql":"SELECT 1"}' } },
        tool: { toolCallId: `call-${i}`, name: 'mysql_query', phase: 'settled', outcome: i === 99 ? 'unknown' : 'ok', occurredAt: i + 10,
          startedAt: i, settledAt: i + 10, preview: { kind: 'text', text: 'bounded row preview', truncated: false }, progress: { completed: 1, total: 1 } } } });
      const at = performance.now();
      handleDirectAdapterEvent(host, { type: 'stream.snapshot', sessionKey: host.sessionKey,
        stream: { version: 1, streamEpoch: 'epoch', runId: 'tools-run', turnId: 'turn', subscriptionId: 'sub', fromSeq: i + 1, toSeq: i + 1 },
        snapshot: { version: 1, runId: 'tools-run', sequence: i + 1, attempt: 1, phase: 'tools', parts } });
      update(); await new Promise<void>(resolve => queueMicrotask(resolve)); apply.push(performance.now() - at);
      await frame(); await frame(); paint.push(performance.now() - at);
    }
    const p95 = (s: number[]) => [...s].sort((a,b) => a-b)[Math.ceil(s.length*.95)-1];
    return { acceptedPaint, applyP95: p95(apply), paintP95: p95(paint), raw: { apply, paint } };
  });
  writeFileSync(test.info().outputPath('MAX-128-tools-metrics.json'), JSON.stringify(result, null, 2));
  expect(result.acceptedPaint).toBeLessThanOrEqual(100);
  expect(result.applyP95).toBeLessThanOrEqual(16); expect(result.paintP95).toBeLessThanOrEqual(100);
  await expect(page.locator('.chat-tool-msg-collapse')).toHaveCount(100);
  await expect(page.getByText('结算未知（待确认） · 10 ms · 1/1', { exact: true })).toBeVisible();
});

test('MAX-128 real phases, stop confirmation, reading and stable completion on narrow screen', async ({ page }) => {
  await page.goto('/e2e/fixtures/chat-history.html');
  await page.waitForFunction(() => Boolean((window as any).historyFixture));
  await page.evaluate(() => {
    const f = (window as any).historyFixture;
    const part = (id: string, text: string) => ({ messageId: 'model', part: { id, type: 'text', text, source: 'fact', status: 'partial', generation: 'open' } });
    const source = '```json\n{"ok": true}\n```\n\n阅读位置 **stable**\n\n' + '正文 English\n\n'.repeat(150);
    f.props.messages = [{ id: 'q', role: 'user', content: 'question' }];
    f.props.streamStartedAt = 1; f.props.runId = 'run'; f.props.canAbort = true; f.props.sending = true;
    f.props.messageProjection = { version: 1, runId: 'run', sequence: 1, attempt: 1, phase: 'waiting_model', parts: [part('p', source)] };
    f.props.runtimePhase = 'waiting_model'; f.update();
  });
  await expect(page.getByRole('status').filter({ hasText: '等待模型响应' })).toBeVisible();
  await page.locator('.json-collapse > summary').click();
  await page.evaluate(() => {
    const f = (window as any).historyFixture;
    const text = document.querySelector('.chat-group.assistant .chat-text p')!; const range = document.createRange(); range.selectNodeContents(text);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    (window as any).savedDetails = document.querySelector('.json-collapse');
    const thread = document.querySelector('.chat-thread')!; thread.scrollTop = 300;
    (window as any).readingTop = thread.scrollTop;
    f.props.runtimePhase = 'generating'; f.props.messageProjection.parts[0].part.text += '\n\n新内容'; f.update();
  });
  await expect(page.getByText('新内容', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()!.toString())).toBe('阅读位置 stable');
  await page.evaluate(() => {
    const f = (window as any).historyFixture; f.props.messageProjection.terminal = 'completed';
    f.props.canAbort = false; f.props.runId = null; f.props.sending = false; f.update();
  });
  expect(await page.evaluate(() => document.querySelector('.json-collapse') === (window as any).savedDetails)).toBe(true);
  expect(await page.locator('.json-collapse').evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);
  expect(await page.evaluate(() => document.querySelector('.chat-thread')!.scrollTop === (window as any).readingTop)).toBe(true);
  const scroll = await page.evaluate(async () => {
    const { handleChatScroll, scheduleChatScroll } = await import('/src/app/ui/app-scroll.ts');
    const thread = document.querySelector<HTMLElement>('.chat-thread')!;
    const host: any = { updateComplete: Promise.resolve(), querySelector: (selector: string) => document.querySelector(selector),
      chatScrollFrame: null, chatScrollTimeout: null, chatHasAutoScrolled: true, chatUserNearBottom: true, chatNewMessagesBelow: false };
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    thread.scrollTop = thread.scrollHeight;
    handleChatScroll(host, { currentTarget: thread } as any);
    thread.scrollTop -= 20; handleChatScroll(host, { currentTarget: thread } as any);
    const at = thread.scrollTop; scheduleChatScroll(host, true); await frame(); await frame();
    const paused = thread.scrollTop === at && host.chatNewMessagesBelow;
    host.chatUserNearBottom = true; scheduleChatScroll(host); await frame(); await frame();
    return { paused, resumed: thread.scrollHeight - thread.scrollTop - thread.clientHeight < 5 };
  });
  expect(scroll).toEqual({ paused: true, resumed: true });
  for (const [phase, label] of [['approval', '等待审批，操作尚未执行'], ['retrying', '正在重试，已撤回无效输出'], ['saving', '保存诊断结果']]) {
    await page.evaluate(phase => { const f = (window as any).historyFixture; f.props.canAbort = true; f.props.runtimePhase = phase; f.update(); }, phase);
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await page.evaluate(() => { const f = (window as any).historyFixture; f.props.onAbort = () => { f.props.cancelRequested = true; f.update(); }; f.update(); });
  await page.getByRole('button', { name: 'Stop generating' }).click();
  await expect(page.getByRole('button', { name: '等待取消确认' })).toBeDisabled();
  await expect(page.getByText('取消请求已发送，等待服务端确认')).toBeVisible();
  await page.evaluate(() => { const f = (window as any).historyFixture; f.props.cancelRequested = false; f.props.connected = false; f.update(); });
  await expect(page.getByText('连接恢复中，服务端任务可能仍在运行')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= 390)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('MAX-128-narrow.png'), fullPage: true });
});
