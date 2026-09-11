import { css } from 'lit';
export const dashboardStyles = css`
  :host { display: block; min-width: 0; color: var(--text); container-type: inline-size; --overview-action: color-mix(in srgb, var(--accent) 55%, var(--text-strong)); --btn-primary-bg: var(--overview-action); --btn-primary-color: var(--card); --btn-primary-border: var(--overview-action); --btn-ghost-color: var(--muted-strong); --btn-ghost-hover-color: var(--overview-action); --btn-secondary-border: var(--border); }
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
  app-card { min-width: 0; }
  .risk-row { padding: var(--space-xs) var(--space-sm); border-bottom: 1px solid var(--border); display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: var(--space-sm); row-gap: var(--space-xs); min-width: 0; }
  .risk-row:last-child { border-bottom: 0; }
  .risk-row.selected { background: var(--accent-subtle); box-shadow: inset 3px 0 var(--overview-action); }
  .risk-identity { display: flex; align-items: center; gap: var(--space-sm); min-width: 0; }
  .risk-identity > span { display: flex; color: var(--muted-strong); }
  .resource-name { font-weight: 600; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
  .risk-identity app-badge { flex: none; }
  .risk-row > .actions { justify-content: flex-end; gap: 0; }
  .risk-observation { grid-column: 1 / -1; }
  .risk-observation time { font-variant-numeric: tabular-nums; }
  .risk-observation .relation-select { margin-left: auto; }
  .health-row { display: grid; gap: var(--space-xs); margin-bottom: var(--space-sm); }
  .health-track { display: flex; gap: var(--space-xs); flex-wrap: wrap; }
  .health-track button { font-variant-numeric: tabular-nums; padding: var(--space-xs); }
  .health-track button::before { content: ''; width: 5px; height: 5px; background: var(--muted); border-radius: var(--radius-sm); }
  .health-track .normal::before { background: var(--ok); }
  .health-track .abnormal::before { background: var(--warn); }
  .health-track .unavailable::before { background: var(--danger); }
  .health-bar { display: flex; height: 4px; background: var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .health-bar span { background: var(--muted); }
  .health-bar .normal { background: var(--ok); } .health-bar .abnormal { background: var(--warn); } .health-bar .unavailable { background: var(--danger); }
  .table-scroll { overflow: auto; max-width: 100%; }
  .table-scroll app-data-table { min-width: 760px; }
  .table-scroll td:first-child { max-width: 240px; overflow-wrap: anywhere; }
  .table-scroll td .actions { min-width: 190px; }
  input, select { font: inherit; color: var(--text); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-sm); max-width: 100%; min-width: 0; }
  .filters app-form-field { flex: 1 1 200px; max-width: 360px; }
  .notice { border-left: 3px solid var(--warn); padding: var(--space-sm); color: var(--text); background: var(--warn-subtle); overflow-wrap: anywhere; }
  .metric-row, .engine-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(80px, 2fr) auto; gap: var(--space-sm); align-items: center; margin: var(--space-sm) 0; }
  .engine-row button { justify-content: start; min-width: 0; overflow-wrap: anywhere; }
  meter { width: 100%; accent-color: var(--accent); }
  .metric-row strong { font-variant-numeric: tabular-nums; }
  .trend-chart-container svg { width: 100%; height: 100%; }
  .trend-chart-container { height: 240px; width: 100%; }
  .skeleton { min-height: 100px; border-radius: var(--radius-md); background: var(--border); opacity: .45; }
  .skeleton.large { min-height: 240px; }
  details > summary { cursor: pointer; padding: var(--space-xs) 0; }
  :host { font-size: var(--text-base); line-height: 1.5; }
  app-card::part(root) { border-radius: var(--radius-sm); box-shadow: none; }
  app-card::part(header), app-card::part(footer) { padding: var(--space-sm) var(--space-md); }
  app-card::part(body) { padding: var(--space-md); }
  app-card:not(#resource-details)::part(footer) { display: none; }
  app-card > [slot='header'] { width: 100%; }
  stat-card::part(root) { box-sizing: border-box; border-radius: var(--radius-sm); padding: var(--space-sm) var(--space-md); min-height: 96px; height: 100%; animation: none; transform: none; box-shadow: none; }
  stat-card::part(label), stat-card::part(hint) { color: var(--muted-strong); font-size: var(--text-sm); text-transform: none; letter-spacing: normal; }
  stat-card::part(value) { font-variant-numeric: tabular-nums; }
  stat-card[aria-pressed='true']::part(root) { background: var(--accent-subtle); outline: 1px solid var(--overview-action); outline-offset: -1px; }
  .btn, .btn-ghost, .btn-primary { min-height: 32px; padding: var(--space-xs) var(--space-sm); font-size: var(--text-sm); }
  button[aria-pressed='true'] { background: var(--accent-subtle); color: var(--overview-action); }
  .scope-toolbar { display: flex; flex-wrap: wrap; gap: var(--space-lg); align-items: center; border-bottom: 1px solid var(--border); padding-bottom: var(--space-sm); }
  .scope-switch { gap: 0; }
  .scope-switch .btn { border: 0; border-radius: 0; background: transparent; min-height: 36px; border-bottom: 2px solid transparent; }
  .scope-switch button[aria-selected='true'] { border-bottom-color: var(--overview-action); background: var(--accent-subtle); }
  .scope-filters { margin-left: 0; flex: 0 1 540px; max-width: 540px; align-items: end; flex-wrap: nowrap; }
  .filters app-form-field { margin-bottom: 0; }
  .scope-filters app-form-field::part(field), .capacity-controls app-form-field::part(field) { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: var(--space-sm); }
  .scope-filters app-form-field::part(label), .capacity-controls app-form-field::part(label) { margin: 0; white-space: nowrap; }
  .scope-filters app-form-field { min-width: 0; }
  .main-panels { display: grid; gap: var(--space-md); min-width: 0; }
  .main-panels .risk-row { grid-template-columns: minmax(0, 1fr) auto; }
  .main-panels .risk-row > .actions { grid-row: auto; }
  :host { --overview-series-0: var(--accent); --overview-series-1: color-mix(in srgb, var(--accent) 75%, var(--text-strong)); --overview-series-2: color-mix(in srgb, var(--accent) 45%, var(--card)); --overview-series-3: var(--muted-strong); --overview-series-4: color-mix(in srgb, var(--accent) 25%, var(--card)); --overview-series-5: var(--text-strong); }
  .engine-distribution { display: flex; gap: var(--space-lg); align-items: center; min-height: 210px; }
  .engine-pie { width: 160px; height: 160px; border-radius: 50%; flex: none; }
  .engine-legend { min-width: 0; flex: 1; }
  .engine-key { width: 100%; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; text-align: left; }
  .engine-key > span { overflow-wrap: anywhere; }
  .series-dot { width: 8px; height: 8px; border-radius: var(--radius-sm); }
  .capacity-controls { gap: var(--space-sm); }
  .capacity-controls app-form-field { max-width: 280px; }
  .capacity-panel .trend-chart-container { height: 190px; }
  .chart-notes { color: var(--muted-strong); font-size: var(--text-sm); }

  .scope-filters app-form-field { flex: 1 1 180px; }
  input, select { width: 100%; min-height: 32px; padding: var(--space-xs) var(--space-sm); }
  input:hover, select:hover { border-color: var(--border-strong); }
  :host app-badge { font-size: var(--text-sm); }
  :host app-badge[variant='muted'] { color: var(--muted-strong); }
  :host app-badge[variant='ok'] { color: color-mix(in srgb, var(--ok) 60%, var(--text-strong)); }
  :host app-badge[variant='warn'] { color: color-mix(in srgb, var(--warn) 60%, var(--text-strong)); }
  :host app-badge[variant='danger'] { color: color-mix(in srgb, var(--danger) 60%, var(--text-strong)); }
  .collection-summary, .relation-summary { border-top: 1px solid var(--border); padding-top: var(--space-sm); margin-top: var(--space-sm); }
  .relation-source { overflow-wrap: anywhere; }
  .database-panels { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr); align-items: start; gap: var(--space-md); }
  .inventory-empty::part(header), .inventory-empty::part(footer) { display: none; }
  .empty-content { display: flex; flex-direction: column; align-items: center; padding: var(--space-xl) var(--space-md); }
  .empty-content .btn-primary { width: auto; }
  .empty-state-description { color: var(--muted-strong); }
  @container (max-width: 1000px) { .engine-distribution { flex-wrap: wrap; justify-content: center; } .engine-pie { width: 120px; height: 120px; } .main-panels .risk-row { grid-template-columns: minmax(0, 1fr); } .main-panels .risk-row > .actions { grid-row: 3; } }
  @container (max-width: 1000px) { .risk-row { grid-template-columns: minmax(0, 1fr); } .risk-row > .actions { grid-row: 3; justify-content: flex-start; } .scope-filters { max-width: none; } }
  @container (max-width: 760px) { .dashboard__stat-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } .dashboard__primary, .database-panels { grid-template-columns: minmax(0, 1fr); } .scope-toolbar { align-items: stretch; } .scope-filters { flex-basis: 100%; } }
  @container (max-width: 420px) { .dashboard__stat-cards { grid-template-columns: minmax(0, 1fr); } .metric-row, .engine-row { grid-template-columns: minmax(0, 1fr) auto; } .metric-row meter, .engine-row meter { display: none; } .scope-filters { flex-wrap: wrap; } .risk-identity { flex-wrap: wrap; } .risk-observation .relation-select { margin-left: 0; } }
  @media (pointer: coarse), (max-width: 768px) { .btn, .btn-ghost, .btn-primary, .scope-switch .btn, input, select { min-height: 44px; } .scope-switch { width: 100%; } }
`;
