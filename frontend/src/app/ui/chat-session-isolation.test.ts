import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { handleSendChat } from './app-chat.ts';
import { renderChatControls, switchChatSession } from './app-render.helpers.ts';
import { handleDirectAdapterEvent, clearExpiredChatState } from './direct-gateway.ts';
import { loadChatHistory } from './controllers/chat.ts';
import { chatSessionHost } from './chat-session-state.ts';

vi.mock('./app-scroll.ts', () => ({ scheduleChatScroll: vi.fn(), resetChatScroll: vi.fn() }));

function host() {
  const state: any = {
    sessionKey: 'A', connected: true, chatMessage: '', chatMessages: [], chatAttachments: [],
    chatQueue: [], chatRunId: null, chatSending: false, chatStream: null,
    chatThinkingText: '', chatThinkingComplete: false, chatSideResultTerminalRuns: new Set(),
    chatToolMessages: [], chatStreamSegments: [], toolStreamById: new Map(), toolStreamOrder: [],
    refreshSessionsAfterChat: new Set(), settings: {}, basePath: '', hello: null,
    chatModelCatalog: [], chatModelOverrides: {}, sessionsResult: null,
    resetToolStream: vi.fn(), resetChatScroll: vi.fn(),
    applySettings(next: any) { state.settings = next; },
    client: { request: vi.fn().mockResolvedValue({ messages: [] }), watchSession: vi.fn(), cancelChat: vi.fn() },
    handleSendChat: (text: string) => handleSendChat(state, text),
    onSlashAction: (action: string) => switchChatSession(state, action.slice('switch-session:'.length)),
  };
  return state;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 25));
afterEach(() => { window.history.replaceState({}, '', '/'); vi.clearAllMocks(); });

