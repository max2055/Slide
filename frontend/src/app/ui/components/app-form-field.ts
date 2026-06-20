/**
 * Shared form field component with label, hint, error, and required marker.
 *
 * Usage:
 *   <app-form-field label="Username" hint="Enter your username" .error=${errorMsg} required>
 *     <input type="text" .value=${username} @input=${onInput} />
 *   </app-form-field>
 *
 * When `error` is set, the slotted input receives aria-invalid="true"
 * via the `updated()` lifecycle hook.
 */
import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("app-form-field")
export class AppFormField extends LitElement {
  @property() label = "";
  @property() hint = "";
  @property() error = "";
  @property({ type: Boolean }) required = false;
  @property({ type: Boolean }) inline = false;

  updated(changed: Map<string, unknown>): void {
    if (changed.has("error")) {
      const control = this.querySelector("input, select, textarea");
      if (control) {
        if (this.error) {
          control.setAttribute("aria-invalid", "true");
        } else {
          control.removeAttribute("aria-invalid");
        }
      }
    }
  }

  render() {
    return html`
      <style>
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
          margin-left: 4px;
          vertical-align: middle;
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
          color: #999;
          margin-top: 6px;
          line-height: 1.4;
        }
        .form-error {
          font-size: var(--text-xs, 11px);
          color: var(--danger, #dc2626);
          margin-top: var(--space-xs, 4px);
          line-height: 1.4;
        }
      </style>
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
          <slot></slot>
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
}
