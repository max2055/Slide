import { createHash } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import type { Message, ToolSchema, LLMProvider } from './types.js';

export type TokenMethod = 'exact' | 'family-tokenizer' | 'conservative-heuristic';
/** Context estimates are never provider usage or settlement. tokens includes margin. */
export interface PromptTokenEstimate {
  tokens: number;
  rawTokens: number;
  method: TokenMethod;
  model: string;
  version: string;
  margin: { ratio: number; fixedTokens: number; floorTokens: number };
  fallbackReason?: string;
}
export const TOKEN_ESTIMATOR_VERSION = 'utf8-upper-bound/v1';
export const FAMILY_TOKENIZER_VERSION = 'js-tiktoken/1.0.21;serialized-payload/v1';

export function hasMedia(messages: Message[]): boolean {
  return messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type !== 'text'));
}
/** Retain metadata too: it can only increase this conservative budget. */
export function tokenPayload(messages: Message[], tools: unknown[]): string {
  return JSON.stringify({ messages: messages.map(({ messageParts: _parts, ...message }) => message), tools });
}
export function conservativePromptEstimate(messages: Message[], tools: unknown[], model = 'unknown', fallbackReason?: string): PromptTokenEstimate {
  let rawTokens = 32 + Buffer.byteLength(JSON.stringify(tools), 'utf8');
  for (const message of messages) {
    // Parts/rollback snapshots are local persistence fields, never provider payload.
    const { messageParts: _parts, ...payload } = message;
    rawTokens += 16 + Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (Array.isArray(message.content)) rawTokens += message.content.filter(b => b.type === 'image_url').length * 4096;
  }
  return { tokens: rawTokens, rawTokens, method: 'conservative-heuristic', model, version: TOKEN_ESTIMATOR_VERSION,
    margin: { ratio: 0, fixedTokens: 0, floorTokens: rawTokens }, ...(fallbackReason ? { fallbackReason } : {}) };
}
export function conservativeTextTokens(text: string | null): number {
  return text ? Buffer.byteLength(text, 'utf8') : 0;
}
function validEstimate(value: PromptTokenEstimate, model: string): boolean {
  return value.model === model && ['exact', 'family-tokenizer'].includes(value.method) &&
    typeof value.version === 'string' && value.version.length > 0 && value.version.length <= 256 &&
    Number.isSafeInteger(value.tokens) && value.tokens >= 0 &&
    Number.isSafeInteger(value.rawTokens) && value.rawTokens >= 0 &&
    !!value.margin && Number.isFinite(value.margin.ratio) && value.margin.ratio >= 0 &&
    Number.isSafeInteger(value.margin.fixedTokens) && value.margin.fixedTokens >= 0 &&
    Number.isSafeInteger(value.margin.floorTokens) && value.margin.floorTokens >= 0 &&
    value.tokens >= Math.max(value.margin.floorTokens, Math.ceil(value.rawTokens * (1 + value.margin.ratio)) + value.margin.fixedTokens);
}
/** A method's existence is not evidence that this particular request was counted. */
export function estimateWithProvider(messages: Message[], tools: ToolSchema[], model: string, provider?: LLMProvider): PromptTokenEstimate {
  const fallback = (reason: string) => conservativePromptEstimate(messages, tools, model, reason);
  if (hasMedia(messages)) return fallback('MEDIA_UNCALIBRATED');
  if (!provider?.countPromptTokens) return fallback('TOKENIZER_UNAVAILABLE');
  try {
    const value = provider.countPromptTokens(messages, tools, model);
    if (value === undefined) return fallback('TOKENIZER_UNSUPPORTED');
    if (typeof value === 'number') {
      // Old providers promised exact counting for their default model only.
      if (!Number.isSafeInteger(value) || value < 0 || (value === 0 && (messages.length > 0 || tools.length > 0))) return fallback('TOKENIZER_INVALID');
      if (model !== provider.getDefaultModel()) return fallback('TOKENIZER_MODEL_MISMATCH');
      return { tokens: value, rawTokens: value, method: 'exact', model, version: 'legacy-provider-counter/v1',
        margin: { ratio: 0, fixedTokens: 0, floorTokens: 0 } };
    }
    if (!validEstimate(value, model) || (value.tokens === 0 && (messages.length > 0 || tools.length > 0))) return fallback('TOKENIZER_INVALID');
    const result = structuredClone(value);
    if (result.method === 'family-tokenizer') {
      result.margin.floorTokens = Math.max(result.margin.floorTokens, fallback('CHAT_FRAMING_UNCALIBRATED').tokens);
      result.tokens = Math.max(result.tokens, result.margin.floorTokens);
    }
    return result;
  } catch {
    // No exception payload (may contain user content or credentials).
    return fallback('TOKENIZER_FAILED');
  }
}

type Encoding = 'cl100k_base' | 'o200k_base';
const encoders = new Map<Encoding, ReturnType<typeof getEncoding>>();
/** Only documented OpenAI families; never infer tokenizer from API compatibility. */
export function openAIEncoding(model: string): Encoding | undefined {
  if (/^(gpt-4o(?:-mini)?|gpt-4\.1(?:-mini|-nano)?)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return 'o200k_base';
  if (/^(gpt-4|gpt-4-turbo|gpt-3\.5-turbo)(?:-\d{4}|-\d{4}-\d{2}-\d{2}|-preview)?$/.test(model)) return 'cl100k_base';
  return undefined;
}
/** Hash keys, TTL, bounded entries and payload size: never retain prompt text in cache. */
export class FamilyTokenCounter {
  private cache = new Map<string, { rawTokens: number; expiresAt: number }>();
  invalidate(): void { this.cache.clear(); }
  get size(): number { return this.cache.size; }
  count(messages: Message[], tools: ToolSchema[], model: string): PromptTokenEstimate | undefined {
    const encoding = openAIEncoding(model);
    if (!encoding || hasMedia(messages)) return undefined;
    const payload = tokenPayload(messages, tools);
    if (Buffer.byteLength(payload) > 1_000_000) return undefined;
    const key = createHash('sha256').update(FAMILY_TOKENIZER_VERSION + ':' + model + ':' + payload).digest('hex');
    const now = Date.now();
    for (const [id, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(id);
    let rawTokens = this.cache.get(key)?.rawTokens;
    if (rawTokens === undefined) {
      let encoder = encoders.get(encoding);
      if (!encoder) { encoder = getEncoding(encoding); encoders.set(encoding, encoder); }
      rawTokens = encoder.encode(payload, [], []).length;
      if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { rawTokens, expiresAt: now + 300_000 });
    }
    // No live chat-framing calibration yet: do not lower the existing upper bound.
    const margin = { ratio: 0.15, fixedTokens: 128, floorTokens: conservativePromptEstimate(messages, tools, model).tokens };
    return { tokens: Math.max(margin.floorTokens, Math.ceil(rawTokens * (1 + margin.ratio)) + margin.fixedTokens),
      rawTokens, method: 'family-tokenizer', model, version: FAMILY_TOKENIZER_VERSION + ';' + encoding, margin };
  }
}
