/**
 * Shared form field component with label, hint, error, and required marker.
 *
 * Usage:
 *   <app-form-field label="Username" hint="Enter your username" .error=${errorMsg} required>
 *     <input type="text" .value=${username} @input=${onInput} />
 *   </app-form-field>
 *
 * When `error` is set, the slotted input receives aria-invalid="true"
 * via the slotchange handler.
 */
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("app-form-field")
export class AppFormField extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property() label = "";
  @property() hint = "";
  @property() error = "";
  @property({ type: Boolean }) required = false;
  @property({ type: Boolean }) inline = false;

  private _onSlotChange(): void {
    const slot = this.querySelector("slot:not([name])");
    if (!slot) return;
    const assigned = (slot as HTMLSlotElement).assignedElements?.() ?? [];
    if (this.error) {
      for (const el of assigned) {
        if (el instanceof HTMLElement) {
          el.setAttribute("aria-invalid", "true");
        }
      }
    } else {
      for (const el of assigned) {
        el.removeAttribute("aria-invalid");
      }
    }
  }

  render() {
    return html`
      <div class="form-field" part="field">
        ${this.label
          ? html`
              <label class="form-label" part="label">
                ${this.label}${this.required
                  ? html`<span class="required-mark" aria-hidden="true">*</span>`
                  : ""}
              </label>
            `
          : ""}
        <div class="form-control" part="control">
          <slot @slotchange=${this._onSlotChange}></slot>
        </div>
        ${this.hint && !this.error
          ? html`<div class="form-hint" part="hint">${this.hint}</div>`
          : ""}
        ${this.error
          ? html`<div class="form-error" part="error" role="alert">
              ${this.error}
            </div>`
          : ""}
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      margin-bottom: var(--space-md, 12px);
    }
    :host([inline]) {
      display: flex;
      align-items: baseline;
      gap: var(--space-md, 12px);
    }
    :host([inline]) .form-label {
      margin-bottom: 0;
      white-space: nowrap;
      min-width: 100px;
      flex-shrink: 0;
    }
    :host([inline]) .form-control {
      flex: 1;
    }
    .form-field {
      width: 100%;
    }
    .form-label {
      display: block;
      font-size: var(--text-sm, 12px);
      font-weight: 500;
      color: var(--text-strong, #1a1a1e);
      margin-bottom: var(--space-xs, 4px);
      line-height: 1.4;
    }
    :host([error]) .form-label {
      color: var(--danger, #dc2626);
    }
    .required-mark {
      color: var(--danger, #dc2626);
      margin-left: 2px;
    }
    .form-control {
      position: relative;
    }
    :host([error]) .form-control {
      box-shadow: 0 0 0 2px var(--danger-subtle, rgba(220, 38, 38, 0.12));
      border-radius: var(--radius-sm, 6px);
    }
    .form-hint {
      font-size: var(--text-xs, 11px);
      color: var(--muted, #6e6e73);
      margin-top: var(--space-xs, 4px);
      line-height: 1.4;
    }
    .form-error {
      font-size: var(--text-xs, 11px);
      color: var(--danger, #dc2626);
      margin-top: var(--space-xs, 4px);
      line-height: 1.4;
    }
  `;
}
