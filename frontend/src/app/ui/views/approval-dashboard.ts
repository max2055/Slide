import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, css, nothing } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, state } from "lit/decorators.js";
import "../components/app-dialog.js";
import "../components/app-card.js";
import "../components/app-data-table.js";
import "../components/app-badge.js";
import "../components/app-empty-state.js";
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
  operation_id?: string | null;
}

interface AgentApproval {
  id: string;
  tool_name: string;
  requester_id: number;
  args_redacted: unknown;
  resource_json: unknown;
  status: string;
  scope?: 'once' | 'window' | 'session';
  risk_level?: 'low' | 'medium' | 'high';
  used_count?: number;
  max_uses?: number;
  expires_at: string;
  created_at: string;
}

type HistoryItem = { kind: 'sql'; record: ApprovalRequest } | { kind: 'agent'; record: AgentApproval };
type ExecutionState = 'none' | 'success' | 'failed' | 'running' | 'unknown' | 'conflict';

export function approvalValue(value: unknown): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function approvalDecision(status: string): string {
  if (['approved', 'executed', 'execution_failed', 'executing', 'consumed'].includes(status)) return 'approved';
  return status;
}

// Presentation only: approval and consumption do not prove execution success.
export function approvalExecution(record: { status: string; execution_result?: unknown }, agent = false): ExecutionState {
  const result = approvalValue(record.execution_result);
  const hasResult = record.execution_result != null && record.execution_result !== '';
  if (record.status === 'rejected' || record.status === 'cancelled' || record.status === 'expired') {
    return hasResult ? 'conflict' : 'none';
  }
  if (agent) return record.status === 'consumed' ? 'unknown' : 'none';
  // A failed SQL/audit acknowledgement can follow a commit; it is not a known failure.
  if (result?.executionState === 'unknown') {
    return record.status === 'executed' || record.status === 'execution_failed' || result?.success === true ? 'conflict' : 'unknown';
  }
  if (result?.success === false || result?.error || record.status === 'execution_failed') {
    return record.status === 'executed' || result?.success === true ? 'conflict' : 'failed';
  }
  if (record.status === 'executing') return result?.success === true ? 'conflict' : 'running';
  if (record.status === 'executed' || result?.success === true) return 'success';
  return hasResult || !['pending', 'approved'].includes(record.status) ? 'unknown' : 'none';
}

const executionLabels: Record<ExecutionState, string> = {
  none: '未执行', success: '执行成功', failed: '执行失败', running: '执行中', unknown: '结果未知', conflict: '证据冲突',
};
const shortText = (value: string, length = 90) => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > length ? text.slice(0, length) + '…' : text;
};
const evidenceText = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '未提供';

export function agentApprovalsLoadError(status: number): string {
  if (status === 401 || status === 403) {
    return 'Agent 审批列表加载失败：当前用户没有审批查看权限';
  }
  if (status === 503) {
    return 'Agent 审批列表加载失败：审批表不可用，请检查数据库迁移';
  }
  return `Agent 审批列表加载失败（HTTP ${status}）`;
}

interface ApprovalEvent {
  id: number;
  request_id: number;
  event_type: 'submitted' | 'ai_reviewed' | 'approved' | 'rejected' | 'executed' | 'execution_failed' | 'notified';
  event_data: any;
  created_by: number | null;
  created_at: string;
}

interface OperationEvent { toState: string; reasonCode: string; metadata?: Record<string, unknown>; createdAt: string; }

