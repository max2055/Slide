import { LitElement, html, css, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';

export class StatCard extends LitElement {
  @property({ type: String }) label = '';
  @property({ type: String }) value = '';
  @property({ type: Object }) hint: string | TemplateResult = '';
  @property({ type: String }) variant?: 'ok' | 'warn' | 'danger' | 'info';

  static override styles = css`
    :host {
      display: block;
    }

    .stat-card {
      display: grid;
      gap: 6px;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--card);
      text-align: left;
      transition: border-color var(--duration-normal) var(--ease-out),
                  box-shadow var(--duration-normal) var(--ease-out),
                  transform var(--duration-fast) var(--ease-out);
      animation: rise 0.25s var(--ease-out) backwards;
      position: relative;
    }

    .stat-card:hover {
      border-color: var(--border-strong);
      box-shadow: var(--shadow-sm);
      transform: translateY(-1px);
    }

    .stat-card:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }

    .stat-card__label {
      font-size: 11px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .stat-card__value {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.03em;
      line-height: 1.15;
      color: var(--text-strong);
    }

    .stat-card__hint {
      font-size: 12px;
      color: var(--muted);
      line-height: 1.35;
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-md);
      min-height: 1.35em;
    }

    .stat-card__hint span {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
    }

    .stat-card__hint .danger { color: var(--danger); }

    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      display: inline-block;
    }

    .dot.ok { background: var(--ok); }
    .dot.warn { background: var(--warn); }
    .dot.danger { background: var(--destructive); }

    /* Variant indicator dot (left border style) */
    .stat-card.variant-ok {
      border-left: 3px solid var(--ok);
    }

    .stat-card.variant-warn {
      border-left: 3px solid var(--warn);
    }

    .stat-card.variant-danger {
      border-left: 3px solid var(--destructive);
    }

    .stat-card.variant-info {
      border-left: 3px solid var(--info);
    }

    @keyframes rise {
      from {
        opacity: 0;
        transform: translateY(8px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @media (max-width: 640px) {
      .stat-card {
        padding: 12px;
      }
      .stat-card__value {
        font-size: 18px;
      }
    }
  `;

  override render() {
    const variantClass = this.variant ? `variant-${this.variant}` : '';
    return html`
      <div class="stat-card ${variantClass}" part="root">
        <span class="stat-card__label">${this.label}</span>
        <span class="stat-card__value">${this.value}</span>
        <span class="stat-card__hint">${this.hint}</span>
      </div>`;
  }
}

if (!customElements.get('stat-card')) {
  customElements.define('stat-card', StatCard);
}
