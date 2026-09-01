import { css } from "lit";

/** Shared layout contract for resource list search, filters, actions, and result feedback. */
export const sharedResourceToolbarStyles = css`
  .resource-toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-md) var(--space-lg);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }

  .resource-toolbar .search-box,
  .resource-toolbar .resource-search {
    position: relative;
    flex: 1 1 300px;
    min-width: 240px;
    max-width: 400px;
  }

  .resource-toolbar .search-input,
  .resource-toolbar .resource-search-input {
    box-sizing: border-box;
    width: 100%;
    height: 40px;
    padding: var(--space-sm) var(--space-md) var(--space-sm) 34px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: var(--text-base);
    color: var(--text);
    background: var(--card);
    transition: all var(--duration-normal) var(--ease-out);
  }

  .resource-toolbar .search-input:focus,
  .resource-toolbar .resource-search-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-subtle);
  }

  .resource-toolbar .search-icon {
    position: absolute;
    left: 10px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--muted);
    display: flex;
    opacity: 0.6;
  }

  .resource-toolbar .filter-select,
  .resource-toolbar .resource-filter {
    flex: 0 1 148px;
    width: 148px;
    min-width: 128px;
    height: 40px;
    box-sizing: border-box;
    padding: var(--space-sm) var(--space-md);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--text);
    background: var(--card);
  }

  .resource-toolbar .filter-select:focus,
  .resource-toolbar .resource-filter:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-subtle);
  }

  .resource-toolbar .filter-group {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    flex-wrap: wrap;
  }

  .resource-toolbar .filter-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    height: 40px;
    padding: var(--space-sm) var(--space-md);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text);
    background: var(--secondary);
    cursor: pointer;
    transition: all var(--duration-normal) var(--ease-out);
  }

  .resource-toolbar .filter-btn:hover {
    border-color: var(--border-strong);
    background: var(--bg-hover);
  }

  .resource-toolbar .filter-btn.active {
    background: var(--accent);
    color: var(--accent-foreground);
    border-color: var(--accent);
  }

  .resource-toolbar .toolbar-actions {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    margin-left: auto;
  }

  .resource-toolbar .resource-action {
    min-height: 40px;
    box-sizing: border-box;
    justify-content: center;
  }

  .resource-toolbar .resource-action--refresh {
    min-width: 88px;
  }

  .resource-toolbar .resource-action--add {
    min-width: 128px;
  }

  .resource-toolbar-meta {
    display: flex;
    align-items: center;
    gap: var(--space-md);
    min-height: 40px;
    padding: 0 var(--space-lg);
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: var(--text-sm);
  }

  .resource-result-count {
    color: var(--text-strong);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .resource-filter-state {
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
  }

  .resource-filter-state::before {
    content: "";
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
  }

  .resource-filter-reset {
    margin-left: auto;
  }

  @media (max-width: 900px) {
    .resource-toolbar .search-box,
    .resource-toolbar .resource-search {
      flex-basis: calc(100% - 160px);
      max-width: none;
    }

    .resource-toolbar .toolbar-actions {
      margin-left: 0;
    }
  }

  @media (max-width: 640px) {
    .resource-toolbar {
      padding: var(--space-sm) var(--space-md);
    }

    .resource-toolbar .search-box,
    .resource-toolbar .resource-search,
    .resource-toolbar .filter-select,
    .resource-toolbar .resource-filter {
      flex: 1 1 100%;
      width: 100%;
      max-width: none;
    }

    .resource-toolbar .toolbar-actions {
      width: 100%;
      justify-content: flex-end;
    }

    .resource-toolbar-meta {
      padding: 0 var(--space-md);
    }
  }
`;

export const sharedResourceToolbarCssText = sharedResourceToolbarStyles.cssText;