@customElement("approval-dashboard")
export class ApprovalDashboard extends LitElement {
  static styles = [sharedFieldStyles, sharedBtnStyles, css`
    :host { display: block; padding: var(--space-xl); min-width: 0; color: var(--text); }
    * { box-sizing: border-box; }
    .page-head { display: flex; justify-content: space-between; align-items: start; gap: var(--space-md); margin-bottom: var(--space-xl); }
    h1 { font-size: 24px; margin: 0 0 var(--space-sm); color: var(--text-strong); }
    .caption { color: var(--muted); font-size: 12px; margin: 0; line-height: 1.6; }
    .history-toolbar { display: flex; flex-wrap: wrap; align-items: end; gap: var(--space-md); margin-bottom: var(--space-lg); }
    .history-toolbar label { display: grid; gap: var(--space-xs); font-size: 12px; color: var(--muted); }
    .history-toolbar .search { flex: 1; min-width: 180px; max-width: 380px; }
    .history-toolbar input, .history-toolbar select { width: 100%; min-height: 38px; font: inherit; font-size: 14px; color: var(--text); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-sm) var(--space-md); }
    .history-notice { padding: var(--space-md) var(--space-lg); background: var(--bg-elevated); border-left: 3px solid var(--border-strong); border-radius: var(--radius-sm); font-size: 12px; line-height: 1.7; margin-bottom: var(--space-lg); }
    .history-notice strong { display: block; font-size: 14px; }
    .history-card::part(header), .history-card::part(footer) { display: none; }
    .table-scroll { overflow-x: auto; }
    app-data-table { min-width: 860px; }
    .history-detail { color: var(--accent-text); }
    .history-summary { display: block; max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 14px; font-weight: 500; }
    .history-target { display: block; max-width: 180px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pagination { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-md); padding: var(--space-md) var(--space-lg); border-top: 1px solid var(--border); font-size: 12px; }
    .pagination > div { display: flex; gap: var(--space-sm); align-items: center; }
    .evidence-section { margin: var(--space-lg) 0; min-width: 0; }
    .evidence-section h3 { font-size: 16px; margin: 0 0 var(--space-sm); }
    .evidence-section pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono); font-size: 12px; background: var(--bg-elevated); padding: var(--space-md); border-radius: var(--radius-sm); max-height: 400px; overflow: auto; }
    .evidence-meta { display: flex; gap: var(--space-sm); flex-wrap: wrap; align-items: center; margin-bottom: var(--space-md); }
    .pending-preview { max-height: none !important; overflow-wrap: anywhere; }
    .pending-detail { margin-top: var(--space-sm); }
    .meta-value, .timeline-detail { overflow-wrap: anywhere; min-width: 0; }
    .meta-row { gap: var(--space-md); }
    .detail-split > * { min-width: 0; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (max-width: 850px) { .detail-split { grid-template-columns: minmax(0, 1fr) !important; gap: var(--space-lg) !important; } }
    @media (max-width: 600px) {
      :host { padding: var(--space-md); }
      h1 { font-size: 22px; }
      .history-toolbar label { flex: 1; min-width: 130px; }
      .history-toolbar .search { flex-basis: 100%; max-width: none; }
      .actions, .batch-bar, .card-header { flex-wrap: wrap; }
      .batch-bar { height: auto !important; padding: var(--space-sm) !important; }
      .card-checkbox { min-width: 24px !important; }
    }
    .tabs { display: flex; gap: var(--space-xs); margin-bottom: 16px; border-bottom: 1px solid var(--border, #e5e7eb); }
    .tab { padding: 10px var(--space-xl); font-size: var(--text-md); cursor: pointer; border: none; background: none; color: var(--muted, #6b7280); border-bottom: 2px solid transparent; }
    .tab.active { color: var(--accent-text); border-bottom-color: var(--accent, #3b82f6); }
    .card { background: var(--card, #fff); border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-md); padding: var(--space-lg); margin-bottom: 12px; }
    .card:hover { border-color: var(--border-strong, #d1d1d6); }
    .card.selected { background: var(--accent-subtle, rgba(64,158,255,0.08)); border-color: var(--accent, #3b82f6); }
    .card-row { display: flex; align-items: flex-start; gap: var(--space-md); cursor: pointer; }
    .card-checkbox { margin-top: 4px; min-width: 44px; display: flex; align-items: center; justify-content: center; background: var(--bg-secondary, #f3f4f6); border-radius: var(--radius-sm); }
    .card-checkbox input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent, #409eff); }
    .card-body { overflow-wrap: anywhere; flex: 1; min-width: 0; }
    .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
    .sql-preview { font-family: var(--mono, monospace); font-size: var(--text-sm); padding: var(--space-sm); background: var(--bg-elevated, #f9fafb); border-radius: var(--radius-sm); overflow: hidden; text-overflow: ellipsis; white-space: pre-wrap; max-height: 80px; }
    .actions { display: flex; gap: var(--space-sm); margin-top: 12px; }
    .btn { padding: var(--space-sm) var(--space-lg); border-radius: var(--radius-sm); font-size: var(--text-base); cursor: pointer; border: 1px solid var(--border, #e5e7eb); background: var(--card, #fff); color: var(--text, #3c3c43); }
    .btn-approve { background: var(--ok-subtle, #ecfdf5); color: var(--ok, #22c55e); border-color: var(--ok, #22c55e); }
    .btn-reject { background: var(--danger-subtle, #fef2f2); color: var(--danger, #ef4444); border-color: var(--danger, #ef4444); }
    .batch-bar { display: flex; align-items: center; gap: var(--space-md); height: 48px; padding: 0 var(--space-lg); margin-bottom: 12px; background: var(--card, #fff); border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-md); animation: fade-in 0.2s ease; }
    .batch-bar .count { font-size: var(--text-md); color: var(--text, #3c3c43); font-weight: 500; }
    .batch-bar .spacer { flex: 1; }
    .card-exec-checkbox { margin-top: 8px; padding-top: 12px; border-top: 1px solid var(--border, #e5e7eb); font-size: var(--text-sm); color: var(--muted, #6e6e73); display: flex; align-items: center; gap: var(--space-xs); }
    .card-exec-checkbox input[type="checkbox"] { width: 14px; height: 14px; cursor: pointer; accent-color: var(--accent, #409eff); }
    .card-exec-checkbox label { cursor: pointer; user-select: none; }
    .exec-result { margin-top: 8px; font-size: var(--text-sm); padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-sm); }
    .exec-result.success { color: var(--ok, #22c55e); background: var(--ok-subtle, #ecfdf5); }
    .exec-result.fail { color: var(--danger, #ef4444); background: var(--danger-subtle, #fef2f2); }
    .empty { padding: 40px; text-align: center; color: var(--muted, #6b7280); }
    .ai-badge { font-size: var(--text-xs); padding: var(--space-xs) var(--space-sm); background: var(--bg-elevated, #f9fafb); border-radius: var(--radius-sm); color: var(--muted, #6b7280); }
    .loading { padding: 40px; text-align: center; color: var(--muted, #6b7280); }
    .detail-header { display: flex; align-items: center; gap: var(--space-md); margin-bottom: 20px; }
    .back-link { color: var(--accent-text); cursor: pointer; font-size: var(--text-md); text-decoration: none; }
    .back-link:hover { text-decoration: underline; }
    .detail-title { font-size: var(--text-xl); font-weight: 600; color: var(--text-strong, #1a1a1e); margin: 0; }


    .error-box { background: var(--danger-subtle, #fef2f2); color: var(--danger, #ef4444); padding: var(--space-sm) var(--space-md); border-radius: var(--radius-sm); font-size: var(--text-base); margin-bottom: 12px; }
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
    .timeline-dot--execution_failed { background: var(--danger, #ef4444); }
    .timeline-content { min-width: 0; }
    .timeline-event-name { font-size: var(--text-md); font-weight: 500; color: var(--text-strong, #1a1a1e); }
    .timeline-timestamp { font-size: var(--text-sm); color: var(--muted, #6e6e73); margin-top: 2px; }
    .timeline-detail { font-size: var(--text-sm); color: var(--text, #3c3c43); margin-top: 4px; white-space: pre-wrap; }
    .detail-error { padding: 20px; text-align: center; color: var(--danger, #ef4444); }
    .detail-error button { margin-top: 12px; }
  `];

