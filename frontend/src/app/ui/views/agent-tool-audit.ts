import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.js';
import { icons } from '../../../icons.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import { showToast } from '../components/app-toast-container.js';
import '../components/app-badge.js';
import '../components/app-card.js';
import '../components/app-data-table.js';
import '../components/app-dialog.js';
import '../components/app-empty-state.js';
import '../components/app-form-field.js';

interface AuditRecord {
  id: number;
  phase: 'decision' | 'result';
  actorId: number;
  actorUsername: string | null;
  agentId: string;
  requestId: string;
  toolName: string;
  allowed: boolean;
  reasonCode: string;
  resource: unknown;
  approvalId: number | null;
  createdAt: string;
  policySnapshot?: unknown;
  args?: unknown;
  result?: unknown;
  relatedRecordId?: number | null;
}

const phaseLabels = { decision: '权限决策', result: '执行结果' };

@customElement('agent-tool-audit-page')
export class AgentToolAuditPage extends LitElement {
  @state() private records: AuditRecord[] = [];
  @state() private loading = true;
  @state() private loadError = '';
  @state() private detailLoading = false;
  @state() private detailId: number | null = null;
  @state() private selected: AuditRecord | null = null;
  @state() private nextCursor: number | null = null;
  @state() private cursor: number | undefined;
  @state() private cursorStack: Array<number | undefined> = [];
  @state() private toolName = '';
  @state() private actorId = '';
  @state() private phase = '';
  @state() private allowed = '';
  @state() private from = '';
  @state() private to = '';
  private listGeneration = 0;
  private detailGeneration = 0;
  private accessChanged = () => {
    this.listGeneration++;
    this.records = [];
    this.nextCursor = null;
    this.cursor = undefined;
    this.cursorStack = [];
    this.loading = false;
    this.loadError = '权限已变更，请刷新 Agent 审计。';
    this.closeDetail();
  };

