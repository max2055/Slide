import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acknowledgeMessageParts, compatibleMessageParts, migrateMessageParts, projectProviderMessages, restoreLegacyMessage } from '../message-parts.js';
import { SessionManager, Session } from '../session.js';
import { checkpointFacts } from '../runtime/checkpoint.js';
import type { Message } from '../types.js';
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const call = { id: 'call', type: 'function' as const, function: { name: 'read', arguments: '{"sql":"SELECT 1"}' } };
const legacy: Message[] = [
  { id: 'policy', role: 'system', content: 'policy <think>literal</think>' },
  { id: 'user', role: 'user', content: '' },
  { id: 'assistant', runId: 'run', turnId: 'user', role: 'assistant', content: '<think>中文 reasoning</think>\n answer', reasoning_content: 'required',
    thinking_blocks: [{ type: 'thinking', thinking: 'signed', signature: 'opaque' }, { type: 'redacted_thinking', data: 'opaque' }], tool_calls: [call] },
  { id: 'result', role: 'tool', content: 'result', tool_call_id: 'call', name: 'read' },
  { id: 'null', role: 'assistant', content: null },
];
it.each(legacy)('lossless deterministic roundtrip for $role $id', message => {
  const doc = migrateMessageParts(message);
  expect(restoreLegacyMessage(doc.messageParts)).toEqual(message);
  expect(migrateMessageParts(doc)).toEqual(doc);
  expect(doc.messageParts.parts.map(p => p.id)).toEqual(migrateMessageParts(message).messageParts.parts.map(p => p.id));
});
it('preserves tool links, opaque signatures and separate reasoning formats', () => {
  const doc = migrateMessageParts(legacy[2]).messageParts;
  expect(doc.parts.map(p => p.type)).toEqual(['reasoning', 'text', 'reasoning', 'reasoning', 'reasoning', 'tool_call']);
  expect(doc.parts.at(-1)).toMatchObject({ call });
  expect(migrateMessageParts(legacy[3]).messageParts.parts[0]).toMatchObject({ type: 'tool_result', toolCallId: call.id });
});
it('future version / malformed migration retain all legacy bytes', () => {
  const future = { ...legacy[2], messageParts: { version: 99, raw: 'future-data' } } as unknown as Message;
  expect(() => migrateMessageParts(future)).toThrow('UNSUPPORTED_MESSAGE_PARTS_VERSION');
  expect(compatibleMessageParts(future)).toEqual(future);
  expect(compatibleMessageParts({ ...legacy[2], thinking_blocks: {} as any })).toEqual({ ...legacy[2], thinking_blocks: {} });
});
it('completed requires durable evidence; failed/discarded and attempt IDs survive repeated checkpoint conversion', () => {
  expect(() => migrateMessageParts(legacy[0], { status: 'completed' })).toThrow('INVALID_PART_BOUNDARY');
  const doc = migrateMessageParts(legacy[2], { status: 'partial', attempt: 2, sourceRequestId: 'request' });
  for (const status of ['failed', 'discarded', 'completed'] as const) {
    const acknowledged = acknowledgeMessageParts(doc, { status, durable: { kind: 'checkpoint', reference: 'cp' } });
    expect(acknowledged.messageParts.parts.every(p => p.status === status && p.attempt === 2)).toBe(true);
    expect(acknowledged.messageParts.parts.map(p => p.id)).toEqual(doc.messageParts.parts.map(p => p.id));
  }
  const cp = { assistantMessage: { ...legacy[2], id: undefined }, completedToolResults: [legacy[3]], iteration: 2, stream_state_v1: { attempt: 2, sourceRequestId: 'req' } };
  const facts = checkpointFacts(cp, 'run');
  expect(facts[0].messageParts).toMatchObject({ status: 'partial', attempt: 2, sourceRequestId: 'req' });
  expect(checkpointFacts(cp, 'run')).toEqual(facts);
  const session = new Session('cp'); session.appendFacts(facts); session.appendFacts(facts);
  expect(session.messages).toHaveLength(2);
});
it('runtime notice cannot append itself as a canonical fact', () => {
  const runtime = migrateMessageParts({ id: 'runtime', source: 'runtime', role: 'user', content: 'notice' });
  expect(runtime.messageParts.parts[0].type).toBe('runtime_notice');
  const session = new Session('notice'); session.appendFacts([runtime]); expect(session.messages).toHaveLength(0);
});
it('reasoning replay is limited to the active tool turn and never alters signed blocks', () => {
  const messages = [legacy[2], legacy[1], legacy[2], legacy[3]];
  const projected = projectProviderMessages(messages, { supportsVision: false, reasoning: 'tool-turn' });
  expect(projected[0].reasoning_content).toBeUndefined();
  expect(projected[2].thinking_blocks).toEqual(legacy[2].thinking_blocks);
  expect(projected[2].reasoning_content).toBe('required');
  expect(String(projected[2].content)).not.toContain('<think>');
  expect(projectProviderMessages(messages, { supportsVision: false, reasoning: 'omit' }).every(m => !m.thinking_blocks && !m.reasoning_content)).toBe(true);
  expect(messages[0].thinking_blocks).toEqual(legacy[2].thinking_blocks);
});
const image: Message = { id: 'image', role: 'user', content: [{ type: 'text', text: 'inspect ' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' }, _meta: { bytes: 5, tokens: 4096 } }, { type: 'text', text: ' exactly' }] };
it('projects mixed images within capability/byte/token budgets and keeps original source', () => {
  const migrated = migrateMessageParts(image);
  const hash = JSON.stringify(migrated);
  const projection = projectProviderMessages([migrated], { supportsVision: true, reasoning: 'omit', budget: { maxBytes: 5, maxTokens: 4096 } });
  expect(projection[0].content).toEqual(image.content);
  expect(JSON.stringify(migrated)).toBe(hash);
  expect(restoreLegacyMessage(migrated.messageParts)).toEqual(image);
});
it.each([
  [{ supportsVision: false, reasoning: 'omit' }, image, 'ATTACHMENT_UNSUPPORTED'],
  [{ supportsVision: true, reasoning: 'omit', budget: { maxBytes: 4, maxTokens: 4096 } }, image, 'ATTACHMENT_BUDGET_EXCEEDED'],
  [{ supportsVision: true, reasoning: 'omit', budget: { maxBytes: 5, maxTokens: 4095 } }, image, 'ATTACHMENT_BUDGET_EXCEEDED'],
  [{ supportsVision: true, reasoning: 'omit' }, { id: 'file', role: 'user', content: '', attachments: [{ kind: 'file', reference: 'source-file', bytes: 3 }] }, 'ATTACHMENT_UNSUPPORTED'],
  [{ supportsVision: true, reasoning: 'omit' }, { id: 'file', role: 'user', content: 'text', attachments: [{ kind: 'file', reference: 'expired', available: false, bytes: 3 }] }, 'ATTACHMENT_SOURCE_UNAVAILABLE'],
] as const)('rejected projection preserves canonical refs (%s)', (policy, input, error) => {
  const message = migrateMessageParts(input as unknown as Message); const before = JSON.stringify(message);
  expect(() => projectProviderMessages([message], policy)).toThrow(error);
  expect(JSON.stringify(message)).toBe(before);
});
it('counts aggregate attachments and safely projects readable files', () => {
  expect(() => projectProviderMessages([image, { ...image, id: 'image2' }], { supportsVision: true, reasoning: 'omit', budget: { maxBytes: 5, maxTokens: 8192 } })).toThrow('ATTACHMENT_BUDGET_EXCEEDED');
  const file = { id: 'file', role: 'user' as const, content: 'text', attachments: [{ kind: 'file' as const, reference: 'source-file', bytes: 3, text: 'abc' }] };
  expect(projectProviderMessages([file], { supportsVision: false, reasoning: 'omit' })[0].content).toBe('textabc');
});
it('derived compacted text never revives the canonical raw content', () => {
  const original = migrateMessageParts(legacy[2]);
  expect(projectProviderMessages([{ ...original, source: 'derived', content: 'compact' }], { supportsVision: false, reasoning: 'omit' })[0].content).toBe('compact');
  expect(restoreLegacyMessage(original.messageParts)).toEqual(legacy[2]);
});
it('JSONL acknowledgement happens after rename, remains reversible and preserves failure state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'parts-')); dirs.push(dir);
  const manager = new SessionManager(dir); const session = manager.getOrCreate('history');
  session.addMessage('user', 'old'); await manager.save(session, { fsync: true });
  const path = join(dir, '.slide/sessions', manager.safeKey('history') + '.jsonl');
  const old = await readFile(path, 'utf8');
  session.addMessage('assistant', 'candidate');
  const rename = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('FAIL_RENAME'));
  await expect(manager.save(session)).rejects.toThrow('FAIL_RENAME');
  expect(session.messages.at(-1)?.messageParts?.status).toBe('partial');
  expect(await readFile(path, 'utf8')).toBe(old);
  rename.mockRestore();
  await manager.save(session);
  const loaded = new SessionManager(dir).getOrCreate('history');
  expect(loaded.messages).toEqual(session.messages);
  expect(loaded.messages.at(-1)?.messageParts?.status).toBe('completed');
  expect(restoreLegacyMessage(loaded.messages.at(-1)!.messageParts!).content).toBe('candidate');
  session.addMessage('assistant', 'cancelled-prefix', { metadata: { stopReason: 'cancelled' } });
  await manager.save(session); expect(session.messages.at(-1)?.messageParts?.status).toBe('partial');
  session.addMessage('assistant', 'failed-prefix', { metadata: { stopReason: 'error' } });
  await manager.save(session); expect(session.messages.at(-1)?.messageParts?.status).toBe('failed');
});
it('durable tool intent stays partial until its result is durable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'parts-intent-')); dirs.push(dir);
  const manager = new SessionManager(dir); const session = manager.getOrCreate('intent');
  session.addMessage('user', 'read'); session.addMessage('assistant', null, { tool_calls: [call] });
  await manager.save(session); expect(session.messages[1].messageParts?.status).toBe('partial');
  expect(new SessionManager(dir).getOrCreate('intent').messages[1].messageParts?.status).toBe('partial');
  session.addMessage('tool', 'settled', { tool_call_id: call.id });
  await manager.save(session); expect(session.messages[1].messageParts?.status).toBe('completed');
});
