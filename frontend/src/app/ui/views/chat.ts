import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { CompactionStatus, FallbackStatus } from "../app-tool-stream.ts";
import { DeletedMessages } from "../chat/deleted-messages.ts";
import { getOrCreateSessionCacheValue } from "../chat/session-cache.ts";
import type { ChatSideResult } from "../chat/side-result.ts";
import { extractToolCards, extractToolPreview, buildSidebarContent } from "../chat/tool-cards.ts";
import type { EmbedSandboxMode } from "../embed-sandbox.ts";
import { icons } from "../../../icons.js";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import type { SidebarContent } from "../sidebar-content.ts";
import { detectTextDirection } from "../text-direction.ts";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";
import type { ChatItem, MessageGroup, ToolCard } from "../types/chat-types.ts";
import type { ChatAttachment, ChatQueueItem } from "../ui-types.ts";
import { resolveAgentAvatarUrl } from "./agents-utils.ts";
import { renderMarkdownSidebar } from "./markdown-sidebar.ts";
import "../components/resizable-divider.ts";
import "../components/chat-message-list.ts";
import "../components/chat-compose-area.ts";
import {
  isToolResultMessage, normalizeMessage, normalizeRoleForGrouping,
} from "../chat/message-normalizer.ts";
import { extractTextCached } from "../chat/message-extract.ts";
import { messageMatchesSearchQuery } from "../chat/search-match.ts";
import { PinnedMessages } from "../chat/pinned-messages.ts";
import { getPinnedMessageSummary } from "../chat/pinned-summary.ts";

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  showToolCalls: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  compactionStatus?: CompactionStatus | null;
  fallbackStatus?: FallbackStatus | null;
  messages: unknown[];
  sideResult?: ChatSideResult | null;
  sideResultTerminalRuns?: Set<string>;
  runId?: string | null;
  toolMessages: unknown[];
  streamSegments: Array<{ text: string; ts: number }>;
  stream: string | null;
  streamStartedAt: number | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  lastError: string | null;
  onReconnect?: () => void;
  sessions: SessionsListResult | null;
  focusMode: boolean;
  sidebarOpen?: boolean;
  sidebarContent?: SidebarContent | null;
  sidebarError?: string | null;
  splitRatio?: number;
  canvasHostUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  assistantName: string;
  assistantAvatar: string | null;
  localMediaPreviewRoots?: string[];
  assistantAttachmentAuthToken?: string | null;
  autoExpandToolCalls?: boolean;
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  showNewMessages?: boolean;
  onScrollToBottom?: () => void;
  onRefresh: () => void;
  onToggleFocusMode: () => void;
  getDraft?: () => string;
  onDraftChange: (next: string) => void;
  onRequestUpdate?: () => void;
  onSend: () => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onDismissSideResult?: () => void;
  onNewSession: () => void;
  onClearHistory?: () => void;
  agentsList: { agents: Array<{ id: string; name?: string; identity?: { name?: string; avatarUrl?: string } }>; defaultId?: string } | null;
  currentAgentId: string;
  onAgentChange: (agentId: string) => void;
  onNavigateToAgent?: () => void;
  onSessionSelect?: (sessionKey: string) => void;
  onOpenSidebar?: (content: SidebarContent) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
  basePath?: string;
  modelCatalog?: unknown[];
  modelsLoading?: boolean;
  modelOverrides?: Record<string, unknown>;
  manualRefreshInFlight?: boolean;
  newMessagesBelow?: boolean;
  settings?: Record<string, unknown>;
  hello?: Record<string, unknown> | null;
};

const COMPACTION_TOAST_DURATION_MS = 5000;
const FALLBACK_TOAST_DURATION_MS = 8000;

const pinnedMessagesMap = new Map<string, PinnedMessages>();
const deletedMessagesMap = new Map<string, DeletedMessages>();

const expandedToolCardsBySession = new Map<string, Map<string, boolean>>();
const initializedToolCardsBySession = new Map<string, Set<string>>();
const lastAutoExpandPrefBySession = new Map<string, boolean>();