  static styles = [sharedFieldStyles, sharedBtnStyles, css`
    :host { display: block; color: var(--text); }
    .page-header, .filters, .pagination, .dialog-grid { display: flex; }
    .page-header { align-items: center; justify-content: space-between; gap: var(--space-lg); margin-bottom: var(--space-xl); }
    .page-header h1 { margin: 0 0 var(--space-xs); font-size: var(--text-xl); color: var(--text-strong); }
    .page-header p { margin: 0; color: var(--muted); font-size: var(--text-sm); }
    button svg { width: 1rem; height: 1rem; }
    .filters { align-items: end; flex-wrap: wrap; gap: var(--space-md); }
    .filters app-form-field { flex: 1 1 9rem; margin-bottom: 0; }
    input, select { box-sizing: border-box; width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--card); color: var(--text); padding: var(--space-sm) var(--space-md); font: inherit; }
    input:focus, select:focus { outline: 2px solid var(--accent-subtle); border-color: var(--accent); }
    .table-wrap { overflow-x: auto; margin-top: var(--space-lg); }
    .tool-name, .mono { font-family: var(--font-mono); font-size: var(--text-xs); overflow-wrap: anywhere; }
    .pagination { justify-content: flex-end; gap: var(--space-sm); margin-top: var(--space-md); }
    .dialog-grid { flex-direction: column; gap: var(--space-lg); }
    .detail-row { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: var(--space-md); font-size: var(--text-sm); }
    .detail-row > span:first-child { color: var(--muted); }
    pre { box-sizing: border-box; max-height: 18rem; overflow: auto; margin: var(--space-xs) 0 0; padding: var(--space-md); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elevated); color: var(--text); font-family: var(--font-mono); font-size: var(--text-xs); white-space: pre-wrap; overflow-wrap: anywhere; }
    @media (max-width: 760px) {
      .filters { align-items: stretch; flex-direction: column; }
      .filters app-form-field { flex: 0 0 auto; width: 100%; }
      .detail-row { grid-template-columns: 1fr; gap: var(--space-xs); }
    }
  `];

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('slide-permissions-loaded', this.accessChanged);
    window.addEventListener('slide-session-expired', this.accessChanged);
    void this.load(true);
  }

  override disconnectedCallback(): void {
    this.accessChanged();
    window.removeEventListener('slide-permissions-loaded', this.accessChanged);
    window.removeEventListener('slide-session-expired', this.accessChanged);
    super.disconnectedCallback();
  }

  private async load(reset = false): Promise<void> {
    const generation = ++this.listGeneration;
    this.records = [];
    this.nextCursor = null;
    this.loadError = '';
    this.closeDetail();
    if (reset) {
      this.cursor = undefined;
      this.cursorStack = [];
    }
    this.loading = true;
    try {
      const params: Record<string, string | number | boolean | undefined> = {
        limit: 25,
        cursor: this.cursor,
        toolName: this.toolName.trim() || undefined,
        actorId: this.actorId.trim() || undefined,
        phase: this.phase || undefined,
        allowed: this.allowed ? this.allowed === 'true' : undefined,
        from: this.from ? new Date(this.from).toISOString() : undefined,
        to: this.to ? new Date(this.to).toISOString() : undefined,
      };
      const response = await apiClient.get<{ records: AuditRecord[]; nextCursor: number | null }>('/agent/security/audit', { params });
      if (generation !== this.listGeneration) return;
      if (!Array.isArray(response?.records) || (response.nextCursor !== null && !Number.isSafeInteger(response.nextCursor))) {
        throw new Error('审计查询响应无效');
      }
      this.records = response.records;
      this.nextCursor = response.nextCursor;
    } catch (error) {
      if (generation !== this.listGeneration) return;
      const forbidden = error instanceof Error && /^HTTP (401|403):/.test(error.message);
      this.loadError = forbidden ? '当前会话无权查看 Agent 审计。' : 'Agent 审计读取失败，请刷新重试。';
      showToast(this.loadError, 'error');
    } finally {
      if (generation === this.listGeneration) this.loading = false;
    }
  }

  private async openDetail(id: number): Promise<void> {
    const generation = ++this.detailGeneration;
    this.detailId = id;
    this.detailLoading = true;
    this.selected = this.records.find((record) => record.id === id) ?? null;
    try {
      const response = await apiClient.get<{ record: AuditRecord }>(`/agent/security/audit/${id}`);
      if (generation !== this.detailGeneration) return;
      if (response?.record?.id !== id) throw new Error('审计记录响应无效');
      this.selected = response.record;
    } catch (error) {
      if (generation !== this.detailGeneration) return;
      const forbidden = error instanceof Error && /^HTTP (401|403):/.test(error.message);
      if (forbidden) {
        this.accessChanged();
        this.loadError = '当前会话无权查看 Agent 审计。';
      } else {
        showToast('加载审计详情失败', 'error');
        this.closeDetail();
      }
    } finally {
      if (generation === this.detailGeneration) this.detailLoading = false;
    }
  }

  private closeDetail(): void {
    this.detailGeneration++;
    this.detailId = null;
    this.selected = null;
    this.detailLoading = false;
  }

  private nextPage(): void {
    if (this.loading || this.nextCursor === null) return;
    this.cursorStack = [...this.cursorStack, this.cursor];
    this.cursor = this.nextCursor;
    void this.load();
  }

  private previousPage(): void {
    if (this.loading || this.cursorStack.length === 0) return;
    const stack = [...this.cursorStack];
    this.cursor = stack.pop();
    this.cursorStack = stack;
    void this.load();
  }

  private rows(): Record<string, unknown>[] {
    return this.records.map((record) => ({
      createdAt: new Date(record.createdAt).toLocaleString(),
      toolName: html`<span class="tool-name">${record.toolName}</span>`,
      phase: phaseLabels[record.phase],
      actor: record.actorUsername || `用户 #${record.actorId}`,
      allowed: html`<app-badge variant=${record.allowed ? 'ok' : 'danger'}>${record.allowed ? '允许' : '拒绝'}</app-badge>`,
      reasonCode: html`<span class="mono">${record.reasonCode}</span>`,
      actions: html`<button class="btn-icon" title="查看详情" aria-label="查看详情" @click=${() => this.openDetail(record.id)}>${icons.eye}</button>`,
    }));
  }

  private json(value: unknown): string {
    return value == null ? '未提供' : JSON.stringify(value, null, 2);
  }

  private async openRelatedDetail(id: number): Promise<void> {
    this.renderRoot.querySelector<HTMLButtonElement>('[slot="footer"]')?.focus({ preventScroll: true });
    await this.openDetail(id);
    await this.updateComplete;
    if (this.selected?.id === id) this.renderRoot.querySelector<HTMLElement>('#audit-detail-record')?.focus();
  }

  private renderRelatedRecord(record: AuditRecord) {
    const id = record.relatedRecordId;
    if (this.detailLoading) return nothing;
    const label = record.phase === 'decision' ? phaseLabels.result : phaseLabels.decision;
    return html`<div class="detail-row"><span>关联${label}</span><div>
      ${typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id !== record.id
        ? html`<button type="button" class="btn" @click=${() => this.openRelatedDetail(id)}>查看${label} #${id}</button>`
        : '无法确认关联'}
    </div></div>`;
  }

  override render() {
    return html`
      <div class="page-header"><div><h1>Agent 审计</h1><p>查看模型工具发现、执行决策和脱敏后的结果记录</p></div><button aria-busy=${String(this.loading)} class="btn btn-refresh" title="刷新" aria-label="刷新" @click=${() => this.load()} .disabled=${this.loading}>刷新</button></div>
      <app-card>
        <span slot="header">筛选</span>
        <div class="filters">
          <app-form-field label="Tool"><input type="text" .value=${this.toolName} @input=${(event: Event) => { this.toolName = (event.target as HTMLInputElement).value; }}></app-form-field>
          <app-form-field label="操作者 ID"><input type="text" inputmode="numeric" .value=${this.actorId} @input=${(event: Event) => { this.actorId = (event.target as HTMLInputElement).value; }}></app-form-field>
          <app-form-field label="阶段"><select .value=${this.phase} @change=${(event: Event) => { this.phase = (event.target as HTMLSelectElement).value; }}><option value="">全部</option><option value="decision">权限决策</option><option value="result">执行结果</option></select></app-form-field>
          <app-form-field label="授权判定"><select .value=${this.allowed} @change=${(event: Event) => { this.allowed = (event.target as HTMLSelectElement).value; }}><option value="">全部</option><option value="true">允许</option><option value="false">拒绝</option></select></app-form-field>
          <app-form-field label="开始时间"><input type="datetime-local" .value=${this.from} @input=${(event: Event) => { this.from = (event.target as HTMLInputElement).value; }}></app-form-field>
          <app-form-field label="结束时间"><input type="datetime-local" .value=${this.to} @input=${(event: Event) => { this.to = (event.target as HTMLInputElement).value; }}></app-form-field>
          <button class="btn-primary" @click=${() => this.load(true)}>查询</button>
        </div>
        ${this.loadError ? html`<p role="alert">${this.loadError}</p>` : html`
        ${this.loading ? html`<p role="status">正在读取 Agent 审计…</p>` : nothing}
        <div class="table-wrap" aria-busy=${this.loading}><app-data-table .columns=${[{ key: 'createdAt', label: '时间' }, { key: 'toolName', label: 'Tool' }, { key: 'phase', label: '阶段' }, { key: 'actor', label: '操作者' }, { key: 'allowed', label: '授权判定' }, { key: 'reasonCode', label: '原因码' }, { key: 'actions', label: '' }]} .rows=${this.rows()} .loading=${this.loading} .dense=${true} emptyMessage="当前条件下暂无 Agent 审计记录"></app-data-table></div>
        <div class="pagination"><button class="btn" @click=${this.previousPage} .disabled=${this.cursorStack.length === 0 || this.loading}>上一页</button><button class="btn" @click=${this.nextPage} .disabled=${this.nextCursor === null || this.loading}>下一页</button></div>
        `}
      </app-card>
      <app-dialog size="xl" title="Tool 审计详情" .open=${this.detailId !== null} @app-dialog-close=${this.closeDetail}>
        ${this.selected ? html`<div class="dialog-grid">
          <div class="detail-row"><span>记录</span><strong id="audit-detail-record" tabindex="-1">#${this.selected.id} · ${this.selected.toolName}</strong></div>
          <div class="detail-row"><span>请求 ID</span><span class="mono">${this.selected.requestId}</span></div>
          <div class="detail-row"><span>Agent</span><span>${this.selected.agentId}</span></div>
          <div class="detail-row"><span>阶段</span><strong>${phaseLabels[this.selected.phase]}</strong></div>
          <div class="detail-row"><span>授权判定</span><span><app-badge variant=${this.selected.allowed ? 'ok' : 'danger'}>${this.selected.allowed ? '允许' : '拒绝'}</app-badge> <span class="mono">${this.selected.reasonCode}</span></span></div>
          ${this.renderRelatedRecord(this.selected)}
          <div><strong>资源</strong><pre>${this.json(this.selected.resource)}</pre></div>
          <div><strong>策略快照</strong><pre>${this.detailLoading ? '加载中' : this.json(this.selected.policySnapshot)}</pre></div>
          <div><strong>参数（已脱敏）</strong><pre>${this.detailLoading ? '加载中' : this.json(this.selected.args)}</pre></div>
          ${this.selected.phase === 'result' ? html`<div><strong>执行回执（已脱敏）</strong><pre>${this.detailLoading ? '加载中' : this.json(this.selected.result)}</pre></div>` : nothing}
        </div>` : this.detailLoading ? html`<p role="status">正在读取审计记录 #${this.detailId}…</p>` : nothing}
        <button slot="footer" type="button" class="btn" @click=${this.closeDetail}>返回列表</button>
      </app-dialog>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'agent-tool-audit-page': AgentToolAuditPage } }
