import { expect, it, vi, afterEach } from 'vitest';
import { handleDirectAdapterEvent } from './direct-gateway.ts';
import { handleAgentEvent, resetToolStream } from './app-tool-stream.ts';
import { extractToolCards, toolLifecycleLabel } from './chat/tool-cards.ts';
import baseline from '../../../../tests/fixtures/tool-stream-baseline.json' with { type: 'json' };

const host = () => ({ chatRunId: 'run', sessionKey: 'session', chatStream: '', chatStreamStartedAt: null,
  chatMessages: [], chatQueue: [], chatSending: true, lastError: null, chatThinkingText: '',
  settings: { lastActiveSessionKey: '' }, applySettings() {}, refreshSessionsAfterChat: new Set(),
  chatToolMessages: [], chatStreamSegments: [], toolStreamById: new Map(), toolStreamOrder: [], toolStreamSyncTimer: null });
afterEach(() => { vi.useRealTimers(); });

it('approval denial stays visible as unexecuted even after its result is saved', () => {
  const card = { kind: 'result' as const, name: 'mysql_query', phase: 'persisted' as const, outcome: 'error' as const,
    outputText: JSON.stringify({ success: false, errorCode: 'APPROVAL_REQUIRED', data: { approvalId: 'actual-request' } }) };
  expect(toolLifecycleLabel(card)).toBe('等待审批 · 尚未执行');
  expect(toolLifecycleLabel({ ...card, outputText: 'ordinary failure' })).toBe('执行失败');
  expect(toolLifecycleLabel({ ...card, outcome: 'unknown', outputText: 'uncertain' })).toContain('待确认');
});

it('raw events create separate same-name cards and preserve text → tools → text segments', async () => {
  vi.useFakeTimers();
  const state = host();
  const send = (event: object) => handleDirectAdapterEvent(state, { runId: 'run', ...event } as any);
  send({ type: 'text_delta', delta: 'before', partId: 'text:0', partText: 'before' });
  send({ type: 'tool_state', toolCallId: 'slow', toolName: 'query', phase: 'planned', occurredAt: 1, args: {} });
  send({ type: 'tool_state', toolCallId: 'slow', toolName: 'query', phase: 'queued', occurredAt: 2 });
  expect(state.toolStreamById.get('slow').startedAt).toBeUndefined();
  send({ type: 'tool_start', toolCallId: 'slow', toolName: 'query', occurredAt: 3, args: {} });
  send({ type: 'tool_start', toolCallId: 'fast', toolName: 'query', occurredAt: 4, args: {} });
  send({ type: 'tool_result', toolCallId: 'fast', toolName: 'query', occurredAt: 5, result: 'ok' });
  expect(state.toolStreamById.get('slow').phase).toBe('running');
  expect(state.toolStreamById.get('fast').phase).toBe('settled');
  send({ type: 'tool_error', toolCallId: 'slow', toolName: 'query', occurredAt: 6, outcome: 'unknown', error: 'unsettled' });
  send({ type: 'tool_result', toolCallId: 'slow', toolName: 'query', occurredAt: 7, result: 'late' });
  send({ type: 'tool_progress', toolCallId: 'fast', toolName: 'query', occurredAt: 7, progress: { completed: 9 } });
  send({ type: 'tool_state', toolCallId: 'fast', toolName: 'query', occurredAt: 8, phase: 'persisted' });
  send({ type: 'text_delta', delta: 'beforeafter', partId: 'text:1', partText: 'after' });
  await vi.advanceTimersByTimeAsync(90);
  expect(state.chatStreamSegments).toMatchObject([{ text: 'before', partId: 'text:0', beforeToolCallId: 'slow' }]);
  expect(state.chatStream).toBe('after');
  expect(state.toolStreamOrder).toEqual(['slow', 'fast']);
  expect(state.toolStreamById.get('slow').outcome).toBe('unknown');
  expect(state.toolStreamById.get('slow').output).toBe('unsettled');
  const card = extractToolCards(state.toolStreamById.get('slow').message)[0];
  expect(toolLifecycleLabel(card)).toContain('结算未知');
  expect(toolLifecycleLabel(card)).toContain('3 ms');
});

it('malformed and unidentified old adapter frames are dropped without poisoning ordering', () => {
  const state = host();
  for (const event of baseline.adapterEvents) handleDirectAdapterEvent(state, event as any);
  handleDirectAdapterEvent(state, { type: 'tool_start', toolCallId: 'valid', toolName: 'query', args: [], occurredAt: 1, sequence: 900, attempt: 1, runId: 'run' } as any);
  handleDirectAdapterEvent(state, { type: 'tool_result', toolCallId: 'valid', toolName: 'query', result: 'ok', occurredAt: 2, sequence: 2, attempt: 1, runId: 'run' });
  expect(state.toolStreamOrder).toEqual(['valid']);
});

it('terminal rejects late tool success, including frames without ordering metadata', () => {
  const state = host();
  handleDirectAdapterEvent(state, { type: 'error', error: 'stopped', runId: 'run', sequence: 1, attempt: 1 });
  handleDirectAdapterEvent(state, { type: 'tool_result', toolCallId: 'late', toolName: 'query', occurredAt: 2, result: 'success', runId: 'run' });
  expect(state.toolStreamOrder).toEqual([]);
});


it('identified legacy AgentEvent adapts explicitly; progress alone never invents an execution start', () => {
  const state = host();
  handleAgentEvent(state, { runId: 'run', seq: 1, stream: 'tool', ts: 1, sessionKey: 'session', data: baseline.identifiedLegacyAgentEvent });
  expect(state.toolStreamById.get('probe-tool-1').startedAt).toBe(1);
  handleDirectAdapterEvent(state, { type: 'tool_progress', toolCallId: 'progress-only', toolName: 'query', occurredAt: 2, progress: { completed: 1, total: 2 } });
  expect(state.toolStreamById.get('progress-only').startedAt).toBeUndefined();
  resetToolStream(state);
});
