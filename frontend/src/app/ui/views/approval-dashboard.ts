import { LitElement, html, css, nothing } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, state } from "lit/decorators.js";
import "../components/app-dialog.js";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { sql, MySQL, PostgreSQL } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
import { authFetch } from "../../../api/index.js";

interface ApprovalRequest {
  id: number; instance_id: number; sql_text: string; risk_level: string;
  ai_recommendation: any; status: string; reviewed_by: number | null;
  review_notes: string | null; execution_result: any; created_at: string;
  target_database?: string;
}

interface ApprovalEvent {
  id: number;
  request_id: number;
  event_type: 'submitted' | 'ai_reviewed' | 'approved' | 'rejected' | 'executed' | 'execution_failed' | 'notified';
  event_data: any;
  created_by: number | null;
  created_at: string;
}

@customElement("approval-dashboard")
export class ApprovalDashboard extends LitElement {
  static styles = [sharedBtnStyles, css`
    :host { display: block; padding: var(--space-xl); }
    .tabs { display: flex; gap: var(--space-xs); margin-bottom: 16px; border-bottom: 1px solid var(--border, #e5e7eb); }
    .tab { padding: 10px var(--space-xl); font-size: var(--text-md); cursor: pointer; border: none; background: none; color: var(--muted, #6b7280); border-bottom: 2px solid transparent; }
    .tab.active { color: var(--accent, #3b82f6); border-bottom-color: var(--accent, #3b82f6); }
    .card { background: var(--card, #fff); border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-md); padding: var(--space-lg); margin-bottom: 12px; }
    .card:hover { border-color: var(--border-strong, #d1d1d6); }
    .card.selected { background: var(--accent-subtle, rgba(64,158,255,0.08)); border-color: var(--accent, #3b82f6); }
    .card-row { display: flex; align-items: flex-start; gap: var(--space-md); cursor: pointer; }
    .card-checkbox { margin-top: 4px; min-width: 44px; display: flex; align-items: center; justify-content: center; background: var(--bg-secondary, #f3f4f6); border-radius: var(--radius-sm); }
    .card-checkbox input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent, #409eff); }
    .card-body { flex: 1; min-width: 0; }
    .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
    .sql-preview { font-family: var(--mono, monospace); font-size: var(--text-sm); padding: var(--space-sm); background: var(--bg-elevated, #f9fafb); border-radius: var(--radius-sm); overflow: hidden; text-overflow: ellipsis; white-space: pre-wrap; max-height: 80px; }
    .actions { display: flex; gap: var(--space-sm); margin-top: 12px; }
    .btn { padding: var(--space-sm) var(--space-lg); border-radius: var(--radius-sm); font-size: var(--text-base); cursor: pointer; border: 1px solid var(--border, #e5e7eb); background: var(--card, #fff); color: var(--text, #3c3c43); }
    .btn-approve { background: var(--ok-subtle, #ecfdf5); color: var(--ok, #22c55e); border-color: var(--ok, #22c55e); }
    .btn-reject { background: var(--danger-subtle, #fef2f2); color: var(--destructive, #ef4444); border-color: var(--destructive, #ef4444); }
    .batch-bar { display: flex; align-items: center; gap: var(--space-md); height: 48px; padding: 0 var(--space-lg); margin-bottom: 12px; background: var(--card, #fff); border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-md); animation: fade-in 0.2s ease; }
    .batch-bar .count { font-size: var(--text-md); color: var(--text, #3c3c43); font-weight: 500; }
    .batch-bar .spacer { flex: 1; }
    .card-exec-checkbox { margin-top: 8px; padding-top: 12px; border-top: 1px solid var(--border, #e5e7eb); font-size: var(--text-sm); color: var(--muted, #6e6e73); display: flex; align-items: center; gap: var(--space-xs); }
    .card-exec-checkbox input[type="checkbox"] { width: 14px; height: 14px; cursor: pointer; accent-color: var(--accent, #409eff); }
    .card-exec-checkbox label { cursor: pointer; user-select: none; }
    .exec-result { margin-top: 8px; font-size: var(--text-sm); padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-sm); }
    .exec-result.success { color: var(--ok, #22c55e); background: var(--ok-subtle, #ecfdf5); }
    .exec-result.fail { color: var(--destructive, #ef4444); background: var(--danger-subtle, #fef2f2); }
    .empty { padding: 40px; text-align: center; color: var(--muted, #6b7280); }
    .ai-badge { font-size: var(--text-xs); padding: var(--space-xs) var(--space-sm); background: var(--bg-elevated, #f9fafb); border-radius: var(--radius-sm); color: var(--muted, #6b7280); }
    .loading { padding: 40px; text-align: center; color: var(--muted, #6b7280); }
    .detail-header { display: flex; align-items: center; gap: var(--space-md); margin-bottom: 20px; }
    .back-link { color: var(--accent, #409eff); cursor: pointer; font-size: var(--text-md); text-decoration: none; }
    .back-link:hover { text-decoration: underline; }
    .detail-title { font-size: var(--text-xl); font-weight: 600; color: var(--text-strong, #1a1a1e); margin: 0; }


    .error-box { background: var(--danger-subtle, #fef2f2); color: var(--destructive, #ef4444); padding: var(--space-sm) var(--space-md); border-radius: var(--radius-sm); font-size: var(--text-base); margin-bottom: 12px; }
    .detail-split { display: grid; grid-template-columns: 1fr 360px; gap: 32px; align-items: start; }
    .detail-sql-panel { background: var(--card, #fff); border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-md); overflow: hidden; min-height: 300px; }
    .detail-sql-panel .cm-editor { height: 100%; }
    .detail-sql-panel .cm-scroller { font-family: var(--mono, 'JetBrains Mono', monospace); font-size: var(--text-base); overflow: auto; }
    .detail-sidebar { display: flex; flex-direction: column; gap: var(--space-lg); }
    .meta-card { background: var(--card, #fff); border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-md); padding: var(--space-lg); }
    .meta-card h3 { font-size: var(--text-md); font-weight: 600; color: var(--text-strong, #1a1a1e); margin: 0 0 12px 0; padding-bottom: 8px; border-bottom: 1px solid var(--border, #e5e7eb); }
    .meta-row { display: flex; justify-content: space-between; padding: var(--space-sm) 0; font-size: var(--text-base); }
    .meta-label { color: var(--muted, #6e6e73); }
    .meta-value { color: var(--text, #3c3c43); font-weight: 500; text-align: right; }
    .timeline-card { background: var(--card, #fff); border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-md); padding: var(--space-lg); }
    .timeline-header { font-size: var(--text-md); font-weight: 600; color: var(--text-strong, #1a1a1e); margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid var(--border, #e5e7eb); }
    .timeline-list { position: relative; padding-left: 24px; }
    .timeline-list::before { content: ''; position: absolute; left: 11px; top: 0; bottom: 0; width: 2px; background: var(--border, #e5e5ea); }
    .timeline-node { display: flex; gap: var(--space-md); padding-bottom: 20px; position: relative; animation: fade-in 0.3s ease-out both; }
    .timeline-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; margin-top: 4px; z-index: 1; }
    .timeline-dot--submitted,
    .timeline-dot--notified { background: var(--accent, #409eff); }
    .timeline-dot--ai_reviewed { background: var(--warn, #f59e0b); }
    .timeline-dot--approved,
    .timeline-dot--executed { background: var(--ok, #22c55e); }
    .timeline-dot--rejected,
    .timeline-dot--execution_failed { background: var(--destructive, #ef4444); }
    .timeline-content { min-width: 0; }
    .timeline-event-name { font-size: var(--text-md); font-weight: 500; color: var(--text-strong, #1a1a1e); }
    .timeline-timestamp { font-size: var(--text-sm); color: var(--muted, #6e6e73); margin-top: 2px; }
    .timeline-detail { font-size: var(--text-sm); color: var(--text, #3c3c43); margin-top: 4px; white-space: pre-wrap; }
    .detail-error { padding: 20px; text-align: center; color: var(--destructive, #ef4444); }
    .detail-error button { margin-top: 12px; }
  `];

