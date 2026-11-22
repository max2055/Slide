import '../components/template-event-evidence.js';
import '../components/event-investigation-record.ts';
import type { EventInvestigationRecord } from '../components/event-investigation-record.ts';
import '../components/app-card.ts';
import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, css } from "lit";
import { keyed } from 'lit/directives/keyed.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import { icons, renderIcon } from "../../../icons.js";
import { authFetch } from "../../../api/index.js";
import { showToast } from "../components/app-toast-container.js";
import { workspaceReturnTo } from '../workbench-routing.ts';
import { returnToWorkbench } from '../workbench-position.ts';
import { eventDisplayTitle } from '../controllers/event-investigation-api.ts';

const API_BASE = "/api";

interface AlertEvent {
  id: string;
  title: string;
  source_type?: string;
  status: "open" | "investigating" | "handled" | "resolved" | "closed";
  severity: string;
  instance_id: number | null;
  instance_name?: string;
  alert_count?: number;
  root_cause?: string;
  assignee?: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  verification_passed_at?: string | null;
  verification_reason?: string | null;
  verification_actor_id?: number | null;
}

interface EventStats {
  total: number;
  open: number;
  investigating: number;
  handled: number;
  resolved: number;
  closed: number;
  avg_resolution_time?: number;
}

interface MTTREntry {
  avg_mttr_minutes?: number;
  total_resolved?: number;
}

interface AlertMember {
  id: number;
  title: string;
  level: string;
  metric_name: string;
  metric_value: string;
  created_at: string;
}

interface EventLog {
  id: number;
  action: string;
  actor?: string;
  note?: string;
  created_at: string;
}

@customElement("event-management-page")
export class EventManagementPage extends LitElement {
  @property({type:Number}) eventId = 0;
  @property() returnTo = '';
  @property({type:Boolean}) canViewInvestigations = false;
  static styles = [sharedFieldStyles, sharedBtnStyles, css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      animation: fade-in 0.25s var(--ease-out);
    }

    @keyframes fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .page {
      padding: 0;
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }
    .record { display:grid; gap:var(--space-md); min-width:0; }
    .record-nav, .record-status { display:flex; align-items:center; flex-wrap:wrap; gap:var(--space-sm) var(--space-md); }
    .record h3 { font-size:var(--text-xl); line-height:1.4; margin:0 0 var(--space-sm); overflow-wrap:anywhere; }
    .record-status { margin:var(--space-sm) 0; }
    .record-meta { margin:var(--space-sm) 0; color:var(--muted); overflow-wrap:anywhere; }
    .record-more > summary { cursor:pointer; color:var(--accent-text); }
    .record-overview { background:var(--card); border:1px solid var(--border); border-radius:var(--radius-md); overflow:hidden; }

