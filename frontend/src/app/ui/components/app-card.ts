/**
 * Shared card component with header/body/footer slots.
 * Usage: <app-card variant="elevated">
 *          <span slot="header">Title</span>
 *          <p>Body content</p>
 *          <div slot="footer"><button>Action</button></div>
 *        </app-card>
 *
 * Variants: default (bg + border), elevated (+ shadow), bordered (transparent bg)
 */
import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

export type CardVariant = "default" | "elevated" | "bordered";

@customElement("app-card")
export class AppCard extends LitElement {
  @property() variant: CardVariant = "default";

  createRenderRoot() { return this.attachShadow({ mode: "open" }); }

  private _onHeaderSlotChange(e: Event) {
    const slot = e.target as HTMLSlotElement;
    const container = slot.parentElement;
    if (container) container.classList.toggle("empty", slot.assignedNodes().length === 0);
  }
  private _onFooterSlotChange(e: Event) {
    const slot = e.target as HTMLSlotElement;
    const container = slot.parentElement;
    if (container) container.classList.toggle("empty", slot.assignedNodes().length === 0);
  }

  render() {
    return html`
      <style>
        :host { display: block; }
        .card {
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
          overflow: hidden;
        }
        .card--elevated {
          box-shadow: var(--shadow-md);
        }
        .card--bordered {
          background: transparent;
          box-shadow: none;
        }
        .card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: var(--space-sm);
          font-size: var(--text-md);
          font-weight: 600;
          color: var(--text-strong);
          background: var(--bg-elevated);
          border-bottom: 1px solid var(--border);
          padding: var(--space-md) var(--space-lg);
        }
        .card-header.empty { display: none; }
        .card-header ::slotted(svg) {
          width: 16px;
          height: 16px;
          opacity: 0.72;
          vertical-align: -2px;
        }
        .card-body {
          padding: var(--space-lg);
        }
        .card-footer {
          border-top: 1px solid var(--border);
          padding: var(--space-md) var(--space-lg);
          display: flex;
          justify-content: flex-end;
          gap: var(--space-sm);
          background: var(--bg-elevated);
        }
        .card-footer.empty { display: none; }
      </style>
      <div class="card card--${this.variant}">
        <div class="card-header">
          <slot name="header" @slotchange=${this._onHeaderSlotChange}></slot>
        </div>
        <div class="card-body"><slot></slot></div>
        <div class="card-footer">
          <slot name="footer" @slotchange=${this._onFooterSlotChange}></slot>
        </div>
      </div>
    `;
  }
}
