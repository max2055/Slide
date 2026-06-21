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
          padding: var(--space-lg);
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
          border-bottom: 1px solid var(--border);
          padding-bottom: var(--space-md);
          margin-bottom: var(--space-md);
        }
        .card-footer {
          border-top: 1px solid var(--border);
          padding-top: var(--space-md);
          margin-top: var(--space-md);
          display: flex;
          justify-content: flex-end;
          gap: var(--space-sm);
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
