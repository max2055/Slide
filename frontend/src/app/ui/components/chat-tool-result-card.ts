import { html, nothing, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../../../icons.js";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import type { ToolCard } from "../types/chat-types.ts";
import "../components/app-badge.ts";

/**
 * Renders a tool result card inside an app-card wrapper.
 * Shows tool name, status badge, duration, and result content.
 */
@customElement("chat-tool-result-card")
export class ChatToolResultCard extends LitElement {
  createRenderRoot() { return this; }

  @property({ type: Object }) result: ToolCard | null = null;
  @property({ type: Boolean }) collapsible = true;

  override render() {
    if (!this.result) return nothing;

    const card = this.result;
    const hasOutput = Boolean(card.outputText?.trim());
    const status = card.kind === "result" ? (hasOutput ? "ok" : "muted") : "info";

    return html`
      <div class="chat-tool-result-card" style="margin:4px 0;border:1px solid var(--border);border-radius:var(--radius-md);overflow:hidden;">
        <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-subtle);border-bottom:1px solid var(--border);font-size:13px;">
          <span style="font-weight:600;flex:1;">${card.name}</span>
          <app-badge variant=${status}>${card.kind}</app-badge>
          ${this.collapsible ? html`<button class="btn btn--ghot" style="padding:2px 6px;font-size:12px;" @click=${() => this.dispatchEvent(new CustomEvent("collapse-toggle", { detail: { id: card.id }, bubbles: true, composed: true }))}>${icons["chevron-down"]}</button>` : nothing}
        </div>
        ${hasOutput ? html`<div style="padding:8px 12px;max-height:300px;overflow-y:auto;"><pre style="margin:0;font-size:12px;white-space:pre-wrap;word-break:break-all;">${unsafeHTML(toSanitizedMarkdownHtml(card.outputText!))}</pre></div>` : nothing}
        ${card.args ? html`<details style="padding:4px 12px;font-size:11px;color:var(--muted);"><summary>Input</summary><pre style="font-size:11px;white-space:pre-wrap;">${JSON.stringify(card.args, null, 2)}</pre></details>` : nothing}
      </div>`;
  }
}
