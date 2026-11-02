import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.ts';
import type { SystemInvestigationFacts, SystemVerification } from '../../../api/generated/public-api.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import './app-card.ts';

const labels = { recovered: '后续观测支持恢复', not_improved: '仍有失败信号', insufficient_evidence: '证据不足，状态未知' };
const gaps: Record<string,string> = {
  SYSTEM_COLLECTION_DISABLED: '异常采集未生效', SOURCE_EVENT_VERSION_MISSING: '缺少故障部署版本',
  SOURCE_COMMIT_MISMATCH: '后续信号部署版本已变化', LOG_WINDOW_UNAVAILABLE: '故障窗口已超出日志保留或时钟异常',
  LOG_WINDOW_PRECEDES_PROCESS: '故障发生早于当前进程', LOG_BUFFER_TRUNCATED: '日志已截断',
  LOG_EVIDENCE_MISSING: '没有故障之后同位置的新鲜信号', LOG_STATUS_UNKNOWN: '后续信号结果未知', LOG_EVIDENCE_UNAVAILABLE: '读取观测失败',
  LOG_REQUEST_SCOPE_UNAVAILABLE: '缺少原故障请求范围证据，无法确认恢复',
};
@customElement('system-investigation-facts')
export class SystemInvestigationFactsElement extends LitElement {
  @property() investigationId = '';
  @property({ type: Number }) version = 1;
  @property({ type: Boolean }) disabled = false;
  @state() private data: SystemInvestigationFacts | null = null;
  @state() private error = '';
  @state() private loading = false;
  @state() private busy = false;
  private generation = 0;
  private denied = false;
  private pending: { eventId: string; key: string; expectedVersion: number } | null = null;
  private invalidate = () => { this.generation++; this.data = null; this.pending = null; this.busy = false; this.loading = false; this.error = '会话或权限已变化，请重新打开调查核对。'; this.denied = true; };
  private permissionsChanged = (event: Event) => {
    const values = (event as CustomEvent<{permissions?: string[]}>).detail?.permissions;
    const allowed = Array.isArray(values) && ['chat:view','config:view'].every(required => values.some(p => p === '*' || p === required || p === required.split(':')[0] + ':*'));
    this.invalidate();
    if (allowed) { this.denied = false; void this.load(); }
  };
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-session-expired', this.invalidate);
    window.addEventListener('slide-permissions-loaded', this.permissionsChanged);
  }
  override disconnectedCallback() {
    this.generation++; this.data = null; this.pending = null; this.busy = false; this.loading = false;
    window.removeEventListener('slide-session-expired', this.invalidate);
    window.removeEventListener('slide-permissions-loaded', this.permissionsChanged);
    super.disconnectedCallback();
  }
  createRenderRoot() { return this; }
  protected updated(changed: Map<string, unknown>) {
    if (changed.has('investigationId')) { this.denied = false; this.pending = null; void this.load(); }
    else if (changed.has('version') && !this.busy && !this.denied) void this.load();
  }
  private async load() {
    if (!this.investigationId || this.denied) return;
    const g = ++this.generation;
    this.busy = false;
    this.loading = true; this.error = ''; this.data = null;
    try {
      const r = await authFetch(`/api/investigations/${encodeURIComponent(this.investigationId)}/platform-events`, { cache: 'no-store' });
      if (!r.ok) throw new Error([401,403,404].includes(r.status) ? '无权读取原平台异常。' : '平台证据读取失败，当前状态未知。');
      const data = await r.json();
      if (g === this.generation) this.data = data;
    } catch (e) { if (g === this.generation) this.error = e instanceof Error ? e.message : '读取失败，当前状态未知。'; }
    finally { if (g === this.generation) this.loading = false; }
  }
  private async verify(eventId: string) {
    if (this.busy || this.disabled || this.denied) return;
    const g = this.generation;
    const investigationId = this.investigationId;
    const current = () => g === this.generation && investigationId === this.investigationId && this.isConnected;
    const pending = this.pending ?? { eventId, key: crypto.randomUUID(), expectedVersion: this.version };
    if (pending.eventId !== eventId) return;
    this.pending = pending; this.busy = true; this.error = '';
    try {
      const r = await authFetch(`/api/platform/system-events/${encodeURIComponent(eventId)}/verifications`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
        body: JSON.stringify({ investigationId, expectedVersion: pending.expectedVersion }) });
      if (!current()) return;
      if (!r.ok) {
        if ([400,401,403,404,409].includes(r.status)) this.pending = null;
        if ([401,403,404].includes(r.status)) this.data = null;
        throw new Error(r.status === 409 ? '调查版本或运行状态已变化，请刷新核对。' : '复测未确认，请用原请求重试；不能据此判断恢复。');
      }
      const receipt: SystemVerification = await r.json();
      if (!current()) return;
      this.pending = null;
      this.busy = false;
      this.dispatchEvent(new CustomEvent('platform-verification-saved', { bubbles: true, composed: true, detail: receipt }));
      if (current()) await this.load();
    } catch (e) { if (current()) this.error = e instanceof Error ? e.message : '复测回执未知，请用原请求重试。'; }
    finally { if (current()) this.busy = false; }
  }
  render() {
    return html`<style>${sharedBtnStyles.cssText}
      system-investigation-facts { display:block; min-width:0; overflow-wrap:anywhere; }
      system-investigation-facts pre { white-space:pre-wrap; overflow-wrap:anywhere; }
      system-investigation-facts .actions { display:flex; gap:var(--space-sm); flex-wrap:wrap; }
    </style><app-card><span slot="header">原平台异常与恢复验证</span>
      <p>查看事实不会调用模型。复测读取后续服务端观测，不执行修复、不重放故障请求；结论仅适用于原异常。</p>
      ${this.loading ? html`<p role="status">正在读取原异常证据…</p>` : nothing}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${this.data?.events.map(row => {
        const fact = row.fact as { event?: { summary?: string; occurredAt?: string; releaseId?: string; commitSha?: string; subject?: { component?: string } }; contentHash?: string };
        return html`<section><h3>${fact.event?.summary ?? '平台异常'}</h3>
          <p>组件：${fact.event?.subject?.component ?? '未知'} · 故障时间：${fact.event?.occurredAt ?? '未知'}</p>
          <p>故障部署：${fact.event?.releaseId ?? '缺失'} · ${fact.event?.commitSha ?? '缺少源码版本，不能以最新版本替代'}</p>
          <div class="actions"><a class="btn" href=${row.returnTo}>返回原平台异常</a>
            <button class="btn" ?disabled=${this.disabled || this.busy || this.denied || !!this.pending && this.pending.eventId !== row.eventId}
              @click=${() => void this.verify(row.eventId)}>${this.busy ? '正在复测…' : this.pending?.eventId === row.eventId ? '重试原复测请求' : '复测原异常'}</button></div>
          ${row.verifications.length ? row.verifications.map(v => html`<p><strong>${labels[v.conclusion]}</strong> · ${v.verifiedAt}<br>观测窗口：${v.from} — ${v.to}<br>${v.gaps.map(g => gaps[g] ?? g).join('；')}</p>`)
            : html`<p>尚未复测；分析完成不会自动恢复。</p>`}
          <details><summary>原事实、复测证据与审计标识</summary><pre>${JSON.stringify(row, null, 2)}</pre></details>
        </section>`;
      })}
      ${this.data && !this.data.events.length ? html`<p>未关联持久平台异常，状态未知。</p>` : nothing}
      ${this.data?.truncated ? html`<p>仅展示最早100条关联事件，不能据此判断全平台健康。</p>` : nothing}
      <button class="btn btn-refresh" ?disabled=${this.loading || this.busy || this.denied} @click=${() => void this.load()}>刷新原异常</button>
    </app-card>`;
  }
}
