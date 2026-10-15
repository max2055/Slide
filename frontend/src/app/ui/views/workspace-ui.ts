import { css, html, type TemplateResult } from 'lit';
import type { Column } from '../components/app-data-table.js';
import '../components/app-card.js';
import '../components/app-dialog.js';
import '../components/app-data-table.js';
import '../components/app-empty-state.js';
import '../components/app-form-field.js';
import '../components/app-badge.js';
import '../../../components/stat-card.js';
export const fmt = (value: number) => value.toLocaleString('en-US');
// Automatic activation for the two workspaces' native button tabs.
export function tabKeydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const current = tabs.indexOf(event.target as HTMLButtonElement);
  if (current < 0) return;
  event.preventDefault();
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[index].focus(); tabs[index].click();
}
export const badge = (label: string, variant = 'muted') => html`<app-badge variant=${variant}>${label}</app-badge>`;
export const stat = (label: string, value: string, hint: string) => html`<stat-card .label=${label} .value=${value} .hint=${hint}></stat-card>`;
export const pairs = (rows: Array<[string, unknown]>) => html`<dl class="definition">${rows.map(([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`)}</dl>`;
export const table = (columns: Column[], rows: Record<string, unknown>[], emptyMessage = '暂无数据'): TemplateResult => html`<div class="table-wrap" tabindex="0" aria-label="数据表格，可横向滚动"><app-data-table .columns=${columns} .rows=${rows} .striped=${false} .emptyMessage=${emptyMessage}></app-data-table></div>`;
export const workspaceStyles = css`
.conflict { color:var(--danger); } pre { white-space:pre-wrap; overflow-wrap:anywhere; }
:host { display:block; min-width:0; color:var(--text); }
*, *::before, *::after { box-sizing:border-box; }
app-card { min-width:0; }
button,input,select { font:inherit; }
a { color:var(--accent-text); }
p,dd,code { overflow-wrap:anywhere; }
:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-xl); margin-bottom: var(--space-xl); }
h1 { color: var(--text-strong); font-size: 24px; line-height: 1.3; font-weight: 650; letter-spacing: -.03em; margin: 0 0 var(--space-sm); }
h2 { color: var(--text-strong); font-size: 15px; line-height: 1.5; margin: 0; font-weight: 600; }
h3 { color: var(--text-strong); font-size: 14px; margin: 0 0 var(--space-sm); }
p { margin: 0 0 var(--space-md); }
.muted, .caption { color: var(--muted); }
.caption { font-size: 12px; }
.small { font-size: 12px; }
.notice { display: flex; align-items: flex-start; gap: var(--space-md); padding: 13px var(--space-lg); background: var(--warn-subtle); border-left: 3px solid var(--warn); border-radius: var(--radius-sm); margin-bottom: var(--space-xl); font-size: 12px; }
.notice svg { width: 18px; height: 18px; color: var(--warn); flex-shrink: 0; margin-top: 2px; }
.notice strong { display: block; color: var(--text-strong); font-size: 13px; }
.notice.neutral { background: var(--bg-accent); border-color: var(--border-strong); }
.section-head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-md); margin: 28px 0 var(--space-md); }
.section-head p { margin: 0; }
.table-wrap { overflow-x: auto; }
.table-wrap app-data-table { min-width: 590px; }
.data-table { table-layout: fixed; }
.data-table td { vertical-align: middle; overflow-wrap: anywhere; }
.data-table th { white-space: nowrap; }
.entity { color: var(--text-strong); font-weight: 600; }
.entity-sub { color: var(--muted); font-size: 12px; margin-top: 3px; }
.mono { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.link { padding: 0; background: transparent; border: 0; color: var(--accent-text); text-align: left; }
.link:hover { text-decoration: underline; }
.stack { display: grid; gap: var(--space-lg); }
.split { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(250px, 1fr); gap: var(--space-lg); }
.metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-md); margin-bottom: var(--space-xl); }
.metrics.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.snapshot { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-lg); padding-bottom: var(--space-lg); }
.snapshot-title { display: flex; align-items: center; gap: var(--space-md); margin-bottom: var(--space-sm); }
.snapshot-title svg { width: 24px; color: var(--accent-text); }
.snapshot-title h2 { font-size: 18px; }
.snapshot-counts { display: flex; flex-wrap: wrap; border-top: 1px solid var(--border); padding-top: var(--space-lg); gap: 36px; }
.snapshot-counts .number { font-size: 22px; color: var(--text-strong); font-weight: 650; font-variant-numeric: tabular-nums; }
.snapshot-counts .caption { margin-left: var(--space-sm); }
.details-line { display: flex; align-items: center; justify-content: space-between; margin-top: var(--space-lg); border-top: 1px solid var(--border); padding-top: var(--space-lg); gap: var(--space-lg); }
.definition { margin: 0; }
.definition > div { display: flex; justify-content: space-between; gap: var(--space-lg); padding: 10px 0; border-bottom: 1px solid var(--border); }
.definition > div:last-child { border-bottom: 0; }
dt { color: var(--muted); font-size: 12px; }
dd { margin: 0; color: var(--text-strong); text-align: right; font-variant-numeric: tabular-nums; }
.definitions-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-xl); }
.rules { margin: 0; padding-left: var(--space-lg); color: var(--muted); font-size: 12px; line-height: 1.8; }
.tabs { display: flex; border-bottom: 1px solid var(--border); margin-bottom: var(--space-lg); gap: var(--space-xl); overflow-x: auto; }
.tab { background: transparent; border: 0; border-bottom: 2px solid transparent; padding: 12px 0; color: var(--muted); white-space: nowrap; }
.tab[aria-selected="true"] { border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
.tab span { font-size: 11px; margin-left: 6px; }
.toolbar { display: flex; gap: var(--space-md); align-items: end; flex-wrap: wrap; margin-bottom: var(--space-lg); }
.toolbar app-form-field { flex: 1; min-width: 170px; margin: 0; }
.toolbar app-form-field.filter { max-width: 210px; }
input, select { border: 1px solid var(--border-strong); background: var(--bg); color: var(--text); border-radius: var(--radius-sm); padding: 8px var(--space-md); }
input { width: 100%; }
.toolbar select { width: 100%; }
.paging { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--space-md); border-top: 1px solid var(--border); padding: var(--space-md) var(--space-lg); font-size: 12px; }
.paging select { padding: 3px 8px; font-size: 12px; }
.detail-back { display: inline-flex; gap: var(--space-sm); align-items: center; color: var(--muted); font-size: 12px; margin-bottom: var(--space-lg); text-decoration: none; }
.detail-back:hover { color: var(--accent-text); }
.detail-back svg { width: 15px; }
.detail-note { font-size: 12px; color: var(--muted); margin: var(--space-md) 0 0; }
.dialog-section { padding: 0 0 var(--space-lg); margin-bottom: var(--space-lg); border-bottom: 1px solid var(--border); }
.dialog-section:last-child { border: 0; margin: 0; padding: 0; }
.tool-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-sm); }
.tool-list li { padding: var(--space-sm); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.tool-list code { display: block; font-size: 10px; color: var(--muted); overflow-wrap: anywhere; }
details { margin-top: var(--space-md); }
summary { cursor: pointer; color: var(--muted); font-size: 12px; }
.metadata { padding: var(--space-md); background: var(--bg); border-radius: var(--radius-sm); margin-top: var(--space-md); }
.metadata code { display: block; overflow-wrap: anywhere; font-size: 11px; color: var(--text); }
.metadata dt { margin-top: var(--space-md); }
.metadata dt:first-child { margin-top: 0; }
.empty-space { min-height: 190px; display: grid; place-items: center; }
.state-box { min-height: 280px; display: grid; align-items: center; }
.loading-line { height: 18px; margin: var(--space-xl) 0; background: var(--border); border-radius: var(--radius-sm); max-width: 75%; animation: pulse 1.2s ease-in-out infinite alternate; }
@keyframes pulse { to { opacity: .35; } }
.diagnosis-picker { display:grid; grid-template-columns:minmax(160px,1fr) minmax(230px,1.8fr) auto; align-items:center; gap:var(--space-lg); padding:var(--space-lg); }
.diagnosis-picker app-form-field { margin-bottom:0; }
.diagnosis-picker select { width:100%; }
.diagnosis-context { display:flex; align-items:center; justify-content:space-between; gap:var(--space-lg); flex-wrap:wrap; padding:var(--space-xl) 0 var(--space-sm); }
.diagnosis-context h2 { font-size:20px; }
.diagnosis-context p { margin:var(--space-sm) 0 0; }
.diagnosis-intro { font-size:13px; padding-bottom:var(--space-lg); border-bottom:1px solid var(--border); margin-bottom:var(--space-lg); }
.diagnosis-workspace { display:grid; grid-template-columns:minmax(0,1fr) 270px; gap:var(--space-xl); }
.diagnosis-main .table-wrap app-data-table { min-width:550px; }
.diagnosis-main .tabs { gap:var(--space-xl); }
.diagnosis-subhead { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:var(--space-sm); margin-bottom:var(--space-lg); }
.diagnosis-subhead [aria-pressed="true"] { color:var(--accent-text); background:var(--accent-subtle); border-color:var(--border); }
.diagnosis-value { display:inline-block; margin-left:var(--space-sm); font-variant-numeric:tabular-nums; }
.diagnosis-aside { display:grid; align-content:start; gap:var(--space-lg); }
.diagnosis-gap { padding-bottom:var(--space-md); margin-bottom:var(--space-md); border-bottom:1px solid var(--border); }
.diagnosis-gap strong { font-size:13px; }
.diagnosis-gap p { margin:var(--space-xs) 0 0; }
.diagnosis-source-link { padding-top:var(--space-md); margin-top:var(--space-md); border-top:1px solid var(--border); }
.diagnosis-result { margin-top:var(--space-xl); }
.diagnosis-result h3 { margin-top:var(--space-lg); }
.diagnosis-return { margin-top:var(--space-lg); }
@media(max-width:1200px) { .diagnosis-workspace { grid-template-columns:minmax(0,1fr); } .diagnosis-aside { grid-template-columns:1fr 1fr; } .diagnosis-picker { grid-template-columns:1fr 1.5fr; } .diagnosis-picker>.caption { grid-column:1 / -1; } }
@media(max-width:640px) { .metrics,.metrics.four,.definitions-grid,.tool-list,.diagnosis-aside,.diagnosis-picker { grid-template-columns:minmax(0,1fr); } .page-header,.snapshot { flex-wrap:wrap; } .diagnosis-picker>.caption { grid-column:auto; } .diagnosis-main { min-width:0; } .page-header { gap:var(--space-md); } }
@media(min-width:641px) and (max-width:900px) { .metrics,.metrics.four { grid-template-columns:repeat(2,minmax(0,1fr)); } }
.diagnosis-main { min-width:0; } .row { display:flex; align-items:center; gap:var(--space-md); flex-wrap:wrap; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;