function getPinnedMessages(sessionKey: string): PinnedMessages {
  return getOrCreateSessionCacheValue(pinnedMessagesMap, sessionKey, () => new PinnedMessages(sessionKey));
}
function getDeletedMessages(sessionKey: string): DeletedMessages {
  return getOrCreateSessionCacheValue(deletedMessagesMap, sessionKey, () => new DeletedMessages(sessionKey));
}
function getExpandedToolCards(sessionKey: string): Map<string, boolean> {
  return getOrCreateSessionCacheValue(expandedToolCardsBySession, sessionKey, () => new Map());
}
function getInitializedToolCards(sessionKey: string): Set<string> {
  return getOrCreateSessionCacheValue(initializedToolCardsBySession, sessionKey, () => new Set());
}

function appendCanvasBlockToAssistantMessage(message: unknown, preview: NonNullable<ToolCard["preview"]>, rawText: string | null) {
  const raw = message as Record<string, unknown>;
  const existingContent = Array.isArray(raw.content) ? [...raw.content]
    : typeof raw.content === "string" ? [{ type: "text", text: raw.content }]
    : typeof raw.text === "string" ? [{ type: "text", text: raw.text }] : [];
  const alreadyHasArtifact = existingContent.some((block) => {
    if (!block || typeof block !== "object") return false;
    const typed = block as { type?: unknown; preview?: { kind?: unknown; viewId?: unknown; url?: unknown } };
    return typed.type === "canvas" && typed.preview?.kind === "canvas" && ((preview.viewId && typed.preview.viewId === preview.viewId) || (preview.url && typed.preview.url === preview.url));
  });
  if (alreadyHasArtifact) return message;
  return { ...raw, content: [...existingContent, { type: "canvas", preview, ...(rawText ? { rawText } : {}) }] };
}

function extractChatMessagePreview(toolMessage: unknown): { preview: NonNullable<ToolCard["preview"]>; text: string | null; timestamp: number | null } | null {
  const normalized = normalizeMessage(toolMessage);
  const cards = extractToolCards(toolMessage, "preview");
  for (let index = cards.length - 1; index >= 0; index--) {
    const card = cards[index];
    if (card?.preview?.kind === "canvas") return { preview: card.preview, text: card.outputText ?? null, timestamp: normalized.timestamp ?? null };
  }
  const text = extractTextCached(toolMessage) ?? undefined;
  const toolRecord = toolMessage as Record<string, unknown>;
  const toolName = typeof toolRecord.toolName === "string" ? toolRecord.toolName : typeof toolRecord.tool_name === "string" ? toolRecord.tool_name : undefined;
  const preview = extractToolPreview(text, toolName);
  if (preview?.kind !== "canvas") return null;
  return { preview, text: text ?? null, timestamp: normalized.timestamp ?? null };
}

function findNearestAssistantMessageIndex(items: ChatItem[], toolTimestamp: number | null): number | null {
  const assistantEntries = items.map((item, index) => {
    if (item.kind !== "message") return null;
    const message = item.message as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
    if (role !== "assistant") return null;
    return { index, timestamp: normalizeMessage(item.message).timestamp ?? null };
  }).filter(Boolean) as Array<{ index: number; timestamp: number | null }>;
  if (assistantEntries.length === 0) return null;
  if (toolTimestamp == null) return assistantEntries[assistantEntries.length - 1]?.index ?? null;
  let previous: { index: number; timestamp: number } | null = null;
  let next: { index: number; timestamp: number } | null = null;
  for (const entry of assistantEntries) {
    if (entry.timestamp == null) continue;
    if (entry.timestamp <= toolTimestamp) { previous = { index: entry.index, timestamp: entry.timestamp }; continue; }
    next = { index: entry.index, timestamp: entry.timestamp }; break;
  }
  if (previous && next) { const pd = toolTimestamp - previous.timestamp, nd = next.timestamp - toolTimestamp; return nd < pd ? next.index : previous.index; }
  return previous?.index ?? next?.index ?? assistantEntries[assistantEntries.length - 1]?.index ?? null;
}

interface ChatEphemeralState { searchOpen: boolean; searchQuery: string; pinnedExpanded: boolean; }
function createCES(): ChatEphemeralState { return { searchOpen: false, searchQuery: "", pinnedExpanded: false }; }
const vs = createCES();
export function resetChatViewState() { Object.assign(vs, createCES()); }
export const cleanupChatModuleState = resetChatViewState;

