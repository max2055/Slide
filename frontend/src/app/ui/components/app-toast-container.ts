/**
 * Global toast notification container.
 * Usage: import { showToast } from "./components/app-toast-container.ts";
 *        showToast("Operation successful", "success");
 *
 * Singleton pattern — call showToast() from anywhere after the container mounts.
 */
import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";

export type ToastType = "success" | "error" | "warning" | "info";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
  exiting: boolean;
}

let _nextId = 0;
let _instance: ToastContainer | null = null;

@customElement("app-toast-container")
export class ToastContainer extends LitElement {
  createRenderRoot() {
    return this;
  }

  @state() private _toasts: Toast[] = [];

  addToast(message: string, type: ToastType = "info"): void {
    const id = _nextId++;
    this._toasts = [{ id, message, type, exiting: false }, ...this._toasts].slice(0, 5);
    setTimeout(() => this._dismiss(id), 3000);
  }

  private _dismiss(id: number): void {
    this._toasts = this._toasts.map((t) =>
      t.id === id ? { ...t, exiting: true } : t,
    );
    setTimeout(() => {
      this._toasts = this._toasts.filter((t) => t.id !== id);
    }, 200);
  }

  private _close(id: number): void {
    this._dismiss(id);
  }

  firstUpdated(): void {
    _instance = this;
  }

  private _iconForType(type: ToastType): string {
    switch (type) {
      case "success":
        return "✓";
      case "error":
        return "✕";
      case "warning":
        return "⚠";
      case "info":
        return "ⓘ";
    }
  }

  render() {
    return html`
      <style>
        .toast-container {
          position: fixed;
          bottom: 20px;
          right: 20px;
          z-index: var(--z-toast, 1100);
          display: flex;
          flex-direction: column;
          gap: 8px;
          pointer-events: none;
        }
        .toast {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 14px;
          border-radius: var(--radius-md);
          background: var(--card);
          border: 1px solid var(--border);
          box-shadow: var(--shadow-lg);
          min-width: 280px;
          max-width: 420px;
          pointer-events: auto;
          animation: toast-enter var(--duration-normal, 180ms) var(--ease-out) both;
        }
        .toast--exit {
          animation: toast-exit var(--duration-normal, 180ms) var(--ease-out) both;
        }
        .toast--success { border-left: 3px solid var(--ok); }
        .toast--error { border-left: 3px solid var(--danger); }
        .toast--warning { border-left: 3px solid var(--warn); }
        .toast--info { border-left: 3px solid var(--info); }
        .toast__icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          font-size: 12px;
          font-weight: 700;
          flex-shrink: 0;
        }
        .toast--success .toast__icon { background: var(--ok-subtle); color: var(--ok); }
        .toast--error .toast__icon { background: var(--danger-subtle); color: var(--danger); }
        .toast--warning .toast__icon { background: var(--warn-subtle); color: var(--warn); }
        .toast--info .toast__icon { background: var(--accent-subtle); color: var(--accent); }
        .toast__msg {
          flex: 1;
          font-size: var(--text-sm);
          color: var(--text-strong);
          line-height: 1.4;
        }
        .toast__close {
          background: none;
          border: none;
          cursor: pointer;
          color: var(--muted);
          padding: 4px 6px;
          font-size: 16px;
          line-height: 1;
          border-radius: var(--radius-sm);
          transition: all var(--duration-fast, 100ms) var(--ease-out);
        }
        .toast__close::after { content: "×"; }
        .toast__close:hover { color: var(--text-strong); background: var(--bg-hover); }
        @keyframes toast-enter {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes toast-exit {
          from { opacity: 1; transform: translateX(0); }
          to { opacity: 0; transform: translateX(40px); }
        }
      </style>
      <div class="toast-container" role="status" aria-live="polite">
        ${this._toasts.map(
          (t) => html`
            <div class="toast toast--${t.type}${t.exiting ? " toast--exit" : ""}">
              <span class="toast__icon">${this._iconForType(t.type)}</span>
              <span class="toast__msg">${t.message}</span>
              <button class="toast__close" @click=${() => this._close(t.id)} aria-label="Dismiss"></button>
            </div>
          `,
        )}
      </div>
    `;
  }
}

export function showToast(message: string, type: ToastType = "info"): void {
  if (_instance) {
    _instance.addToast(message, type);
  } else {
    console.warn("showToast: app-toast-container not yet mounted");
  }
}
