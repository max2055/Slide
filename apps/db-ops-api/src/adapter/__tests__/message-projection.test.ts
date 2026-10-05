import { expect, it } from 'vitest';
import { AdapterMessageProjection } from '../message-projection.js';
import { persistedMessageParts, recordMessageParts } from '../message-parts.js';
import { createMessageProjection, reduceMessageProjection, hydrateMessageProjection } from '@slide/agent-core/message-projection';

it('normalizes an interleaved live run, persists source identities, then hydrates identical parts', () => {
  const adapter = new AdapterMessageProjection('run');
  adapter.begin('model-message');
  let seq = 0;
  const consume = (event: any) => adapter.observe(event, 1, ++seq);
  consume({ type: 'thinking_delta', delta: 'inspect' });
  consume({ type: 'thinking_end' });
  consume({ type: 'text_delta', delta: 'before', partId: 'text/1', partText: 'before' });
  consume({ type: 'tool_start', toolCallId: 'call', toolName: 'query', args: {}, occurredAt: 1 });
  consume({ type: 'tool_result', toolCallId: 'call', toolName: 'query', result: 'result', occurredAt: 2 });
  consume({ type: 'text_delta', delta: 'beforeafter', partId: 'text/2', partText: 'after' });
  const candidate = adapter.document('model-message', { id: 'stored-message', role: 'assistant', content: 'beforeafter' });
  const fact = persistedMessageParts({ ...candidate.legacy, messageParts: candidate } as any);
  const frame = consume({ type: 'message_parts', operations: [{ type: 'parts.persisted', documents: [fact.messageParts] }] });
  const live = adapter.state;
  expect(live.parts.map(p => p.part.type)).toEqual(['reasoning', 'text', 'tool_call', 'text']);
  expect(hydrateMessageProjection('run', [fact.messageParts!]).parts).toEqual(live.parts);
  const replay = reduceMessageProjection(createMessageProjection('run'), { ...frame, operations: [{ type: 'stream.snapshot', snapshot: live }] });
  expect(replay.parts).toEqual(live.parts);
  expect(fact.messageParts?.projectionMessageId).toBe('model-message');
});

it('reset removes input and thinking together while keeping a committed tool', () => {
  const adapter = new AdapterMessageProjection('run'); adapter.begin('model-message');
  adapter.observe({ type: 'tool_start', toolCallId: 'call', toolName: 'query', args: {}, occurredAt: 1 }, 1, 1);
  adapter.observe({ type: 'tool_result', toolCallId: 'call', toolName: 'query', result: 'ok', occurredAt: 2 }, 1, 2);
  adapter.observe({ type: 'thinking_delta', delta: 'invalid' }, 1, 3);
  adapter.observe({ type: 'message_parts', operations: adapter.input({ id: 'new', function: { name: 'query', arguments: '{' } }) }, 1, 4);
  expect(adapter.state.parts.some(p => p.part.type === 'tool_input')).toBe(true);
  adapter.observe({ type: 'text_delta', delta: '', reset: true, thinkingContent: '' }, 2, 5);
  expect(adapter.state.parts.map(p => p.part.type)).toEqual(['tool_call']);
});

it('corrupt metadata cannot override the stored identity/content or be acknowledged', () => {
  const wrong = { version: 1, id: 'other', role: 'assistant', status: 'partial', parts: [], legacy: { content: 'injected' } };
  const entry = recordMessageParts({ message_id: 'stored', role: 'assistant', content: 'actual', metadata: { messageParts: wrong } });
  expect(entry.messageParts?.id).toBe('stored');
  expect(entry.messageParts?.legacy.content).toBe('actual');
});
it('final persistence retains earlier checkpoint-only continuation parts with original message IDs', () => {
  const adapter = new AdapterMessageProjection('run'); adapter.begin('first');
  adapter.observe({ type: 'text_delta', delta: 'prefix', partId: 'first/text', partText: 'prefix' }, 1, 1);
  adapter.state.parts[0].part.durable = { kind: 'checkpoint', reference: 'continuation-anchor' };
  adapter.begin('second');
  adapter.observe({ type: 'text_delta', delta: 'prefixsuffix', partId: 'second/text', partText: 'suffix' }, 2, 2);
  const doc = adapter.finalDocument({ id: 'stored', role: 'assistant', content: 'prefixsuffix' });
  expect(doc.parts.map(p => p.id)).toEqual(['first/text', 'second/text']);
  expect(doc.parts.map(p => p.sourceMessageId)).toEqual(['first', 'second']);
});