function syncToolCardExpansionState(sessionKey: string, items: Array<ChatItem | MessageGroup>, autoExpandToolCalls: boolean) {
  const expanded = getExpandedToolCards(sessionKey);
  const initialized = getInitializedToolCards(sessionKey);
  const previousAutoExpand = lastAutoExpandPrefBySession.get(sessionKey) ?? false;
  const currentToolCardIds = new Set<string>();
  for (const item of items) {
    if (item.kind !== "group") continue;
    for (const entry of item.messages) {
      const cards = extractToolCards(entry.message, entry.key);
      for (let ci = 0; ci < cards.length; ci++) { const did = `${entry.key}:toolcard:${ci}`; currentToolCardIds.add(did); if (!initialized.has(did)) { expanded.set(did, autoExpandToolCalls); initialized.add(did); } }
      const mr = entry.message as Record<string, unknown>;
      const nr = normalizeRoleForGrouping(typeof mr.role === "string" ? mr.role : "unknown");
      const isTool = isToolResultMessage(entry.message) || nr === "tool" || typeof mr.toolCallId === "string" || typeof mr.tool_call_id === "string";
      if (!isTool) continue;
      const did = `toolmsg:${entry.key}`; currentToolCardIds.add(did);
      if (!initialized.has(did)) { expanded.set(did, autoExpandToolCalls); initialized.add(did); }
    }
  }
  if (autoExpandToolCalls && !previousAutoExpand) { for (const id of currentToolCardIds) expanded.set(id, true); }
  lastAutoExpandPrefBySession.set(sessionKey, autoExpandToolCalls);
}

function renderCompactionIndicator(status: CompactionStatus | null | undefined) {
  if (!status) return nothing;
  if (status.phase === "active" || status.phase === "retrying") return html`<div class="compaction-indicator compaction-indicator--active" role="status" aria-live="polite">${icons['loader']} Compacting context...</div>`;
  if (status.completedAt && Date.now() - status.completedAt < COMPACTION_TOAST_DURATION_MS) return html`<div class="compaction-indicator compaction-indicator--complete" role="status" aria-live="polite">${icons['check']} Context compacted</div>`;
  return nothing;
}

function renderFallbackIndicator(status: FallbackStatus | null | undefined) {
  if (!status) return nothing;
  const phase = status.phase ?? "active";
  if (Date.now() - status.occurredAt >= FALLBACK_TOAST_DURATION_MS) return nothing;
  const details = [`Selected: ${status.selected}`, phase === "cleared" ? `Active: ${status.selected}` : `Active: ${status.active}`, phase === "cleared" && status.previous ? `Previous fallback: ${status.previous}` : null, status.reason ? `Reason: ${status.reason}` : null, status.attempts.length > 0 ? `Attempts: ${status.attempts.slice(0, 3).join(" | ")}` : null].filter(Boolean).join(" • ");
  const msg = phase === "cleared" ? `Fallback cleared: ${status.selected}` : `Fallback active: ${status.active}`;
  const cls = phase === "cleared" ? "compaction-indicator compaction-indicator--fallback-cleared" : "compaction-indicator compaction-indicator--fallback";
  return html`<div class=${cls} role="status" aria-live="polite" title=${details}>${phase === "cleared" ? icons['check'] : icons['brain']} ${msg}</div>`;
}

function renderSideResult(sideResult: ChatSideResult | null | undefined, onDismiss?: () => void): TemplateResult | typeof nothing {
  if (!sideResult) return nothing;
  return html`<section class="chat-side-result ${sideResult.isError ? "chat-side-result--error" : ""}" role="status" aria-live="polite" aria-label="BTW side result">
    <div class="chat-side-result__header"><div class="chat-side-result__label-row"><span class="chat-side-result__label">BTW</span><span class="chat-side-result__meta">Not saved to chat history</span></div><button class="btn chat-side-result__dismiss" type="button" aria-label="Dismiss BTW result" title="Dismiss" @click=${() => onDismiss?.()}>${icons['x']}</button></div>
    <div class="chat-side-result__question">${sideResult.question}</div>
    <div class="chat-side-result__body" dir=${detectTextDirection(sideResult.text)}>${unsafeHTML(toSanitizedMarkdownHtml(sideResult.text))}</div>
  </section>`;
}

