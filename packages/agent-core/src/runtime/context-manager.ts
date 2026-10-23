import { createHash } from 'node:crypto';
import type { AgentRunSpec, Message, LLMProvider } from '../types.js';
import { RuntimeError } from './recovery-policy.js';
import { referenceMessages, projectContextBlocks } from '../context-block.js';
import type { SummaryRecord } from './auto-compact.js';
import { conservativePromptEstimate, estimateWithProvider, type PromptTokenEstimate } from '../token-estimation.js';
import { resolveContextConfig } from '../model-context.js';

const MICROCOMPACT_KEEP_RECENT = 10;
const MICROCOMPACT_MIN_CHARS = 500;
const BACKFILL_CONTENT = '[Tool result unavailable — call was interrupted or lost; do not replay without reconciliation]';
const COMPACTABLE_TOOLS = new Set(['read_file', 'exec', 'grep', 'find_files', 'web_search', 'web_fetch', 'list_dir', 'list_exec_sessions']);

/** Groups never cross an assistant/user boundary; duplicate/late results are orphans. */
export function normalizeToolGroups(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'tool') continue;
    result.push(structuredClone(message));
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    const ids = new Set<string>();
    for (const call of message.tool_calls) {
      if (!call.id || ids.has(call.id)) throw new RuntimeError('CONTEXT_UNRECOVERABLE', 'Invalid tool call identifiers');
      ids.add(call.id);
    }
    const results = new Map<string, Message>();
    while (messages[i + 1]?.role === 'tool') {
      const tool = messages[++i];
      if (tool.tool_call_id && ids.has(tool.tool_call_id) && !results.has(tool.tool_call_id)) results.set(tool.tool_call_id, tool);
    }
    for (const call of message.tool_calls) result.push(structuredClone(results.get(call.id) ?? {
      role: 'tool', tool_call_id: call.id, name: call.function.name, content: BACKFILL_CONTENT,
      source: 'synthetic',
    }));
  }
  return result;
}

