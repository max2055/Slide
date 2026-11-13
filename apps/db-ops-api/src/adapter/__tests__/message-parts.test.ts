import { expect, it } from 'vitest';
import { persistedMessageParts, recordMessageParts } from '../message-parts.js';
import type { PartStatus, SessionEntry } from '@slide/agent-core';

it.each<PartStatus>(['partial', 'completed', 'failed', 'discarded'])('MAX-471 preserves validated %s history without writing or changing part boundaries', status => {
  const entry = persistedMessageParts({ id: 'history', role: 'assistant', content: 'stored text' } as SessionEntry, 'mysql', status);
  const row = { message_id: entry.id!, role: entry.role, content: entry.content as string, metadata: { messageParts: entry.messageParts, stopReason: 'completed' } };
  const before = structuredClone(row);
  expect(recordMessageParts({ ...row, metadata: { messageParts: entry.messageParts } }).messageParts).toEqual(entry.messageParts);
  expect(recordMessageParts(row).messageParts).toEqual(entry.messageParts);
  expect(recordMessageParts({ ...row, metadata: JSON.stringify(row.metadata) }).messageParts).toEqual(entry.messageParts);
  expect(row).toEqual(before);
});

it.each([['cancelled', 'partial'], ['timed_out', 'partial'], ['failed', 'failed'], ['discarded', 'discarded'], [undefined, 'completed']])('MAX-471 derives missing legacy status from %s', (stopReason, status) => {
  const row = { message_id: 'legacy', role: 'assistant' as const, content: 'old text', metadata: { stopReason } };
  expect(recordMessageParts(row).messageParts).toMatchObject({ status, legacy: { content: 'old text' } });
});

it('MAX-471 validates documents before trusting status and retains old text for malformed documents', () => {
  const entry = persistedMessageParts({ id: 'history', role: 'assistant', content: 'stored text' } as SessionEntry, 'mysql', 'partial');
  const doc = { ...entry.messageParts!, parts: [{ id: 'bad', type: 'text', text: 42 }] };
  expect(recordMessageParts({ message_id: 'history', role: 'assistant', content: 'stored text', metadata: { messageParts: doc } }).messageParts)
    .toMatchObject({ status: 'completed', legacy: { content: 'stored text' } });
});
