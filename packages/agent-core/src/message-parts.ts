import type { ContentBlock, Message, ToolCall } from './types.js';

export type PartStatus = 'partial' | 'failed' | 'discarded' | 'completed';
export interface PartBoundary {
  status: PartStatus;
  /** Evidence is assigned by storage, never by response_ready or a stream callback. */
  durable?: { kind: 'jsonl' | 'mysql' | 'checkpoint'; reference: string };
  attempt?: number;
  sourceRequestId?: string;
}
interface PartBase extends PartBoundary {
  id: string;
  source: Message['source'];
  /** Model generation is independent of storage acknowledgement. */
  generation?: 'open' | 'ended';
  tool?: import('./tool-stream.js').NormalizedToolEvent;
}
export type MessagePart = PartBase & (
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text?: string; block?: unknown; format: 'think' | 'reasoning_content' | 'thinking_block' }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_input'; toolCallId: string; text: string; name?: string }
  | { type: 'tool_result'; toolCallId: string; content: Message['content']; name?: string }
  | { type: 'attachment'; attachment: AttachmentSource }
  | { type: 'runtime_notice'; text: string }
);
export interface AttachmentSource {
  /** Original reference retained even when a projection is rejected. */
  reference: string;
  kind: 'image' | 'file';
  mimeType?: string;
  bytes?: number;
  tokens?: number;
  available?: boolean;
  text?: string;
}
export interface MessageParts extends PartBoundary {
  version: 1;
  id: string;
  role: Message['role'];
  runId?: string;
  turnId?: string;
  source: Message['source'];
  /** Original generating message ID when storage uses a stable completion key. */
  projectionMessageId?: string;
  parts: MessagePart[];
  /** Exact rollback projection, including null/empty content and unknown legacy fields. */
  legacy: Omit<Message, 'messageParts'> & Record<string, unknown>;
}
export type LegacyPartMessage = Message & { attachments?: AttachmentSource[] };

export function statusForStopReason(stop: unknown): PartStatus {
  if (stop === 'failed' || stop === 'error') return 'failed';
  if (stop === 'discarded') return 'discarded';
  return stop && stop !== 'completed' ? 'partial' : 'completed';
}

export function hasMessageAttachments(messages: Message[]): boolean {
  return messages.some(m => !!m.attachments?.length || !!m.messageParts?.parts?.some(p => p.type === 'attachment')
    || (Array.isArray(m.content) && m.content.some(b => b.type === 'image_url')));
}

function validateBoundary(boundary: PartBoundary): void {
  if (!['partial', 'failed', 'discarded', 'completed'].includes(boundary.status)
    || (boundary.status === 'completed' && !boundary.durable)
    || (boundary.durable && (!['jsonl', 'mysql', 'checkpoint'].includes(boundary.durable.kind) || !boundary.durable.reference))
    || (boundary.attempt !== undefined && (!Number.isSafeInteger(boundary.attempt) || boundary.attempt < 0))) {
    throw new Error('INVALID_PART_BOUNDARY');
  }
}

export function readMessageParts(value: unknown): MessageParts {
  const doc = value as MessageParts;
  if (!doc || doc.version !== 1) throw new Error('UNSUPPORTED_MESSAGE_PARTS_VERSION');
  validateBoundary(doc);
  if (!doc.id || !['system', 'user', 'assistant', 'tool'].includes(doc.role) || !Array.isArray(doc.parts) || !doc.legacy) throw new Error('INVALID_MESSAGE_PARTS');
  const ids = new Set<string>();
  for (const part of doc.parts) {
    validateBoundary(part);
    if (!part.id || ids.has(part.id) || !['text', 'reasoning', 'tool_call', 'tool_input', 'tool_result', 'attachment', 'runtime_notice'].includes(part.type)) throw new Error('INVALID_MESSAGE_PARTS');
    ids.add(part.id);
    if ((part.type === 'text' || part.type === 'runtime_notice') && typeof part.text !== 'string') throw new Error('INVALID_MESSAGE_PARTS');
    if (part.type === 'tool_call' && (!part.call?.id || typeof part.call.function?.arguments !== 'string' || typeof part.call.function.name !== 'string')) throw new Error('INVALID_MESSAGE_PARTS');
    if (part.type === 'tool_input' && (!part.toolCallId || typeof part.text !== 'string')) throw new Error('INVALID_MESSAGE_PARTS');
    if (part.generation !== undefined && !['open', 'ended'].includes(part.generation)) throw new Error('INVALID_MESSAGE_PARTS');
    if (part.type === 'tool_result' && typeof part.toolCallId !== 'string') throw new Error('INVALID_MESSAGE_PARTS');
    if (part.type === 'attachment' && (!part.attachment || typeof part.attachment.reference !== 'string' || !['image', 'file'].includes(part.attachment.kind))) throw new Error('INVALID_MESSAGE_PARTS');
  }
  return doc;
}