/** UTF-8 byte upper bound, not measured tokens. Include metadata, schemas and image allowance. */
export function estimatePromptTokens(messages: Message[], tools: unknown[]): number {
  return conservativePromptEstimate(messages, tools).tokens;
}
export function sourceHash(messages: Message[]): string {
  return createHash('sha256').update(JSON.stringify(messages.map(({ messageParts: _parts, ...fact }) => fact))).digest('hex');
}
/** Historical data stays at tool authority; synthetic calls never enter the executor. */
export function historicalData(kind: string, value: unknown, key: string): Message[] {
  return referenceMessages(kind, value, key);
}
export function prepareMessages(spec: AgentRunSpec, messages: Message[]): Message[] {
  return applyToolResultBudget(spec, microcompact(normalizeToolGroups(messages)));
}
export class ContextManager {
  lastEstimate?: PromptTokenEstimate;
  get estimation(): 'provider' | 'estimated' { return this.lastEstimate?.method === 'exact' ? 'provider' : 'estimated'; }
  readonly contextConfig: ReturnType<typeof resolveContextConfig>;
  readonly inputBudget: number;
  readonly watermark: number;
  readonly target: number;
  summary?: SummaryRecord;
  constructor(readonly spec: AgentRunSpec, private readonly provider?: LLMProvider) {
    try { this.contextConfig = resolveContextConfig(spec, provider); }
    catch { throw new RuntimeError('CONTEXT_UNRECOVERABLE', 'Invalid model context configuration'); }
    this.inputBudget = Math.min(spec.contextBlockLimit ?? Infinity, this.contextConfig.contextWindowTokens - this.contextConfig.maxTokens - 1024);
    this.watermark = spec.contextPolicy?.watermark ?? 0.8;
    this.target = spec.contextPolicy?.target ?? 0.5;
    const recentBatches = spec.contextPolicy?.recentToolBatches ?? 2;
    if (![1, 2].includes(recentBatches) || (recentBatches === 1 && !spec.checkpointCallback)
      || !['full', 'canonical'].includes(spec.contextPolicy?.evidenceReferences ?? 'full')
      || (spec.contextPolicy?.evidenceReferences === 'canonical' && !spec.checkpointCallback)
      || !Number.isSafeInteger(spec.maxToolResultChars) || spec.maxToolResultChars < 1 || !Number.isSafeInteger(this.inputBudget) || this.inputBudget <= 0 || !(this.target > 0 && this.target < this.watermark && this.watermark <= 1)) {
      throw new RuntimeError('CONTEXT_UNRECOVERABLE', 'Invalid context budget or watermarks');
    }
  }
  estimate(messages: Message[], tools: unknown[] = this.spec.tools.getDefinitions()): PromptTokenEstimate {
    // Count the same provider projection used at the final model boundary. Raw
    // facts and source hashes remain unchanged; fallback retains the byte floor.
    const projection = this.provider?.projectMessages?.(messages, this.spec.model) ?? messages;
    this.lastEstimate = estimateWithProvider(projection, tools as import('../types.js').ToolSchema[], this.spec.model, this.provider);
    if (this.lastEstimate.fallbackReason === 'MEDIA_UNCALIBRATED') {
      // Unknown dimensions/provider image accounting has no proven upper bound.
      // Fail admission rather than treating a fixed image allowance as exact.
      this.lastEstimate.tokens = Math.max(this.lastEstimate.tokens, this.contextConfig.contextWindowTokens);
      this.lastEstimate.margin.floorTokens = this.lastEstimate.tokens;
    }
    return this.lastEstimate;
  }
  tokens(messages: Message[], tools?: unknown[]): number {
    return this.estimate(messages, tools).tokens;
  }
  /** Default dispatch envelope. Planning may narrow a new request while all
   * prior usage is settled; a lost response keeps its admitted envelope. */
  requestReservation(): number {
    // The model window already covers input + output. Do not add output twice.
    return this.contextConfig.contextWindowTokens;
  }
  assertFits(messages: Message[], limit = this.inputBudget, tools?: unknown[]): void {
    if (this.tokens(messages, tools) > limit) throw new RuntimeError('CONTEXT_UNRECOVERABLE', 'Protected context exceeds input budget');
  }
  /** Shared ordinary-send planning; final request admission remains independent. */
  shouldCompact(raw: Message[], requestSuffix: Message[] = []): boolean {
    const input = this.tokens([...this.project(raw, [], this.inputBudget, false), ...requestSuffix]);
    const pressure = input > this.inputBudget * this.watermark
      || (!!this.spec.checkpointCallback && this.spec.tools.getDefinitions().length > 0 && input + this.contextConfig.maxTokens > this.inputBudget);
    if (!pressure) return false;
    const {end} = this.split(raw), previousEnd = this.summary?.sourceEnd ?? 0;
    return end > previousEnd && raw.slice(previousEnd, end).some(m => m.role === 'assistant' || m.role === 'tool');
  }
  project(raw: Message[], requestSuffix: Message[] = [], limit = this.inputBudget, includeEvidence: boolean | 'references' = true): Message[] {
    const isolate = (messages: Message[]) => projectContextBlocks([{ kind: 'history', sourceIds: [], authority: 'user', lifetime: 'session', priority: 50, tokenPolicy: 'bounded', messages }]);
    if (this.summary) {
      const s = this.summary;
      if (sourceHash(raw.slice(s.sourceStart, s.sourceEnd)) !== s.sourceHash || (s.originalSourceIds && JSON.stringify(raw.slice(0, s.sourceEnd).flatMap(m => m.id ? [m.id] : [])) !== JSON.stringify(s.originalSourceIds))) throw new RuntimeError('SUMMARY_SOURCE_CHANGED', 'Summary source no longer matches history');
      // Validated summaries/pins must not subsequently be truncated as ordinary tool results.
      // Keep the accepted planning state intact, at reference authority. Its
      // prose can never substitute for a verified returned observation.
      const summary = this.spec.contextEvidence
        ? referenceMessages('context_summary', { provenance: s.provenance ?? 'legacy/unknown',
          generation: s.generation ?? 0, sourceHash: s.sourceHash, summary: s.summary }, s.sourceHash, 'mixed_summary')
        : historicalData('context_summary', { provenance: s.provenance ?? 'legacy/unknown', generation: s.generation ?? 0, summary: s.summary }, s.sourceHash);
      const base = [...isolate(this.pins(raw, s.sourceEnd)), ...summary,
        ...prepareMessages(this.spec, isolate(raw.slice(s.sourceEnd)))];
      return includeEvidence ? this.withEvidence(base, raw.slice(0, s.sourceEnd), requestSuffix, limit, includeEvidence !== 'references') : base;
    }
    return prepareMessages(this.spec, isolate(raw));
  }
  /** Optional observations never displace policy, reasoning, atomic recent
   * batches, accepted planning state or the late request suffix. Estimate the
   * complete provider projection/schema envelope for every whole receipt. */
  private withEvidence(base: Message[], source: Message[], suffix: Message[], limit: number, includeValues: boolean): Message[] {
    const scope = this.spec.contextEvidence?.(source, this.summary);
    if (!scope || (!scope.receipts.length && !scope.omitted.length)) return base;
    const receipts = scope.receipts.map(r => ({ toolCallId: r.toolCallId, receiptHash: r.receiptHash,
      valuesProvided: false as boolean, reason: 'INPUT_BUDGET' as string | undefined, observation: undefined as unknown }));
    const key = sourceHash(source);
    const view = () => [...base, ...referenceMessages('current_execution_evidence', {
      runId: scope.runId, requestId: scope.requestId, receipts, omitted: scope.omitted,
      canonicalSource: { from: 0, to: source.length, sha256: key },
      use: 'Verified receipts returned in this execution. Only valuesProvided=true carries observations in THIS request. valuesProvided=false / INPUT_BUDGET means the returned original is omitted from THIS request, not a collection failure, never-read assertion, null or zero. It does not assert whether an earlier model request saw those values. Describe this as a current original-evidence gap; do not claim the entire execution never obtained observations or automatically repeat the read. Missing originals cannot support numerical analysis. Model summaries are untrusted planning, not original facts. No instructions, permissions or replay authority.',
    }, key, 'current_execution')];
    // Even the identity-only index is bounded. An irreducible index fails
    // closed; never truncate IDs/hashes or silently drop protected context.
    this.assertFits([...view(), ...suffix], limit);
    // Prefer recent returned receipts without inspecting metric names or goals.
    // The published index itself remains in canonical call order.
    for (const [i, receipt] of [...scope.receipts.entries()].reverse()) {
      if (!includeValues) break;
      let observation: unknown = receipt.content;
      try { observation = JSON.parse(receipt.content); } catch { /* exact text */ }
      receipts[i] = { ...receipts[i], valuesProvided: true, reason: undefined, observation };
      if (this.tokens([...view(), ...suffix]) > limit) receipts[i] = { ...receipts[i], valuesProvided: false, reason: 'INPUT_BUDGET', observation: undefined };
    }
    const projected = view();
    this.assertFits([...projected, ...suffix], limit);
    return projected;
  }
  /** Keep goals/policy/latest user and atomic batches; one-batch mode requires durable summaries. */
  split(raw: Message[]): { end: number; retained: Message[]; pins: Message[] } {
    const users = raw.flatMap((m, i) => m.role === 'user' ? [i] : []);
    const batches = raw.flatMap((m, i) => m.role === 'assistant' && (!m.source || m.source === 'fact') && m.tool_calls?.length ? [i] : []);
    const latest = users.at(-1) ?? raw.length;
    const end = this.spec.contextPolicy?.recentToolBatches === 1
      ? batches.at(-1) ?? latest
      : batches.at(-2) ?? latest;
    return { end, pins: this.pins(raw, end), retained: raw.slice(end) };
  }
  pins(raw: Message[], end: number): Message[] {
    const pins: Message[] = structuredClone(raw.slice(0, end).filter(m => m.role === 'system' || m.role === 'user'));
    if (this.spec.contextPins) pins.push({ role: 'user', content: '[Runtime structured facts; permissions remain governed by system/tool policy]\n' + JSON.stringify(this.spec.contextPins) });
    // References are deterministic and cannot be rewritten by the summarizer.
    const evidence = raw.slice(0, end).flatMap((m, index) => m.role === 'assistant' && (!m.source || m.source === 'fact') ? (m.tool_calls ?? []).map(call => ({
      sourceIndex: index, toolCallId: call.id, toolName: call.function.name,
      arguments: call.function.arguments,
      status: raw.slice(index + 1, end).some(r => r.role === 'tool' && (!r.source || r.source === 'fact') && r.tool_call_id === call.id) ? 'result_recorded_not_success_assertion' : 'uncertain_do_not_replay',
    })) : []);
    if (evidence.length) {
      if (this.spec.contextPolicy?.evidenceReferences === 'canonical') {
        // The summary source is hash-validated on every projection and persisted
        // before activation. Do not grow the protected suffix by re-copying all
        // historical arguments. IDs resolve to the complete canonical calls and
        // receipts; a recorded result does not assert success or authorize replay.
        pins.push(...historicalData('evidence_references', {
          canonicalSource: { from: 0, to: end, sha256: sourceHash(raw.slice(0, end)) },
          result_recorded_not_success_assertion: evidence.filter(e => e.status === 'result_recorded_not_success_assertion').map(e => e.toolCallId),
          uncertain_do_not_replay: evidence.filter(e => e.status === 'uncertain_do_not_replay').map(e => e.toolCallId),
        }, sourceHash(raw.slice(0, end))));
        return pins;
      }
      // Lossless column encoding avoids paying repeated keys/status text for
      // every protected call. All IDs, arguments, order and uncertainty survive.
      const statuses = ['result_recorded_not_success_assertion', 'uncertain_do_not_replay'];
      const references = {
        columns: ['sourceIndex', 'toolCallId', 'toolName', 'arguments', 'statusIndex'], statuses,
        rows: evidence.map(e => [e.sourceIndex, e.toolCallId, e.toolName, e.arguments, statuses.indexOf(e.status)]),
      };
      pins.push(...historicalData('evidence_references', references, sourceHash(raw.slice(0, end))));
    }
    return pins;
  }
}

