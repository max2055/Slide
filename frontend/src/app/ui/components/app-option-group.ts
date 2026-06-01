/**
 * Reusable option button group (single-select).
 * Usage: <app-option-group .value=${v} .options=${opts} @change=${handler}></app-option-group>
 */
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

export interface OptionItem {
  value: string | number;
  label: string;
}

@customElement("app-option-group")
export class AppOptionGroup extends LitElement {
  @property() value: string | number = "";
  @property({ type: Array }) options: OptionItem[] = [];
  @property({ type: Boolean }) multi = false;
  @property({ type: Array }) selected: (string | number)[] = [];

  static styles = css`
    :host { display: flex; gap: 6px; flex-wrap: wrap; }
    button {
      flex: 1; min-width: 0;
      padding: 8px 6px;
      border: 2px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--card);
      cursor: pointer;
      font-size: 13px; color: var(--text);
      text-align: center;
      transition: border-color 0.15s, background 0.15s;
    }
    button:hover { background: var(--bg-hover); }
    button.active {
      border-color: var(--accent);
      background: var(--accent-subtle);
      color: var(--text-strong);
    }
  `;

  render() {
    return html`
      ${this.options.map((o) => {
        const active = this.multi
          ? this.selected.includes(o.value)
          : this.value === o.value;
        return html`
          <button
            class=${active ? "active" : ""}
            @click=${() => this._select(o.value)}
          >${o.label}</button>
        `;
      })}
    `;
  }

  private _select(v: string | number) {
    if (this.multi) {
      let next: (string | number)[];
      if (this.selected.includes(v)) {
        next = this.selected.filter((s) => s !== v);
      } else {
        next = [...this.selected, v];
      }
      this.selected = next;
      this.dispatchEvent(new CustomEvent("change", { detail: next, bubbles: true }));
    } else {
      this.value = v;
      this.dispatchEvent(new CustomEvent("change", { detail: v, bubbles: true }));
    }
  }
}
