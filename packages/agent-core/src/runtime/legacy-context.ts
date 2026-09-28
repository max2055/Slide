import type { AgentRunSpec, Message } from "../types.js";

const SNIP_SAFETY_BUFFER = 1024;
const MICROCOMPACT_KEEP_RECENT = 10;
const MICROCOMPACT_MIN_CHARS = 500;
const BACKFILL_CONTENT = "[Tool result unavailable — call was interrupted or lost]";

const COMPACTABLE_TOOLS = new Set([
  "read_file",
  "exec",
  "grep",
  "find_files",
  "web_search",
  "web_fetch",
  "list_dir",
  "list_exec_sessions",
]);

export function dropOrphanToolResults(messages: Message[]): Message[] {
  const declared = new Set<string>();
  let updated: Message[] | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const tc of msg.tool_calls || []) {
        if (tc.id) declared.add(tc.id);
      }
    }
    if (msg.role === "tool") {
      if (msg.tool_call_id && !declared.has(msg.tool_call_id)) {
        if (!updated) updated = messages.slice(0, i).map((m) => ({ ...m }));
        continue;
      }
    }
    if (updated) updated.push({ ...msg });
  }

  return updated || messages;
}

export function backfillMissingToolResults(messages: Message[]): Message[] {
  const declared: { idx: number; id: string; name: string }[] = [];
  const fulfilled = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const tc of msg.tool_calls || []) {
        if (tc.id) {
          declared.push({ idx: i, id: tc.id, name: tc.function?.name || "" });
        }
      }
    } else if (msg.role === "tool") {
      if (msg.tool_call_id) fulfilled.add(msg.tool_call_id);
    }
  }

  const missing = declared.filter((d) => !fulfilled.has(d.id));
  if (missing.length === 0) return messages;

  const updated = [...messages];
  let offset = 0;
  for (const m of missing) {
    let insertAt = m.idx + 1 + offset;
    while (insertAt < updated.length && updated[insertAt].role === "tool") {
      insertAt++;
    }
    updated.splice(insertAt, 0, {
      role: "tool",
      tool_call_id: m.id,
      name: m.name,
      content: BACKFILL_CONTENT,
    });
    offset++;
  }
  return updated;
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
      updated[i] = { ...updated[i], content: normalized };
    }
  }
  return updated || messages;
}

export function snipHistory(
  spec: AgentRunSpec,
  messages: Message[],
  provider: import("../types.js").LLMProvider
): Message[] {
  if (!messages.length || !spec.contextWindowTokens) return messages;

  const maxOutput = spec.maxTokens || 4096;
  const budget = spec.contextBlockLimit || spec.contextWindowTokens - maxOutput - SNIP_SAFETY_BUFFER;
  if (budget <= 0) return messages;

  // Quick estimate: if under budget, skip
  const estimate = estimatePromptTokensChain(messages, spec.tools.getDefinitions());
  if (estimate <= budget) return messages;

  const systemMsgs = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (nonSystem.length === 0) return messages;

  const systemTokens = systemMsgs.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const remainingBudget = Math.max(128, budget - systemTokens);

  const kept: Message[] = [];
  let keptTokens = 0;
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(nonSystem[i]);
    if (kept.length > 0 && keptTokens + msgTokens > remainingBudget) break;
    kept.unshift(nonSystem[i]);
    keptTokens += msgTokens;
  }

  // Ensure starts with user message
  const firstUser = kept.findIndex((m) => m.role === "user");
  if (firstUser > 0) {
    kept.splice(0, firstUser);
  }

  return [...systemMsgs, ...kept];
}

// ── Token estimation (simplified — production would use tiktoken) ──

function estimateMessageTokens(msg: Message): number {
  let chars = 0;
  if (typeof msg.content === "string") chars += msg.content.length;
  else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "text") chars += block.text.length;
    }
  }
  if (msg.tool_calls) chars += JSON.stringify(msg.tool_calls).length;
  if (msg.tool_call_id) chars += msg.tool_call_id.length;
  if (msg.name) chars += msg.name.length;
  // Rough estimate: ~4 chars per token
  return Math.ceil(chars / 4);
}

function estimatePromptTokensChain(messages: Message[], tools: unknown[]): number {
  let total = 0;
  for (const msg of messages) total += estimateMessageTokens(msg);
  total += Math.ceil(JSON.stringify(tools).length / 4);
  return total;
}

// ── Injection callbacks ──

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

function ensureNonemptyToolResult(toolName: string, result: unknown): string {
  if (result === undefined || result === null) return `[${toolName}: no result]`;
  if (typeof result === "string" && result.trim() === "")
    return `[${toolName}: empty result]`;
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + "...";
}