  @state() private view: "list" | "detail" = "list";
  @state() private requests: ApprovalRequest[] = [];
  @state() private agentApprovals: AgentApproval[] = [];
  @state() private agentApprovalsError: string | null = null;
  @state() private reviewingAgentTools: Set<string> = new Set();
  @state() private filter: "pending" | "processed" = "pending";
  @state() private historyQuery = '';
  @state() private decisionFilter = 'all';
  @state() private executionFilter = 'all';
  @state() private historyPage = 0;
  @state() private selectedAgent: AgentApproval | null = null;
  @state() private evidenceWarning = '';
  private listGeneration = 0;
  private detailGeneration = 0;
  private detailTrigger: HTMLElement | null = null;
  private get historyContextKey() {
    try { return `slide.approval-history.v1:${JSON.parse(localStorage.getItem('user') ?? 'null')?.id ?? 'default'}`; }
    catch { return 'slide.approval-history.v1:default'; }
  }
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
  @state() private operationDetail: unknown = null;
  @state() private operationEvents: OperationEvent[] = [];
  @state() private operationState: string | null = null;

  private _codeMirrorView: EditorView | null = null;
  private _codeMirrorContainer: HTMLElement | null = null;

  override connectedCallback() {
    super.connectedCallback();
    try {
      const context = JSON.parse(sessionStorage.getItem(this.historyContextKey) ?? 'null');
      if (context) {
        this.filter = context.filter === 'processed' ? 'processed' : 'pending';
        this.historyQuery = typeof context.query === 'string' ? context.query : '';
        this.decisionFilter = typeof context.decision === 'string' ? context.decision : 'all';
        this.executionFilter = typeof context.execution === 'string' ? context.execution : 'all';
        this.historyPage = Number.isSafeInteger(context.page) && context.page > 0 ? context.page : 0;
      }
    } catch { /* Unavailable storage does not block approval reads. */ }
    this.loadRequests();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.listGeneration++;
    this.detailGeneration++;
    this._destroyCodeMirror();
    document.removeEventListener('keydown', this._handleEscapeKey);
  }

  private async loadRequests() {
    const generation = ++this.listGeneration;
    this.loading = true;
    this.agentApprovalsError = null;
    try {
      const endpoint = `/api/approval/unified?status=${this.filter}`;
      const res = await authFetch(endpoint);
      if (generation !== this.listGeneration) return;
      if (res.ok) {
        const payload = await res.json() as { items?: Array<ApprovalRequest & { kind?: 'sql' | 'agent' }> };
        if (generation !== this.listGeneration) return;
        const items = Array.isArray(payload?.items) ? payload.items : [];
        this.requests = items.filter((item) => item.kind !== 'agent') as ApprovalRequest[];
        this.agentApprovals = items.filter((item) => item.kind === 'agent') as unknown as AgentApproval[];
        this.agentApprovalsError = null;
        if (this.filter === 'pending') {
          this.executeAfterApprove = Object.fromEntries(this.requests.map(r => [r.id, true]));
        }
      } else {
        this.requests = [];
        this.agentApprovals = [];
        this.agentApprovalsError = agentApprovalsLoadError(res.status);
      }
    } catch {
      if (generation !== this.listGeneration) return;
      this.requests = [];
      this.agentApprovals = [];
      this.agentApprovalsError = '审批列表加载失败，请检查数据库迁移和当前用户权限';
    }
    this.loading = false;
    this.historyPage = Math.min(this.historyPage, Math.max(0, Math.ceil(this.historyItems().length / 6) - 1));
    this.saveHistoryContext();
  }

