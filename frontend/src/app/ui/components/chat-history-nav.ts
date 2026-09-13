import { html, LitElement, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import type { HistoryTurn } from "../chat/history-navigation.ts";
import "./app-card.ts";

@customElement("chat-history-nav")
export class ChatHistoryNav extends LitElement {
  @property({ attribute: false }) turns: HistoryTurn[] = [];
  @property() sessionKey = "";
  @property() stream = "";
  @property({ attribute: false }) onNavigate?: (turn: HistoryTurn) => void;
  @state() private hovered = -1;
  @state() private activeKey = "";
  @state() private previewTop = 0;
  private thread: HTMLElement | null = null;
  private anchors: HTMLElement[] = [];
  private mutationObserver?: MutationObserver;
  private resizeObserver?: ResizeObserver;
  private frame = 0;
  private highlightTimer?: ReturnType<typeof setTimeout>;
  private highlighted?: HTMLElement;
  private jumpVersion = 0;
  private pointerY: number | null = null;

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.detach();
  }

  private detach() {
    this.thread?.removeEventListener("scroll", this.schedulePosition);
    this.thread = null;
    this.mutationObserver?.disconnect();
    this.resizeObserver?.disconnect();
    cancelAnimationFrame(this.frame);
    clearTimeout(this.highlightTimer);
    this.highlighted?.classList.remove("chat-history-highlight");
    this.jumpVersion++;
  }

  protected override updated(changed: PropertyValues) {
    if (changed.has("sessionKey")) {
      if (this.thread) delete this.thread.dataset.historyReading;
      this.detach();
      this.hovered = -1;
      this.activeKey = "";
    }
    const thread = this.parentElement?.querySelector<HTMLElement>(".chat-thread") ?? null;
    if (thread !== this.thread) {
      this.detach();
      this.thread = thread;
      this.thread?.addEventListener("scroll", this.schedulePosition, { passive: true });
      this.mutationObserver = new MutationObserver(this.refreshAnchors);
      if (thread) this.mutationObserver.observe(thread, { childList: true, subtree: true });
      this.resizeObserver = new ResizeObserver(this.schedulePosition);
      if (thread) {
        this.resizeObserver.observe(thread);
        const inner = thread.querySelector(".chat-thread-inner");
        if (inner) this.resizeObserver.observe(inner);
      }
      this.resizeObserver.observe(this);
      this.refreshAnchors();
    }
    if (changed.has("turns")) this.refreshAnchors();
    if (this.hovered >= 0) {
      const card = this.renderRoot.querySelector<HTMLElement>("app-card");
      const button = this.renderRoot.querySelectorAll(".tick")[this.hovered];
      if (card && button) {
        const bounds = this.getBoundingClientRect();
        const top = Math.max(0, Math.min(button.getBoundingClientRect().top - bounds.top, bounds.height - card.offsetHeight));
        if (Math.abs(this.previewTop - top) > 1) this.previewTop = top;
      }
    }
  }

  private refreshAnchors = () => {
    this.anchors = Array.from(this.thread?.querySelectorAll<HTMLElement>("[data-chat-turn]") ?? []);
    this.schedulePosition();
  };

  private schedulePosition = () => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      if (!this.thread || !this.anchors.length) return;
      const top = this.thread.getBoundingClientRect().top + 32;
      let active = this.anchors[0];
      for (const anchor of this.anchors) {
        if (anchor.getBoundingClientRect().top > top) break;
        active = anchor;
      }
      if (this.thread.scrollHeight - this.thread.scrollTop - this.thread.clientHeight <= 4) active = this.anchors[this.anchors.length - 1];
      const key = active.dataset.chatTurn ?? "";
      if (key !== this.activeKey) {
        this.activeKey = key;
        // Follow transcript scrolling only while the user is not browsing the ruler.
        if (this.hovered < 0) {
          const index = this.turns.findIndex((turn) => turn.key === key);
          const button = this.renderRoot.querySelectorAll<HTMLElement>(".tick")[index];
          const ruler = this.renderRoot.querySelector<HTMLElement>("nav");
          if (button && ruler) {
            if (button.offsetTop < ruler.scrollTop) ruler.scrollTop = button.offsetTop;
            else if (button.offsetTop + button.offsetHeight > ruler.scrollTop + ruler.clientHeight) ruler.scrollTop = button.offsetTop + button.offsetHeight - ruler.clientHeight;
          }
        }
      }
    });
  };

  private preview(index: number) {
    this.hovered = index;
    const button = this.renderRoot.querySelectorAll(".tick")[index];
    if (button) this.previewTop = Math.max(0, button.getBoundingClientRect().top - this.getBoundingClientRect().top);
  }

  private close = () => { this.hovered = -1; this.pointerY = null; };

  private rulerScrolled = () => {
    if (this.pointerY === null) { this.requestUpdate(); return; }
    const ruler = this.renderRoot.querySelector<HTMLElement>("nav");
    const first = this.renderRoot.querySelector<HTMLElement>(".tick");
    if (!ruler || !first) return;
    const index = Math.floor((this.pointerY - ruler.getBoundingClientRect().top + ruler.scrollTop) / first.offsetHeight);
    if (index >= 0 && index < this.turns.length) this.preview(index);
  };

  async navigate(turn: HistoryTurn) {
    const version = ++this.jumpVersion;
    this.close();
    if (this.thread) this.thread.dataset.historyReading = "true";
    this.onNavigate?.(turn);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (version !== this.jumpVersion || !this.isConnected || !this.thread) return;
    this.refreshAnchors();
    const target = this.anchors.find((anchor) => anchor.dataset.chatTurn === turn.key);
    if (!target) return;
    // Set position immediately so scheduled streaming scrolls cannot win the race.
    this.thread.scrollTop += target.getBoundingClientRect().top - this.thread.getBoundingClientRect().top - 8;
    this.activeKey = turn.key;
    this.highlighted?.classList.remove("chat-history-highlight");
    clearTimeout(this.highlightTimer);
    this.highlighted = target;
    target.classList.add("chat-history-highlight");
    this.highlightTimer = setTimeout(() => target.classList.remove("chat-history-highlight"), 1600);
  }

  private keydown(event: KeyboardEvent, index: number) {
    if (event.key === "Escape") { this.close(); return; }
    let next = index;
    if (event.key === "ArrowDown") next++;
    else if (event.key === "ArrowUp") next--;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = this.turns.length - 1;
    else return;
    event.preventDefault();
    this.renderRoot.querySelectorAll<HTMLButtonElement>(".tick")[Math.max(0, Math.min(next, this.turns.length - 1))]?.focus();
  }

  override render() {
    const turn = this.turns[this.hovered];
    const answer = turn === this.turns[this.turns.length - 1] && this.stream.trim() ? this.stream.slice(0, 400) : turn?.answer;
    return html`
      <style>
        :host { display: block; position: absolute; inset: var(--space-sm) auto var(--space-sm) 0; width: 4rem; z-index: 5; }
        :host([hidden]) { display: none; }
        :host > div { height: 100%; }
        nav { position: relative; height: 100%; overflow: auto; scrollbar-width: none; overscroll-behavior: contain; }
        nav::-webkit-scrollbar { display: none; }
        .tick { display: flex; align-items: center; width: 100%; height: 1.25rem; padding: 0 var(--space-sm); border: 0; background: transparent; cursor: pointer; }
        .tick::before { content: ""; display: block; width: var(--tick-width, .75rem); height: .1875rem; flex-shrink: 0; background: var(--border-strong, var(--border)); transition: width 120ms ease-out, background 120ms ease-out; }
        .tick[aria-current="true"]::before { background: var(--muted); }
        .tick[data-hovered]::before { background: var(--text-strong); }
        .tick:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: var(--radius-sm); }
        app-card { position: absolute; left: 100%; width: min(24rem, calc(var(--history-panel-width, 100vw) - 5rem)); max-height: 100%; overflow: auto; overscroll-behavior: contain; }
        app-card::part(header), app-card::part(footer) { display: none; }
        app-card::part(body) { padding: var(--space-md); }
        .question { color: var(--text-strong); font-weight: 600; -webkit-line-clamp: 2; }
        .answer { color: var(--muted); margin-top: var(--space-sm); -webkit-line-clamp: 4; }
        .question, .answer { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; line-height: 1.5; }
        @media (prefers-reduced-motion: reduce) { .tick::before { transition: none; } }
      </style>
      <div @pointerleave=${this.close} @focusout=${(event: FocusEvent) => { if (!this.renderRoot.contains(event.relatedTarget as Node)) this.close(); }}>
        <nav aria-label="历史对话导航" @scroll=${this.rulerScrolled} @pointermove=${(event: PointerEvent) => { this.pointerY = event.clientY; this.rulerScrolled(); }}>
          ${repeat(this.turns, (entry) => entry.key, (entry, index) => {
            const distance = this.hovered < 0 ? 99 : Math.abs(index - this.hovered);
            const width = distance < 4 ? 3.25 - distance * .625 : .75;
            return html`<button type="button" class="tick" style=${styleMap({ "--tick-width": `${width}rem` })}
              aria-label=${`第 ${index + 1} 轮：${entry.question}`} aria-current=${String(entry.key === this.activeKey)}
              aria-describedby=${index === this.hovered ? "history-preview" : nothing}
              tabindex=${entry.key === this.activeKey || (!this.activeKey && index === 0) ? 0 : -1}
              ?data-hovered=${index === this.hovered}
              @pointerenter=${() => this.preview(index)} @focus=${() => this.preview(index)}
              @keydown=${(event: KeyboardEvent) => this.keydown(event, index)} @click=${() => this.navigate(entry)}></button>`;
          })}
        </nav>
        ${turn ? html`<app-card id="history-preview" role="tooltip" variant="elevated" style=${styleMap({ top: `${this.previewTop}px` })}>
          <div class="question">${turn.question}</div>
          <div class="answer">${answer || "暂无回复"}</div>
        </app-card>` : nothing}
      </div>`;
  }
}
