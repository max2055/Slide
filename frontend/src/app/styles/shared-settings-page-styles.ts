import { css } from "lit";

export const sharedSettingsPageStyles = css`
  :host { display: block; min-width: 0; max-width: 70rem; }
  .page-header { margin-bottom: var(--space-lg); }
  .page-header h1 {
    margin: 0 0 var(--space-xs);
    color: var(--text-strong);
    font-size: var(--text-2xl);
    font-weight: 700;
    line-height: 1.35;
  }
  .page-header p {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-md);
    line-height: 1.6;
  }
`;

export const settingsManagementHeaderStyles = css`
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    margin-bottom: var(--space-lg);
  }
  .page-header h1 {
    margin: 0;
    color: var(--text-strong);
    font-size: var(--text-2xl);
    line-height: 1.35;
  }
`;

export const settingsEditorActionsStyles = css`
  .settings-editor-actions {
    position: sticky;
    inset-block-start: var(--settings-editor-sticky-top, 0);
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-lg);
    margin-block-end: var(--space-sm);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--card);
  }
  .settings-editor-status {
    flex: 1 1 auto;
    color: var(--muted);
    font-size: var(--text-sm);
  }
  .settings-editor-status [role="alert"] { color: var(--danger); }
  .settings-editor :is(input, textarea, summary, button):focus-visible {
    scroll-margin-block-start: calc(var(--control-height) + var(--space-xl) + var(--space-md));
  }
`;
