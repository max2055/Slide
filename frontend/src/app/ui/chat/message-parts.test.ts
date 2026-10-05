import { expect, it } from 'vitest';
import { migrateMessageParts } from '../../../../../packages/agent-core/src/message-parts.ts';
import { messagePartsRenderRows, messagePartsToolOutputs, normalizeMessage } from './message-normalizer.ts';
import { extractThinking, extractText } from './message-extract.ts';
it.each(['system', 'user', 'assistant', 'tool'] as const)('parts/old frontend agree for %s', role => {
  const message = { id: role, role, content: role === 'assistant' ? '<think>analysis</think>\nanswer' : 'text', timestamp: 1 };
  expect(normalizeMessage(migrateMessageParts(message))).toEqual(normalizeMessage(message));
});
it('future/malformed document uses readable old fields', () => {
  const message = { id: 'legacy', role: 'user', content: 'safe legacy' };
  expect(normalizeMessage({ ...message, messageParts: { version: 9 } }).content).toEqual(normalizeMessage(message).content);
});
it('REST thinking/text projection is preserved when the rollback snapshot contains think tags', () => {
  const doc = migrateMessageParts({ id: 'rest', role: 'assistant', content: '<think>analysis</think>answer' }).messageParts;
  const rest = { id: 'rest', role: 'assistant', timestamp: 1, content: [{ type: 'thinking', thinking: 'analysis' }, { type: 'text', text: 'answer' }] };
  expect(normalizeMessage({ ...rest, messageParts: doc })).toEqual(normalizeMessage(rest));
});
it('mixed image/text keeps both canonical sources visible', () => {
  const message = migrateMessageParts({ id: 'image', role: 'user', content: [{ type: 'text', text: 'inspect' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] });
  expect(normalizeMessage(message).content).toEqual([{ type: 'text', text: 'inspect' },
    { type: 'attachment', attachment: { url: 'data:image/png;base64,aGVsbG8=', kind: 'image', label: '图片附件' } }]);
});
it('ordered parts render the same projection even when legacy content is only a rollback copy', () => {
  const message = migrateMessageParts({ id: 'ordered', role: 'assistant', content: 'old text' });
  message.messageParts.parts = [
    { id: 'r', source: 'fact', type: 'reasoning', status: 'partial', text: 'inspect', format: 'reasoning_content' },
    { id: 't', source: 'fact', type: 'text', status: 'partial', text: 'current' },
  ];
  expect(normalizeMessage(message).content).toEqual([{ type: 'thinking', thinking: 'inspect' }, { type: 'text', text: 'current' }]);
  expect(extractThinking(message)).toBe('inspect');
  expect(extractText(message)).toBe('current');
});

it('history rows preserve text/tool/text order and lifecycle using source part IDs', () => {
  const message = migrateMessageParts({ id: 'stored', role: 'assistant', content: 'rollback' });
  message.messageParts.projectionMessageId = 'model';
  message.messageParts.parts = [
    { id: 'before', source: 'fact', type: 'text', status: 'partial', text: 'before' },
    { id: 'tool', source: 'fact', type: 'tool_call', status: 'partial', call: { id: 'real-call', type: 'function', function: { name: 'query', arguments: '{}' } },
      tool: { toolCallId: 'real-call', name: 'query', phase: 'settled', outcome: 'ok', occurredAt: 1, preview: { kind: 'text', text: 'ok', truncated: false } } },
    { id: 'after', source: 'fact', type: 'text', status: 'partial', text: 'after' },
  ];
  const rows = messagePartsRenderRows(message)!;
  expect(rows.map(row => row.partId)).toEqual(['before', 'tool', 'after']);
  expect(rows.map(row => normalizeMessage(row.message).role)).toEqual(['assistant', 'toolResult', 'assistant']);
  expect(rows[1].message).toMatchObject({ toolCallId: 'real-call', toolPhase: 'settled', toolOutcome: 'ok' });
  expect(message.messageParts.parts).toHaveLength(3);
  message.messageParts.runId = 'run';
  const result = migrateMessageParts({ id: 'result', runId: 'run', role: 'tool', content: 'ok', tool_call_id: 'real-call' });
  const outputs = messagePartsToolOutputs([message, result]);
  expect(messagePartsRenderRows(result, outputs)).toEqual([]);
  result.messageParts.runId = 'other-run';
  expect(messagePartsRenderRows(result, outputs)).toBeNull();
});

it.each([
  ['第一段。', '第二段。'],
  ['```sql\nSELECT ', '1;\n```'],
])('continuation parts preserve exact answer bytes and one Markdown row: %s', (first, second) => {
  const message = migrateMessageParts({ id: 'continued', role: 'assistant', content: first + second });
  message.messageParts.projectionMessageId = 'model-first';
  message.messageParts.parts = [
    { id: 'first-text', sourceMessageId: 'model-first', source: 'fact', type: 'text', status: 'partial', generation: 'ended', text: first },
    { id: 'second-text', sourceMessageId: 'model-second', source: 'fact', type: 'text', status: 'partial', generation: 'ended', text: second },
  ];
  const original = structuredClone(message);
  expect(extractText(message)).toBe(first + second);
  expect(normalizeMessage(message).content).toEqual([{ type: 'text', text: first + second }]);
  const rows = messagePartsRenderRows(message)!;
  expect(rows).toHaveLength(1);
  expect(rows[0].partId).toBe('first-text');
  expect(extractText(rows[0].message)).toBe(first + second);
  expect(rows[0].message.messageParts).toMatchObject({ parts: original.messageParts.parts });
  expect(message).toEqual(original);
});

it('reasoning remains a boundary between text runs', () => {
  const message = migrateMessageParts({ id: 'reasoned', role: 'assistant', content: 'rollback' });
  message.messageParts.projectionMessageId = 'model';
  message.messageParts.parts = [
    { id: 'before', source: 'fact', type: 'text', status: 'partial', text: 'before' },
    { id: 'thinking', source: 'fact', type: 'reasoning', status: 'partial', text: 'inspect', format: 'reasoning_content' },
    { id: 'after', source: 'fact', type: 'text', status: 'partial', text: 'after' },
    { id: 'continued', source: 'fact', type: 'text', status: 'partial', text: ' continuation' },
  ];
  const rows = messagePartsRenderRows(message)!;
  expect(rows.map(row => row.partId)).toEqual(['before', 'thinking', 'after']);
  expect(rows.map(row => extractText(row.message))).toEqual(['before', null, 'after continuation']);
  expect(extractThinking(rows[1].message)).toBe('inspect');
});