  private saveHistoryContext() {
    try { sessionStorage.setItem(this.historyContextKey, JSON.stringify({ filter: this.filter, query: this.historyQuery, decision: this.decisionFilter, execution: this.executionFilter, page: this.historyPage })); } catch { /* Optional navigation context. */ }
  }

  private switchFilter(filter: 'pending' | 'processed') {
    this.filter = filter;
    this.clearSelection();
    this.saveHistoryContext();
    this.loadRequests();
  }

  private async reviewAgentApproval(id: string, action: 'approve' | 'reject', scope?: 'once' | 'window' | 'session') {
    try {
      const response = await authFetch(`/api/agent/approvals/${encodeURIComponent(id)}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(scope ? { scope } : {}) }),
      });
      if (!response.ok) throw new Error('review failed');
      await this.loadRequests();
    } catch {
      this.agentApprovalsError = 'Agent 审批处理失败，请重试或刷新核对结果';
    }
  }

  private async reviewPendingAgentTool(toolName: string) {
    this.reviewingAgentTools = new Set(this.reviewingAgentTools).add(toolName);
    this.agentApprovalsError = null;
    try {
      const response = await authFetch('/api/agent/approvals/batch-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolName, action: 'approve', scope: 'once' }),
      });
      if (!response.ok) throw new Error('batch review failed');
      await this.loadRequests();
    } catch {
      this.agentApprovalsError = `批量审批 ${toolName} 失败，请刷新后重试`;
    } finally {
      const reviewing = new Set(this.reviewingAgentTools);
      reviewing.delete(toolName);
      this.reviewingAgentTools = reviewing;
    }
  }

  // --- Sub-view switching ---
  private openDetail(request: ApprovalRequest, trigger?: HTMLElement) {
    this.detailTrigger = trigger ?? null;
    this.evidenceWarning = '';
    this.operationState = null;
    this.operationDetail = null;
    this.operationEvents = [];
    this.selectedRequest = request;
    this.view = "detail";
    this._loadDetail(request.id);
  }

  private async backToList() {
    this.detailGeneration++;
    this.selectedAgent = null;
    this._destroyCodeMirror();
    this.events = [];
    this.operationEvents = [];
    this.operationState = null;
    this.operationDetail = null;
    this.detailError = null;
    this.detailLoading = false;
    this.view = "list";
    this.selectedRequest = null;
    await this.updateComplete;
    if (this.detailTrigger?.isConnected) this.detailTrigger.focus();
    else if (this.filter === 'pending') this.shadowRoot?.querySelector<HTMLButtonElement>(`[data-request-id="${this.detailTrigger?.dataset.requestId}"]`)?.focus();
    this.detailTrigger = null;
  }

  private async _loadDetail(requestId: number) {
    const generation = ++this.detailGeneration;
    this.detailLoading = true;
    this.detailError = null;
    this.evidenceWarning = '';
    this.events = [];
    this._destroyCodeMirror();
    try {
      const [detailRes, eventsRes] = await Promise.all([
        authFetch(`/api/approval/${requestId}`),
        authFetch(`/api/approval/${requestId}/events`),
      ]);
      if (generation !== this.detailGeneration) return;
      if (!detailRes.ok) { this.detailError = detailRes.status === 403 ? '当前用户没有此审批的查看权限' : '加载失败，请重试'; this.detailLoading = false; return; }
      const detail = await detailRes.json() as ApprovalRequest;
      if (generation !== this.detailGeneration) return;
      this.selectedRequest = detail;
      if (eventsRes.ok) {
        this.events = await eventsRes.json() as ApprovalEvent[];
      }
      else this.evidenceWarning = '审批事件读取失败，当前详情的证据不完整';
      if (detail.operation_id) {
        const [operationRes, operationEventsRes] = await Promise.all([
          authFetch(`/api/operations/${detail.operation_id}`),
          authFetch(`/api/operations/${detail.operation_id}/events`),
        ]);
        if (generation !== this.detailGeneration) return;
        if (!operationRes.ok || !operationEventsRes.ok) this.evidenceWarning = 'Operation 证据读取失败，不能据此推断执行状态';
        if (operationRes.ok) { const operation = await operationRes.json(); this.operationDetail = operation; this.operationState = operation.state ?? null; }
        if (operationEventsRes.ok) this.operationEvents = (await operationEventsRes.json()).events ?? [];
      }
      if (generation !== this.detailGeneration) return;
      this.detailLoading = false;
      // Mount CodeMirror in next microtask to ensure DOM is rendered
      await this.updateComplete;
      if (generation === this.detailGeneration && this.filter === 'pending') this._mountCodeMirror(`cm-container-${requestId}`, detail.sql_text, (detail as any).db_type || 'mysql');
    } catch {
      if (generation !== this.detailGeneration) return;
      this.detailError = '加载失败，请重试';
      this.detailLoading = false;
    }
  }

  // --- Helper methods for detail view ---
  private _statusLabel(status: string): string {
    const labels: Record<string, string> = {
      'pending': '待审批', 'approved': '已通过', 'rejected': '已驳回',
      'execution_failed': '已通过', 'executing': '已通过', 'executed': '已通过', 'cancelled': '已取消', 'consumed': '已执行', 'expired': '已过期',
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

  private async _cancelOperation() {
    const operationId = this.selectedRequest?.operation_id;
    if (!operationId || !this.selectedRequest) return;
    const response = await authFetch(`/api/operations/${operationId}/cancel`, { method: 'POST' });
    if (!response.ok) {
      this.detailError = '当前状态不允许取消';
      return;
    }
    await this._loadDetail(this.selectedRequest.id);
  }

  private async _retryOperation() {
    const operationId = this.selectedRequest?.operation_id;
    if (!operationId || !this.selectedRequest) return;
    const response = await authFetch(`/api/operations/${operationId}/retry`, { method: 'POST' });
    if (!response.ok) { this.detailError = '当前状态不允许重试'; return; }
    await this._loadDetail(this.selectedRequest.id);
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
    if (this.batchLoading) return;
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
      if (!res.ok || (Array.isArray(data) ? data : data?.results)?.some((item: { success: boolean }) => !item.success)) {
        this.batchError = data?.error || (Array.isArray(data) ? data : data?.results)?.filter((item: { success: boolean }) => !item.success).map((item: { id: number; error?: string }) => `#${item.id}: ${item.error || '未完成'}`).join('；') || '操作失败，请重试';
        this.batchLoading = false;
        return;
      }
      this.batchLoading = false;
      this._closeBatchDialog();
      this.clearSelection();
      this.loadRequests();
    } catch {
      this.batchError = '操作失败，请重试';
      this.batchLoading = false;
    }
  }