    .page-top {
      flex-shrink: 0;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--space-lg);
    }

    .header h2 {
      font-size: var(--text-xl);
      font-weight: 600;
      color: var(--text-strong);
      margin: 0;
    }

    .stats-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: var(--space-md);
      margin-bottom: var(--space-lg);
    }

    .stat-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: var(--space-md) var(--space-lg);
      text-align: center;
    }

    .stat-card .stat-value {
      font-size: var(--text-2xl);
      font-weight: 700;
      color: var(--text-strong);
    }

    .stat-card .stat-label {
      font-size: var(--text-xs);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.03em;
      margin-top: var(--space-xs);
    }

    .stat-card.stat-open { border-left: 3px solid var(--danger, #ef4444); }
    .stat-card.stat-investigating { border-left: 3px solid var(--warn, #f59e0b); }
    .stat-card.stat-resolved { border-left: 3px solid var(--success, #22c55e); }
    .stat-card.stat-closed { border-left: 3px solid var(--muted); }

    .filter-bar {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      margin-bottom: var(--space-lg);
      flex-wrap: wrap;
    }

    .filter-bar label {
      font-size: var(--text-base);
      color: var(--muted);
    }

    .filter-bar select, .filter-bar input {
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--card);
      color: var(--text);
      font-size: var(--text-base);
      outline: none;
    }

    .filter-bar select:focus, .filter-bar input:focus {
      border-color: var(--border-strong);
    }

    .search-bar {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      margin-bottom: var(--space-lg);
    }

    .search-bar input {
      flex: 1;
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--card);
      color: var(--text);
      font-size: var(--text-base);
      outline: none;
    }

    .search-bar input:focus {
      border-color: var(--border-strong);
    }

    .tab.active {
      color: var(--accent-text) !important;
      border-bottom-color: var(--accent) !important;
    }

    .tab:hover {
      color: var(--text) !important;
    }

    .empty-state {
      text-align: center;
      padding: 60px var(--space-xl);
      color: var(--muted);
      font-size: var(--text-md);
    }

    .empty-state .empty-icon {
      width: 48px;
      height: 48px;
      margin: 0 auto var(--space-md) auto;
      opacity: 0.5;
      color: var(--muted);
    }
    .empty-state .empty-icon svg {
      width: 100%;
      height: 100%;
    }

    .postmortem-section {
      margin-top: var(--space-md);
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }

    .postmortem-item {
      padding: var(--space-md) var(--space-md);
      background: var(--bg-secondary);
      border-radius: var(--radius-md);
      font-size: var(--text-sm);
      margin-bottom: var(--space-sm);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .postmortem-item .postmortem-time {
      font-size: var(--text-xs);
      color: var(--muted);
      margin-bottom: var(--space-xs);
    }

    .main-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-lg);
      flex: 1;
      min-height: 0;
      padding-bottom: 8px;
    }

    @media (max-width: 900px) {
      .main-layout { grid-template-columns: 1fr; }
    }

    .panel {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: clip;
      display: flex;
      flex-direction: column;
    }

    .panel-header {
      padding: var(--space-md) var(--space-lg);
      background: var(--bg-tertiary);
      font-size: var(--text-base);
      font-weight: 600;
      color: var(--text-strong);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    .event-list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }

    .event-item {
      display: block;
      width: 100%;
      text-align: left;
      color: inherit;
      font: inherit;
      background: transparent;
      border: 0;
      padding: var(--space-md) var(--space-lg);
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      transition: background 0.15s;
    }

    .event-item:last-child { border-bottom: none; }
    .event-item:hover { background: var(--bg-secondary); }
    .event-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .event-item.selected { background: var(--bg-secondary); border-left: 3px solid var(--primary, #3b82f6); }

    .event-item .event-title {
      font-size: var(--text-base);
      font-weight: 500;
      color: var(--text);
      margin-bottom: var(--space-xs);
    }

    .event-item .event-meta {
      display: flex;
      gap: var(--space-sm);
      font-size: var(--text-xs);
      color: var(--muted);
    }

    .detail-panel {
      min-width: 0;
      overflow-wrap: anywhere;
      padding: var(--space-lg);
    }

    .detail-empty {
      text-align: center;
      padding: var(--space-xl);
      color: var(--muted);
      font-size: var(--text-base);
    }

    .detail-section {
      margin-bottom: var(--space-lg);
    }

    .detail-section h4 {
      font-size: var(--text-sm);
      font-weight: 600;
      text-transform: uppercase;
      color: var(--muted);
      margin: 0 0 8px 0;
      letter-spacing: 0.03em;
    }

    .detail-row {
      display: flex;
      justify-content: space-between;
      padding: var(--space-xs) 0;
      font-size: var(--text-base);
    }

    .detail-row .label { color: var(--muted); }
    .detail-row .value { color: var(--text); font-weight: 500; }

    .alert-member-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }

    .alert-member-item {
      padding: var(--space-sm) var(--space-md);
      background: var(--bg-secondary);
      border-radius: var(--radius-md);
      font-size: var(--text-sm);
    }

    .alert-member-item .alert-title { font-weight: 500; }
    .alert-member-item .alert-meta { color: var(--muted); margin-top: var(--space-xs); }

    .timeline {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }

    .timeline-item {
      display: flex;
      gap: var(--space-md);
      font-size: var(--text-sm);
    }

    .timeline-time {
      color: var(--muted);
      min-width: 140px;
      flex-shrink: 0;
    }

    .timeline-action {
      color: var(--text);
    }

    .timeline-note {
      color: var(--muted);
      font-style: italic;
    }

    .action-bar {
      display: flex;
      gap: var(--space-sm);
      flex-wrap: wrap;
      margin-top: var(--space-lg);
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }

    .pagination {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-md);
      padding: var(--space-sm) 0;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }
    .pagination-info {
      font-size: var(--text-sm);
      color: var(--muted);
    }

    .loading {
      text-align: center;
      padding: var(--space-xl);
      color: var(--muted);
    }

    .error {
      text-align: center;
      padding: var(--space-xl);
      color: var(--danger);
    }

    .note-input {
      width: 100%;
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--card);
      color: var(--text);
      font-size: var(--text-base);
      resize: vertical;
      min-height: 60px;
      margin-top: var(--space-sm);
      box-sizing: border-box;
    }

    .note-input:focus {
      border-color: var(--border-strong);
      outline: none;
    }
  `];

  @state() private events: AlertEvent[] = [];
  @state() private stats: EventStats | null = null;
  @state() private mttr: MTTREntry | null = null;
  @state() private selectedEvent: AlertEvent | null = null;
  @state() private detailLoading = false;
  @state() private detailError = '';
  @state() private recordMore = false;
  @state() private eventMembers: AlertMember[] = [];
  @state() private eventLogs: EventLog[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private loadError: string | null = null;
  @state() private retryLoading = false;
  @state() private activeListTab: 'active' | 'resolved' = 'active';
  @state() private filterSeverity = "all";
  @state() private filterSearch = "";
  @state() private noteText = "";
  @state() private recoveryVerificationReason = "";
  @state() private actionLoading = false;
  @state() private showPostmortemForm = false;
  @state() private postmortemText = "";
  @state() private rcaLoading = false;
  @state() private rcaResult: { analysisIds: number[]; sessionKeys: string[]; eventId: number } | null = null;
  @state() private eventsPage = 0;
  @state() private eventsTotal = 0;
  private readonly eventsPageSize = 50;
  private closeDetail = (event?: KeyboardEvent) => {
    if (event && (event.key !== 'Escape' || event.defaultPrevented
      || event.composedPath().some(target => target instanceof HTMLDialogElement))) return;
    if (this.eventId) return;
    const id = this.selectedEvent?.id;
    this._clearDetail();
    if (id !== undefined) void this.updateComplete.then(() =>
      Array.from(this.renderRoot.querySelectorAll<HTMLButtonElement>('button[data-event-id]')).find(row => row.dataset.eventId === String(id))?.focus());
  };
  override disconnectedCallback() {
    this.listRequest++; this.detailRequest++;
    window.removeEventListener('keydown', this.closeDetail);
    super.disconnectedCallback();
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this.closeDetail);
    // Restore persisted RCA result
    try {
      const saved = localStorage.getItem('event_rca_result');
      if (saved) {
        const result = JSON.parse(saved);
        if (this._validRCAResult(result)) this.rcaResult = result;
        else localStorage.removeItem('event_rca_result');
      }
    } catch {
      try { localStorage.removeItem('event_rca_result'); } catch {}
    }
  }

  protected override updated(changes: Map<string, unknown>) {
    if (!changes.has('eventId')) return;
    if (this.eventId) void this._readDetail(this.eventId);
    else {
      if (changes.get('eventId')) this.closeDetail();
      void this._loadEvents();
    }
  }

  private _validRCAResult(value: any): value is NonNullable<typeof this.rcaResult> {
    return value !== null && typeof value === 'object' && value.success !== false
      && Number.isSafeInteger(value.eventId) && value.eventId > 0
      && Array.isArray(value.analysisIds) && value.analysisIds.every((id: unknown) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
      && Array.isArray(value.sessionKeys) && value.sessionKeys.every((key: unknown) => typeof key === 'string' && key.trim().length > 0);
  }

  private _saveRCAResult() {
    if (this.rcaResult) {
      localStorage.setItem('event_rca_result', JSON.stringify(this.rcaResult));
    }
  }

  private _clearRCAResult() {
    this.rcaResult = null;
    localStorage.removeItem('event_rca_result');
  }

  private listRequest = 0;

  private async _loadEvents() {
    const request = ++this.listRequest;
    this.retryLoading = true;
    try {
      const offset = this.eventsPage * this.eventsPageSize;
      const statusFilter = this.activeListTab === 'active'
        ? 'open,investigating,handled'
        : 'resolved,closed';
      const [eventsRes, statsRes, mttrRes] = await Promise.all([
        authFetch(`${API_BASE}/alerts/events?limit=${this.eventsPageSize}&offset=${offset}&status=${statusFilter}`),
        authFetch(`${API_BASE}/alerts/events/stats`),
        authFetch(`${API_BASE}/alerts/events/mttr`),
      ]);
      if (!eventsRes.ok) throw new Error(eventsRes.status === 403 ? '无权访问事件' : `事件加载失败: ${eventsRes.status}`);
      if (!statsRes.ok) throw new Error(`Failed to load stats: ${statsRes.status}`);
      const data = await eventsRes.json();
      if (!Array.isArray(data?.items ?? data)) throw new Error('事件返回格式异常');
      const stats = await statsRes.json();
      const mttr = mttrRes.ok ? await mttrRes.json() : null;
      if (request !== this.listRequest) return;
      this.loadError = null;
      this.events = data.items ?? data;
      this.eventsTotal = data.total ?? 0;
      this.stats = stats;
      this.mttr = mttr;
    } catch (e: any) {
      if (request === this.listRequest) {
        this.loadError = e.message;
        this.events = []; this.stats = null; this.mttr = null;
        this.closeDetail();
      }
    } finally {
      if (request === this.listRequest) {
        this.loading = false;
        this.retryLoading = false;
      }
    }
  }

  private detailRequest = 0;
  private detailKey = '';

  private _resetDrafts() {
    this.noteText = '';
    this.postmortemText = '';
    this.recoveryVerificationReason = '';
    this.showPostmortemForm = false;
    this.error = null;
  }

  private _clearDetail(detailError = '') {
    this.detailRequest++;
    this.detailKey = '';
    this.selectedEvent = null;
    this.eventMembers = [];
    this.eventLogs = [];
    this.detailError = detailError;
    this.detailLoading = false;
    this.recordMore = false;
    this._resetDrafts();
  }

  private async _selectEvent(event: AlertEvent) {
    const read = this._readDetail(event.id, event);
    if (this.isConnected) {
      await this.updateComplete;
      if (this.selectedEvent?.id === event.id) this.focusRecord();
    }
    await read;
  }

  private focusRecord() {
    const overview = this.renderRoot.querySelector<EventInvestigationRecord>('event-investigation-record');
    if (overview) overview.focusHeading();
    else this.renderRoot.querySelector<HTMLElement>('.record h3')?.focus({preventScroll:true});
  }

  private async _readDetail(id: string | number, event?: AlertEvent) {
    const request = ++this.detailRequest;
    if (this.detailKey !== String(id)) { this._resetDrafts(); this.recordMore = false; }
    this.detailKey = String(id);
    this.selectedEvent = event ?? null;
    this.eventMembers = [];
    this.eventLogs = [];
    this.detailLoading = true;
    this.detailError = '';
    const detailRead = authFetch(`${API_BASE}/alerts/events/${id}`);
    const accessDenied = (response: Response) => {
      if (![401, 403, 404].includes(response.status)) return false;
      if (request === this.detailRequest) this._clearDetail('事件不可访问或已不存在。');
      return true;
    };
    const logsRead = authFetch(`${API_BASE}/alerts/events/${id}/logs`)
      .then(async response => !accessDenied(response) && response.ok ? await response.json() : [])
      .catch(() => []);
    try {
      const detailRes = await detailRead;
      if (request !== this.detailRequest) return;
      if (accessDenied(detailRes)) return;
      const detail = detailRes.ok ? await detailRes.json() : null;
      if (request !== this.detailRequest) return;
      if (!detail || String(detail.id) !== String(id)) throw new Error('EVENT_DETAIL_INVALID');
      this.eventMembers = Array.isArray(detail.alerts) ? detail.alerts : [];
      this.selectedEvent = {
        ...event, ...detail,
        alert_count: Array.isArray(detail.alerts) ? this.eventMembers.length : detail.alert_count ?? event?.alert_count,
      };
      if (this.eventId && this.isConnected) void this.updateComplete.then(() => {
        if (request === this.detailRequest) this.focusRecord();
      });
    } catch {
      if (request === this.detailRequest) this.detailError = '读取事件详情失败，请重试。';
      return;
    } finally {
      if (request === this.detailRequest) this.detailLoading = false;
    }
    const logs = await logsRead;
    if (request === this.detailRequest && Array.isArray(logs)) this.eventLogs = logs;
  }

  private async _action(action: () => Promise<void>) {
    if (this.actionLoading) return;
    const request = this.detailRequest;
    this.error = null;
    this.actionLoading = true;
    try {
      await action();
      if (request !== this.detailRequest) return;
      if (!this.eventId) await this._loadEvents();
      if (request === this.detailRequest && this.selectedEvent) {
        await this._selectEvent(this.selectedEvent);
      }
    } catch (e: any) {
      if (request === this.detailRequest) this.error = e.message;
    } finally {
      this.actionLoading = false;
    }
  }

  private async _startInvestigation() {
    const eventId = this.selectedEvent?.id;
    if (!eventId) { this.error = "未选择事件"; return; }
    await this._action(async () => {
      const res = await authFetch(`${API_BASE}/alerts/events/${eventId}/investigate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "开始调查" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
  }

  private async _addNote() {
    const eventId = this.selectedEvent?.id;
    if (!eventId || !this.noteText.trim()) return;
    const request = this.detailRequest;
    const draft = this.noteText;
    const note = draft.trim();
    await this._action(async () => {
      const res = await authFetch(`${API_BASE}/alerts/events/${eventId}/note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      if (result.success === false) throw new Error(result.error || "保存失败");
      if (request === this.detailRequest && String(this.selectedEvent?.id) === String(eventId) && this.noteText === draft) this.noteText = "";
    });
  }

  private _navigateToChat(sessionKey: string) {
    window.dispatchEvent(new CustomEvent("slide-navigate", {
      detail: { tab: "chat", session: sessionKey },
    }));
  }

  private async _triggerRCA() {
    if (this.rcaLoading) return;
    const eventId = this.selectedEvent?.id;
    if (!eventId) { this.error = "未选择事件"; return; }
    const request = this.detailRequest;
    this.rcaLoading = true;
    this.rcaResult = null;
    this.error = null;
    try {
      localStorage.removeItem('event_rca_result');
      const res = await authFetch(`${API_BASE}/alerts/events/${eventId}/rca`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (request !== this.detailRequest) return;
      const result = { ...data, eventId: Number(eventId) };
      if (!this._validRCAResult(result)) throw new Error(data?.error || '根因分析失败，未返回有效分析结果');
      this.rcaResult = result;
      this._saveRCAResult();
    } catch (e: any) {
      if (request === this.detailRequest) this.error = e.message;
    } finally {
      this.rcaLoading = false;
    }
  }

  private async _resolveEvent() {
    const eventId = this.selectedEvent?.id;
    if (!eventId) { this.error = "未选择事件"; return; }
    await this._action(async () => {
      const res = await authFetch(`${API_BASE}/alerts/events/${eventId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution_notes: "已解决" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
  }

  private async _closeEvent() {
    const eventId = this.selectedEvent?.id;
    if (!eventId) { this.error = "未选择事件"; return; }
    await this._action(async () => {
      const res = await authFetch(`${API_BASE}/alerts/events/${eventId}/close`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
    });
  }

  private async _verifyRecovery() {
    const eventId = this.selectedEvent?.id;
    const draft = this.recoveryVerificationReason;
    const reason = draft.trim();
    if (!eventId || !reason) return;
    const request = this.detailRequest;
    await this._action(async () => {
      const res = await authFetch(`${API_BASE}/alerts/events/${eventId}/verify-recovery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      if (request === this.detailRequest && String(this.selectedEvent?.id) === String(eventId)) {
        if (this.recoveryVerificationReason === draft) this.recoveryVerificationReason = '';
        showToast('人工恢复确认已记录，可以关闭事件', 'success');
      }
    });
  }

  private async _addPostmortem() {
    const eventId = this.selectedEvent?.id;
    if (!eventId || !this.postmortemText.trim()) return;
    const request = this.detailRequest;
    const draft = this.postmortemText;
    const postmortem = draft.trim();
    await this._action(async () => {
      const res = await authFetch(`${API_BASE}/alerts/events/${eventId}/postmortem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postmortem }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      if (result.success === false) throw new Error(result.error || "保存失败");
      if (request === this.detailRequest && String(this.selectedEvent?.id) === String(eventId) && this.postmortemText === draft) {
        this.postmortemText = "";
        this.showPostmortemForm = false;
      }
    });
  }

  private _getFilteredEvents(): AlertEvent[] {
    let result = this.events;
    if (this.filterSeverity !== "all") {
      result = result.filter((e) => e.severity === this.filterSeverity);
    }
    if (this.filterSearch.trim()) {
      const q = this.filterSearch.trim().toLowerCase();
      result = result.filter((e) =>
        `#${e.id}`.includes(q) ||
        e.title.toLowerCase().includes(q) ||
        (e.root_cause && e.root_cause.toLowerCase().includes(q)) ||
        (e.instance_name && e.instance_name.toLowerCase().includes(q))
      );
    }
    return result;
  }

  private _statusBadge(status: string) {
    const variantMap: Record<string, string> = {
      open: "warn",
      investigating: "info",
      handled: "muted",
      resolved: "ok",
      closed: "muted",
    };
    const labelMap: Record<string, string> = {
      open: "开放",
      investigating: "调查中",
      handled: "已处理",
      resolved: "已解决",
      closed: "已关闭",
    };
    return html`<app-badge variant=${variantMap[status] || "muted"}>${labelMap[status] || status}</app-badge>`;
  }

  private _severityColor(severity: string): string {
    const colors: Record<string, string> = {
      info: "var(--info, #3b82f6)",
      warning: "var(--warn, #f59e0b)",
      error: "var(--danger, #ef4444)",
      critical: "var(--danger)",
    };
    return colors[severity] || "var(--muted)";
  }

  private _renderPagination() {
    const totalPages = Math.max(1, Math.ceil(this.eventsTotal / this.eventsPageSize));
    if (totalPages <= 1) return html``;
    return html`
      <div class="pagination">
        <button class="btn" ?disabled=${this.eventsPage === 0} @click=${() => { this.eventsPage--; this._loadEvents(); }}>← 上一页</button>
        <span class="pagination-info">第 ${this.eventsPage + 1}/${totalPages} 页，共 ${this.eventsTotal} 条</span>
        <button class="btn" ?disabled=${this.eventsPage >= totalPages - 1} @click=${() => { this.eventsPage++; this._loadEvents(); }}>下一页 →</button>
      </div>`;
  }

  private _formatTime(dateStr: string): string {
    try {
      return new Date(dateStr).toLocaleString("zh-CN");
    } catch {
      return dateStr;
    }
  }

  override render() {
    if (this.eventId || this.selectedEvent || this.detailError) return this._renderRecord();
    if (this.loading) {
      return html`<div class="page"><button class="btn" disabled aria-label="刷新事件">正在加载事件</button><div role="status" class="loading" style="flex-direction:column;gap:16px;">
          <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:var(--space-md);width:100%;">
            <div class="skeleton-stat" style="width:100%;height:70px;"></div>
            <div class="skeleton-stat" style="width:100%;height:70px;"></div>
            <div class="skeleton-stat" style="width:100%;height:70px;"></div>
            <div class="skeleton-stat" style="width:100%;height:70px;"></div>
            <div class="skeleton-stat" style="width:100%;height:70px;"></div>
            <div class="skeleton-stat" style="width:100%;height:70px;"></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-md);width:100%;">
            <div class="skeleton-block" style="height:300px;"></div>
            <div class="skeleton-block" style="height:300px;"></div>
          </div>
        </div></div>`;
    }

    const filtered = this._getFilteredEvents();

    return html`
      <div class="page">
        ${this.detailError ? html`<p class="error" role="alert">${this.detailError}</p>` : nothing}
        ${this.loadError ? html`<div class="error" role="alert">加载失败: ${this.loadError}
          <button class="btn btn-refresh" ?disabled=${this.retryLoading} @click=${this._loadEvents}>${this.retryLoading ? '重试中...' : '重试加载'}</button>
        </div>` : nothing}
        ${this.error ? html`<div class="error" role="alert">操作失败: ${this.error}</div>` : nothing}
        <div class="page-top">
        <div class="header"><button class="btn btn-refresh" aria-label="刷新事件" ?disabled=${this.retryLoading} @click=${this._loadEvents}>${this.retryLoading ? '刷新中...' : '刷新事件'}</button></div>

        ${this.stats ? this._renderStats() : nothing}

        <div class="search-bar">
          <input
            type="text"
            aria-label="搜索本页事件"
            placeholder="搜索本页事件标题、实例或根因..."
            .value=${this.filterSearch}
            @input=${(e: Event) => { this.filterSearch = (e.target as HTMLInputElement).value; }}
          />
        </div>

        <p>搜索和严重度仅筛选本页；分页总数为当前状态的全部事件数。</p>

        <!-- 活跃/已解决 Tab -->
        <div style="display:flex;gap:var(--space-md);margin-bottom:var(--space-lg);">
          <button class="tab ${this.activeListTab === 'active' ? 'active' : ''}"
            @click=${() => { this.activeListTab = 'active'; this.eventsPage = 0; this._loadEvents(); }}
            style="padding:var(--space-sm) var(--space-lg);font-size:var(--text-base);font-weight:500;background:transparent;border:none;border-bottom:2px solid transparent;cursor:pointer;color:var(--muted);position:relative;">
            活跃事件
            ${this.stats ? html`<span style="position:absolute;top:2px;right:-4px;min-width:16px;height:16px;padding:0 var(--space-xs);background:var(--accent-solid);color:var(--accent-solid-foreground);border-radius:var(--radius-full);font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center;">${this.stats.open + this.stats.investigating + this.stats.handled}</span>` : nothing}
          </button>
          <button class="tab ${this.activeListTab === 'resolved' ? 'active' : ''}"
            @click=${() => { this.activeListTab = 'resolved'; this.eventsPage = 0; this._loadEvents(); }}
            style="padding:var(--space-sm) var(--space-lg);font-size:var(--text-base);font-weight:500;background:transparent;border:none;border-bottom:2px solid transparent;cursor:pointer;color:var(--muted);position:relative;">
            已解决
            ${this.stats ? html`<span style="position:absolute;top:2px;right:-4px;min-width:16px;height:16px;padding:0 var(--space-xs);background:var(--ok-subtle, #dcfce7);color:var(--ok, #22c55e);border-radius:var(--radius-full);font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center;">${this.stats.resolved + this.stats.closed}</span>` : nothing}
          </button>
        </div>

        <div class="filter-bar">
          <label>本页严重度:</label>
          <select aria-label="本页严重度" @change=${(e: Event) => { this.filterSeverity = (e.target as HTMLSelectElement).value; }}>
            <option value="all">全部</option>
            <option value="critical" ?selected=${this.filterSeverity === 'critical'}>严重</option>
            <option value="error" ?selected=${this.filterSeverity === 'error'}>错误</option>
            <option value="warning" ?selected=${this.filterSeverity === 'warning'}>警告</option>
            <option value="info" ?selected=${this.filterSeverity === 'info'}>提示</option>
          </select>
        </div>
        </div>

        ${this.events.length === 0
          ? this.loadError || this.retryLoading ? nothing : html`
              <div class="empty-state">
                <div class="empty-icon">${this.activeListTab === 'resolved' ? renderIcon('check-circle') : renderIcon('triangle-alert')}</div>
                <div>${this.activeListTab === 'resolved' ? '没有已解决事件' : '暂无活跃事件'}</div>
                <div style="font-size:var(--text-sm);margin-top:var(--space-sm);">${this.activeListTab === 'resolved' ? '已解决的事件会出现在这里' : '系统运行正常'}</div>
              </div>
            `
          : html`
              <div class="main-layout">
                <div class="panel">
                  <div class="panel-header">事件列表</div>
                  <div class="event-list">
                    ${filtered.length === 0
                      ? html`<div class="detail-empty">暂无匹配的事件</div>`
                      : filtered.map((event) => html`
                          <button type="button" data-event-id=${event.id} aria-label=${`查看事件 #${event.id} 详情`}
                            class="event-item ${this.selectedEvent?.id === event.id ? "selected" : ""}"
                            @click=${() => this._selectEvent(event)}
                          >
                            <div class="event-title">${event.title}</div>
                            <div class="event-meta">
                              ${this._statusBadge(event.status)}
                              <span style="color: ${this._severityColor(event.severity)}">${event.severity.toUpperCase()}</span>
                              <span>${event.alert_count} 条告警</span>
                              <span>${event.instance_name || "N/A"}</span>
                              <span>${this._formatTime(event.created_at)}</span>
                            </div>
                          </button>
                        `)}
                  </div>
                  ${this._renderPagination()}
                </div>

              </div>
            `}
      </div>
    </div>
    `;
  }

  private _renderRecord() {
    const event = this.selectedEvent;
    const origin = workspaceReturnTo(this.returnTo);
    const workspace = origin && new URL(origin,location.origin).pathname === '/workbench' ? origin : null;
    const returnLabel = workspace && new URL(workspace,location.origin).searchParams.has('investigation') ? '返回调查' : '返回工作台';
    const severity: Record<string, string> = { critical: '严重', error: '错误', warning: '警告', info: '提示' };
    const template = event?.source_type === 'template-trigger';
    return html`<section class="record" aria-label="事件详情">
      <nav class="record-nav" aria-label="返回">
        ${this.eventId ? html`<a class="btn" href="/events?view=aggregate">返回事件列表</a>`
          : html`<button class="btn" @click=${() => this.closeDetail()}>返回事件列表</button>`}
        ${workspace ? html`<a class="btn" href=${workspace} @click=${(e: MouseEvent) => returnToWorkbench(e, workspace)}>${returnLabel}</a>` : nothing}
      </nav>
      ${this.detailLoading && !event ? html`<p role="status">正在读取事件 #${this.eventId}…</p>` : nothing}
      ${this.detailError ? html`<p role="alert" class="error">${this.detailError}
        ${this.detailError.startsWith('读取') ? html`<button class="btn" @click=${() => void this._readDetail(event?.id ?? this.eventId, event ?? undefined)}>重试</button>` : nothing}</p>` : nothing}
      ${event ? html`${this.canViewInvestigations ? keyed(event.id,html`<div class="record-overview">
        <event-investigation-record .event=${event} .lookup=${true} .full=${true} .allowStart=${true}
          @template-event-closed=${() => void this._action(async () => {})}
          @event-investigation-denied=${() => this._clearDetail('事件不可访问或已不存在。')}></event-investigation-record>
      </div>`) : html`<app-card><span slot="header">事件详情</span>
        <h3 tabindex="-1">事件 #${event.id}：${eventDisplayTitle(event)}</h3>
        <div class="record-status">
          <span>事件处理 ${this._statusBadge(event.status)}</span>
          <span>严重度 <app-badge variant="muted">${severity[event.severity] ?? '未知'}</app-badge></span>
          ${event.source_type !== 'template-trigger' ? html`<span>恢复确认 <app-badge variant="muted">${event.verification_passed_at ? '已人工确认' : '待核对'}</app-badge></span>` : nothing}
        </div>
        <p class="record-meta">发生于 ${this._formatTime(event.created_at)}
          ${event.alert_count != null ? html` · ${event.alert_count} 条关联告警` : nothing}
          ${event.instance_name ? html` · ${event.instance_name}` : nothing}</p>
        <template-event-evidence .eventId=${Number(event.id)} .compact=${template} .allowClose=${template}
          @template-event-closed=${() => void this._action(async () => {})}></template-event-evidence>
        ${event.source_type !== 'template-trigger' ? html`<button class="btn" @click=${() => this.renderRoot.querySelector<HTMLElement>('.detail-panel')?.scrollIntoView({block:'start'})}>查看事件记录与操作</button>` : nothing}
      </app-card>`}${template ? html`<details class="record-more" ?open=${this.recordMore}
        @toggle=${(e:Event) => {this.recordMore = (e.target as HTMLDetailsElement).open;}}>
        <summary>更多事件记录与操作</summary>
        ${this.canViewInvestigations && this.recordMore ? keyed(event.status, html`<template-event-evidence
          .eventId=${Number(event.id)} .compact=${true}></template-event-evidence>`) : nothing}
        ${this._renderDetail()}</details>` : this._renderDetail()}` : nothing}
    </section>`;
  }

  private _renderStats() {
    const s = this.stats!;
    const avgMttr = this.mttr?.avg_mttr_minutes ?? s.avg_resolution_time ?? null;
    return html`
      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-value">${s.total}</div>
          <div class="stat-label">总计</div>
        </div>
        <div class="stat-card stat-open">
          <div class="stat-value">${s.open}</div>
          <div class="stat-label">开放</div>
        </div>
        <div class="stat-card stat-investigating">
          <div class="stat-value">${s.investigating}</div>
          <div class="stat-label">调查中</div>
        </div>
        <div class="stat-card stat-resolved">
          <div class="stat-value">${s.resolved}</div>
          <div class="stat-label">已解决</div>
        </div>
        <div class="stat-card stat-closed">
          <div class="stat-value">${s.closed}</div>
          <div class="stat-label">已关闭</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${avgMttr !== null ? `${Math.round(avgMttr)}` : "—"}</div>
          <div class="stat-label">平均 MTTR (分钟)</div>
        </div>
      </div>
    `;
  }

  private _renderDetail() {
    const e = this.selectedEvent!;
    return html`
      <div class="detail-panel">
        <div class="detail-section">
          <h4>基本信息</h4>
          <div class="detail-row"><span class="label">标题</span><span class="value">${e.title}</span></div>
          <div class="detail-row"><span class="label">状态</span><span class="value">${this._statusBadge(e.status)}</span></div>
          <div class="detail-row"><span class="label">严重度</span><span class="value" style="color: ${this._severityColor(e.severity)}">${e.severity.toUpperCase()}</span></div>
          <div class="detail-row"><span class="label">告警数</span><span class="value">${e.alert_count ?? '未知'}</span></div>
          <div class="detail-row"><span class="label">实例</span><span class="value">${e.instance_name || "N/A"}</span></div>
          <div class="detail-row"><span class="label">负责人</span><span class="value">${e.assignee || "未分配"}</span></div>
          <div class="detail-row"><span class="label">创建时间</span><span class="value">${this._formatTime(e.created_at)}</span></div>
          ${e.verification_passed_at ? html`
            <div class="detail-row"><span class="label">人工恢复确认</span><span class="value">${this._formatTime(e.verification_passed_at)}</span></div>
            <div class="detail-row"><span class="label">确认人 ID</span><span class="value">${e.verification_actor_id ?? "历史记录未提供"}</span></div>
            <div class="detail-row"><span class="label">确认依据</span><span class="value">${e.verification_reason || "历史记录未提供"}</span></div>
          ` : nothing}
          ${e.status === "resolved" || e.verification_passed_at ? html`<div class="detail-row"><span class="label">确认含义</span><span class="value">人工确认不代表客观指标观察窗验证通过。</span></div>` : nothing}
          ${e.root_cause ? html`<div class="detail-row"><span class="label">根因</span><span class="value">${e.root_cause}</span></div>` : nothing}
        </div>

        ${this.eventMembers.length > 0 ? html`
          <div class="detail-section">
            <h4>关联告警 (${this.eventMembers.length})</h4>
            <div class="alert-member-list">
              ${this.eventMembers.map((m) => html`
                <div class="alert-member-item">
                  <div class="alert-title">${m.title}</div>
                  <div class="alert-meta">
                    ${m.level.toUpperCase()} · ${m.metric_name} = ${m.metric_value} · ${this._formatTime(m.created_at)}
                  </div>
                </div>
              `)}
            </div>
          </div>
        ` : nothing}

        ${this.eventLogs.length > 0 ? html`
          <div class="detail-section">
            <h4>操作记录</h4>
            <div class="timeline">
              ${this.eventLogs.map((log) => html`
                <div class="timeline-item">
                  <span class="timeline-time">${this._formatTime(log.created_at)}</span>
                  <span class="timeline-action">${log.action}</span>
                  ${log.note ? html`<span class="timeline-note">${log.note}</span>` : nothing}
                </div>
              `)}
            </div>
          </div>
        ` : nothing}

        ${e.status !== "closed" ? html`
          <div class="action-bar">
            ${e.status === "open" ? html`<button class="btn btn-primary" @click=${this._startInvestigation} ?disabled=${this.actionLoading}>开始调查</button>` : nothing}
            <button class="btn" @click=${this._triggerRCA} ?disabled=${this.rcaLoading} style="border-color:var(--accent);color:var(--accent-text);">${this.rcaLoading ? "分析中..." : "AI 根因分析"}</button>
            ${this.rcaResult && this.rcaResult.eventId === Number(this.selectedEvent?.id) ? html`
              <span style="font-size:12px;color:var(--ok);margin-left:8px;">已触发 ${this.rcaResult.analysisIds.length} 个分析</span>
              ${this.rcaResult.sessionKeys.map((sk: string) => html`
                <a href="#" @click=${(e: Event) => { e.preventDefault(); this._navigateToChat(sk); }} style="font-size:11px;color:var(--accent-text);margin-left:4px;">查看 →</a>
              `)}
              <button class="btn" style="font-size:var(--text-xs);margin-left:var(--space-sm);padding:var(--space-xs) var(--space-sm);" @click=${this._clearRCAResult}>清除</button>
            ` : nothing}
            <button class="btn" @click=${() => { this.showPostmortemForm = !this.showPostmortemForm; }} ?disabled=${this.actionLoading}>添加复盘</button>
            ${e.source_type!=='template-trigger' && ["open", "investigating", "handled"].includes(e.status) ? html`<button class="btn btn-primary" @click=${this._resolveEvent} ?disabled=${this.actionLoading}>标记解决</button>` : nothing}
            ${e.status === "resolved" && !e.verification_passed_at ? html`
              <textarea
                class="note-input"
                aria-label="人工恢复确认依据"
                maxlength="1024"
                placeholder="填写人工检查的依据、结果与原因后确认恢复"
                .value=${this.recoveryVerificationReason}
                @input=${(event: Event) => { this.recoveryVerificationReason = (event.target as HTMLTextAreaElement).value; }}
              ></textarea>
              <button class="btn-primary" @click=${this._verifyRecovery} .disabled=${this.actionLoading || !this.recoveryVerificationReason.trim()}>人工确认恢复</button>
            ` : nothing}
            ${e.status === "resolved" && e.verification_passed_at ? html`<button class="btn-primary btn-danger" @click=${this._closeEvent} ?disabled=${this.actionLoading}>关闭事件</button>` : nothing}
          </div>
          <div class="action-bar" style="border-top: none; padding-top: 0; margin-top: var(--space-sm);">
            <textarea
              class="note-input"
              aria-label="事件备注"
              placeholder="添加备注..."
              .value=${this.noteText}
              @input=${(e: Event) => { this.noteText = (e.target as HTMLTextAreaElement).value; }}
            ></textarea>
            <button class="btn" @click=${this._addNote} ?disabled=${this.actionLoading || !this.noteText.trim()}>添加备注</button>
          </div>

          ${this.showPostmortemForm ? html`
            <div class="postmortem-section">
              <textarea
                class="note-input"
                aria-label="事件复盘"
                placeholder="输入复盘内容（支持 Markdown）..."
                style="min-height: 120px;"
                .value=${this.postmortemText}
                @input=${(e: Event) => { this.postmortemText = (e.target as HTMLTextAreaElement).value; }}
              ></textarea>
              <div style="margin-top: var(--space-sm); display: flex; gap: var(--space-sm);">
                <button class="btn btn-primary" @click=${this._addPostmortem} ?disabled=${this.actionLoading || !this.postmortemText.trim()}>提交复盘</button>
                <button class="btn" @click=${() => { this.showPostmortemForm = false; this.postmortemText = ""; }}>取消</button>
              </div>
            </div>
          ` : nothing}
        ` : nothing}
      </div>
    `;
  }
}

if (!customElements.get("event-management-page")) {
  customElements.define("event-management-page", EventManagementPage);
}
