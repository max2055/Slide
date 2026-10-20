import { css } from 'lit';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';

export const operationsStyles = css`${sharedBtnStyles}
  :host { display:block; min-width:0; color:var(--text); font-size:var(--text-md); line-height:1.65; }
  .heading,.toolbar,.row-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--space-sm); }
  .heading { margin-bottom:var(--space-lg); }
  h1 { margin:0; font-size:calc(var(--text-lg) * 1.75); line-height:1.35; color:var(--text-strong); font-weight:600; }
  h2 { font-size:var(--text-xl); color:var(--text-strong); margin:0 0 var(--space-sm); }
  h3 { font-size:var(--text-md); color:var(--text-strong); margin:0 0 var(--space-xs); }
  p { margin:var(--space-xs) 0 var(--space-md); }
  p,dd,strong,li { overflow-wrap:anywhere; }
  .muted,dt { color:var(--muted); font-size:var(--text-base); }
  .layout { display:grid; grid-template-columns:minmax(0,1fr) 286px; gap:var(--space-lg); align-items:start; }
  .stack { display:grid; gap:var(--space-md); min-width:0; }
  app-card { min-width:0; } app-card::part(footer) { display:none; }
  .toolbar { justify-content:flex-start; margin-bottom:var(--space-md); align-items:end; }
  .toolbar label { flex:1 1 140px; max-width:340px; }
  label { display:grid; gap:var(--space-xs); min-width:0; font-size:var(--text-base); }
  input,select,textarea { box-sizing:border-box; min-width:0; width:100%; padding:var(--space-sm); border:1px solid var(--border-strong); border-radius:var(--radius-sm); background:var(--input-bg); color:var(--text); font:inherit; }
  input:focus-visible,select:focus-visible,textarea:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
  input[type=checkbox] { width:auto; }
  .check { display:flex; align-items:start; gap:var(--space-sm); }
  .row { padding:var(--space-md) 0; border-bottom:1px solid var(--border); }
  .row:last-child { border-bottom:0; }
  .row .btn-ghost { white-space:normal; text-align:left; font-size:var(--text-lg); padding-inline:0; }
  .meta { display:flex; flex-wrap:wrap; gap:var(--space-md); color:var(--muted); font-size:var(--text-sm); }
  .notice { padding:var(--space-md); border-inline-start:3px solid var(--accent); background:var(--accent-subtle); margin-block:var(--space-md); border-radius:var(--radius-sm); }
  .warn { border-color:var(--warn); } [role=alert] { color:var(--danger); }
  .article section + section { border-top:1px solid var(--border); margin-top:var(--space-lg); padding-top:var(--space-lg); }
  .article p { white-space:pre-wrap; }
  dl { display:grid; grid-template-columns:minmax(90px,auto) minmax(0,1fr); gap:var(--space-sm) var(--space-md); margin:0; }
  dd { margin:0; } pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:var(--text-sm); }
  summary { cursor:pointer; } details { margin-block:var(--space-md); }
  .form { display:grid; gap:var(--space-md); }
  .skeleton { min-height:120px; background:var(--border); border-radius:var(--radius-md); }
  a { color:var(--accent-text,var(--accent)); overflow-wrap:anywhere; }
  button { max-width:100%; } .toolbar .btn-ghost { white-space:normal; }
  @media(max-width:959px) { .layout { grid-template-columns:minmax(0,1fr); } }
  @media(max-width:500px) { h1 { font-size:24px; } .toolbar label { max-width:none; flex-basis:100%; } dl { grid-template-columns:minmax(0,1fr); gap:var(--space-xs); } dd { margin-bottom:var(--space-sm); } }
`;