describe('MAX-134 independent conversations', () => {
  it.each([false, true])('keeps an accessible new button before refresh when busy=%s', async busy => {
    const state = host(); state.chatSending = busy; state.chatRunId = busy ? 'run-A' : null;
    state.chatMessage = 'A draft';
    const container = document.createElement('div');
    render(renderChatControls(state), container);
    const button = container.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe('新建对话');
    expect(button.title).toContain('当前任务继续运行');
    expect(button.disabled).toBe(false);
    expect(button.type).toBe('button');
    button.click(); await settle();
    expect(state.sessionKey).toBe('');
    expect(state.chatSending).toBe(false);
    expect(state.chatRunId).toBeNull();
    expect(state.chatMessage).toBe('');
    expect(state.client.cancelChat).not.toHaveBeenCalled();
    switchChatSession(state, 'A');
    expect(state.chatMessage).toBe('A draft');
    expect(state.chatRunId).toBe(busy ? 'run-A' : null);
    render(null, container);
  });

  it('separates draft, queue, notices and a throttled stream flush while A continues', async () => {
    const state = host(); state.chatRunId = 'run-A';
    state.chatMessage = 'A draft'; state.chatAttachments = [{ id: 'image-A' }];
    state.chatQueue = [{ id: 'queued-A', text: 'A follow-up' }];
    state.chatRecoveryNotice = 'A recovery';
    handleDirectAdapterEvent(state, { type: 'thinking_delta', sessionKey: 'A', runId: 'run-A', delta: 'A thinking' });
    handleDirectAdapterEvent(state, { type: 'text_delta', sessionKey: 'A', runId: 'run-A', delta: 'A still running' });
    await handleSendChat(state, '/new');
    state.chatMessage = 'B draft';
    await settle();
    expect(state.chatMessage).toBe('B draft');
    expect(state.chatStream).toBeNull();
    expect(state.chatThinkingText).toBe('');
    expect(state.chatQueue).toEqual([]);
    expect(state.chatRecoveryNotice).toBeNull();
    handleDirectAdapterEvent(state, { type: 'run.started', sessionKey: 'A', runId: 'run-A', messageId: 'old' });
    expect(state.sessionKey).toBe('');
    switchChatSession(state, 'A');
    expect(state.chatMessage).toBe('A draft');
    expect(state.chatAttachments).toEqual([{ id: 'image-A' }]);
    expect(state.chatQueue[0].text).toBe('A follow-up');
    expect(state.chatThinkingText).toBe('A thinking');
    expect(state.chatStream).toBe('A still running');
    expect(state.chatRecoveryNotice).toBeNull(); // MAX-135: navigation ends the old recovery notice.
  });

  it('routes late admission of an unallocated A without stealing the independently admitted B', async () => {
    const state = host(); switchChatSession(state, '');
    const sends: { params: any; resolve: () => void }[] = [];
    state.client.request.mockImplementation((method: string, params: any) => method === 'chat.send'
      ? new Promise<void>(resolve => sends.push({ params, resolve })) : Promise.resolve({ messages: [] }));
    state.chatMessage = 'question A';
    const sendA = handleSendChat(state);
    await handleSendChat(state, '/new');
    state.chatMessage = 'question B';
    const sendB = handleSendChat(state);
    expect(sends).toHaveLength(2);
    expect(sends.map(s => s.params.sessionKey)).toEqual(['', '']);
    expect(sends[0].params.idempotencyKey).not.toBe(sends[1].params.idempotencyKey);
    for (const [index, key] of [[0, 'allocated-A'], [1, 'allocated-B']] as const) {
      const messageId = sends[index].params.idempotencyKey;
      handleDirectAdapterEvent(state, { type: 'session.created', sessionKey: key, messageId });
      handleDirectAdapterEvent(state, { type: 'run.started', sessionKey: key, runId: `run-${index}`, messageId });
      if (index === 0) expect(state.sessionKey).toBe('');
      sends[index].resolve();
    }
    await Promise.all([sendA, sendB]);
    expect(state.sessionKey).toBe('allocated-B');
    expect(state.chatRunId).toBe('run-1');
    expect(state.chatSending).toBe(false);
    expect(state.chatMessages).toHaveLength(1);
    expect(JSON.stringify(state.chatMessages)).toContain('question B');
    expect(JSON.stringify(state.chatMessages)).not.toContain('question A');
    handleDirectAdapterEvent(state, { type: 'run.snapshot', sessionKey: 'allocated-A',
      run: { id: 'run-0', sessionId: 'allocated-A', messageId: sends[0].params.idempotencyKey,
        idempotencyKey: sends[0].params.idempotencyKey, state: 'running' } });
    expect(state.sessionKey).toBe('allocated-B');
    expect(new URL(window.location.href).searchParams.get('session')).toBe('allocated-B');
    switchChatSession(state, 'allocated-A');
    expect(state.chatRunId).toBe('run-0');
    expect(JSON.stringify(state.chatMessages)).toContain('question A');
    expect(state.client.cancelChat).not.toHaveBeenCalled();
  });

  it('keeps old send rejection and late history in A; permits new views while disconnected', async () => {
    const state = host(); let reject!: (error: Error) => void;
    let history!: (result: unknown) => void;
    state.client.request.mockImplementation((method: string) => method === 'chat.send'
      ? new Promise((_, r) => { reject = r; }) : new Promise(resolve => { history = resolve; }));
    state.chatMessage = 'A unsent';
    const send = handleSendChat(state);
    const read = loadChatHistory(state);
    state.connected = false;
    await handleSendChat(state, '/new');
    state.chatMessage = 'B draft';
    reject(new Error('A send failed')); history({ messages: [{ role: 'user', content: 'A history' }] });
    await Promise.all([send, read]);
    expect(state.sessionKey).toBe('');
    expect(state.chatMessage).toBe('B draft');
    expect(state.lastError).toBeNull();
    expect(state.chatMessages).toEqual([]);
    expect(state.chatSending).toBe(false);
    switchChatSession(state, 'A');
    expect(state.lastError).toBe('A send failed');
    expect(state.chatMessage).toBe('A unsent');
    expect(state.chatMessages).toEqual([{ role: 'user', content: 'A history' }]);
  });

  it('does not let a delayed acknowledgement of a prior run replace the current run', () => {
    const state = host(); state.chatRunId = 'current-run';
    handleDirectAdapterEvent(state, { type: 'run.started', runId: 'old-run', sessionKey: 'A', messageId: 'old-send' });
    handleDirectAdapterEvent(state, { type: 'run.snapshot', sessionKey: 'A',
      run: { id: 'old-run', sessionId: 'A', messageId: 'old-send', idempotencyKey: 'old-send', state: 'completed' } });
    expect(state.chatRunId).toBe('current-run');
  });

  it('ignores foreign recovery snapshots and clears cached conversations on expiry', async () => {
    const state = host(); state.chatMessage = 'private A draft';
    switchChatSession(state, 'B');
    const snapshot: any = { type: 'stream.snapshot', sessionKey: 'A',
      stream: { version: 1, streamEpoch: 'epoch', runId: 'run-A', turnId: 'turn', subscriptionId: 'sub', fromSeq: 1, toSeq: 1 },
      snapshot: { version: 1, runId: 'run-A', attempt: 1, sequence: 1, phase: 'generating', parts: [] },
      recovery: { cold: true } };
    handleDirectAdapterEvent(state, snapshot);
    expect(state.chatRecoveryNotice).toBeNull();
    expect(state.sessionKey).toBe('B');
    const old = chatSessionHost(state);
    clearExpiredChatState(state);
    old.chatMessage = 'late private B draft';
    switchChatSession(state, 'A');
    expect(state.chatMessage).toBe('');
    expect(state.chatRecoveryNotice).toBeNull();
    await settle();
  });
});
