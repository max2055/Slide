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

  createRenderRoot() { return this; }

  private _hasHeader = false;
  private _hasFooter = false;

  private _onSlotChange(e: Event, which: "header" | "footer") {
    const slot = e.target as HTMLSlotElement;
    const has = slot.assignedNodes().length > 0;
    if (which === "header" && has !== this._hasHeader) {
      this._hasHeader = has;
      this.requestUpdate();
    } else if (which === "footer" && has !== this._hasFooter) {
      this._hasFooter = has;
      this.requestUpdate();
    }
  }

  render() {
    return html`
      <style>
        app-card { display: block; }
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
          border-bottom: 1px solid var(--border);
          padding-bottom: var(--space-md);
          margin-bottom: var(--space-md);
        }
        .card-header[hidden] { display: none; }
        .card-footer {
          border-top: 1px solid var(--border);
          padding-top: var(--space-md);
          margin-top: var(--space-md);
          display: flex;
          justify-content: flex-end;
          gap: var(--space-sm);
        }
        .card-footer[hidden] { display: none; }
      </style>
      <div class="card card--${this.variant}">
        <div class="card-header" ?hidden=${!this._hasHeader}>
          <slot name="header" @slotchange=${(e: Event) => this._onSlotChange(e, "header")}></slot>
        </div>
        <div class="card-body"><slot></slot></div>
        <div class="card-footer" ?hidden=${!this._hasFooter}>
          <slot name="footer" @slotchange=${(e: Event) => this._onSlotChange(e, "footer")}></slot>
        </div>
      </div>
    `;
  }
}
