/**
 * Reusable toggle switch — consistent styling via CSS custom properties.
 * Usage: <app-toggle ?checked=${this.val} @change=${(e) => this.val = e.detail}>Label</app-toggle>
 */
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("app-toggle")
export class AppToggle extends LitElement {
  @property({ type: Boolean }) checked = false;
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean, reflect: true }) compact = false;

  static styles = css`
    :host {
      display: inline-flex; align-items: center; gap: 10px;
      padding: 4px 0; cursor: pointer; vertical-align: middle;
    }
    :host([compact]) { padding: 0; gap: 0; }
    :host([disabled]) { opacity: 0.5; pointer-events: none; }
    .label { font-size: 13px; color: var(--text); }
    :host([compact]) .label { display: none; }
    .toggle {
      width: 44px; height: 24px;
      background: var(--border);
      border-radius: 12px;
      border: none; cursor: pointer;
      position: relative; flex-shrink: 0;
      transition: background 0.2s, box-shadow 0.2s;
    }
    :host([compact]) .toggle { width: 36px; height: 20px; }
    :host([compact]) .toggle::after { width: 16px; height: 16px; }
    :host([compact]) .toggle.on::after { transform: translateX(16px); }
    .toggle.on { background: var(--accent); }
    .toggle::after {
      content: "";
      position: absolute; top: 2px; left: 2px;
      width: 20px; height: 20px;
      background: white; border-radius: 50%;
      transition: transform 0.2s;
      box-shadow: 0 1px 2px rgba(0,0,0,0.15);
    }
    .toggle.on::after { transform: translateX(20px); }
    .toggle:hover { box-shadow: 0 0 0 3px var(--accent-subtle); }
  `;

  render() {
    return html`
      <span class="label"><slot></slot></span>
      <button
        class="toggle ${this.checked ? "on" : ""}"
        type="button"
        ?disabled=${this.disabled}
        @click=${this._toggle}
        aria-pressed=${this.checked}
      ></button>
    `;
  }

  private _toggle() {
    this.checked = !this.checked;
    this.dispatchEvent(new CustomEvent("change", { detail: this.checked, bubbles: true }));
  }
}
