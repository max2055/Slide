import { describe, expect, it } from 'vitest';
import * as projection from '../message-projection.js';
import { acknowledgeMessageParts, migrateMessageParts } from '../message-parts.js';
import type { MessagePart } from '../message-parts.js';

const text = (id: string, value = ''): MessagePart => ({ id, source: 'fact', type: 'text', text: value, status: 'partial' });
const reasoning = (id: string, value = ''): MessagePart => ({ id, source: 'fact', type: 'reasoning', format: 'reasoning_content', text: value, status: 'partial' });
const durable = { kind: 'checkpoint' as const, reference: 'anchor-1' };
const start = (part: MessagePart) => ({ type: 'part.start' as const, messageId: 'message', part });
const tool = (phase: 'running' | 'settled' | 'persisted', outcome?: 'ok' | 'unknown') => ({ type: 'tool.state' as const,
  messageId: 'message', partId: 'call/part', event: { toolCallId: 'call', name: 'query', phase, occurredAt: 1, outcome },
  ...(phase === 'persisted' ? { durable } : {}) });
function apply(state: projection.MessageProjection, operations: projection.ProjectionOperation[], attempt = state.attempt) {
  return projection.reduceMessageProjection(state, { version: 1, runId: 'run', sequence: state.sequence + 1, attempt, operations });
}

describe('one message projection for live, history and recovery', () => {
  it('keeps thinking/text/tool/text order and separates generation end from persistence', () => {
    let state = projection.createMessageProjection('run');
    state = apply(state, [start(reasoning('r')), { type: 'part.append', partId: 'r', text: 'inspect' }, { type: 'part.end', partId: 'r' },
      start(text('a')), { type: 'part.append', partId: 'a', text: 'before' }, { type: 'part.end', partId: 'a' }, tool('running'),
      tool('settled', 'ok'), start(text('b')), { type: 'part.replace', partId: 'b', text: 'after' }, { type: 'part.end', partId: 'b' }]);
    expect(state.parts.map(p => p.part.id)).toEqual(['r', 'a', 'call/part', 'b']);
    expect(state.parts.filter(p => p.part.type === 'text').map(p => p.part)).toEqual([
      expect.objectContaining({ text: 'before', status: 'partial', generation: 'ended' }),
      expect.objectContaining({ text: 'after', status: 'partial', generation: 'ended' })]);
    expect(state.parts.every(p => !p.part.durable)).toBe(true);
    state = apply(state, [tool('persisted')]);
    expect(state.parts[2].part).toMatchObject({ status: 'completed', durable, tool: { phase: 'persisted', outcome: 'ok' } });
  });

  it('drops duplicate, invalid and late mutations without poisoning the watermark', () => {
    let state = apply(projection.createMessageProjection('run'), [start(text('a')), { type: 'part.append', partId: 'a', text: 'once' }]);
    const frame = { version: 1 as const, runId: 'run', sequence: 1, attempt: 0, operations: [{ type: 'part.append' as const, partId: 'a', text: 'twice' }] };
    expect(projection.reduceMessageProjection(state, frame)).toBe(state);
    expect(projection.reduceMessageProjection(state, { ...frame, sequence: 99, operations: [{ type: 'part.append', partId: 'a', text: 4 } as any] })).toBe(state);
    state = apply(state, [{ type: 'part.end', partId: 'a' }]);
    const ended = apply(state, [{ type: 'part.replace', partId: 'a', text: 'late' }, start(text('a', 'duplicate'))]);
    expect(ended.parts).toEqual(state.parts);
    state = apply(state, [{ type: 'run.terminal', outcome: 'failed', error: 'storage failed' }]);
    expect(apply(state, [{ type: 'run.terminal', outcome: 'completed', durable }])).toBe(state);
    expect(apply(state, [start(text('late'))], 2)).toBe(state);
    expect(state.terminal).toBe('failed');
  });

  it.each(['', 'safe'])('atomically resets text/reasoning/input to anchor (%j), preserving settled tools', safe => {
    let state = apply(projection.createMessageProjection('run'), [start(text('bad', 'invalid')), start(reasoning('r', 'private tail')),
      start({ id: 'input', source: 'fact', status: 'partial', type: 'tool_input', toolCallId: 'unexecuted', text: '{"sql":' }), tool('running'), tool('settled', 'unknown')]);
    const anchor = { id: 'anchor', parts: safe ? [{ messageId: 'message', part: { ...text('safe', safe), generation: 'ended' as const, durable } }] : [] };
    state = apply(state, [{ type: 'stream.reset', anchor }], 1);
    expect(state.parts.map(p => p.part.id)).toEqual(safe ? ['call/part', 'safe'] : ['call/part']);
    const reset = apply(state, [{ type: 'stream.reset', anchor }], 1);
    expect(reset.parts).toEqual(state.parts);
    expect(reset.parts[0].part).toMatchObject({ tool: { phase: 'settled', outcome: 'unknown' } });
  });

  it('never accepts completed/persisted claims without storage evidence', () => {
    const state = projection.createMessageProjection('run');
    expect(apply(state, [start({ ...text('a'), status: 'completed' })])).toBe(state);
    expect(apply(state, [{ ...tool('persisted'), durable: undefined }])).toBe(state);
    expect(apply(state, [{ type: 'run.terminal', outcome: 'completed' }])).toBe(state);
  });

  it('live suffix and snapshot recovery equal hydration of the same persisted facts', () => {
    let live = apply(projection.createMessageProjection('run'), [start(reasoning('r', 'inspect')), { type: 'part.end', partId: 'r' },
      start(text('a', 'answer')), { type: 'part.end', partId: 'a' }, tool('running'), tool('settled', 'ok')]);
    const snapshot = structuredClone(live);
    const doc = migrateMessageParts({ id: 'message', runId: 'run', role: 'assistant', content: 'answer' }).messageParts;
    doc.parts = live.parts.map(p => p.part);
    const acknowledged = acknowledgeMessageParts({ ...doc.legacy, id: 'message', role: 'assistant', content: 'answer', messageParts: doc } as any,
      { status: 'completed', durable }).messageParts;
    const operations: projection.ProjectionOperation[] = [{ type: 'parts.persisted', documents: [acknowledged] }, { type: 'run.terminal', outcome: 'completed', durable }];
    live = apply(live, operations);
    const restored = apply(projection.restoreMessageProjection(snapshot), operations);
    const history = projection.hydrateMessageProjection('run', [acknowledged]);
    expect(restored).toEqual(live);
    expect(history.parts).toEqual(live.parts);
    expect(live.parts.every(p => p.part.status === 'completed' && p.part.durable)).toBe(true);
  });

  it('protects durable facts against regressive reset/snapshot and wrong-run facts', () => {
    const doc = migrateMessageParts({ id: 'm', runId: 'run', role: 'assistant', content: 'committed' }, { status: 'completed', durable }).messageParts;
    const state = projection.hydrateMessageProjection('run', [doc]);
    const reset = apply(state, [{ type: 'stream.reset', anchor: { id: 'old', parts: [] } }], 1);
    expect(reset.parts).toEqual(state.parts);
    expect(apply(reset, [{ type: 'parts.persisted', documents: [{ ...doc, runId: 'other' }] }])).toBe(reset);
  });
});
