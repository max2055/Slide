import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** Inline actionable notice shared by chat and login. The caller owns its live region. */
@customElement('app-notice')
export class AppNotice extends LitElement {
  @property({ reflect: true }) severity: 'error' | 'warning' | 'info' = 'error';
  render() {
    return html`
      <style>
        :host { display: block; --notice-color: var(--danger); }
        :host([severity="warning"]) { --notice-color: var(--warn); }
        :host([severity="info"]) { --notice-color: var(--accent); }
        div { padding: var(--space-sm) var(--space-md); margin-block: var(--space-sm);
          border: 1px solid color-mix(in srgb, var(--notice-color) 35%, var(--border));
          background: color-mix(in srgb, var(--notice-color) 8%, var(--card));
          color: var(--text); border-radius: var(--radius-md); font-size: var(--text-sm);
          overflow-wrap: anywhere; }
      </style>
      <div part="notice"><slot></slot></div>`;
  }
}
