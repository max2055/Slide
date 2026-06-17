import { html, nothing, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../../../icons.js";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import { authFetch } from "../../../api/index.js";
import type { SidebarContent } from "../sidebar-content.ts";
import type { ChatItem, MessageGroup } from "../types/chat-types.ts";
import { agentLogoUrl, resolveAgentAvatarUrl } from "../views/agents-utils.ts";
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
} from "../chat/grouped-render.ts";

// Module-level greeting cache
let _agentGreeting: string | null = null;
let _agentGreetingPending = false;

async function _fetchAgentGreeting(requestUpdate: () => void): Promise<void> {
  if (_agentGreeting !== null || _agentGreetingPending) return;
  _agentGreetingPending = true;
  try {
    const res = await authFetch("/api/chat/greeting", { headers: { "Content-Type": "application/json" } });
    if (res.ok) { const data = await res.json(); _agentGreeting = data.greeting || null; }
  } catch { /* silent */ } finally {
    _agentGreetingPending = false;
    requestUpdate();
  }
}

const WELCOME_SUGGESTIONS = ["查看实例运行状态", "列出活跃告警", "分析慢查询 SQL", "查看运维概览"];

function isHeartbeatAckText(text: string | null | undefined): boolean {
  if (!text) return false;
  return /^[\s​-‍﻿⁠ ]+$/.test(text);
}

function collectToolIdsFromAllGroups(chatItems: Array<ChatItem | MessageGroup>): { instanceIds: Set<number>; alertIds: Set<number> } {
  const instanceIds = new Set<number>();
  const alertIds = new Set<number>();
  for (const item of chatItems) {
    if (item.kind !== "group") continue;
    for (const entry of (item as MessageGroup).messages) {
      const msg = entry.message as Record<string, unknown>;
      const raw = msg.content;
      const role = typeof msg.role === "string" ? msg.role : "";
      if (role !== "toolResult" && role !== "tool_result") continue;
      let text = typeof raw === "string" ? raw : Array.isArray(raw) ? (raw as Array<Record<string, unknown>>).map(c => typeof c.text === "string" ? c.text : "").join("\n") : "";
      try { const data = JSON.parse(text); const d = data?.data || data;
        if (Array.isArray(d?.instances)) for (const inst of d.instances) { if (typeof inst.id === "number" && typeof inst.name === "string" && inst.name) instanceIds.add(inst.id); }
        if (Array.isArray(d?.alerts)) for (const a of d.alerts) { if (typeof a.id === "number") alertIds.add(a.id); }
      } catch { /* skip */ }
    }
  }
  return { instanceIds, alertIds };
}

