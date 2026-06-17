/**
 * Unified dialog/modal component with 4 sizes and scale-in animation.
 *
 * Usage:
 *   <app-dialog .open=${showDialog} size="md" title="Confirm" @app-dialog-close=${onClose}>
 *     <p>Dialog content here</p>
 *     <div slot="footer">
 *       <button class="btn" @click=${onCancel}>Cancel</button>
 *       <button class="btn-primary" @click=${onConfirm}>Confirm</button>
 *     </div>
 *   </app-dialog>
 */
import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";

export type DialogSize = "sm" | "md" | "lg" | "xl";

const SIZE_MAP: Record<DialogSize, string> = {
  sm: "400px",
  md: "520px",
  lg: "640px",
  xl: "720px",
};

@customElement("app-dialog")
export class AppDialog extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Boolean }) open = false;
  @property() size: DialogSize = "md";
  @property() title = "";
  @property({ type: Boolean }) closable = true;

  private _previousFocus: HTMLElement | null = null;

  updated(changed: Map<string, unknown>): void {
    if (changed.has("open")) {
      if (this.open) {
        this._previousFocus = document.activeElement as HTMLElement | null;
        this._trapFocus();
      } else if (this._previousFocus) {
        this._previousFocus.focus();
        this._previousFocus = null;
      }
    }
  }

  private _trapFocus(): void {
    // On next frame after render, focus the first focusable element inside dialog.
    requestAnimationFrame(() => {
      const dialog = this.querySelector('[role="dialog"]');
      if (!dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length > 0) {
        focusable[0].focus();
      }
    });
  }

  private _onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && this.closable && this.open) {
      this._close();
    }
  }

  private _onOverlayClick(e: MouseEvent): void {
    // T-120-01: Only close on overlay click, not content click
    if (e.target === e.currentTarget && this.closable) {
      this._close();
    }
  }

  private _close(): void {
    this.open = false;
    this.dispatchEvent(
      new CustomEvent("app-dialog-close", { bubbles: true, composed: true }),
    );
  }

  render() {
    if (!this.open) {
      return nothing;
    }

    const width = SIZE_MAP[this.size] ?? SIZE_MAP.md;

    return html`
      <div
        class="dialog-overlay"
        @click=${this._onOverlayClick}
        @keydown=${this._onKeydown}
      >
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          aria-label="${this.title || nothing}"
          style="max-width: ${width}"
        >
          <div class="dialog-header">
            <span class="dialog-title">${this.title}</span>
            ${this.closable
              ? html`
                  <button
                    class="dialog-close"
                    @click=${this._close}
                    aria-label="Close dialog"
                    type="button"
                  >
                    ×
                  </button>
                `
              : nothing}
          </div>
          <div class="dialog-body">
            <slot></slot>
          </div>
          <div class="dialog-footer">
            <slot name="footer"></slot>
          </div>
        </div>
      </div>
    `;
  }

  static styles = css`
    .dialog-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.3);
      z-index: var(--z-modal, 1000);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-xl, 24px);
      animation: fade-in 200ms var(--ease-out) both;
    }
    .dialog {
      background: var(--card, #fff);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-xl);
      width: 100%;
      max-width: 520px;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      animation: scale-in 200ms var(--ease-out) both;
    }
    .dialog-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-lg) var(--space-xl);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .dialog-title {
      font-size: var(--text-lg, 16px);
      font-weight: 600;
      color: var(--text-strong);
      line-height: 1.3;
    }
    .dialog-close {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      flex-shrink: 0;
      background: none;
      border: 1px solid transparent;
      cursor: pointer;
      color: var(--muted);
      font-size: 20px;
      line-height: 1;
      border-radius: var(--radius-sm);
      transition: all var(--duration-fast, 100ms) var(--ease-out);
    }
    .dialog-close:hover {
      color: var(--text-strong);
      background: var(--bg-hover);
      border-color: var(--border);
    }
    .dialog-body {
      padding: var(--space-xl);
      overflow-y: auto;
      flex: 1;
    }
    .dialog-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-sm);
      padding: var(--space-lg) var(--space-xl);
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }
  `;
}
