import { markChatRecoveryInterruption, dismissChatRecoveryNotice } from './chat/recovery-notice.ts';
import { activateChatSession, chatSessionHost } from './chat-session-state.ts';
import { describe, expect, it, vi } from 'vitest';
import { handleDirectAdapterEvent } from './direct-gateway.ts';
import { loadChatHistory, sendChatMessage } from './controllers/chat.ts';
import { createMessageProjection } from '../../../../packages/agent-core/src/message-projection.ts';
import type { DisplayStreamEvent } from '../../../../packages/agent-core/src/display-stream.ts';

function host() {
  return { sessionKey: 'one', connected: true, chatRunId: null as string | null, chatSending: false,
    chatRecoveryNotice: null as string | null, chatMessages: [], chatStream: null, chatStreamStartedAt: null,
    lastError: null, chatAttachments: [], chatMessage: '', chatLoading: false, chatThinkingLevel: null,
    client: { request: vi.fn().mockResolvedValue({ messages: [{ role: 'assistant', content: 'saved history' }] }) } };
}
function snapshot(cold = false, truncated = false): DisplayStreamEvent {
  const runId = cold ? 'cold' : 'run';
  return { type: 'stream.snapshot', sessionKey: 'one',
    stream: { version: 1, runId, turnId: runId, streamEpoch: 'epoch', subscriptionId: 'sub', fromSeq: 0, toSeq: 0 },
    snapshot: createMessageProjection(runId),
    recovery: { cold, truncated, omittedParts: 0, detailRef: { sessionKey: 'one', runId, kind: 'authorized-history' } } };
}

describe('DirectGateway recovery notices', () => {
  it('cold after an execution interruption warns once and dismissal survives repeated snapshots', async () => {
    const state = host(); state.chatRunId = 'run';
    markChatRecoveryInterruption(state);
    handleDirectAdapterEvent(state, snapshot(true, true));
    expect(state.chatRecoveryNotice).toContain('未保存的流尾部可能丢失');
    await loadChatHistory(state as any);
    expect(state.chatRecoveryNotice).toContain('未保存的流尾部可能丢失');
    dismissChatRecoveryNotice(state);
    handleDirectAdapterEvent(state, { ...snapshot(true, true), stream: { ...snapshot(true).stream, streamEpoch: 'new-cold' } });
    expect(state.chatRecoveryNotice).toBeNull();
    markChatRecoveryInterruption(state); // a distinct interruption in the same run
    handleDirectAdapterEvent(state, snapshot(true, true));
    expect(state.chatRecoveryNotice).toContain('未保存的流尾部可能丢失');
  });
  it('idle disconnection and a locally active run without an interruption are silent', () => {
    const state = host();
    markChatRecoveryInterruption(state);
    state.chatRunId = 'run';
    handleDirectAdapterEvent(state, snapshot(true, true));
    expect(state.chatRecoveryNotice).toBeNull();
  });
  it('full replay after a real interruption ends recovery without a warning', () => {
    const state = host(); state.chatRunId = 'run';
    markChatRecoveryInterruption(state);
    handleDirectAdapterEvent(state, snapshot());
    expect(state.chatRecoveryNotice).toBeNull();
    handleDirectAdapterEvent(state, snapshot(true, true));
    expect(state.chatRecoveryNotice).toBeNull();
  });
  it('dismissed truncated snapshot is scoped to a run and does not suppress a new epoch', () => {
    const state = host();
    handleDirectAdapterEvent(state, snapshot(false, true));
    dismissChatRecoveryNotice(state);
    handleDirectAdapterEvent(state, snapshot(false, true));
    expect(state.chatRecoveryNotice).toBeNull();
    handleDirectAdapterEvent(state, { ...snapshot(false, true), stream: { ...snapshot().stream, streamEpoch: 'new', subscriptionId: 'next' } });
    expect(state.chatRecoveryNotice).toContain('完整已保存内容');
  });
  it('hidden-session risk stays in its own receiver', () => {
    const state = host(); state.chatRunId = 'run';
    const a = chatSessionHost(state);
    markChatRecoveryInterruption(a);
    activateChatSession(state, 'two');
    handleDirectAdapterEvent(state, snapshot(true, true));
    expect(state.chatRecoveryNotice).toBeNull();
    expect(a.chatRecoveryNotice).toContain('未保存的流尾部可能丢失');
  });

  it('hydrates complete history silently even from an older cold/truncated server', async () => {
    const state = host();
    handleDirectAdapterEvent(state, snapshot(true, true));
    await vi.waitFor(() => expect(state.chatLoading).toBe(false));
    expect(state.chatMessages).toEqual([{ role: 'assistant', content: 'saved history' }]);
    expect(state.chatRecoveryNotice).toBeNull();
  });
  it('keeps a truthful truncated warning through automatic history hydration', async () => {
    const state = host();
    handleDirectAdapterEvent(state, snapshot(false, true));
    const warning = state.chatRecoveryNotice;
    expect(warning).toContain('完整已保存内容');
    await loadChatHistory(state as any);
    expect(state.chatRecoveryNotice).toBe(warning);
  });
  it('explicit refresh suppresses the same truncated event on repeated watch', async () => {
    const state = host();
    handleDirectAdapterEvent(state, snapshot(false, true));
    await loadChatHistory(state as any, { clearNotices: true });
    handleDirectAdapterEvent(state, { ...snapshot(false, true), stream: { ...snapshot().stream, subscriptionId: 'rewatch' } });
    expect(state.chatRecoveryNotice).toBeNull();
  });
  it('a new request cannot inherit the prior run warning', async () => {
    const state = host();
    handleDirectAdapterEvent(state, snapshot(false, true));
    await sendChatMessage(state as any, 'next');
    handleDirectAdapterEvent(state, snapshot(false, true));
    expect(state.chatRecoveryNotice).toBeNull();
  });
  it('a complete snapshot and replay need no lasting recovery warning', () => {
    const state = host();
    handleDirectAdapterEvent(state, snapshot());
    handleDirectAdapterEvent(state, { type: 'stream.delta', sessionKey: 'one', stream: { ...snapshot().stream, fromSeq: 1, toSeq: 1 },
      projection: { version: 1, runId: 'run', sequence: 1, attempt: 0, operations: [{ type: 'run.status', phase: 'generating' }] } });
    expect(state.chatRecoveryNotice).toBeNull();
  });
});