function parseHexRgb(hex: string): [number, number, number] | null {
  const h = hex.trim().replace(/^#/, ""); if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
let cachedNoticeColors: { warnHex: string; dangerHex: string; warnRgb: [number, number, number]; dangerRgb: [number, number, number] } | null = null;
function getNoticeColors() {
  if (cachedNoticeColors) return cachedNoticeColors;
  const root = getComputedStyle(document.documentElement);
  const warnHex = root.getPropertyValue("--warn").trim() || "#f59e0b";
  const dangerHex = root.getPropertyValue("--danger").trim() || "#ef4444";
  cachedNoticeColors = { warnHex, dangerHex, warnRgb: parseHexRgb(warnHex) ?? [245, 158, 11], dangerRgb: parseHexRgb(dangerHex) ?? [239, 68, 68] };
  return cachedNoticeColors;
}

function renderContextNotice(session: GatewaySessionRow | undefined, defaultContextTokens: number | null) {
  if (session?.totalTokensFresh === false) return nothing;
  const used = session?.totalTokens ?? 0; const limit = session?.contextTokens ?? defaultContextTokens ?? 0;
  if (!used || !limit) return nothing;
  const ratio = used / limit; if (ratio < 0.85) return nothing;
  const pct = Math.min(Math.round(ratio * 100), 100);
  const { warnRgb, dangerRgb } = getNoticeColors();
  const t = Math.min(Math.max((ratio - 0.85) / 0.1, 0), 1);
  const r = Math.round(warnRgb[0] + (dangerRgb[0] - warnRgb[0]) * t), g = Math.round(warnRgb[1] + (dangerRgb[1] - warnRgb[1]) * t), b = Math.round(warnRgb[2] + (dangerRgb[2] - warnRgb[2]) * t);
  return html`<div class="context-notice" role="status" style="--ctx-color:rgb(${r},${g},${b});--ctx-bg:rgba(${r},${g},${b},${0.08 + 0.08 * t})"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>${pct}% context used</span><span class="context-notice__detail">${fTC(used)} / ${fTC(limit)}</span></div>`;
}

function fTC(n: number): string { if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`; if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`; return String(n); }

function renderConnectionStatus(props: ChatProps): TemplateResult | typeof nothing {
  const isConnected = props.connected;
  const isExhausted = props.disabledReason === '连接失败，请点击重试';
  const isAuthFailed = props.lastError === '认证失败，请重新登录';
  return html`<div class="connection-status"><span class="connection-status__dot ${isConnected ? 'connected' : isAuthFailed || isExhausted ? 'disconnected' : 'connecting'}"></span><span class="connection-status__text">${isConnected ? '已连接' : isExhausted ? '连接失败' : isAuthFailed ? '认证失败，请重新登录' : '重新连接中...'}</span>${isExhausted ? html`<button class="connection-status__reconnect" @click=${props.onReconnect ?? props.onRefresh}>重新连接</button>` : nothing}</div>`;
}

function renderSearchBar(requestUpdate: () => void): TemplateResult | typeof nothing {
  if (!vs.searchOpen) return nothing;
  return html`<div class="agent-chat__search-bar">${icons['search']}<input type="text" placeholder="Search messages..." aria-label="Search messages" .value=${vs.searchQuery} @input=${(e: Event) => { vs.searchQuery = (e.target as HTMLInputElement).value; requestUpdate(); }}/><button class="btn btn--ghost" aria-label="Close search" @click=${() => { vs.searchOpen = false; vs.searchQuery = ""; requestUpdate(); }}>${icons['x']}</button></div>`;
}

function renderPinnedSection(props: ChatProps, pinned: PinnedMessages, requestUpdate: () => void): TemplateResult | typeof nothing {
  const messages = Array.isArray(props.messages) ? props.messages : [];
  const entries: Array<{ index: number; text: string; role: string }> = [];
  for (const idx of pinned.indices) { const msg = messages[idx] as Record<string, unknown> | undefined; if (!msg) continue; entries.push({ index: idx, text: getPinnedMessageSummary(msg), role: typeof msg.role === "string" ? msg.role : "unknown" }); }
  if (entries.length === 0) return nothing;
  return html`<div class="agent-chat__pinned"><button class="agent-chat__pinned-toggle" @click=${() => { vs.pinnedExpanded = !vs.pinnedExpanded; requestUpdate(); }}>${icons['bookmark']} ${entries.length} pinned <span class="collapse-chevron ${vs.pinnedExpanded ? "" : "collapse-chevron--collapsed"}">${icons['chevron-down']}</span></button>${vs.pinnedExpanded ? html`<div class="agent-chat__pinned-list">${entries.map(({ index, text, role }) => html`<div class="agent-chat__pinned-item"><span class="agent-chat__pinned-role">${role === "user" ? "You" : "Assistant"}</span><span class="agent-chat__pinned-text">${text.slice(0, 100)}${text.length > 100 ? "..." : ""}</span><button class="btn btn--ghost" @click=${() => { pinned.unpin(index); requestUpdate(); }} title="Unpin">${icons['x']}</button></div>`)}</div>` : nothing}</div>`;
}

export function renderChat(props: ChatProps) {
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const hasThinkingMessages = props.messages.some(m => { const c = (m as Record<string, unknown>).content; return Array.isArray(c) ? c.some((x: Record<string, unknown>) => x.type === 'thinking') : false; });
  const showReasoning = (props.showThinking && reasoningLevel !== "off") || hasThinkingMessages;
  const assistantIdentity = { name: props.assistantName, avatar: resolveAgentAvatarUrl({ identity: { avatar: props.assistantAvatar ?? undefined, avatarUrl: props.assistantAvatarUrl ?? undefined } }) ?? null };
  const pinned = getPinnedMessages(props.sessionKey);
  const deleted = getDeletedMessages(props.sessionKey);
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);

  const chatItems = buildChatItems(props);
  syncToolCardExpansionState(props.sessionKey, chatItems, Boolean(props.autoExpandToolCalls));
  const expandedToolCards = getExpandedToolCards(props.sessionKey);
  const toggleToolCardExpanded = (toolCardId: string) => { expandedToolCards.set(toolCardId, !expandedToolCards.get(toolCardId)); requestUpdate(); };

  return html`
    <section class="card chat" @drop=${(e: DragEvent) => handleDrop(e, props)} @dragover=${(e: DragEvent) => e.preventDefault()}>
      <style>
        .card.chat .chat-link-row { display:flex; gap:8px; padding:4px 12px; }
        .card.chat .chat-link-btn { font-size:12px; color:var(--accent); text-decoration:underline; background:none; border:none; cursor:pointer; }
        .connection-status { display:flex; align-items:center; gap:8px; padding:8px 16px; font-size:12px; color:var(--muted); border-top:1px solid var(--border); }
        .connection-status__dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; transition: background 300ms ease-out, box-shadow 300ms ease-out; }
        .connection-status__dot.connected { background:var(--ok); box-shadow:0 0 0 4px color-mix(in srgb,var(--ok) 14%,transparent); }
        .connection-status__dot.disconnected { background:var(--danger); box-shadow:0 0 0 4px color-mix(in srgb,var(--danger) 14%,transparent); }
        .connection-status__dot.connecting { background:var(--muted); box-shadow:0 0 0 4px color-mix(in srgb,var(--muted) 14%,transparent); }
        .connection-status__reconnect { margin-left:auto; padding:4px 12px; border:1px solid var(--border); border-radius:var(--radius-md); background:var(--bg-elevated); color:var(--text); font-size:var(--text-sm); font-weight:600; cursor:pointer; }
        .connection-status__reconnect:hover { border-color:var(--accent); background:var(--accent-subtle); color:var(--accent); }
      </style>
      ${props.disabledReason ? html`<div class="callout">${props.disabledReason}</div>` : nothing}
      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}
      ${props.focusMode ? html`<button class="chat-focus-exit" type="button" @click=${props.onToggleFocusMode}>${icons['x']}</button>` : nothing}
      ${renderSearchBar(requestUpdate)} ${renderPinnedSection(props, pinned, requestUpdate)}

      <div class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}">
        <div class="chat-main" style="flex:${sidebarOpen ? `0 0 ${splitRatio * 100}%` : "1 1 100%"}">
          <chat-message-list
            .chatItems=${chatItems}
            .loading=${props.loading}
            .showToolCalls=${props.showToolCalls}
            .showReasoning=${showReasoning}
            .autoExpandToolCalls=${Boolean(props.autoExpandToolCalls)}
            .assistantName=${props.assistantName}
            .assistantAvatar=${assistantIdentity.avatar}
            .assistantAvatarUrl=${props.assistantAvatarUrl}
            .basePath=${props.basePath ?? ""}
            .error=${props.error}
            .showNewMessages=${props.showNewMessages ?? false}
            .searchOpen=${vs.searchOpen}
            .searchQuery=${vs.searchQuery}
            .onOpenSidebar=${(content: SidebarContent) => props.onOpenSidebar?.(content)}
            .onChatScroll=${(e: Event) => props.onChatScroll?.(e)}
            .onScrollToBottom=${() => props.onScrollToBottom?.()}
            .onToggleToolExpanded=${toggleToolCardExpanded}
            .onDeleteMessage=${(key: string) => { deleted.delete(key); requestUpdate(); }}
          ></chat-message-list>
        </div>

        ${sidebarOpen ? html`<resizable-divider .splitRatio=${splitRatio} @resize=${(e: CustomEvent) => props.onSplitRatioChange?.(e.detail.splitRatio)}></resizable-divider>
          <div class="chat-sidebar">${renderMarkdownSidebar({
            content: props.sidebarContent ?? null, error: props.sidebarError ?? null,
            canvasHostUrl: props.canvasHostUrl, embedSandboxMode: props.embedSandboxMode ?? "scripts",
            allowExternalEmbedUrls: props.allowExternalEmbedUrls ?? false,
            onClose: props.onCloseSidebar!,
            onViewRawText: () => {
              if (!props.sidebarContent || !props.onOpenSidebar) return;
              if (props.sidebarContent.kind === "markdown") { props.onOpenSidebar(buildSidebarContent(`\`\`\`\n${props.sidebarContent.content}\n\`\`\``)); return; }
              if (props.sidebarContent.rawText?.trim()) props.onOpenSidebar(buildSidebarContent(`\`\`\`json\n${props.sidebarContent.rawText}\n\`\`\``));
            }})}</div>` : nothing}
      </div>

      ${renderSideResult(props.sideResult, props.onDismissSideResult)}
      ${renderFallbackIndicator(props.fallbackStatus)}
      ${renderCompactionIndicator(props.compactionStatus)}
      ${renderContextNotice(activeSession, props.sessions?.defaults?.contextTokens ?? null)}

      <chat-compose-area
        .draft=${props.draft}
        .connected=${props.connected}
        .sending=${props.sending}
        .stream=${props.stream}
        .canAbort=${props.canAbort ?? false}
        .attachments=${props.attachments ?? []}
        .sessionKey=${props.sessionKey}
        .assistantName=${props.assistantName}
        .messagesLength=${Array.isArray(props.messages) ? props.messages.length : 0}
        .queue=${props.queue}
        .placeholder=${props.connected ? (props.attachments?.length ? "Add a message or paste more images..." : `Message ${props.assistantName || "agent"} (Enter to send)`) : props.disabledReason === '连接失败，请点击重试' ? "连接失败，请检查网络" : "重新连接中..."}
        .onSend=${props.onSend}
        .onDraftChange=${(v: string) => props.onDraftChange(v)}
        .onAbort=${props.onAbort}
        .onAttachmentsChange=${(v: ChatAttachment[]) => props.onAttachmentsChange?.(v)}
        .onNewSession=${props.onNewSession}
        .onQueueRemove=${(id: string) => props.onQueueRemove(id)}
      ></chat-compose-area>

      ${renderConnectionStatus(props)}
    </section>`;
}

const CHAT_HISTORY_RENDER_LIMIT = 200;

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;
  for (const item of items) {
    if (item.kind !== "message") { if (currentGroup) { result.push(currentGroup); currentGroup = null; } result.push(item); continue; }
    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const senderLabel = role.toLowerCase() === "user" ? (normalized.senderLabel ?? null) : null;
    const timestamp = normalized.timestamp || Date.now();
    if (!currentGroup || currentGroup.role !== role || (role.toLowerCase() === "user" && currentGroup.senderLabel !== senderLabel)) {
      if (currentGroup) result.push(currentGroup);
      currentGroup = { kind: "group", key: `group:${role}:${item.key}`, role, senderLabel, messages: [{ message: item.message, key: item.key }], timestamp, isStreaming: false };
    } else { currentGroup.messages.push({ message: item.message, key: item.key }); }
  }
  if (currentGroup) result.push(currentGroup);
  return result;
}

