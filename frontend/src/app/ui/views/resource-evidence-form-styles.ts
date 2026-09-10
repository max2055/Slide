import { css } from 'lit';
export const resourceEvidenceFormStyles = css`
  :host { display: block; min-width: 0; color: var(--text); }
  section { border-top: 1px solid var(--border); padding: var(--space-lg) 0; }
  header, .actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm); }
  header { justify-content: space-between; } h2 { font-size: 16px; color: var(--text-strong); }
  form { padding-top: var(--space-md); } .fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-sm); }
  input:not([type="checkbox"]), textarea, select { box-sizing: border-box; width: 100%; min-width: 0; padding: var(--space-sm); color: var(--text); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-sm); font: inherit; }
  textarea { min-height: 80px; resize: vertical; } article { border-bottom: 1px solid var(--border); padding: var(--space-sm) 0; }
  p, code, summary, label { overflow-wrap: anywhere; } .meta { font-size: 12px; color: var(--muted); }
  .error { color: var(--danger); } .skeleton { height: 80px; background: var(--border); opacity: .4; }
  svg { width: 16px; height: 16px; } details { margin: var(--space-sm) 0; } summary { cursor: pointer; }
  .evidence-option { display: flex; align-items: flex-start; gap: var(--space-sm); padding: var(--space-sm) 0; }
  .evidence-option span { min-width: 0; } .evidence-option code { display: block; }
  @media (max-width: 640px) { .fields { grid-template-columns: minmax(0, 1fr); } }
`;
