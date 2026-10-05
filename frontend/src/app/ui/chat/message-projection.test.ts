import { expect, it } from 'vitest';
import { handleDirectAdapterEvent } from '../direct-gateway.ts';
import { getChatProjection, hydrateChatProjections } from './message-projection.ts';
import { migrateMessageParts } from '../../../../../packages/agent-core/src/message-parts.ts';

function host() {
  return { sessionKey: 'session', chatRunId: 'run', chatStream: '', chatStreamStartedAt: 1, chatThinkingText: '', chatThinkingComplete: false,
    chatToolMessages: [], chatStreamSegments: [], toolStreamById: new Map(), toolStreamOrder: [], toolStreamSyncTimer: null,
    chatMessages: [], chatQueue: [], chatSending: false, lastError: null };
}
it('consumes native projection exactly once and atomically resets speculative state while retaining tool settlement', () => {
  const state = host();
  const part = { id: 'text', type: 'text', text: 'before', source: 'fact', status: 'partial' };
  const frame = (sequence: number, operations: unknown[]) => handleDirectAdapterEvent(state, { type: 'message_parts', runId: 'run', sessionKey: 'session',
    projection: { version: 1, runId: 'run', attempt: 1, sequence, operations } } as any);
  frame(1, [{ type: 'part.start', messageId: 'm', part },
    { type: 'tool.state', messageId: 'm', partId: 'call-part', event: { toolCallId: 'call', name: 'query', phase: 'settled', outcome: 'ok', occurredAt: 2, preview: { kind: 'text', text: 'ok', truncated: false } } },
    { type: 'part.start', messageId: 'm', part: { id: 'reasoning', type: 'reasoning', text: 'invalid', format: 'reasoning_content', source: 'fact', status: 'partial' } }]);
  expect(state.chatToolMessages).toHaveLength(1);
  expect(state.chatStreamSegments).toHaveLength(1);
  frame(2, [{ type: 'stream.reset', anchor: { id: 'empty', parts: [] } }]);
  expect(state.chatStream).toBe('');
  expect(state.chatThinkingText).toBe('');
  expect(state.chatStreamSegments).toEqual([]);
  expect(state.chatToolMessages).toHaveLength(1);
  frame(2, [{ type: 'part.start', messageId: 'm', part: { ...part, id: 'duplicate' } }]);
  expect(getChatProjection(state)?.parts.map(p => p.part.id)).toEqual(['call-part']);
});
it('history hydration replaces the session projection and blocks stale prior-session frames', () => {
  const state = host();
  const doc = migrateMessageParts({ id: 'fact', runId: 'run', role: 'assistant', content: 'saved' }, { status: 'completed', durable: { kind: 'mysql', reference: 'fact' } }).messageParts;
  hydrateChatProjections(state, [{ id: 'fact', role: 'assistant', messageParts: doc }]);
  expect(getChatProjection(state, 'run')?.parts[0].part).toMatchObject({ type: 'text', text: 'saved', status: 'completed' });
  state.sessionKey = 'other';
  handleDirectAdapterEvent(state, { type: 'message_parts', runId: 'run', sessionKey: 'session',
    projection: { version: 1, runId: 'run', sequence: 9, attempt: 1, operations: [] } } as any);
  expect(getChatProjection(state, 'run')).toBeUndefined();
});
