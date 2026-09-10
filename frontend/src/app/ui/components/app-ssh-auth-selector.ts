import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

export type SshAuthMethod = "password" | "key";

@customElement("app-ssh-auth-selector")
export class AppSshAuthSelector extends LitElement {
  @property() value: SshAuthMethod = "password";
  @property({ type: Boolean }) disabled = false;

  private select(value: SshAuthMethod) {
    if (this.disabled || this.value === value) return;
    this.value = value;
    this.dispatchEvent(new CustomEvent("ssh-auth-change", {
      detail: { value },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    return html`
      <style>
        :host { display:block; min-width:0; }
        .options { display:flex; align-items:center; gap:var(--space-lg); min-height:40px; }
        label { display:inline-flex; align-items:center; gap:var(--space-sm); color:var(--text); cursor:pointer; }
        input { margin:0; accent-color:var(--accent); }
        input:disabled, input:disabled + span { cursor:not-allowed; opacity:var(--disabled-opacity, 0.45); }
      </style>
      <div class="options" role="radiogroup" aria-label="SSH 认证方式">
        <label>
          <input type="radio" name="ssh-auth-method" value="password"
            .checked=${this.value === "password"} .disabled=${this.disabled}
            @change=${() => this.select("password")}>
          <span>密码</span>
        </label>
        <label>
          <input type="radio" name="ssh-auth-method" value="key"
            .checked=${this.value === "key"} .disabled=${this.disabled}
            @change=${() => this.select("key")}>
          <span>SSH 密钥</span>
        </label>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "app-ssh-auth-selector": AppSshAuthSelector;
  }
}
