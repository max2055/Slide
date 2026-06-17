import { html, nothing, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { CHAT_ATTACHMENT_ACCEPT, isSupportedChatAttachmentMimeType } from "../chat/attachment-support.ts";
import { icons } from "../../../icons.js";
import { detectTextDirection } from "../text-direction.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { CATEGORY_LABELS, SLASH_COMMANDS, getSlashCommandCompletions, type SlashCommandDef, type SlashCommandCategory } from "../chat/slash-commands.ts";
import { exportChatMarkdown } from "../chat/export.ts";
import { InputHistory } from "../chat/input-history.ts";

interface SM { open: boolean; items: SlashCommandDef[]; index: number; mode: "command" | "args"; command: SlashCommandDef | null; argItems: string[]; }
function smCreate(): SM { return { open: false, items: [], index: 0, mode: "command", command: null, argItems: [] }; }
function smReset(s: SM): void { s.open = false; s.mode = "command"; s.command = null; s.argItems = []; s.items = []; }

const inputHistories = new Map<string, InputHistory>();
function getIH(sessionKey: string): InputHistory { let h = inputHistories.get(sessionKey); if (!h) { h = new InputHistory(); inputHistories.set(sessionKey, h); } return h; }

function adjHeight(el: HTMLTextAreaElement) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 150)}px`; }
function genAttId(): string { return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }
function tokEst(draft: string): string | null { return draft.length < 100 ? null : `~${Math.ceil(draft.length / 4)} tokens`; }

@customElement("chat-compose-area")
export class ChatComposeArea extends LitElement {
  createRenderRoot() { return this; }
  @property({ type: Boolean }) disabled = false;
  @property({ type: String }) placeholder = "";
  @property({ type: String }) draft = "";
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) sending = false;
  @property({ type: String }) stream: string | null = null;
  @property({ type: Boolean }) canAbort = false;
  @property({ type: Array }) attachments: ChatAttachment[] = [];
  @property({ type: String }) sessionKey = "";
  @property({ type: String }) assistantName = "";
  @property({ type: Number }) messagesLength = 0;
  @property({ type: Array }) queue: Array<{ id: string; text?: string; attachments?: unknown[] }> = [];
  @property() onSend?: () => void;
  @property() onDraftChange?: (next: string) => void;
  @property() onAbort?: () => void;
  @property() onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  @property() onNewSession?: () => void;
  @property() onQueueRemove?: (id: string) => void;
  @property() onRequestUpdate?: () => void;

  @state() private _sm: SM = smCreate();

  private updateSm(value: string): void {
    const s = this._sm;
    const argMatch = value.match(/^\/(\S+)\s(.*)$/);
    if (argMatch) {
      const cmd = SLASH_COMMANDS.find(c => c.name === argMatch[1].toLowerCase());
      if (cmd?.argOptions?.length) {
        const filtered = argMatch[2] ? cmd.argOptions.filter(opt => opt.toLowerCase().startsWith(argMatch[2].toLowerCase())) : cmd.argOptions;
        if (filtered.length > 0) { s.mode = "args"; s.command = cmd; s.argItems = filtered; s.open = true; s.index = 0; s.items = []; this.requestUpdate(); return; }
      }
      smReset(s); this.requestUpdate(); return;
    }
    const match = value.match(/^\/(\S*)$/);
    if (match) { const items = getSlashCommandCompletions(match[1]); s.items = items; s.open = items.length > 0; s.index = 0; s.mode = "command"; s.command = null; s.argItems = []; }
    else smReset(s);
    this.requestUpdate();
  }

  private selectCmd(cmd: SlashCommandDef): void {
    const s = this._sm;
    if (cmd.argOptions?.length) { this.onDraftChange?.(`/${cmd.name} `); s.mode = "args"; s.command = cmd; s.argItems = cmd.argOptions; s.open = true; s.index = 0; s.items = []; this.requestUpdate(); return; }
    smReset(s); this.onDraftChange?.(cmd.executeLocal && !cmd.args ? `/${cmd.name}` : `/${cmd.name} `); this.requestUpdate(); if (cmd.executeLocal && !cmd.args) this.onSend?.();
  }

  private tabCmd(cmd: SlashCommandDef): void {
    const s = this._sm;
    if (cmd.argOptions?.length) { this.onDraftChange?.(`/${cmd.name} `); s.mode = "args"; s.command = cmd; s.argItems = cmd.argOptions; s.open = true; s.index = 0; s.items = []; this.requestUpdate(); return; }
    smReset(s); this.onDraftChange?.(cmd.args ? `/${cmd.name} ` : `/${cmd.name}`); this.requestUpdate();
  }

  private selectArg(arg: string, exec: boolean): void {
    const cmdName = this._sm.command?.name ?? ""; smReset(this._sm); this.onDraftChange?.(`/${cmdName} ${arg}`); this.requestUpdate(); if (exec) this.onSend?.();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const s = this._sm, ru = () => this.requestUpdate();
    if (s.open && s.mode === "args" && s.argItems.length > 0) { const l = s.argItems.length; switch (e.key) { case "ArrowDown": e.preventDefault(); s.index = (s.index + 1) % l; ru(); return; case "ArrowUp": e.preventDefault(); s.index = (s.index - 1 + l) % l; ru(); return; case "Tab": e.preventDefault(); this.selectArg(s.argItems[s.index], false); return; case "Enter": e.preventDefault(); this.selectArg(s.argItems[s.index], true); return; case "Escape": e.preventDefault(); smReset(s); ru(); return; } }
    if (s.open && s.items.length > 0) { const l = s.items.length; switch (e.key) { case "ArrowDown": e.preventDefault(); s.index = (s.index + 1) % l; ru(); return; case "ArrowUp": e.preventDefault(); s.index = (s.index - 1 + l) % l; ru(); return; case "Tab": e.preventDefault(); this.tabCmd(s.items[s.index]); return; case "Enter": e.preventDefault(); this.selectCmd(s.items[s.index]); return; case "Escape": e.preventDefault(); smReset(s); ru(); return; } }
    if (e.key === "Escape") return;
    const ih = getIH(this.sessionKey);
    if (!this.draft.trim() && e.key === "ArrowUp") { const p = ih.up(); if (p !== null) { e.preventDefault(); this.onDraftChange?.(p); } return; }
    if (!this.draft.trim() && e.key === "ArrowDown") { e.preventDefault(); this.onDraftChange?.(ih.down() ?? ""); return; }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "f") { e.preventDefault(); this.dispatchEvent(new CustomEvent("toggle-search", { bubbles: true, composed: true })); return; }
    if (e.key === "Enter" && !e.shiftKey) { if (e.isComposing || e.keyCode === 229) return; if (!this.connected) return; e.preventDefault(); if (this.draft.trim()) ih.push(this.draft); this.onSend?.(); }
  }

  private handleInput(e: Event): void {
    const target = e.target as HTMLTextAreaElement;
    adjHeight(target); this.updateSm(target.value); getIH(this.sessionKey).reset(); this.onDraftChange?.(target.value);
  }

  private handlePaste(e: ClipboardEvent): void {
    if (!e.clipboardData?.items || !this.onAttachmentsChange) return;
    const imgs = Array.from(e.clipboardData.items).filter(i => i.type.startsWith("image/"));
    if (imgs.length === 0) return;
    e.preventDefault();
    for (const item of imgs) { const file = item.getAsFile(); if (!file) continue; const r = new FileReader(); r.addEventListener("load", () => { this.onAttachmentsChange?.([...(this.attachments ?? []), { id: genAttId(), dataUrl: r.result as string, mimeType: file.type }]); }); r.readAsDataURL(file); }
  }

  private handleFileSelect(e: Event): void {
    const input = e.target as HTMLInputElement; if (!input.files || !this.onAttachmentsChange) return;
    const current = this.attachments ?? []; const additions: ChatAttachment[] = []; let pending = 0;
    for (const file of input.files) { if (!isSupportedChatAttachmentMimeType(file.type)) continue; pending++; const r = new FileReader(); r.addEventListener("load", () => { additions.push({ id: genAttId(), dataUrl: r.result as string, mimeType: file.type }); pending--; if (pending === 0) this.onAttachmentsChange?.([...current, ...additions]); }); r.readAsDataURL(file); }
    input.value = "";
  }

  private renderAttachPreview(): TemplateResult | typeof nothing {
    const atts = this.attachments ?? []; if (atts.length === 0) return nothing;
    return html`<div class="chat-attachments-preview">${atts.map(att => html`<div class="chat-attachment-thumb"><img src=${att.dataUrl} alt="Attachment preview" /><button class="chat-attachment-remove" type="button" aria-label="Remove attachment" @click=${() => { this.onAttachmentsChange?.((this.attachments ?? []).filter(a => a.id !== att.id)); }}>&times;</button></div>`)}</div>`;
  }

  private renderSlashMenu(): TemplateResult | typeof nothing {
    const s = this._sm; if (!s.open) return nothing;
    if (s.mode === "args" && s.command && s.argItems.length > 0) return html`<div class="slash-menu" role="listbox" aria-label="Command arguments"><div class="slash-menu-group"><div class="slash-menu-group__label">/${s.command.name} ${s.command.description}</div>${s.argItems.map((arg, i) => html`<div class="slash-menu-item ${i === s.index ? "slash-menu-item--active" : ""}" role="option" aria-selected=${i === s.index} @click=${() => this.selectArg(arg, true)} @mouseenter=${() => { s.index = i; this.requestUpdate(); }}>${s.command?.icon ? html`<span class="slash-menu-icon">${icons[s.command.icon]}</span>` : nothing}<span class="slash-menu-name">${arg}</span><span class="slash-menu-desc">/${s.command?.name} ${arg}</span></div>`)}</div><div class="slash-menu-footer"><kbd>↑↓</kbd> navigate <kbd>Tab</kbd> fill <kbd>Enter</kbd> run <kbd>Esc</kbd> close</div></div>`;
    if (s.items.length === 0) return nothing;
    const grouped = new Map<SlashCommandCategory, Array<{ cmd: SlashCommandDef; globalIdx: number }>>();
    for (let i = 0; i < s.items.length; i++) { const cmd = s.items[i]; const cat = cmd.category ?? "session"; let list = grouped.get(cat); if (!list) { list = []; grouped.set(cat, list); } list.push({ cmd, globalIdx: i }); }
    return html`<div class="slash-menu" role="listbox" aria-label="Slash commands">${[...grouped].map(([cat, entries]) => html`<div class="slash-menu-group"><div class="slash-menu-group__label">${CATEGORY_LABELS[cat]}</div>${entries.map(({ cmd, globalIdx }) => html`<div class="slash-menu-item ${globalIdx === s.index ? "slash-menu-item--active" : ""}" role="option" aria-selected=${globalIdx === s.index} @click=${() => this.selectCmd(cmd)} @mouseenter=${() => { s.index = globalIdx; this.requestUpdate(); }}>${cmd.icon ? html`<span class="slash-menu-icon">${icons[cmd.icon]}</span>` : nothing}<span class="slash-menu-name">/${cmd.name}</span>${cmd.args ? html`<span class="slash-menu-args">${cmd.args}</span>` : nothing}<span class="slash-menu-desc">${cmd.description}</span>${cmd.argOptions?.length ? html`<span class="slash-menu-badge">${cmd.argOptions.length} options</span>` : cmd.executeLocal && !cmd.args ? html`<span class="slash-menu-badge">instant</span>` : nothing}</div>`)}</div>`)}<div class="slash-menu-footer"><kbd>↑↓</kbd> navigate <kbd>Tab</kbd> fill <kbd>Enter</kbd> select <kbd>Esc</kbd> close</div></div>`;
  }

  override render() {
    const hasAtt = (this.attachments?.length ?? 0) > 0;
    const isBusy = this.sending || this.stream !== null;
    const canAbort = Boolean(this.canAbort && this.onAbort);
    const tokens = tokEst(this.draft);
    const placeholder = this.connected ? (hasAtt ? "Add a message or paste more images..." : `Message ${this.assistantName || "agent"} (Enter to send)`) : this.placeholder;

    return html`
      ${this.queue.length ? html`<div class="chat-queue" role="status" aria-live="polite"><div class="chat-queue__title">Queued (${this.queue.length})</div><div class="chat-queue__list">${this.queue.map(item => html`<div class="chat-queue__item"><div class="chat-queue__text">${item.text || (item.attachments?.length ? `Image (${item.attachments.length})` : "")}</div><button class="btn chat-queue__remove" type="button" aria-label="Remove queued message" @click=${() => this.onQueueRemove?.(item.id)}>${icons["x"]}</button></div>`)}</div></div>` : nothing}
      ${this.renderSlashMenu()}
      ${this.renderAttachPreview()}
      <input type="file" accept=${CHAT_ATTACHMENT_ACCEPT} multiple class="agent-chat__file-input" @change=${this.handleFileSelect} />
      <textarea ${ref((el) => el && adjHeight(el as HTMLTextAreaElement))} .value=${this.draft} dir=${detectTextDirection(this.draft)} ?disabled=${!this.connected}
        @keydown=${this.handleKeyDown} @input=${this.handleInput} @paste=${this.handlePaste} placeholder=${placeholder} rows="1"></textarea>
      <div class="agent-chat__toolbar">
        <div class="agent-chat__toolbar-left">
          <button class="agent-chat__input-btn" @click=${() => { (this.renderRoot as HTMLElement).querySelector<HTMLInputElement>(".agent-chat__file-input")?.click(); }} title="Attach file" aria-label="Attach file" ?disabled=${!this.connected}>${icons["paperclip"]}</button>
          ${tokens ? html`<span class="agent-chat__token-count">${tokens}</span>` : nothing}
        </div>
        <div class="agent-chat__toolbar-right">
          ${canAbort ? nothing : html`<button class="btn btn--ghost" @click=${this.onNewSession} title="New session" aria-label="New session">${icons["plus"]}</button>`}
          <button class="btn btn--ghost" @click=${() => exportChatMarkdown(this.messagesLength > 0 ? [{ role: "assistant", content: "" }] : [], this.assistantName)} title="Export" aria-label="Export chat" ?disabled=${this.messagesLength === 0}>${icons["download"]}</button>
          ${canAbort ? html`<button class="chat-send-btn chat-send-btn--stop" @click=${this.onAbort} title="Stop" aria-label="Stop generating">${icons["stop"]}</button>`
            : html`<button class="chat-send-btn" @click=${() => { if (this.draft.trim()) getIH(this.sessionKey).push(this.draft); this.onSend?.(); }} ?disabled=${!this.connected || this.sending} title=${isBusy ? "Queue" : "Send"} aria-label=${isBusy ? "Queue message" : "Send message"}>${icons["send"]}</button>`}
        </div>
      </div>`;
  }
}
