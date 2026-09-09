import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";

@customElement("platform-observations-page")
export class PlatformObservationsPage extends LitElement {
  @state() private loading = true;
  @state() private groups: Array<{ category: string; count: number; failures: number }> = [];
  static styles = css`
    :host { display:block; max-width: 1000px; }
    h1 { margin:0 0 6px; color:var(--text-strong); font-size:22px; }
    p { color:var(--muted); margin:0 0 20px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:var(--space-md); }
    .card { border:1px solid var(--border); border-radius:var(--radius-md); background:var(--card); padding:var(--space-lg); }
    .label { color:var(--muted); font-size:13px; } .value { display:block; margin-top:8px; font-size:28px; font-weight:700; color:var(--text-strong); }
  `;
  connectedCallback() { super.connectedCallback(); this.load(); }
  private async load() {
    try { const r = await authFetch('/api/health/overview'); const d = await r.json(); const map = new Map<string,{count:number;failures:number}>();
      for (const c of (d.checks ?? [])) { const x=map.get(c.category) ?? {count:0,failures:0}; x.count++; if(c.status==='fail') x.failures++; map.set(c.category,x); }
      this.groups = [...map].map(([category,v])=>({category,...v}));
    } finally { this.loading=false; }
  }
  render() { return html`<h1>平台观测</h1><p>汇总平台运行时产生的结构化观测信号，与平台自检结果分离展示。</p>${this.loading ? html`<p>加载中…</p>` : html`<div class="grid">${this.groups.map(g=>html`<section class="card"><span class="label">${g.category}</span><strong class="value">${g.count}</strong><span class="label">观测项 · ${g.failures ? `${g.failures} 项异常` : '无异常'}</span></section>`)}</div>`}`; }
}