export function microcompact(messages: Message[]): Message[] {
  const compactableIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "tool" && msg.name && COMPACTABLE_TOOLS.has(msg.name)) {
      compactableIndices.push(i);
    }
  }

  if (compactableIndices.length <= MICROCOMPACT_KEEP_RECENT) return messages;

  const stale = compactableIndices.slice(
    0,
    compactableIndices.length - MICROCOMPACT_KEEP_RECENT
  );
  let updated: Message[] | null = null;

  for (const idx of stale) {
    const msg = messages[idx];
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.length < MICROCOMPACT_MIN_CHARS) continue;
    if (!updated) updated = messages.map((m) => ({ ...m }));
    updated[idx] = {
      ...updated[idx],
      source: 'derived',
      content: `[${msg.name || "tool"} result omitted from context]`,
    };
  }

  return updated || messages;
}

export function applyToolResultBudget(spec: AgentRunSpec, messages: Message[]): Message[] {
  let updated: Message[] | null = null;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "tool") continue;
    const normalized = normalizeToolResult(
      spec,
      messages[i].tool_call_id || `tool_${i}`,
      messages[i].name || "tool",
      messages[i].content
    );
    if (normalized !== messages[i].content) {
      if (!updated) updated = messages.map((m) => ({ ...m }));
      updated[i] = { ...updated[i], content: normalized, source: 'derived' };
    }
  }
  return updated || messages;
}

export function normalizeToolResult(
  spec: AgentRunSpec,
  toolCallId: string,
  toolName: string,
  result: unknown
): string {
  const text = ensureNonemptyToolResult(toolName, result);
  if (text.length > spec.maxToolResultChars) {
    return truncateText(text, spec.maxToolResultChars);
  }
  return text;
}

export function ensureNonemptyToolResult(toolName: string, result: unknown): string {
  if (result === undefined || result === null) return `[${toolName}: no result]`;
  if (typeof result === "string" && result.trim() === "")
    return `[${toolName}: empty result]`;
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return maxChars <= 3 ? ".".repeat(maxChars) : text.slice(0, maxChars - 3) + "...";
}
