/**
 * Reusable status badge — driven by CSS custom properties.
 * Usage: <status-badge variant="ok">Active</status-badge>
 *
 * Variants: ok, danger, warn, info, muted
 * Each maps to --{variant}, --{variant}-subtle CSS variables.
 */
import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

export type BadgeVariant = "ok" | "danger" | "warn" | "info" | "muted";

@customElement("status-badge")
export class StatusBadge extends LitElement {
  @property() variant: BadgeVariant = "muted";

  static styles = css`
    :host {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 10px; border-radius: var(--radius-full);
      font-size: 11px; font-weight: 600; white-space: nowrap;
      line-height: 1; letter-spacing: 0.01em;
      background: var(--_badge-bg); color: var(--_badge-color);
      border: 1px solid color-mix(in srgb, var(--_badge-color) 20%, transparent);
      transition: background 0.15s;
    }
    :host::before {
      content: ""; display: inline-block;
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--_badge-color);
      flex-shrink: 0;
    }
    :host([variant="ok"]) {
      --_badge-bg: var(--ok-subtle, rgba(74,222,128,0.12));
      --_badge-color: var(--ok);
    }
    :host([variant="danger"]) {
      --_badge-bg: var(--danger-subtle, rgba(248,113,113,0.12));
      --_badge-color: var(--danger);
    }
    :host([variant="warn"]) {
      --_badge-bg: var(--warn-subtle, rgba(251,191,36,0.12));
      --_badge-color: var(--warn);
    }
    :host([variant="info"]) {
      --_badge-bg: var(--info-subtle, rgba(96,165,250,0.12));
      --_badge-color: var(--info);
    }
    :host([variant="muted"]) {
      --_badge-bg: var(--bg-hover, rgba(131,131,135,0.12));
      --_badge-color: var(--muted);
    }
  `;

  render() {
    return html`<slot></slot>`;
  }
}