  @state() private view: "list" | "detail" = "list";
  @state() private requests: ApprovalRequest[] = [];
  @state() private filter: "pending" | "processed" = "pending";
  @state() private selectedIds: Set<number> = new Set();
  @state() private executeAfterApprove: Record<number, boolean> = {};
  @state() private loading: boolean = false;
  @state() private selectedRequest: ApprovalRequest | null = null;
  @state() private batchDialogOpen: boolean = false;
  @state() private batchIds: number[] = [];
  @state() private batchAction: 'approve' | 'reject' = 'approve';
  @state() private batchNote: string = '';
  @state() private batchLoading: boolean = false;
  @state() private batchError: string | null = null;

  // --- Detail view state ---
  @state() private events: ApprovalEvent[] = [];
  @state() private detailLoading: boolean = false;
  @state() private detailError: string | null = null;

  private _codeMirrorView: EditorView | null = null;
  private _codeMirrorContainer: HTMLElement | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.loadRequests();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
  }

  private async loadRequests() {
    this.loading = true;
    try {
      const endpoint = this.filter === "pending" ? "/api/approval/pending" : "/api/approval/history";
      const res = await authFetch(endpoint);
      if (res.ok) {
        this.requests = await res.json() || [];
        if (this.filter === 'pending') {
          this.executeAfterApprove = Object.fromEntries(this.requests.map(r => [r.id, true]));
        }
      } else {
        this.requests = [];
      }
    } catch {
      this.requests = [];
    }
    this.loading = false;
  }

  // --- Sub-view switching ---
  private openDetail(request: ApprovalRequest) {
    this.selectedRequest = request;
    this.view = "detail";
    this._loadDetail(request.id);
  }

  private backToList() {
    this._destroyCodeMirror();
    this.events = [];
    this.detailError = null;
    this.detailLoading = false;
    this.view = "list";
    this.selectedRequest = null;
  }

  private async _loadDetail(requestId: number) {
    this.detailLoading = true;
    this.detailError = null;
    this.events = [];
    this._destroyCodeMirror();
    try {
      const [detailRes, eventsRes] = await Promise.all([
        authFetch(`/api/approval/${requestId}`),
        authFetch(`/api/approval/${requestId}/events`),
      ]);
      if (!detailRes.ok) { this.detailError = '加载失败，请重试'; this.detailLoading = false; return; }
      const detail = await detailRes.json() as ApprovalRequest;
      this.selectedRequest = detail;
      if (eventsRes.ok) {
        this.events = await eventsRes.json() as ApprovalEvent[];
      }
      this.detailLoading = false;
      // Mount CodeMirror in next microtask to ensure DOM is rendered
      await this.updateComplete;
      this._mountCodeMirror(`cm-container-${requestId}`, detail.sql_text, (detail as any).db_type || 'mysql');
    } catch (e: any) {
      this.detailError = '加载失败，请重试';
      this.detailLoading = false;
    }
  }

  // --- Helper methods for detail view ---
  private _statusLabel(status: string): string {
    const labels: Record<string, string> = {
      'pending': '待审批', 'approved': '已通过', 'rejected': '已驳回',
      'executed': '已执行', 'cancelled': '已取消',
    };
    return labels[status] || status;
  }

  private _eventLabel(type: string): string {
    const labels: Record<string, string> = {
      'submitted': '提交审批', 'ai_reviewed': 'AI 风险评估', 'approved': '审批通过',
      'rejected': '审批驳回', 'executed': '自动执行SQL', 'execution_failed': '自动执行失败',
      'notified': '通知发送',
    };
    return labels[type] || type;
  }

  private _eventDetail(ev: ApprovalEvent): string {
    const d = ev.event_data;
    if (!d) return '';
    switch (ev.event_type) {
      case 'executed': return `影响 ${d.rows ?? d.rowsAffected ?? '?'} 行 · 耗时 ${d.duration ?? '?'}ms`;
      case 'execution_failed': return `错误: ${d.error ?? '未知错误'}`;
      case 'ai_reviewed': return d.risk_level ? `风险等级: ${d.risk_level}` : '';
      case 'rejected': return d.notes ? `备注: ${d.notes}` : '';
      default: return '';
    }
  }

  // --- CodeMirror mount/destroy ---
  private _mountCodeMirror(containerId: string, sqlText: string, dbType: string = 'mysql') {
    this._destroyCodeMirror();
    const container = this.shadowRoot?.getElementById(containerId);
    if (!container) return;
    this._codeMirrorContainer = container as HTMLElement;
    const dialect = dbType === 'postgresql' ? PostgreSQL : MySQL;
    const view = new EditorView({
      state: EditorState.create({
        doc: sqlText,
        extensions: [
          lineNumbers(),
          sql({ dialect }),
          oneDark,
          EditorView.editable.of(false),
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": { fontFamily: "var(--mono, 'JetBrains Mono', monospace)", fontSize: "13px", overflow: "auto" },
          }),
        ],
      }),
      parent: this._codeMirrorContainer,
    });
    this._codeMirrorView = view;
  }

  private _destroyCodeMirror() {
    if (this._codeMirrorView) {
      this._codeMirrorView.destroy();
      this._codeMirrorView = null;
    }
    this._codeMirrorContainer = null;
  }

  // --- Multi-select ---
  private _toggleSelect(id: number) {
    const next = new Set(this.selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    this.selectedIds = next;
  }

  private _isAllSelected(): boolean {
    const pendingItems = this.requests.filter(r => r.status === 'pending');
    return pendingItems.length > 0 && pendingItems.every(r => this.selectedIds.has(r.id));
  }

  private _toggleSelectAll() {
    if (this._isAllSelected()) {
      this.selectedIds = new Set();
    } else {
      this.selectedIds = new Set(this.requests.filter(r => r.status === 'pending').map(r => r.id));
    }
  }

  private clearSelection() {
    this.selectedIds = new Set();
  }

  // --- Batch dialog ---
  private _handleEscapeKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this._closeBatchDialog();
  };

  private _openBatchDialog(ids: number[], action: 'approve' | 'reject') {
    this.batchIds = ids;
    this.batchAction = action;
    this.batchNote = '';
    this.batchLoading = false;
    this.batchError = null;
    this.batchDialogOpen = true;
    // Add Escape key handler per UI-SPEC requirement (checker fix)
    document.addEventListener('keydown', this._handleEscapeKey);
  }

  private _closeBatchDialog() {
    this.batchDialogOpen = false;
    this.batchIds = [];
    this.batchError = null;
    document.removeEventListener('keydown', this._handleEscapeKey);
  }

  private async _confirmBatch() {
    this.batchLoading = true;
    this.batchError = null;
    try {
      const body: any = {
        ids: this.batchIds,
        action: this.batchAction,
        notes: this.batchNote || undefined,
      };
      if (this.batchAction === 'approve') {
        body.execute_ids = this.batchIds.filter(id => this.executeAfterApprove[id] !== false);
      }
      const res = await authFetch('/api/approval/batch-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        this.batchError = data?.error || '操作失败，请重试';
        this.batchLoading = false;
        return;
      }
      this.batchLoading = false;
      this._closeBatchDialog();
      this.clearSelection();
      this.loadRequests();
    } catch (e: any) {
      this.batchError = '操作失败，请重试';
      this.batchLoading = false;
    }
  }

  // --- Execution result display ---
  private _renderExecResult(r: ApprovalRequest) {
    if (!r.execution_result) return '';
    let er: any;
    if (typeof r.execution_result === 'string') {
      try { er = JSON.parse(r.execution_result); } catch { er = { error: '无法解析执行结果' }; }
    } else {
      er = r.execution_result;
    }
    if (er.error) {
      return html`<div class="exec-result fail">执行失败: ${er.error}</div>`;
    }
    const parts: string[] = [];
    const dur = er.duration_ms ?? er.duration;
    if (dur !== undefined && dur !== null) parts.push(`${dur}ms`);
    const rc = er.rowCount ?? er.rowsAffected;
    if (rc !== undefined && rc !== null) parts.push(`${rc} 行`);
    return html`<div class="exec-result success">执行成功 ${parts.length ? '— ' + parts.join(' · ') : ''}</div>`;
  }

  private _riskBadge(level: string) {
    const variantMap: Record<string, string> = {
      high: "danger",
      critical: "danger",
      medium: "warn",
      low: "info",
    };
    return html`<app-badge variant=${variantMap[level] || "muted"}>${level?.toUpperCase()}</app-badge>`;
  }

  override render() {
    if (this.view === "detail" && this.selectedRequest) {
      return this.renderDetail();
    }
    return this.renderList();
  }

  private renderList() {
    return html`
      <div class="tabs">
        <button class="tab ${this.filter === 'pending' ? 'active' : ''}" @click=${() => { this.filter = 'pending'; this.clearSelection(); this.loadRequests(); }}>
          待审批
        </button>
        <button class="tab ${this.filter === 'processed' ? 'active' : ''}" @click=${() => { this.filter = 'processed'; this.clearSelection(); this.loadRequests(); }}>
          已处理
        </button>
      </div>

      ${this.filter === 'pending' && this.selectedIds.size > 0 ? html`
        <div class="batch-bar">
          <span class="count">已选择 <strong>${this.selectedIds.size}</strong> 项</span>
          <div class="spacer"></div>
          <button class="btn btn-approve" @click=${() => this._openBatchDialog(Array.from(this.selectedIds), 'approve')}>
            通过 (${this.selectedIds.size})
          </button>
          <button class="btn btn-reject" @click=${() => this._openBatchDialog(Array.from(this.selectedIds), 'reject')}>
            驳回 (${this.selectedIds.size})
          </button>
        </div>
      ` : ''}

      ${this.loading ? html`<div class="loading">加载中...</div>` :
      this.requests.length === 0 ? html`<div class="empty">${this.filter === 'pending' ? '暂无待审批请求' : '暂无已处理记录'}</div>` :
      this.requests.map(r => html`
        <div class="card ${this.selectedIds.has(r.id) ? 'selected' : ''}">
          <div class="card-row" @click=${() => this.openDetail(r)}>
            ${this.filter === 'pending' ? html`
              <div class="card-checkbox" @click=${(e: Event) => e.stopPropagation()}>
                <input type="checkbox" .checked=${this.selectedIds.has(r.id)} @change=${() => this._toggleSelect(r.id)}>
              </div>
            ` : ''}
            <div class="card-body">
              <div class="card-header">
                <div>
                  ${this._riskBadge(r.risk_level)}
                  <span style="margin-left:8px;font-size:12px;color:var(--muted)">#${r.id} · ${new Date(r.created_at).toLocaleString("zh-CN")}</span>
                  ${r.target_database ? html`
                    <span style="margin-left:8px;font-size:11px;color:var(--muted, #6b7280)">DB: ${r.target_database}</span>
                  ` : ''}
                </div>
                ${r.ai_recommendation ? html`
                  <span class="ai-badge">AI: ${r.ai_recommendation.recommendation === 'approve' ? '建议通过' : '建议驳回'}</span>
                ` : ''}
              </div>
              <div class="sql-preview">${r.sql_text}</div>
              ${r.ai_recommendation?.reasoning ? html`
                <div style="margin-top:8px;font-size:12px;color:var(--muted);">${r.ai_recommendation.reasoning}</div>
              ` : ''}
              ${r.status === 'approved' ? html`
                ${r.execution_result ? this._renderExecResult(r) : html`<div style="margin-top:8px;font-size:12px;color:var(--ok,#15803d);">✓ 已通过 ${r.review_notes ? '— ' + r.review_notes : ''}</div>`}
              ` : ''}
              ${r.status === 'executed' ? this._renderExecResult(r) : ''}
              ${r.status === 'rejected' ? html`
                <div style="margin-top:8px;font-size:12px;color:var(--destructive,#ef4444);">✗ 已驳回 ${r.review_notes ? '— ' + r.review_notes : ''}</div>
              ` : ''}
            </div>
          </div>

          ${r.status === 'pending' ? html`
            <div class="card-exec-checkbox" @click=${(e: Event) => e.stopPropagation()}>
              <input type="checkbox" id="exec-${r.id}" .checked=${this.executeAfterApprove[r.id] !== false}
                @change=${() => { this.executeAfterApprove = { ...this.executeAfterApprove, [r.id]: !this.executeAfterApprove[r.id] }; }}>
              <label for="exec-${r.id}">审批后自动执行</label>
            </div>
            <div class="actions" @click=${(e: Event) => e.stopPropagation()}>
              <button class="btn btn-approve" @click=${() => this._openBatchDialog([r.id], 'approve')}>通过</button>
              <button class="btn btn-reject" @click=${() => this._openBatchDialog([r.id], 'reject')}>驳回</button>
            </div>
          ` : ''}
        </div>
      `)}

      ${this._renderBatchDialog()}
    `;
  }

  private renderDetail() {
    const r = this.selectedRequest;
    if (!r) return this.renderList();
    return html`
      <div class="detail-header">
        <a class="back-link" @click=${this.backToList}>← 返回列表</a>
        <h2 class="detail-title">审批详情</h2>
      </div>

      ${this.detailLoading ? html`<div class="loading">加载中...</div>` :
      this.detailError ? html`
        <div class="detail-error">
          <div>${this.detailError}</div>
          <button class="btn" @click=${() => this._loadDetail(r.id)}>重试</button>
        </div>
      ` :
      html`
        <div class="detail-split">
          <div class="detail-sql-panel">
            <div id="cm-container-${r.id}" style="height:100%;min-height:300px;"></div>
          </div>
          <div class="detail-sidebar">
            <div class="meta-card">
              <h3>基本信息</h3>
              <div class="meta-row"><span class="meta-label">实例名称</span><span class="meta-value">${(r as any).instance_name || String(r.instance_id)}</span></div>
              <div class="meta-row"><span class="meta-label">目标数据库</span><span class="meta-value">${(r as any).target_database || '默认数据库'}</span></div>
              <div class="meta-row"><span class="meta-label">提交人</span><span class="meta-value">${(r as any).submitted_by || '-'}</span></div>
              <div class="meta-row"><span class="meta-label">提交时间</span><span class="meta-value">${new Date(r.created_at).toLocaleString("zh-CN")}</span></div>
              <div class="meta-row"><span class="meta-label">风险等级</span><span class="meta-value">${this._riskBadge(r.risk_level)}</span></div>
              <div class="meta-row"><span class="meta-label">当前状态</span><span class="meta-value">${this._statusLabel(r.status)}</span></div>
              ${r.ai_recommendation ? html`
                <div class="meta-row"><span class="meta-label">AI 分析</span><span class="meta-value"><span class="ai-badge">AI: ${r.ai_recommendation.recommendation === 'approve' ? '建议通过' : '建议驳回'}</span></span></div>
                ${r.ai_recommendation?.reasoning ? html`<div class="meta-row"><span class="meta-label">AI 理由</span><span class="meta-value" style="font-size:12px;color:var(--muted);">${r.ai_recommendation.reasoning}</span></div>` : ''}
              ` : ''}
            </div>
            <div class="timeline-card">
              <div class="timeline-header">审批历程</div>
              <div class="timeline-list">
                ${this.events.length === 0 ? html`<div style="color:var(--muted);font-size:13px;padding:8px 0;">暂无事件记录</div>` :
                this.events.map((ev, i) => html`
                  <div class="timeline-node" style="animation-delay:${i * 50}ms">
                    <div class="timeline-dot timeline-dot--${ev.event_type}"></div>
                    <div class="timeline-content">
                      <div class="timeline-event-name">${this._eventLabel(ev.event_type)}</div>
                      <div class="timeline-timestamp">${new Date(ev.created_at).toLocaleString("zh-CN")}</div>
                      ${ev.event_data ? html`<div class="timeline-detail">${this._eventDetail(ev)}</div>` : ''}
                    </div>
                  </div>
                `)}
              </div>
            </div>
          </div>
        </div>
      `}
    `;
  }

  private _renderBatchDialog() {
    if (!this.batchDialogOpen) return nothing;
    return html`
      <app-dialog .open=${true} size="md" title="${this.batchAction === 'approve' ? '批量通过' : '批量驳回'}" @app-dialog-close=${this._closeBatchDialog}>
        <div style="margin-bottom:12px;font-size:var(--text-md);color:var(--text, #3c3c43);">
          确认对选中的 <strong>${this.batchIds.length}</strong> 项请求执行${this.batchAction === 'approve' ? '通过' : '驳回'}操作？
        </div>
        ${this.batchError ? html`<div class="error-box">${this.batchError}</div>` : ''}
        <textarea style="width:100%;min-height:80px;padding:var(--space-sm) var(--space-md);border:1px solid var(--border, #e5e7eb);border-radius:var(--radius-sm);font-size:var(--text-md);color:var(--text, #3c3c43);resize:vertical;box-sizing:border-box;font-family:inherit;"
          placeholder="审批备注（可选）" .value=${this.batchNote}
          @input=${(e: Event) => { this.batchNote = (e.target as HTMLTextAreaElement).value; }}></textarea>
        <div slot="footer">
          <button class="btn" @click=${this._closeBatchDialog} ?disabled=${this.batchLoading}>取消</button>
          <button class="btn ${this.batchAction === 'approve' ? 'btn-approve' : 'btn-reject'}"
            @click=${this._confirmBatch} ?disabled=${this.batchLoading}>
            ${this.batchLoading ? '处理中...' : (this.batchAction === 'approve' ? '确认通过' : '确认驳回')}
          </button>
        </div>
      </app-dialog>
    `;
  }
}
