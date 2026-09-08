import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.js';
import { icons } from '../../../icons.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import '../components/app-badge.js';
import '../components/app-empty-state.js';

interface LogGroup { component: string; eventType: string; count: number; failures: number; durationMs: number; lastObservedAt: string; correlationIds: string[] }
interface PlatformObservations {
  generatedAt: string; releaseId: string; commitSha: string; uptimeSeconds: number;
  components: Array<{ component: string; quality: string; gaps: string[]; groups: LogGroup[] }>;
  logs: { quality: string; gaps: string[]; groups: LogGroup[]; retentionSeconds: number; persistence: string };
}

@customElement('platform-observations')
export class PlatformObservationsView extends LitElement {
  @state() private data: PlatformObservations | null = null;
  @state() private error = '';
  @state() private loading = true;
  static styles = [sharedBtnStyles, css`
    :host { display: block; min-width: 0; margin: var(--space-xl) 0; color: var(--text); }
    header { display: flex; justify-content: space-between; align-items: center; gap: var(--space-md); }
    h2 { font-size: 18px; color: var(--text-strong); }
    h3 { font-size: 14px; }
    section { border-top: 1px solid var(--border); padding: var(--space-md) 0; }
    dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--space-sm); font-size: 13px; }
    dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
    p, summary { overflow-wrap: anywhere; }
    details { padding: var(--space-sm) 0; } summary { cursor: pointer; }
    .error { color: var(--danger); } svg { width: 16px; height: 16px; }
    .skeleton { height: 100px; background: var(--border); opacity: .4; }
  `];
  override connectedCallback() { super.connectedCallback(); void this.load(); }
  private async load() {
    this.loading = true; this.error = '';
    try {
      const response = await authFetch('/api/platform/observations');
      if (!response.ok) throw new Error(`平台观测不可用 (${response.status})`);
      this.data = await response.json();
    } catch (error) { this.error = String(error); this.data = null; }
    finally { this.loading = false; }
  }
  private renderGroup(group: LogGroup) {
    return html`<details><summary>${group.component} · ${group.eventType} · ${group.count} 次 / ${group.failures} 失败</summary><dl><dt>累计耗时</dt><dd>${group.durationMs} ms</dd><dt>最后观测</dt><dd>${group.lastObservedAt}</dd><dt>关联 ID</dt><dd>${group.correlationIds.join(', ') || '无'}</dd></dl></details>`;
  }
  override render() {
    const data = this.data;
    return html`<header><h2>平台观测</h2><button class="btn" title="刷新平台观测" aria-label="刷新平台观测" .disabled=${this.loading} @click=${this.load}>${icons['refresh-cw']}</button></header>
      ${this.loading ? html`<div class="skeleton" aria-label="加载平台观测"></div>` : nothing}
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${data ? html`<dl><dt>发布</dt><dd>${data.releaseId ?? '未知'}</dd><dt>Commit</dt><dd>${data.commitSha ?? '未知'}</dd><dt>运行时间</dt><dd>${data.uptimeSeconds} s</dd><dt>观测时间</dt><dd>${data.generatedAt}</dd></dl>
        ${data.components.map(component => html`<section><h3>${component.component} <app-badge>${component.quality}</app-badge></h3>${component.gaps.map(gap => html`<p>${gap}</p>`)}${component.groups.map(group => this.renderGroup(group))}</section>`)}
        <section><h3>结构化日志 <app-badge>${data.logs.quality}</app-badge></h3><dl><dt>保留窗口</dt><dd>${data.logs.retentionSeconds} s</dd><dt>存储范围</dt><dd>${data.logs.persistence}</dd></dl>${data.logs.gaps.map(gap => html`<p>${gap}</p>`)}${data.logs.groups.length ? data.logs.groups.map(group => this.renderGroup(group)) : html`<app-empty-state title="暂无日志证据"></app-empty-state>`}</section>` : nothing}`;
  }
}