function renderBackLinks(group: MessageGroup, toolInstanceIds: Set<number>, toolAlertIds: Set<number>): TemplateResult | typeof nothing {
  const linkedInstanceIds = new Set<number>(), linkedAlertIds = new Set<number>();
  const hasToolData = toolInstanceIds.size > 0 || toolAlertIds.size > 0;
  for (const entry of group.messages) {
    const msg = entry.message as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : "";
    if (role !== "assistant") continue;
    const raw = msg.content;
    let content = typeof raw === "string" ? raw : Array.isArray(raw) ? (raw as Array<Record<string, unknown>>).map(c => typeof c.text === "string" ? c.text : "").join("\n") : typeof msg.text === "string" ? msg.text : "";
    let m: RegExpExecArray | null;
    while ((m = /实例\s*[#:：]?\s*(\d+)/g.exec(content)) !== null) { const id = parseInt(m[1], 10); if (!hasToolData || toolInstanceIds.has(id)) linkedInstanceIds.add(id); }
    while ((m = /告警\s*[#:：]?\s*(\d+)/g.exec(content)) !== null) { const id = parseInt(m[1], 10); if (!hasToolData || toolAlertIds.has(id)) linkedAlertIds.add(id); }
  }
  if (linkedInstanceIds.size === 0 && linkedAlertIds.size === 0) return nothing;
  const buttons: TemplateResult[] = [];
  for (const id of linkedInstanceIds) buttons.push(html`<button type="button" class="chat-link-btn" @click=${() => { window.dispatchEvent(new CustomEvent("slide-navigate", { detail: { tab: "instance-detail", id } })); }}>查看实例 #${id}</button>`);
  for (const id of linkedAlertIds) buttons.push(html`<button type="button" class="chat-link-btn" @click=${() => { window.dispatchEvent(new CustomEvent("slide-navigate", { detail: { tab: "alerts", id } })); }}>告警 #${id}</button>`);
  return html`<div class="chat-link-row">${buttons}</div>`;
}

function renderWelcomeState(assistantName: string, assistantAvatar: string | null, assistantAvatarUrl: string | undefined, basePath: string, requestUpdate: () => void): TemplateResult {
  const name = assistantName || "Assistant";
  if (_agentGreeting === null && !_agentGreetingPending) _fetchAgentGreeting(requestUpdate);
  const avatar = resolveAgentAvatarUrl({ identity: { avatar: assistantAvatar ?? undefined, avatarUrl: assistantAvatarUrl ?? undefined } });
  const logoUrl = agentLogoUrl(basePath ?? "");
  return html`
    <div class="agent-chat__welcome" style="--agent-color:var(--accent)">
      <div class="agent-chat__welcome-glow"></div>
      ${avatar ? html`<img src=${avatar} alt=${name} style="width:56px;height:56px;border-radius:50%;object-fit:cover;" />`
        : html`<div class="agent-chat__avatar agent-chat__avatar--logo"><img src=${logoUrl} alt="Slide" /></div>`}
      <h2>${name}</h2>
      ${_agentGreeting ? html`<div class="agent-chat__badges"><div class="agent-chat__badge agent-chat__badge--greeting">${unsafeHTML(toSanitizedMarkdownHtml(_agentGreeting!))}</div></div>`
        : html`<div class="agent-chat__badges"><span class="agent-chat__badge"><img src=${logoUrl} alt="" /> Ready to chat</span></div><p class="agent-chat__hint">Type a message below &middot; <kbd>/</kbd> for commands</p>`}
      <div class="agent-chat__suggestions">${WELCOME_SUGGESTIONS.map(text => html`<button type="button" class="agent-chat__suggestion" @click=${() => { this?.dispatchEvent?.(new CustomEvent("suggest", { detail: { text }, bubbles: true, composed: true })); }}>${text}</button>`)}</div>
    </div>`;
}

@customElement("chat-message-list")
export class ChatMessageList extends LitElement {
  createRenderRoot() { return this; }

  @property({ type: Array }) chatItems: Array<ChatItem | MessageGroup> = [];
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) showToolCalls = true;
  @property({ type: Boolean }) showReasoning = false;
  @property({ type: Boolean }) autoExpandToolCalls = false;
  @property({ type: String }) assistantName = "";
  @property({ type: String }) assistantAvatar: string | null = null;
  @property({ type: String }) assistantAvatarUrl: string | null = null;
  @property({ type: String }) basePath = "";
  @property({ type: String }) error: string | null = null;
  @property({ type: Boolean }) showNewMessages = false;
  @property({ type: Boolean }) searchOpen = false;
  @property({ type: String }) searchQuery = "";
  @property({ type: Boolean }) connected = false;

  @property() onOpenSidebar?: (content: SidebarContent) => void;
  @property() onRequestUpdate?: () => void;
  @property() onChatScroll?: (event: Event) => void;
  @property() onScrollToBottom?: () => void;
  @property() onToggleToolExpanded?: (toolCardId: string) => void;
  @property() onDeleteMessage?: (key: string) => void;

  private handleCodeBlockCopy(e: Event) {
    const btn = (e.target as HTMLElement).closest(".code-block-copy");
    if (!btn) return;
    navigator.clipboard.writeText((btn as HTMLElement).dataset.code ?? "").then(() => { btn.classList.add("copied"); setTimeout(() => btn.classList.remove("copied"), 1500); }, () => {});
  }

  override render() {
    const ru = this.onRequestUpdate ?? (() => {});
    const isEmpty = this.chatItems.length === 0 && !this.loading;
    const toolIds = collectToolIdsFromAllGroups(this.chatItems);

    return html`
      <div class="chat-thread" role="log" aria-live="polite" @scroll=${this.onChatScroll} @click=${this.handleCodeBlockCopy}>
        <div class="chat-thread-inner">
          ${this.loading ? html`<div class="chat-loading-skeleton" aria-label="Loading chat">
            <div class="chat-line assistant"><div class="chat-msg"><div class="chat-bubble"><div class="skeleton skeleton-line skeleton-line--long" style="margin-bottom:8px"></div><div class="skeleton skeleton-line skeleton-line--medium" style="margin-bottom:8px"></div><div class="skeleton skeleton-line skeleton-line--short"></div></div></div></div>
            <div class="chat-line user" style="margin-top:12px"><div class="chat-msg"><div class="chat-bubble"><div class="skeleton skeleton-line skeleton-line--medium"></div></div></div></div>
            <div class="chat-line assistant" style="margin-top:12px"><div class="chat-msg"><div class="chat-bubble"><div class="skeleton skeleton-line skeleton-line--long" style="margin-bottom:8px"></div><div class="skeleton skeleton-line skeleton-line--short"></div></div></div></div>
          </div>` : nothing}
          ${isEmpty && !this.searchOpen ? renderWelcomeState(this.assistantName, this.assistantAvatar, this.assistantAvatarUrl ?? undefined, this.basePath, ru) : nothing}
          ${isEmpty && this.searchOpen ? html`<div class="agent-chat__empty">No matching messages</div>` : nothing}
          ${repeat(this.chatItems, (item) => item.key, (item) => {
            if (item.kind === "divider") return html`<div class="chat-divider" role="separator" data-ts=${String(item.timestamp)}><span class="chat-divider__line"></span><span class="chat-divider__label">${item.label}</span><span class="chat-divider__line"></span></div>`;
            if (item.kind === "reading-indicator") return renderReadingIndicatorGroup({ name: this.assistantName, avatar: this.assistantAvatar }, this.basePath);
            if (item.kind === "stream") { if (isHeartbeatAckText(item.text)) return nothing; return renderStreamingGroup(item.text, item.startedAt, this.onOpenSidebar, { name: this.assistantName, avatar: this.assistantAvatar }, this.basePath); }
            if (item.kind === "group") return html`${renderMessageGroup(item, {
              onOpenSidebar: this.onOpenSidebar, showReasoning: this.showReasoning, showToolCalls: this.showToolCalls,
              autoExpandToolCalls: this.autoExpandToolCalls, isToolExpanded: () => false,
              onToggleToolExpanded: (id: string) => this.onToggleToolExpanded?.(id), onRequestUpdate: ru,
              assistantName: this.assistantName, assistantAvatar: this.assistantAvatar, basePath: this.basePath,
              localMediaPreviewRoots: [], assistantAttachmentAuthToken: null, embedSandboxMode: "scripts" as const,
              allowExternalEmbedUrls: false, contextWindow: null,
              onDelete: this.onDeleteMessage ? () => this.onDeleteMessage!(item.key) : undefined,
            })}${renderBackLinks(item, toolIds.instanceIds, toolIds.alertIds)}`;
            return nothing;
          })}
        </div>
      </div>
      ${this.showNewMessages ? html`<button class="chat-new-messages" type="button" @click=${this.onScrollToBottom}>${icons["arrow-down"]} New messages</button>` : nothing}
      ${this.error ? html`<div class="callout danger">${this.error}</div>` : nothing}
    `;
  }
}
