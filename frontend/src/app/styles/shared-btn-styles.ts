/**
 * Shared button CSS for LitElement shadow DOM.
 * CSS custom properties (--btn-* etc.) pass through shadow boundaries,
 * so these styles respond to appearance settings globally.
 */
import { css } from "lit";

export const sharedBtnStyles = css`
  .btn-ghost {
    display: inline-flex; align-items: center; gap: 3px;
    background: none;
    border: 1px solid transparent;
    color: var(--btn-ghost-color, var(--muted));
    cursor: pointer;
    padding: 3px 6px;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: 500;
    white-space: nowrap;
    transition: all 0.15s var(--ease-out);
  }
  .btn-ghost:hover { color: var(--btn-ghost-hover-color, var(--accent)); border-color: var(--border); background: var(--btn-ghost-hover-bg, var(--bg-hover)); }
  .btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-primary {
    display: inline-flex; align-items: center; gap: 6px;
    white-space: nowrap;
    background: var(--btn-primary-bg, var(--accent));
    color: var(--btn-primary-color, var(--accent-foreground, #fff));
    border: 1px solid var(--btn-primary-border, var(--accent));
    padding: 7px 16px;
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(0,0,0,0.06), 0 0 0 0 var(--accent-glow);
    transition: all 0.18s var(--ease-out);
  }
  .btn-primary:hover {
    opacity: 0.92;
    box-shadow: 0 2px 6px rgba(0,0,0,0.1), 0 0 0 3px var(--accent-glow);
    transform: translateY(-1px);
  }
  .btn-primary:active { transform: translateY(0); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; transform: none; }
  .btn-primary.btn-danger { background: var(--btn-danger-bg, var(--danger)); border-color: var(--btn-danger-border, var(--danger)); color: var(--btn-danger-color, #fff); }
  .btn-primary.btn-danger:hover { box-shadow: 0 2px 6px rgba(0,0,0,0.1), 0 0 0 3px var(--danger-subtle); }
  .btn-primary.btn-success { background: var(--ok); border-color: var(--ok); }
  .btn-primary.btn-success:hover { box-shadow: 0 2px 6px rgba(0,0,0,0.1), 0 0 0 3px var(--ok-subtle); }

  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    white-space: nowrap;
    background: var(--btn-secondary-bg, var(--secondary, var(--card)));
    border: 1px solid var(--btn-secondary-border, var(--border));
    color: var(--btn-secondary-color, var(--text));
    padding: 7px 16px;
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    box-shadow: 0 1px 1px rgba(0,0,0,0.04);
    transition: all 0.18s var(--ease-out);
  }
  .btn:hover { background: var(--bg-hover); border-color: var(--border-strong); box-shadow: 0 2px 4px rgba(0,0,0,0.06); }
  .btn:active { background: var(--bg-elevated); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }

  .btn-icon {
    display: inline-flex; align-items: center; justify-content: center;
    background: none;
    border: 1px solid transparent;
    cursor: pointer;
    color: var(--muted);
    padding: 4px;
    border-radius: var(--radius-sm);
    transition: all 0.15s var(--ease-out);
  }
  .btn-icon:hover { color: var(--accent); background: var(--accent-subtle); border-color: color-mix(in srgb, var(--accent) 20%, transparent); }
  .btn-icon:disabled { opacity: 0.3; cursor: not-allowed; }

  .btn-sm {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 10px;
    font-size: var(--text-xs);
    font-weight: 600;
    border-radius: var(--radius-sm);
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--secondary, var(--card));
    color: var(--text);
    white-space: nowrap;
    transition: all 0.15s var(--ease-out);
    box-shadow: 0 1px 1px rgba(0,0,0,0.04);
  }
  .btn-sm:hover { background: var(--accent); color: var(--accent-foreground, #fff); border-color: var(--accent); box-shadow: 0 2px 4px var(--accent-subtle); transform: translateY(-1px); }
  .btn-sm:active { transform: translateY(0); }
  .btn-sm.danger { color: var(--danger); border-color: var(--danger); }
  .btn-sm.danger:hover { background: var(--danger); color: #fff; box-shadow: 0 2px 4px var(--danger-subtle); }

  .btn-xs {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 2px 7px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    border-radius: var(--radius-sm);
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--secondary, var(--card));
    color: var(--text);
    transition: all 0.15s var(--ease-out);
  }
  .btn-xs:hover { background: var(--accent); color: var(--accent-foreground, #fff); border-color: var(--accent); }

  .btn-danger-outline {
    display: inline-flex; align-items: center; gap: 4px;
    color: var(--danger);
    border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
    background: var(--danger-subtle);
    padding: var(--space-xs) var(--space-sm);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s var(--ease-out);
  }
  .btn-danger-outline:hover { background: var(--danger); color: #fff; border-color: var(--danger); }
`;