function buildChatItems(props: ChatProps): Array<ChatItem | MessageGroup> {
  const items: ChatItem[] = [];
  const history = Array.isArray(props.messages) ? props.messages : [];
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const historyStart = Math.max(0, history.length - CHAT_HISTORY_RENDER_LIMIT);
  if (historyStart > 0) items.push({ kind: "message", key: "chat:history:notice", message: { role: "system", content: `Showing last ${CHAT_HISTORY_RENDER_LIMIT} messages (${historyStart} hidden).`, timestamp: Date.now() } });
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = normalizeMessage(msg);
    if (!props.showToolCalls && normalized.role.toLowerCase() === "toolresult") continue;
    if (vs.searchOpen && vs.searchQuery.trim() && !messageMatchesSearchQuery(msg, vs.searchQuery)) continue;
    items.push({ kind: "message", key: messageKey(msg, i), message: msg });
  }
  const liftedCanvasSources = tools.map(t => extractChatMessagePreview(t)).filter(Boolean) as Array<{ preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>; text: string | null; timestamp: number | null }>;
  for (const lcs of liftedCanvasSources) {
    const ai = findNearestAssistantMessageIndex(items, lcs.timestamp);
    if (ai == null) continue;
    const item = items[ai];
    if (!item || item.kind !== "message") continue;
    items[ai] = { ...item, message: appendCanvasBlockToAssistantMessage(item.message as Record<string, unknown>, lcs.preview, lcs.text) };
  }
  const segments = props.streamSegments ?? [];
  const maxLen = Math.max(segments.length, tools.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < segments.length && segments[i].text.trim().length > 0) items.push({ kind: "stream" as const, key: `stream-seg:${props.sessionKey}:${i}`, text: segments[i].text, startedAt: segments[i].ts });
    if (i < tools.length && props.showToolCalls) items.push({ kind: "message", key: messageKey(tools[i], i + history.length), message: tools[i] });
  }
  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    if (props.stream.trim().length > 0) items.push({ kind: "stream", key, text: props.stream, startedAt: props.streamStartedAt ?? Date.now() });
    else items.push({ kind: "reading-indicator", key });
  }
  return groupMessages(items);
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) {
    const role = typeof m.role === "string" ? m.role : "unknown";
    const id = typeof m.id === "string" ? m.id : typeof m.messageId === "string" ? m.messageId : typeof m.timestamp === "number" ? `${m.timestamp}:${index}` : String(index);
    return `tool:${role}:${toolCallId}:${id}`;
  }
  const id = typeof m.id === "string" ? m.id : typeof m.messageId === "string" ? m.messageId : "";
  if (id) return `msg:${id}`;
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  return timestamp != null ? `msg:${role}:${timestamp}:${index}` : `msg:${role}:${index}`;
}

function handleDrop(e: DragEvent, props: ChatProps) {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (!files || !props.onAttachmentsChange) return;
  const current = props.attachments ?? [];
  const additions: ChatAttachment[] = []; let pending = 0;
  for (const file of files) { if (!/^image\//.test(file.type)) continue; pending++; const r = new FileReader(); r.addEventListener("load", () => { additions.push({ id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, dataUrl: r.result as string, mimeType: file.type }); pending--; if (pending === 0) props.onAttachmentsChange?.([...current, ...additions]); }); r.readAsDataURL(file); }
}
