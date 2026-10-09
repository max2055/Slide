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
