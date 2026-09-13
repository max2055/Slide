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
import { LitElement, html, nothing } from "lit";
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
  @property({ type: Boolean }) open = false;
  @property() size: DialogSize = "md";
  @property() title = "";
  @property({ type: Boolean }) closable = true;
  @property({ type: Boolean }) closeOnOverlay = true;

  private _previousFocus: HTMLElement | null = null;

  private _nativeDialog: HTMLDialogElement | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate();
  }

  disconnectedCallback(): void {
    this._closeNative();
    super.disconnectedCallback();
  }

  updated(): void {
    if (!this.open) { this._closeNative(); return; }
    const dialog = this.renderRoot.querySelector<HTMLDialogElement>('dialog');
    if (!dialog || !this.isConnected || dialog.open) return;
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    this._previousFocus = active instanceof HTMLElement ? active : null;
    this._nativeDialog = dialog;
    // Native modal semantics include the composed slot tree and make the background inert.
    dialog.showModal();
  }

  private _closeNative(): void {
    this._nativeDialog?.close();
    this._nativeDialog = null;
    if (this._previousFocus?.isConnected) this._previousFocus.focus();
    this._previousFocus = null;
  }

  private _onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Tab" || e.composedPath().find(node => node instanceof HTMLDialogElement) !== this._nativeDialog) return;
    const focusable: HTMLElement[] = [];
    const visit = (element: Element): void => {
      if (element.hasAttribute("inert") || element.matches(":disabled") || element.hasAttribute("hidden")) return;
      if (element instanceof HTMLElement && element.tabIndex >= 0 &&
          element.getClientRects().length && getComputedStyle(element).visibility !== "hidden") focusable.push(element);
      const children = element instanceof HTMLSlotElement
        ? element.assignedElements({ flatten: true })
        : element.shadowRoot ? Array.from(element.shadowRoot.children) : Array.from(element.children);
      children.forEach(visit);
    };
    if (!this._nativeDialog) return;
    visit(this._nativeDialog);
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!first || (e.shiftKey ? active === first : active === last)) {
      e.preventDefault();
      (e.shiftKey ? last : first)?.focus();
    }
  }

  private _onCancel(e: Event): void {
    e.preventDefault();
    if (this.closable) this._close();
  }

  private _onOverlayClick(e: MouseEvent): void {
    // T-120-01: Only close on overlay click, not content click
    if (e.target === e.currentTarget && this.closeOnOverlay && this.closable) {
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
      <style>
        *, *::before, *::after { box-sizing: border-box; }
        .dialog-overlay {
          position: fixed;
          inset: 0;
          margin: 0;
          border: 0;
          width: 100vw;
          height: 100dvh;
          max-width: none;
          max-height: none;
          background: transparent;
          color: inherit;
          z-index: var(--z-modal, 1000);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: var(--space-xl, 24px);
          animation: fade-in 200ms var(--ease-out) both;
        }
        .dialog-overlay::backdrop { background: rgba(0, 0, 0, 0.3); }
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
      </style>
      <dialog
        class="dialog-overlay"
        aria-label=${this.title || nothing}
        @click=${this._onOverlayClick}
        @cancel=${this._onCancel}
        @keydown=${this._onKeyDown}
      >
        <div
          class="dialog"
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
      </dialog>
    `;
  }
}