  // --- Execution result display ---
  private _renderExecResult(r: ApprovalRequest) {
    const state = approvalExecution(r);
    return html`<div class="exec-result ${state === 'success' ? 'success' : 'fail'}">${executionLabels[state]}</div>`;
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
    if (this.filter === "pending" && this.view === "detail" && this.selectedRequest) {
      return this.renderDetail();
    }
    return this.renderList();
  }

  private renderList() {
    const agentItems = this.agentApprovals;
    const sqlItems = this.requests;
    const pendingAgentToolCounts = new Map<string, number>();
    const firstPendingAgentApproval = new Map<string, string>();
    for (const approval of agentItems) {
      if (approval.status === 'pending') {
        pendingAgentToolCounts.set(approval.tool_name, (pendingAgentToolCounts.get(approval.tool_name) ?? 0) + 1);
        if (!firstPendingAgentApproval.has(approval.tool_name)) {
          firstPendingAgentApproval.set(approval.tool_name, String(approval.id));
        }
      }
    }
    return html`
      <div class="page-head"><div><h1>${this.filter === 'processed' ? '审批历史' : '待审批'}</h1><p class="caption">${this.filter === 'processed' ? '先看目标、风险与结果，完整 SQL、分析和错误按需查看。' : '核对 SQL、目标资源与风险后，再决定是否批准及执行。'}</p></div><button class="btn" ?disabled=${this.loading} @click=${this.loadRequests}>刷新</button></div>
      <div class="tabs" aria-label="审批分类">
        <button class="tab ${this.filter === 'pending' ? 'active' : ''}" aria-pressed=${this.filter === 'pending'} @click=${() => this.switchFilter('pending')}>待审批</button>
        <button class="tab ${this.filter === 'processed' ? 'active' : ''}" aria-pressed=${this.filter === 'processed'} @click=${() => this.switchFilter('processed')}>审批历史</button>
      </div>
      ${this.agentApprovalsError ? html`<div class="error-box" role="alert">${this.agentApprovalsError}</div>` : nothing}
      ${this.filter === 'processed' ? this.renderHistory() : this.loading ? html`<div class="loading" role="status">加载中...</div>` : this.agentApprovalsError ? nothing : html`
        ${agentItems.map((approval) => html`
          <div class="card">
            <div class="card-header"><div><app-badge variant="info">Agent</app-badge> <strong>${approval.tool_name}</strong></div><span class="ai-badge">#${approval.id}</span></div>
            <div class="sql-preview pending-preview">${JSON.stringify({ args: approval.args_redacted, resource: approval.resource_json }, null, 2)}</div>
            <div style="margin-top:8px;font-size:12px;color:var(--muted)">状态：${this._statusLabel(approval.status)}</div>
            ${approval.status === 'pending' ? html`
            <div class="actions">
              <span class="ai-badge">风险：${approval.risk_level || 'high'} / ${approval.scope || 'once'}</span>
              <button class="btn btn-approve" @click=${() => this.reviewAgentApproval(approval.id, 'approve', approval.risk_level === 'high' ? 'once' : approval.scope || 'window')}>通过</button>
              ${approval.risk_level !== 'high' ? html`<button class="btn btn-approve" @click=${() => this.reviewAgentApproval(approval.id, 'approve', 'window')}>允许 5 分钟</button>` : nothing}
              ${(pendingAgentToolCounts.get(approval.tool_name) ?? 0) > 1
                && firstPendingAgentApproval.get(approval.tool_name) === String(approval.id) ? html`
                <button
                  class="btn btn-approve agent-batch-approve"
                  .disabled=${this.reviewingAgentTools.has(approval.tool_name)}
                  @click=${() => this.reviewPendingAgentTool(approval.tool_name)}
                >同工具全部通过 (${pendingAgentToolCounts.get(approval.tool_name)})</button>
              ` : nothing}
              <button class="btn btn-reject" @click=${() => this.reviewAgentApproval(approval.id, 'reject')}>驳回</button>
            </div>
            ` : nothing}
          </div>
        `)}

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

      ${sqlItems.map(r => html`
        <div class="card ${this.selectedIds.has(r.id) ? 'selected' : ''}">
          <div class="card-row" @click=${() => this.openDetail(r)}>
            ${this.filter === 'pending' ? html`
              <div class="card-checkbox" @click=${(e: Event) => e.stopPropagation()}>
                <input type="checkbox" aria-label=${`选择审批 ${r.id}`} .checked=${this.selectedIds.has(r.id)} @change=${() => this._toggleSelect(r.id)}>
              </div>
            ` : ''}
            <div class="card-body">
              <div class="card-header">
                <div>
                  <app-badge variant="info">SQL</app-badge> ${this._riskBadge(r.risk_level)}
                  <span style="margin-left:8px;font-size:12px;color:var(--muted)">#${r.id} · ${new Date(r.created_at).toLocaleString("zh-CN")}</span>
                  <span class="caption">目标：${this.historyTarget({ kind: 'sql', record: r })}</span>
                </div>
                ${r.ai_recommendation ? html`
                  <span class="ai-badge">AI: ${approvalValue(r.ai_recommendation)?.recommendation === 'approve' ? '建议通过' : approvalValue(r.ai_recommendation)?.recommendation === 'reject' ? '建议驳回' : '建议未知'}</span>
                ` : ''}
              </div>
              <button data-request-id=${r.id} class="btn-ghost pending-detail" @click=${(e: Event) => { e.stopPropagation(); this.openDetail(r, e.currentTarget as HTMLElement); }}>查看完整证据</button>
              <div class="sql-preview pending-preview" @click=${(e: Event) => e.stopPropagation()}>${r.sql_text}</div>
              ${approvalValue(r.ai_recommendation)?.reasoning ? html`
                <div style="margin-top:8px;font-size:12px;color:var(--muted);">${approvalValue(r.ai_recommendation).reasoning}</div>
              ` : ''}
              ${r.status === 'approved' ? html`
                ${r.execution_result ? this._renderExecResult(r) : html`<div style="margin-top:8px;font-size:12px;color:var(--ok,#15803d);">✓ 已通过 ${r.review_notes ? '— ' + r.review_notes : ''}</div>`}
              ` : ''}
              ${r.status === 'executed' ? this._renderExecResult(r) : ''}
              ${r.status === 'rejected' ? html`
                <div style="margin-top:8px;font-size:12px;color:var(--danger,#ef4444);">✗ 已驳回 ${r.review_notes ? '— ' + r.review_notes : ''}</div>
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
      ${agentItems.length === 0 && sqlItems.length === 0 ? html`<div class="empty">${this.filter === 'pending' ? '暂无待审批请求' : '暂无已审批记录'}</div>` : nothing}

      ${this._renderBatchDialog()}
      `}
    `;
  }

  private historyItems(): HistoryItem[] {
    const query = this.historyQuery.trim().toLocaleLowerCase();
    return [
      ...this.requests.map(record => ({ kind: 'sql' as const, record })),
      ...this.agentApprovals.map(record => ({ kind: 'agent' as const, record })),
    ].sort((a, b) => String(b.record.created_at).localeCompare(String(a.record.created_at)) || `${a.kind}:${a.record.id}`.localeCompare(`${b.kind}:${b.record.id}`, undefined, { numeric: true }))
      .filter(item => (this.decisionFilter === 'all' || approvalDecision(item.record.status) === this.decisionFilter)
        && (this.executionFilter === 'all' || approvalExecution(item.record, item.kind === 'agent') === this.executionFilter)
        && (!query || `${this.historySummary(item)} ${this.historyTarget(item)}`.toLocaleLowerCase().includes(query)));
  }

  private historySummary(item: HistoryItem): string {
    return item.kind === 'sql' ? shortText(item.record.sql_text) || 'SQL 审批' : shortText(item.record.tool_name);
  }

  private historyTarget(item: HistoryItem): string {
    if (item.kind === 'sql') return `${(item.record as ApprovalRequest & { instance_name?: string }).instance_name || `实例 #${item.record.instance_id}`} / ${item.record.target_database || '默认数据库'}`;
    const resource = approvalValue(item.record.resource_json);
    return shortText(resource?.name || resource?.label || (resource?.type ? `${resource.type}${resource.id != null ? ` #${resource.id}` : ''}` : '未提供目标资源'));
  }

  private executionBadge(item: HistoryItem) {
    const state = approvalExecution(item.record, item.kind === 'agent');
    return html`<app-badge variant=${state === 'failed' || state === 'conflict' ? 'danger' : state === 'unknown' || state === 'running' ? 'warn' : 'muted'}>${executionLabels[state]}</app-badge>`;
  }

  private changeHistoryFilter(field: 'historyQuery' | 'decisionFilter' | 'executionFilter', value: string) {
    this[field] = value;
    this.historyPage = 0;
    this.saveHistoryContext();
  }

  private renderHistory() {
    const items = this.historyItems();
    const pages = Math.max(1, Math.ceil(items.length / 6));
    const rows = items.slice(this.historyPage * 6, this.historyPage * 6 + 6).map(item => ({
      summary: html`<span class="history-summary">${this.historySummary(item)}</span><span class="caption">${item.kind === 'sql' ? 'SQL' : 'Agent'} · ${new Date(item.record.created_at).toLocaleString('zh-CN')}</span>`,
      target: html`<span class="history-target" title=${this.historyTarget(item)}>${this.historyTarget(item)}</span>`,
      risk: this._riskBadge(item.record.risk_level || 'unknown'),
      decision: html`<app-badge variant="muted">${this._statusLabel(approvalDecision(item.record.status))}</app-badge>`,
      execution: this.executionBadge(item),
      detail: html`<button class="btn-ghost history-detail" aria-label=${`查看证据：${this.historySummary(item)}`} @click=${(event: Event) => {
        if (item.kind === 'sql') this.openDetail(item.record, event.currentTarget as HTMLElement);
        else { this.detailTrigger = event.currentTarget as HTMLElement; this.selectedAgent = item.record; }
      }}>查看证据</button>`,
    }));
    return html`
      <div class="history-toolbar">
        <label class="search">查找摘要或目标<input type="search" placeholder="查找 SQL、工具或资源" .value=${this.historyQuery} @input=${(e: Event) => this.changeHistoryFilter('historyQuery', (e.target as HTMLInputElement).value)}></label>
        <label>审批结果<select .value=${this.decisionFilter} @change=${(e: Event) => this.changeHistoryFilter('decisionFilter', (e.target as HTMLSelectElement).value)}>
          <option value="all">全部审批结果</option><option value="approved">已通过</option><option value="rejected">已驳回</option><option value="cancelled">已取消</option><option value="expired">已过期</option>
        </select></label>
        <label>执行结果<select .value=${this.executionFilter} @change=${(e: Event) => this.changeHistoryFilter('executionFilter', (e.target as HTMLSelectElement).value)}>
          <option value="all">全部执行结果</option>${Object.entries(executionLabels).map(([value, label]) => html`<option value=${value}>${label}</option>`)}
        </select></label>
      </div>
      <div class="history-notice"><strong>审批结果与执行结果分开核对</strong>批准不表示已经执行。待审批页面仍直接展示 SQL、目标资源、风险与关键证据。<br>仅筛选本次已读取记录：SQL 与 Agent 各最多 100 条，不代表全部历史。Agent 授权已使用也不代表工具执行成功。</div>
      ${this.agentApprovalsError ? nothing : html`<app-card class="history-card" .compact=${true}>
        <div class="table-scroll" role="region" aria-label="审批历史，可横向滚动" tabindex="0"><app-data-table .columns=${[
          { key: 'summary', label: '建议摘要' }, { key: 'target', label: '目标资源' }, { key: 'risk', label: '风险' },
          { key: 'decision', label: '审批' }, { key: 'execution', label: '执行' }, { key: 'detail', label: '详情' },
        ]} .rows=${rows} .loading=${this.loading} .dense=${true} .striped=${false} emptyMessage="没有符合条件的审批记录"></app-data-table></div>
        <div class="pagination" aria-live="polite"><span>${this.loading ? '正在读取历史…' : `已读取 ${this.requests.length + this.agentApprovals.length} 条 · 筛选后 ${items.length} 条 · 每页 6 条`}</span><div>
          <button class="btn" ?disabled=${this.loading || this.historyPage === 0} @click=${() => { this.historyPage--; this.saveHistoryContext(); }}>上一页</button>
          <span>第 ${this.historyPage + 1} / ${pages} 页</span><button class="btn" ?disabled=${this.loading || this.historyPage + 1 >= pages} @click=${() => { this.historyPage++; this.saveHistoryContext(); }}>下一页</button>
        </div></div>
      </app-card>`}
      ${this.renderEvidenceDialog()}
    `;
  }

  private evidenceSection(title: string, value: unknown) {
    return html`<section class="evidence-section"><h3>${title}</h3><pre>${evidenceText(value)}</pre></section>`;
  }

  private renderEvidenceDialog() {
    const record = this.selectedAgent ?? this.selectedRequest;
    if (!record) return nothing;
    const item: HistoryItem = this.selectedAgent ? { kind: 'agent', record: this.selectedAgent } : { kind: 'sql', record: this.selectedRequest! };
    return html`<app-dialog .open=${true} size="xl" title="审批与执行详情" @app-dialog-close=${this.backToList}>
      ${this.detailLoading ? html`<p role="status">正在读取完整证据…</p>` : this.detailError ? html`<div role="alert" class="error-box">${this.detailError}</div><button class="btn" @click=${() => this._loadDetail(this.selectedRequest!.id)}>重试</button>` : html`
        <p class="caption">${this.historyTarget(item)} · ${new Date(record.created_at).toLocaleString('zh-CN')}</p>
        <div class="evidence-meta">${this._riskBadge(record.risk_level || 'unknown')}<app-badge variant="muted">${this._statusLabel(approvalDecision(record.status))}</app-badge>${this.executionBadge(item)}</div>
        ${item.kind === 'sql' && approvalValue(item.record.execution_result)?.executionState === 'unknown'
          ? html`<p class="history-notice" role="status">后端执行结果未知：SQL 可能已提交。请勿重试；先核对持久化执行意图与目标数据库，完成对账。</p>` : nothing}
        ${this.evidenceWarning ? html`<p class="history-notice" role="status">${this.evidenceWarning}</p>` : nothing}
        ${item.kind === 'sql' ? html`
          ${this.evidenceSection('完整 SQL', item.record.sql_text)}
          ${this.evidenceSection('完整 AI 分析', item.record.ai_recommendation)}
          ${this.evidenceSection('审批备注', item.record.review_notes)}
          ${this.evidenceSection('完整执行结果 / 错误', item.record.execution_result)}
          <details><summary>原始审批与事件证据</summary>${this.evidenceSection('审批原值', item.record)}${this.evidenceSection('审批事件', this.events)}${item.record.operation_id ? this.evidenceSection('Operation 证据', { operation: this.operationDetail, events: this.operationEvents }) : nothing}</details>
        ` : html`
          <p class="history-notice">当前接口仅提供审批授权记录，未提供工具执行回执。以下证据来自本次读取，参数沿用服务端脱敏值。</p>
          ${this.evidenceSection('工具与参数', { tool: item.record.tool_name, args: item.record.args_redacted })}
          ${this.evidenceSection('目标资源与范围', item.record.resource_json)}
          <details><summary>完整审批记录</summary>${this.evidenceSection('审批原值', item.record)}</details>
        `}
      `}
      <button slot="footer" class="btn" @click=${this.backToList}>关闭</button>
    </app-dialog>`;
  }

  private renderDetail() {
    const r = this.selectedRequest;
    if (!r) return this.renderList();
    return html`
      <div class="detail-header">
        <button class="btn-ghost back-link" @click=${this.backToList}>← 返回列表</button>
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
        ${this.evidenceWarning ? html`<div class="history-notice" role="status">${this.evidenceWarning}</div>` : nothing}
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
              ${r.operation_id ? html`<div class="meta-row"><span class="meta-label">Operation</span><span class="meta-value">${this.operationState ?? '加载中'}</span></div>` : ''}
              ${r.operation_id && ['queued', 'waiting_approval', 'claimed'].includes(this.operationState ?? '') ? html`<div class="actions"><button class="btn btn-reject" @click=${this._cancelOperation}>取消 Operation</button></div>` : ''}
              ${r.operation_id && ['failed', 'unknown', 'cancelled'].includes(this.operationState ?? '') ? html`<div class="actions"><button class="btn btn-approve" @click=${this._retryOperation}>创建重试尝试</button></div>` : ''}
              ${r.ai_recommendation ? html`
                <div class="meta-row"><span class="meta-label">AI 分析</span><span class="meta-value"><span class="ai-badge">AI: ${approvalValue(r.ai_recommendation)?.recommendation === 'approve' ? '建议通过' : approvalValue(r.ai_recommendation)?.recommendation === 'reject' ? '建议驳回' : '建议未知'}</span></span></div>
                ${approvalValue(r.ai_recommendation)?.reasoning ? html`<div class="meta-row"><span class="meta-label">AI 理由</span><span class="meta-value" style="font-size:12px;color:var(--muted);">${approvalValue(r.ai_recommendation)?.reasoning}</span></div>` : ''}
              ` : ''}
            </div>
            ${r.operation_id ? html`<div class="timeline-card">
              <div class="timeline-header">Operation 时间线</div>
              <div class="timeline-list">
                ${this.operationEvents.map((ev, i) => html`<div class="timeline-node" style="animation-delay:${i * 50}ms"><div class="timeline-dot timeline-dot--${ev.toState}"></div><div class="timeline-content"><div class="timeline-event-name">${ev.reasonCode}</div><div class="timeline-timestamp">${new Date(ev.createdAt).toLocaleString("zh-CN")}</div></div></div>`)}
              </div>
            </div>` : ''}
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
                      ${ev.event_data ? html`<div class="timeline-detail" @click=${(e: Event) => e.stopPropagation()}>${this._eventDetail(ev)}</div>` : ''}
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
      <app-dialog .open=${true} .closable=${!this.batchLoading} .closeOnOverlay=${!this.batchLoading} size="md" title="${this.batchAction === 'approve' ? '批量通过' : '批量驳回'}" @app-dialog-close=${this._closeBatchDialog}>
        <div style="margin-bottom:12px;font-size:var(--text-md);color:var(--text, #3c3c43);">
          确认对选中的 <strong>${this.batchIds.length}</strong> 项请求执行${this.batchAction === 'approve' ? '通过' : '驳回'}操作？
        </div>
        ${this.batchError ? html`<div class="error-box" role="alert">${this.batchError}</div>` : ''}
        <textarea aria-label="审批备注" style="width:100%;min-height:80px;padding:var(--space-sm) var(--space-md);border:1px solid var(--border, #e5e7eb);border-radius:var(--radius-sm);font-size:var(--text-md);color:var(--text, #3c3c43);resize:vertical;box-sizing:border-box;font-family:inherit;"
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