/** Pure, deterministic and idempotent; storage remains responsible for assigning C1 IDs. */
export function migrateMessageParts<T extends Message>(message: T, boundary: PartBoundary = { status: 'partial' }): T & { messageParts: MessageParts } {
  if (message.messageParts !== undefined) {
    const doc = readMessageParts(message.messageParts);
    if (doc.id !== message.id || doc.role !== message.role) throw new Error('MESSAGE_PARTS_ID_MISMATCH');
    return structuredClone(message) as T & { messageParts: MessageParts };
  }
  validateBoundary(boundary);
  if (!message.id) throw new Error('MESSAGE_PARTS_ID_REQUIRED');
  const legacy = structuredClone(message) as MessageParts['legacy'];
  const source = message.source ?? 'fact';
  const parts: MessagePart[] = [];
  type Payload<T> = T extends unknown ? Omit<T, keyof PartBase> : never;
  const add = (part: Payload<MessagePart>) => parts.push({ ...part, ...structuredClone(boundary), source, id: `${message.id}/part/${parts.length}` } as MessagePart);
  const text = (value: string) => {
    if (source === 'runtime') { add({ type: 'runtime_notice', text: value }); return; }
    if (message.role !== 'assistant') { add({ type: 'text', text: value }); return; }
    const pattern = /<think>([\s\S]*?)<\/think>/g;
    let start = 0;
    for (const match of value.matchAll(pattern)) {
      if (match.index! > start) add({ type: 'text', text: value.slice(start, match.index) });
      add({ type: 'reasoning', text: match[1], format: 'think' });
      start = match.index! + match[0].length;
    }
    if (start < value.length || value === '') add({ type: 'text', text: value.slice(start) });
  };
  if (message.role === 'tool') add({ type: 'tool_result', toolCallId: message.tool_call_id ?? '', content: structuredClone(message.content), name: message.name });
  else if (typeof message.content === 'string') text(message.content);
  else if (Array.isArray(message.content)) for (const block of message.content) {
    if (block.type === 'text') text(block.text);
    else if (block.type === 'image_url') add({ type: 'attachment', attachment: { ...block._meta, reference: block.image_url.url, kind: 'image' } });
    else throw new Error('UNSUPPORTED_LEGACY_CONTENT_BLOCK');
  }
  if (message.reasoning_content !== undefined && message.reasoning_content !== null) add({ type: 'reasoning', text: message.reasoning_content, format: 'reasoning_content' });
  const extra = (message as Message & { _extra?: { reasoning_content?: string; thinking_blocks?: unknown[] } })._extra;
  if (message.reasoning_content === undefined && typeof extra?.reasoning_content === 'string') add({ type: 'reasoning', text: extra.reasoning_content, format: 'reasoning_content' });
  for (const block of message.thinking_blocks ?? []) add({ type: 'reasoning', block: structuredClone(block), format: 'thinking_block' });
  if (!message.thinking_blocks) for (const block of extra?.thinking_blocks ?? []) add({ type: 'reasoning', block: structuredClone(block), format: 'thinking_block' });
  for (const call of message.tool_calls ?? []) add({ type: 'tool_call', call: structuredClone(call) });
  for (const attachment of (message as LegacyPartMessage).attachments ?? []) add({ type: 'attachment', attachment: structuredClone(attachment) });
  const messageParts: MessageParts = { version: 1, id: message.id, role: message.role, runId: message.runId, turnId: message.turnId, source, ...structuredClone(boundary), parts, legacy };
  readMessageParts(messageParts);
  return { ...structuredClone(message), messageParts };
}

export function restoreLegacyMessage(document: MessageParts): Message {
  return structuredClone(readMessageParts(document).legacy);
}

/** Only the successful persistence owner may promote a candidate. */
export function acknowledgeMessageParts<T extends Message>(message: T, boundary: PartBoundary): T & { messageParts: MessageParts } {
  validateBoundary(boundary);
  const result = migrateMessageParts(message);
  result.messageParts = { ...result.messageParts, ...structuredClone(boundary), parts: result.messageParts.parts.map(part => ({ ...part, ...structuredClone(boundary) })) };
  return result;
}

/** Unknown/invalid parts retain the original reader projection; never repair by deleting facts. */
export function compatibleMessageParts<T extends Message>(message: T, boundary?: PartBoundary): T {
  try { return migrateMessageParts(message, boundary); }
  catch { return structuredClone(message); }
}

