/**
 * Shared form field component with label, hint, error, and required marker.
 *
 * Usage:
 *   <app-form-field label="Username" hint="Enter your username" .error=${errorMsg} required>
 *     <input type="text" .value=${username} @input=${onInput} />
 *   </app-form-field>
 *
 * Native label/description proxies stay in the slotted control's tree so ID
 * references never cross a shadow boundary. Existing caller names are retained.
 */
import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("app-form-field")
export class AppFormField extends LitElement {
  @property() label = "";
  @property() hint = "";
  @property() error = "";
  @property({ type: Boolean }) required = false;
  @property({ type: Boolean, reflect: true }) inline = false;

  private static nextId = 0;
  private readonly associationId = `app-form-field-${++AppFormField.nextId}`;
  private readonly nativeLabel = document.createElement("label");
  private readonly description = document.createElement("span");
  private control?: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  private previousInvalid: string | null = null;
  private ownsInvalid = false;
  private readonly observer = new MutationObserver(() => this.syncControl());

  override connectedCallback(): void {
    super.connectedCallback();
    this.observer.observe(this, { childList: true, subtree: true });
    this.syncControl();
  }

  override disconnectedCallback(): void {
    this.observer.disconnect();
    this.releaseControl();
    super.disconnectedCallback();
  }

  override updated(): void { this.syncControl(); }

  private restoreInvalid(): void {
    if (this.control && this.ownsInvalid) {
      if (this.control.getAttribute("aria-invalid") === "true") {
        if (this.previousInvalid === null) this.control.removeAttribute("aria-invalid");
        else this.control.setAttribute("aria-invalid", this.previousInvalid);
      }
      this.ownsInvalid = false;
    }
  }

  private releaseControl(): void {
    if (this.control) this.describeControl("");
    this.restoreInvalid();
    this.nativeLabel.htmlFor = "";
    this.control = undefined;
  }

  private describeControl(text: string): void {
    const control = this.control!;
    const ids = (control.getAttribute("aria-describedby") ?? "").split(/\s+/)
      .filter(id => id && id !== this.description.id);
    if (text) ids.push(this.description.id);
    if (ids.length) control.setAttribute("aria-describedby", ids.join(" "));
    else control.removeAttribute("aria-describedby");
  }

  private syncControl(): void {
    if (!this.isConnected) return;
    const control = Array.from(this.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input:not([type=hidden]), select, textarea"))
      .find(element => element.closest("app-form-field") === this);
    if (control !== this.control) { this.releaseControl(); this.control = control; }
    if (!control) return;
    if (!control.id) control.id = `${this.associationId}-control`;
    // These are slotted, visually hidden nodes, not a migration of the field DOM.
    this.nativeLabel.slot = this.description.slot = "accessible-text";
    this.description.id = `${this.associationId}-description`;
    if (this.nativeLabel.parentNode !== this) this.append(this.nativeLabel);
    if (this.description.parentNode !== this) this.append(this.description);
    const hasCallerLabel = Array.from(control.labels ?? []).some(label => label !== this.nativeLabel);
    this.nativeLabel.htmlFor = this.label && !hasCallerLabel ? control.id : "";
    if (this.nativeLabel.textContent !== this.label) this.nativeLabel.textContent = this.label;
    const text = this.error || this.hint;
    if (this.description.textContent !== text) this.description.textContent = text;
    this.describeControl(text);
    if (this.error) {
      if (!this.ownsInvalid) { this.previousInvalid = control.getAttribute("aria-invalid"); this.ownsInvalid = true; }
      control.setAttribute("aria-invalid", "true");
    } else this.restoreInvalid();
  }

  render() {
    return html`
      <style>
        :host {
          display: block;
          margin-bottom: var(--space-md, 12px);
        }
        :host([inline]) {
          display: block;
        }
        :host([inline]) .form-field {
          display: grid;
          grid-template-columns: minmax(120px, var(--app-form-field-label-width, 180px)) minmax(0, 1fr);
          column-gap: var(--space-lg, 20px);
          row-gap: var(--space-xs, 4px);
          align-items: start;
        }
        :host([inline]) .form-label {
          grid-column: 1;
          grid-row: 1;
          margin-bottom: 0;
          overflow-wrap: anywhere;
          padding-top: 10px;
        }
        :host([inline]) .form-control {
          grid-column: 2;
          grid-row: 1;
          min-width: 0;
        }
        :host([inline]) .form-hint,
        :host([inline]) .form-error {
          grid-column: 2;
          margin-top: 0;
        }
        @media (max-width: 720px) {
          :host([inline]) .form-field { grid-template-columns: 1fr; }
          :host([inline]) .form-label,
          :host([inline]) .form-control,
          :host([inline]) .form-hint,
          :host([inline]) .form-error { grid-column: 1; }
          :host([inline]) .form-label,
          :host([inline]) .form-control { grid-row: auto; }
          :host([inline]) .form-label { padding-top: 0; }
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
          color: var(--muted);
          margin-top: 6px;
          line-height: 1.4;
        }
        .form-error {
          font-size: var(--text-xs, 11px);
          color: var(--danger, #dc2626);
          margin-top: var(--space-xs, 4px);
          line-height: 1.4;
        }
        .accessible-text {
          position: absolute;
          width: 1px;
          height: 1px;
          overflow: hidden;
          clip-path: inset(50%);
          white-space: nowrap;
        }
      </style>
      <div class="form-field" part="field">
        ${this.label
          ? html`
              <label class="form-label" part="label" @click=${() => this.control?.focus()}>
                ${this.label}${this.required
                  ? html`<span class="required-mark" aria-hidden="true">*</span>`
                  : ""}
              </label>
            `
          : ""}
        <div class="form-control" part="control">
          <slot @slotchange=${this.syncControl}></slot>
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
      <span class="accessible-text"><slot name="accessible-text"></slot></span>
    `;
  }
}
