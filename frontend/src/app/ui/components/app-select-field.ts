/**
 * Reusable select field with label and optional description.
 * Usage: <app-select-field label="Page Size" .value=${10} .options=${opts} @change=${handler}></app-select-field>
 */
import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

export interface SelectOption {
  value: string | number;
  label: string;
}

@customElement("app-select-field")
export class AppSelectField extends LitElement {
  @property() label = "";
  @property() desc = "";
  @property() value: string | number = "";
  @property({ type: Array }) options: SelectOption[] = [];

  static styles = [sharedFieldStyles, css`
    :host { display: block; }
    label { font-size: 13px; color: var(--text); display: block; margin-bottom: 4px; }
    .desc { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
    select {
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--card);
      color: var(--text);
      font-size: 13px;
      width: 100%;
      min-width: 0;
    }
  `];

  render() {
    return html`
      ${this.label ? html`<label for="value">${this.label}</label>` : null}
      ${this.desc ? html`<div class="desc">${this.desc}</div>` : null}
      <select id="value" .value=${String(this.value)} @change=${this._onChange}>
        ${this.options.map((o) => html`
          <option value=${o.value} ?selected=${String(this.value) === String(o.value)}>${o.label}</option>
        `)}
      </select>
    `;
  }

  private _onChange(e: Event) {
    const raw = (e.target as HTMLSelectElement).value;
    // Try numeric if the original value was numeric
    const num = Number(raw);
    const resolved = typeof this.value === "number" && !isNaN(num) ? num : raw;
    this.value = resolved;
    this.dispatchEvent(new CustomEvent("change", { detail: resolved, bubbles: true }));
  }
}
