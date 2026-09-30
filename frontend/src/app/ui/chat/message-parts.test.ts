import { expect, it } from 'vitest';
import { migrateMessageParts } from '../../../../../packages/agent-core/src/message-parts.ts';
import { normalizeMessage } from './message-normalizer.ts';
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
  const rest = { id: 'rest', role: 'assistant', content: [{ type: 'thinking', thinking: 'analysis' }, { type: 'text', text: 'answer' }] };
  expect(normalizeMessage({ ...rest, messageParts: doc })).toEqual(normalizeMessage(rest));
});
it('mixed image/text keeps both canonical sources visible', () => {
  const message = migrateMessageParts({ id: 'image', role: 'user', content: [{ type: 'text', text: 'inspect' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] });
  expect(normalizeMessage(message).content).toEqual([{ type: 'text', text: 'inspect' },
    { type: 'attachment', attachment: { url: 'data:image/png;base64,aGVsbG8=', kind: 'image', label: '图片附件' } }]);
});
