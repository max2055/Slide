import { css } from 'lit';
export const dashboardStyles = css`
  :host { display: block; min-width: 0; color: var(--text); container-type: inline-size; --overview-action: color-mix(in srgb, var(--accent) 55%, var(--text-strong)); --btn-primary-bg: var(--overview-action); --btn-primary-color: var(--card); --btn-primary-border: var(--overview-action); --btn-ghost-color: var(--muted-strong); --btn-ghost-hover-color: var(--overview-action); --btn-secondary-border: var(--muted); }
  * { box-sizing: border-box; }
  .dashboard-grid { display: grid; gap: var(--space-md); padding-bottom: var(--space-xl); min-width: 0; }
  h1 { font-size: var(--text-xl); margin: 0; color: var(--text-strong); }
  h2 { font-size: var(--text-md); margin: 0; }
  p { margin: var(--space-sm) 0; }
  svg { width: 20px; height: 20px; flex: none; }
  .toolbar, .actions, .filters, .metadata { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm); min-width: 0; }
  .toolbar { justify-content: space-between; }
  .metadata, small { color: var(--muted-strong, var(--muted)); font-size: var(--text-sm); }
  a { color: var(--overview-action); text-decoration: none; overflow-wrap: anywhere; }
  a:hover { text-decoration: underline; }
  button:focus-visible, a:focus-visible, select:focus-visible, input:focus-visible, summary:focus-visible, stat-card:focus-visible { outline: 2px solid var(--overview-action); outline-offset: 2px; }
  button, a, stat-card { -webkit-tap-highlight-color: transparent; }
  .scope-switch { display: flex; gap: var(--space-xs); flex-wrap: wrap; }
  .scope-switch button[aria-selected='true'] { color: var(--overview-action); background: var(--accent-subtle); border-color: var(--overview-action); }
  .dashboard__stat-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-md); }
  stat-card { min-width: 0; cursor: pointer; font-variant-numeric: tabular-nums; }
  .dashboard__primary { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); align-items: start; gap: var(--space-md); }
  .side-panels { display: grid; gap: var(--space-md); min-width: 0; }
  app-card { min-width: 0; }
  .risk-row { padding: var(--space-sm) 0; border-bottom: 1px solid var(--border); display: grid; gap: var(--space-xs); min-width: 0; }
  .risk-row:last-child { border-bottom: 0; }
  .resource-name { font-weight: 600; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
  .risk-row .metadata { font-size: var(--text-xs); }
  .health-row { display: grid; gap: var(--space-xs); margin-bottom: var(--space-md); }
  .health-track { display: flex; gap: var(--space-xs); flex-wrap: wrap; }
  .health-track button { font-variant-numeric: tabular-nums; border-bottom: 3px solid var(--border-strong); }
  .health-track .normal { border-bottom-color: var(--ok); }
  .health-track .abnormal { border-bottom-color: var(--warn); }
  .health-track .unavailable { border-bottom-color: var(--danger); }
  .health-bar { display: flex; height: 12px; background: var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .health-bar span { background: var(--muted); }
  .health-bar .normal { background: var(--ok); } .health-bar .abnormal { background: var(--warn); } .health-bar .unavailable { background: var(--danger); }
  .table-scroll { overflow: auto; max-width: 100%; }
  .table-scroll app-data-table { min-width: 760px; }
  .table-scroll td:first-child { max-width: 240px; overflow-wrap: anywhere; }
  .table-scroll td .actions { min-width: 190px; }
  input, select { font: inherit; color: var(--text); background: var(--card); border: 1px solid var(--muted); border-radius: var(--radius-sm); padding: var(--space-sm); max-width: 100%; min-width: 0; }
  .filters app-form-field { flex: 1 1 200px; max-width: 360px; }
  .notice { border-left: 3px solid var(--warn); padding: var(--space-sm); color: var(--text); background: var(--warn-subtle); overflow-wrap: anywhere; }
  .metric-row, .engine-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(80px, 2fr) auto; gap: var(--space-sm); align-items: center; margin: var(--space-sm) 0; }
  .engine-row button { justify-content: start; min-width: 0; overflow-wrap: anywhere; }
  meter { width: 100%; accent-color: var(--accent); }
  .metric-row strong { font-variant-numeric: tabular-nums; }
  .trend-chart-container { height: 240px; width: 100%; }
  .skeleton { min-height: 100px; border-radius: var(--radius-md); background: var(--border); opacity: .45; }
  .skeleton.large { min-height: 240px; }
  details > summary { cursor: pointer; padding: var(--space-xs) 0; }
  @container (max-width: 760px) { .dashboard__stat-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } .dashboard__primary { grid-template-columns: minmax(0, 1fr); } }
  @container (max-width: 420px) { .dashboard__stat-cards { grid-template-columns: minmax(0, 1fr); } .metric-row, .engine-row { grid-template-columns: minmax(0, 1fr) auto; } .metric-row meter, .engine-row meter { display: none; } }
`;