export interface AttachmentBudget { maxBytes: number; maxTokens: number; }
export interface ProviderPartPolicy {
  supportsVision: boolean;
  reasoning: 'omit' | 'tool-turn';
  budget?: AttachmentBudget;
}
export class AttachmentProjectionError extends Error {
  constructor(public readonly code: 'ATTACHMENT_UNSUPPORTED' | 'ATTACHMENT_BUDGET_EXCEEDED' | 'ATTACHMENT_SOURCE_UNAVAILABLE') { super(code); }
}

/** No fetches, logs or tool execution. Rejecting a projection never changes the source. */
export function projectProviderMessages(messages: Message[], policy: ProviderPartPolicy): Message[] {
  const budget = policy.budget ?? { maxBytes: 8 * 1024 * 1024, maxTokens: 8192 };
  if (![budget.maxBytes, budget.maxTokens].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('INVALID_ATTACHMENT_BUDGET');
  let bytes = 0; let tokens = 0;
  let lastUser = -1;
  messages.forEach((m, i) => { if (m.role === 'user' && (!m.source || m.source === 'fact')) lastUser = i; });
  return messages.map((original, index) => {
    const message = migrateMessageParts({ ...original, id: original.id ?? `projection_${index}` });
    const doc = readMessageParts(message.messageParts);
    const projected = structuredClone(original);
    delete projected.messageParts;
    // Model compaction may change text on a derived copy; never resurrect its raw text.
    const derivedText = original.source === 'derived' && JSON.stringify(original.content) !== JSON.stringify(doc.legacy.content);
    const blocks: ContentBlock[] = [];
    let hasAttachment = false;
    for (const part of doc.parts) {
      if (part.status === 'discarded' || part.status === 'failed') continue;
      if (!derivedText && (part.type === 'text' || part.type === 'runtime_notice')) blocks.push({ type: 'text', text: part.text });
      if (part.type !== 'attachment') continue;
      if (doc.role !== 'user') throw new AttachmentProjectionError('ATTACHMENT_UNSUPPORTED');
      const a = part.attachment;
      if (a.available === false || !a.reference) throw new AttachmentProjectionError('ATTACHMENT_SOURCE_UNAVAILABLE');
      const data = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(a.reference);
      if (a.reference.startsWith('data:') && !data) throw new AttachmentProjectionError('ATTACHMENT_SOURCE_UNAVAILABLE');
      const encoded = data?.[2].replace(/\s/g, '');
      const decodedSize = encoded ? Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0) : undefined;
      const size = data ? Math.max(a.bytes ?? 0, decodedSize ?? 0) : a.bytes;
      const cost = a.tokens ?? (a.kind === 'image' ? 4096 : new TextEncoder().encode(a.text ?? '').length);
      if (size === undefined || !Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(cost) || cost < 0) throw new AttachmentProjectionError('ATTACHMENT_BUDGET_EXCEEDED');
      bytes += size; tokens += cost;
      if (bytes > budget.maxBytes || tokens > budget.maxTokens) throw new AttachmentProjectionError('ATTACHMENT_BUDGET_EXCEEDED');
      if (a.kind === 'image') {
        if (!policy.supportsVision || (data && !/^image\/(png|jpeg|gif|webp)$/.test(data[1]))) throw new AttachmentProjectionError('ATTACHMENT_UNSUPPORTED');
        if (!data && !/^https:\/\//.test(a.reference)) throw new AttachmentProjectionError('ATTACHMENT_SOURCE_UNAVAILABLE');
        hasAttachment = true;
        blocks.push({ type: 'image_url', image_url: { url: a.reference }, _meta: { bytes: size, tokens: cost } });
      } else {
        if (a.text === undefined) throw new AttachmentProjectionError('ATTACHMENT_UNSUPPORTED');
        blocks.push({ type: 'text', text: a.text });
      }
    }
    if (derivedText && typeof original.content === 'string') blocks.unshift({ type: 'text', text: original.content });
    if (doc.role !== 'tool') projected.content = hasAttachment ? blocks : doc.legacy.content === null && blocks.length === 0 ? null : blocks.map(b => b.type === 'text' ? b.text : '').join('');
    const replay = policy.reasoning === 'tool-turn' && index > lastUser && original.role === 'assistant' && !!original.tool_calls?.length;
    if (!replay) { delete projected.reasoning_content; delete projected.thinking_blocks; }
    // Protocol extras only: old wrappers must not bypass the reasoning lifecycle.
    const extra = (projected as any)._extra;
    if (extra && !replay) { delete extra.reasoning_content; delete extra.thinking_blocks; }
    return projected;
  });
}
