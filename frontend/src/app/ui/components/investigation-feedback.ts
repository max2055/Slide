import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { InvestigationFeedbackRequest, InvestigationFeedbackRecord } from '../../../api/generated/public-api.ts';
import { investigationApi, InvestigationApiError, investigationErrorText } from '../controllers/investigation-api.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import './app-card.ts';
import './app-form-field.ts';
import './app-empty-state.ts';

const kindLabels = { rating: '结果反馈', handling: '外部处理记录', root_cause: '人工根因确认', recovery: '业务恢复验证', close: '关闭调查' };
const problemLabels = { unconfirmed: '未确认', in_progress: '处理中', resolved: '已验证恢复', not_applicable: '不适用' };

/** Human feedback bound to the latest result and live investigation revision. */
@customElement('investigation-feedback')
export class InvestigationFeedback extends LitElement {
  @property() investigationId = '';
  @property() resultId = '';
  @property({ type: Number }) resultVersion = 0;
  @property({ type: Number }) investigationVersion = 0;
  @property({ type: Boolean }) activeRequest = false;
  @property({ type: Boolean }) readonly = false;
  @state() private kind: InvestigationFeedbackRequest['kind'] = 'rating';
  @state() private rating = 'helpful';
  @state() private problemStatus = 'not_applicable';
  @state() private note = '';
  @state() private method = '';
  @state() private from = '';
  @state() private to = '';
  @state() private performedAt = '';
  @state() private ids = '';
  @state() private items: InvestigationFeedbackRecord[] = [];
  @state() private nextBefore: number | null = null;
  @state() private busy = false;
  @state() private loading = false;
  @state() private error = '';
  @state() private accessWithdrawn = false;
  private epoch = 0;
  private historyEpoch = 0;
  private pending: { body: InvestigationFeedbackRequest; key: string } | null = null;
  createRenderRoot() { return this; }
  private erase() {
    this.epoch++; this.historyEpoch++; this.pending = null; this.items = []; this.nextBefore = null;
    this.note = ''; this.method = ''; this.from = ''; this.to = ''; this.performedAt = ''; this.ids = '';
    this.error = ''; this.busy = false; this.loading = false; this.kind = 'rating'; this.rating = 'helpful'; this.problemStatus = 'not_applicable';
  }
  private authorityChanged = () => { this.erase(); this.accessWithdrawn = true; };
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-session-expired', this.authorityChanged);
    window.addEventListener('slide-permissions-loaded', this.authorityChanged);
  }
  disconnectedCallback() {
    window.removeEventListener('slide-session-expired', this.authorityChanged);
    window.removeEventListener('slide-permissions-loaded', this.authorityChanged);
    this.erase(); super.disconnectedCallback();
  }
  protected willUpdate(changed: Map<string, unknown>) {
    if (changed.has('investigationId')) { this.erase(); this.accessWithdrawn = false; if (this.investigationId) void this.load(); }
    else if (changed.has('resultId') || changed.has('resultVersion')) {
      if (changed.get('resultId') !== undefined || changed.get('resultVersion') !== undefined) {
        this.erase(); if (!this.accessWithdrawn && this.investigationId) void this.load();
      }
    }
  }
  private failure(error: unknown) {
    if (error instanceof InvestigationApiError && (error.status === 401 || error.status === 404
      || error.status === 403 && error.code !== 'INVESTIGATION_OPERATION_FORBIDDEN')) this.authorityChanged();
    this.error = investigationErrorText(error);
  }
  private async load(more = false) {
    if (this.accessWithdrawn || this.loading) return;
    const epoch = this.epoch, historyEpoch = ++this.historyEpoch; this.loading = true;
    try {
      const page = await investigationApi<{ items: InvestigationFeedbackRecord[]; nextBefore: number | null }>(
        `/${encodeURIComponent(this.investigationId)}/feedback${more && this.nextBefore ? `?before=${this.nextBefore}` : ''}`);
      if (epoch !== this.epoch || historyEpoch !== this.historyEpoch) return;
      this.items = more ? [...this.items, ...page.items] : page.items; this.nextBefore = page.nextBefore;
    } catch (error) { if (epoch === this.epoch && historyEpoch === this.historyEpoch) this.failure(error); }
    finally { if (epoch === this.epoch && historyEpoch === this.historyEpoch) this.loading = false; }
  }
  private async submit() {
    if (this.accessWithdrawn || this.readonly || this.busy || !this.resultId || !this.resultVersion || !this.investigationVersion
      || this.activeRequest && this.kind === 'close') return;
    this.error = '';
    if (!this.pending) {
      if (!this.note.trim()) { this.error = '请填写反馈或处理依据。'; return; }
      const base = { resultId: this.resultId, resultVersion: this.resultVersion, expectedVersion: this.investigationVersion, note: this.note.trim() };
      const evidenceIds = [...new Set(this.ids.split(',').map(id => id.trim()).filter(Boolean))];
      let body: InvestigationFeedbackRequest;
      try {
        const requiresVerification = this.kind === 'root_cause' || this.kind === 'recovery' || this.kind === 'close' && this.problemStatus === 'resolved';
        if (requiresVerification && (!this.method.trim() || !evidenceIds.length || !this.from || !this.to || Date.parse(this.from) >= Date.parse(this.to))) throw new Error();
        const verification = requiresVerification ? { method: this.method.trim(), evidenceIds, from: new Date(this.from).toISOString(), to: new Date(this.to).toISOString() } : undefined;
        if (this.kind === 'rating') body = { ...base, kind: 'rating', rating: this.rating as 'helpful' | 'unhelpful' | 'incorrect' };
        else if (this.kind === 'handling') body = { ...base, kind: 'handling', performedAt: new Date(this.performedAt).toISOString(), evidenceIds };
        else if (this.kind === 'close') body = { ...base, kind: 'close', lifecycle: 'closed', problemStatus: this.problemStatus as 'not_applicable' | 'resolved' | 'unconfirmed' | 'in_progress', ...(verification ? { verification } : {}) };
        else body = { ...base, kind: this.kind, verification: verification! };
      } catch { this.error = '请填写有效时间窗口、验证方法与证据 ID。'; return; }
      this.pending = { body, key: crypto.randomUUID() };
    }
    const epoch = this.epoch, pending = this.pending;
    this.busy = true;
    try {
      const record = await investigationApi<InvestigationFeedbackRecord>(`/${encodeURIComponent(this.investigationId)}/feedback`, {
        method: 'POST', headers: { 'Idempotency-Key': pending.key }, body: JSON.stringify(pending.body) });
      if (epoch !== this.epoch) return;
      this.investigationVersion = record.version;
      this.historyEpoch++; this.loading = false;
      this.pending = null; this.note = ''; this.method = ''; this.ids = ''; this.from = ''; this.to = ''; this.performedAt = '';
      this.items = [record, ...this.items.filter(item => item.id !== record.id)];
      this.dispatchEvent(new CustomEvent('investigation-feedback-saved', { bubbles: true, composed: true, detail: record }));
    } catch (error) {
      if (epoch !== this.epoch) return;
      // Unknown acceptance retains the exact command/key. An explicit rejection
      // lets the user correct a draft without pretending it was accepted.
      if (error instanceof InvestigationApiError && error.status < 500) this.pending = null;
      this.failure(error);
    } finally { if (epoch === this.epoch) this.busy = false; }
  }
  render() {
    if (this.accessWithdrawn) return html`<p role="status">反馈内容已清空，请重新核验访问权限。</p>`;
    const verified = this.kind === 'root_cause' || this.kind === 'recovery' || this.kind === 'close' && this.problemStatus === 'resolved';
    const disabled = this.busy || !!this.pending;
    const field = (label: string, value: string, setter: (value: string) => void, type = 'text') => html`<app-form-field label=${label}><input aria-label=${label} type=${type} step="0.001" .value=${value}
      ?disabled=${disabled} @input=${(e: Event) => setter((e.target as HTMLInputElement).value)}></app-form-field>`;
    return html`<style>${sharedBtnStyles.cssText}
      investigation-feedback { display:block; min-width:0; }
      investigation-feedback input, investigation-feedback textarea, investigation-feedback select { box-sizing:border-box; width:100%; min-width:0; background:var(--input); color:var(--text); border:1px solid var(--border); border-radius:var(--radius-sm); padding:var(--space-sm); }
      investigation-feedback form, investigation-feedback .feedback-history { display:grid; gap:var(--space-sm); }
      investigation-feedback .feedback-history { padding:0; list-style:none; }
      investigation-feedback li { border-bottom:1px solid var(--border); padding:var(--space-sm) 0; overflow-wrap:anywhere; }
      investigation-feedback [role=alert] { color:var(--danger); }
    </style><app-card><span slot="header">人工反馈与关闭验证</span>
      <p>当前结果版本 ${this.resultVersion || '暂无'}。根因确认和业务恢复分别记录；外部处理不会由平台执行。</p>
      ${this.readonly ? html`<p>当前为只读查看。</p>` : html`<form @submit=${(e: Event) => { e.preventDefault(); void this.submit(); }}>
        <app-form-field label="记录类型"><select aria-label="记录类型" .value=${this.kind} ?disabled=${disabled}
          @change=${(e: Event) => this.kind = (e.target as HTMLSelectElement).value as InvestigationFeedbackRequest['kind']}>
          ${Object.entries(kindLabels).map(([value, label]) => html`<option value=${value}>${label}</option>`)}</select></app-form-field>
        ${this.kind === 'rating' ? html`<app-form-field label="反馈评价"><select aria-label="反馈评价" .value=${this.rating} ?disabled=${disabled}
          @change=${(e: Event) => this.rating = (e.target as HTMLSelectElement).value}><option value="helpful">有帮助</option><option value="unhelpful">无帮助</option><option value="incorrect">判断有误</option></select></app-form-field>` : nothing}
        ${this.kind === 'close' ? html`<app-form-field label="业务问题状态"><select aria-label="业务问题状态" .value=${this.problemStatus} ?disabled=${disabled}
          @change=${(e: Event) => this.problemStatus = (e.target as HTMLSelectElement).value}>${Object.entries(problemLabels).map(([value, label]) => html`<option value=${value}>${label}</option>`)}</select></app-form-field>` : nothing}
        <app-form-field label="反馈与处理依据"><textarea aria-label="反馈与处理依据" rows="3" maxlength="4000" .value=${this.note} ?disabled=${disabled}
          @input=${(e: Event) => this.note = (e.target as HTMLTextAreaElement).value}></textarea></app-form-field>
        ${this.kind === 'handling' ? field('外部处理时间', this.performedAt, value => this.performedAt = value, 'datetime-local') : nothing}
        ${verified ? html`${field('验证方法', this.method, value => this.method = value)}${field('观察开始时间', this.from, value => this.from = value, 'datetime-local')}
          ${field('观察结束时间', this.to, value => this.to = value, 'datetime-local')}` : nothing}
        ${verified || this.kind === 'handling' ? field('证据 ID（逗号分隔）', this.ids, value => this.ids = value) : nothing}
        ${this.activeRequest && this.kind === 'close' ? html`<p>执行进行中，结束后才能关闭调查。</p>` : nothing}
        <button class="btn-primary" type="submit" ?disabled=${this.busy || !this.resultId || this.activeRequest && this.kind === 'close'}>${this.busy ? '正在保存…' : this.pending ? '核对原提交' : '保存人工记录'}</button>
      </form>`}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${this.loading ? html`<p role="status">正在加载人工记录…</p>` : nothing}
      <ul class="feedback-history" aria-label="人工记录">${this.items.map(item => html`<li>
        <strong>${kindLabels[item.command.kind]}</strong> · 结果 v${item.command.resultVersion} · 记录人 ${item.actorId} · ${item.createdAt}
        ${item.staleResult || item.command.resultId !== this.resultId ? html`<p>旧结果引用，不能用于当前结论。</p>` : nothing}
        <p>${item.command.note}</p>
        ${item.command.kind === 'rating' ? html`<p>${{ helpful: '有帮助', unhelpful: '无帮助', incorrect: '判断有误' }[item.command.rating]}；反馈保留为人工记录。</p>` : nothing}
        ${item.command.kind === 'close' ? html`<p>关闭时业务状态：${problemLabels[item.command.problemStatus]}</p>` : nothing}
        ${item.verification ? html`<p>人工确认 · ${item.verification.method} · ${item.verification.from} 至 ${item.verification.to} · 确认人 ${item.verification.verifiedBy} · ${item.verification.verifiedAt}</p>` : nothing}
        ${item.references.map(ref => html`<p>证据 ${ref.id} · ${ref.status === 'expired' ? '已过期，不能作为新验证依据' : '可用'}</p>`)}
      </li>`)}</ul>
      ${!this.loading && !this.items.length ? html`<app-empty-state title="暂无人工记录"></app-empty-state>` : nothing}
      ${this.nextBefore ? html`<button class="btn" ?disabled=${this.loading} @click=${() => void this.load(true)}>加载更早记录</button>` : nothing}
    </app-card>`;
  }
}
