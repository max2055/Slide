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
