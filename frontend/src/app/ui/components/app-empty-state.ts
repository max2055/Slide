/**
 * Shared empty state component with icon, title, description, and action slot.
 * Usage: <app-empty-state
 *          title="No data"
 *          description="No records found"
 *          icon="inbox"
 *        >
 *          <button slot="actions" class="btn-primary">Add</button>
 *        </app-empty-state>
 */
import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { icons } from "../../../icons.js";

@customElement("app-empty-state")
export class AppEmptyState extends LitElement {
  @property() title = "";
  @property() description = "";
  @property() icon = "";

  createRenderRoot() { return this; }

  private _renderIcon() {
    const svg = icons[this.icon as keyof typeof icons];
    return svg ?? null;
  }

  render() {
    return html`
      <style>
        app-empty-state { display: block; }
        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: var(--space-xl);
          text-align: center;
        }
        .empty-state-icon {
          width: 48px;
          height: 48px;
          color: var(--muted);
          margin-bottom: var(--space-lg);
        }
        .empty-state-icon svg {
          width: 48px;
          height: 48px;
        }
        .empty-state-title {
          font-size: var(--text-lg);
          font-weight: 600;
          color: var(--text-strong);
          margin-bottom: var(--space-sm);
        }
        .empty-state-description {
          font-size: var(--text-sm);
          color: var(--muted);
          max-width: 320px;
          margin: 0 auto;
        }
        .empty-state-actions {
          margin-top: var(--space-lg);
          display: flex;
          gap: var(--space-sm);
          justify-content: center;
        }
      </style>
      <div class="empty-state">
        <slot name="icon">
          ${this.icon
            ? html`<div class="empty-state-icon">${this._renderIcon()}</div>`
            : nothing}
        </slot>
        ${this.title
          ? html`<div class="empty-state-title">${this.title}</div>`
          : ""}
        <slot>
          ${this.description
            ? html`<div class="empty-state-description">${this.description}</div>`
            : nothing}
        </slot>
        <div class="empty-state-actions">
          <slot name="actions"></slot>
        </div>
      </div>
    `;
  }
}
