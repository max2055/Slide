/**
 * Reusable status badge — driven by CSS custom properties.
 * Light DOM parallel of <status-badge> with identical API.
 * Usage: <app-badge variant="ok">Active</app-badge>
 *
 * Variants: ok, danger, warn, info, muted
 * Each maps to --{variant}, --{variant}-subtle CSS variables.
 */
import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

export type BadgeVariant = "ok" | "danger" | "warn" | "info" | "muted";

@customElement("app-badge")
export class AppBadge extends LitElement {
  @property() variant: "ok" | "danger" | "warn" | "info" | "muted" = "muted";

  createRenderRoot() { return this; }

  render() {
    return html`
      <style>
        app-badge {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 3px 10px; border-radius: var(--radius-full);
          font-size: 11px; font-weight: 600; white-space: nowrap;
          line-height: 1; letter-spacing: 0.01em;
        }
        app-badge::before {
          content: ""; display: inline-block;
          width: 6px; height: 6px; border-radius: 50%;
          flex-shrink: 0;
        }
        app-badge[variant="ok"] {
          background: var(--ok-subtle, rgba(21,128,61,0.12));
          color: var(--ok);
          border: 1px solid color-mix(in srgb, var(--ok) 20%, transparent);
        }
        app-badge[variant="ok"]::before { background: var(--ok); }
        app-badge[variant="danger"] {
          background: var(--danger-subtle, rgba(220,38,38,0.12));
          color: var(--danger);
          border: 1px solid color-mix(in srgb, var(--danger) 20%, transparent);
        }
        app-badge[variant="danger"]::before { background: var(--danger); }
        app-badge[variant="warn"] {
          background: var(--warn-subtle, rgba(180,83,9,0.12));
          color: var(--warn);
          border: 1px solid color-mix(in srgb, var(--warn) 20%, transparent);
        }
        app-badge[variant="warn"]::before { background: var(--warn); }
        app-badge[variant="info"] {
          background: var(--info-subtle, rgba(37,99,235,0.12));
          color: var(--info);
          border: 1px solid color-mix(in srgb, var(--info) 20%, transparent);
        }
        app-badge[variant="info"]::before { background: var(--info); }
        app-badge[variant="muted"] {
          background: var(--bg-hover, rgba(131,131,135,0.12));
          color: var(--muted);
          border: 1px solid color-mix(in srgb, var(--muted) 20%, transparent);
        }
        app-badge[variant="muted"]::before { background: var(--muted); }
      </style>
      <slot></slot>
    `;
  }
}
