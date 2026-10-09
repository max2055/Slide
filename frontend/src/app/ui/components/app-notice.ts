import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { LitElement, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** Inline actionable notice shared by chat and login. The caller owns its live region. */
@customElement('app-notice')
export class AppNotice extends LitElement {
  @property({ reflect: true }) severity: 'error' | 'warning' | 'info' = 'error';
  @property({ type: Boolean }) dismissible = false;
  render() {
    return html`
      <style>
        ${sharedBtnStyles.cssText}
        :host { display: block; --notice-color: var(--danger); }
        :host([severity="warning"]) { --notice-color: var(--warn); }
        :host([severity="info"]) { --notice-color: var(--accent); }
        div { display: flex; align-items: flex-start; gap: var(--space-sm); padding: var(--space-sm) var(--space-md); margin-block: var(--space-sm);
          border: 1px solid color-mix(in srgb, var(--notice-color) 35%, var(--border));
          background: color-mix(in srgb, var(--notice-color) 8%, var(--card));
          color: var(--text); border-radius: var(--radius-md); font-size: var(--text-sm);
          overflow-wrap: anywhere; }
        .notice-content { flex: 1; min-width: 0; }
        .btn-ghost { flex: none; padding: 0 var(--space-xs); font: inherit; }
        button:focus-visible { outline: 2px solid var(--accent); border-radius: var(--radius-sm); }
      </style>
      <div part="notice"><span class="notice-content"><slot></slot></span>${this.dismissible ? html`<button class="btn-ghost" type="button" aria-label="关闭提示"
        @click=${() => this.dispatchEvent(new CustomEvent('dismiss', { bubbles: true, composed: true }))}>×</button>` : nothing}</div>`;
  }
}
