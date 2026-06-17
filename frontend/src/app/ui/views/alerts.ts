import { LitElement, html, css } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, state } from "lit/decorators.js";
import { icons } from "../../../icons.js";
import { authFetch } from "../../../api/index.js";
import "./../components/alert-list.js";
import "./../components/alert-detail-modal.js";
import "./../components/alert-rule-editor.js";
import "./../components/alert-analysis-viewer.js";

interface Alert {
  id: number;
  instance_id: number;
  instance_name?: string;
  alert_type: string;
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  status: 'unread' | 'read' | 'acknowledged' | 'resolved' | 'closed';
  acknowledged: boolean;
  acknowledged_by?: string;
  acknowledged_at?: string;
  resolved_at?: string;
  resolved_by?: string;
  created_at: string;
}

interface AlertRule {
  id: number;
  name: string;
  description?: string;
  metric_name: string;
  operator: string;
  threshold: number;
  duration_seconds: number;
  severity: string;
  threshold_type: 'static' | 'dynamic';
  threshold_template?: { warning?: number | null; error?: number | null; critical?: number | null } | null;
  dynamic_config?: any;
  silence_minutes: number;
  db_types?: string[] | null;
  instance_ids?: number[] | null;
  enabled: boolean;
  notification_channels?: any;
  created_by?: number;
  created_at: string;
  updated_at: string;
  instance_id?: number;
  from_level?: string;
  to_level?: string;
  trigger_condition?: string;
  trigger_value?: string;
  start_time?: string;
  end_time?: string;
  _days?: string | number[];
  duration_minutes?: number;
}

@customElement("alerts-page")
export class AlertsPage extends LitElement {
  static styles = [sharedBtnStyles, css`
    :host {
      display: block;
      animation: fade-in 0.25s var(--ease-out);
    }

    @keyframes fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .page {
      padding: 0 0 var(--space-xl) 0;
    }

    /* Tabs */
    .tabs {
      display: flex;
      gap: var(--space-xs);
      margin-bottom: var(--space-xl);
      border-bottom: 1px solid var(--border);
    }

    .tab {
      padding: var(--space-md) var(--space-xl);
      font-size: var(--text-md);
      font-weight: 500;
      color: var(--muted);
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: all 0.15s ease;
      position: relative;
    }

    .tab:hover {
      color: var(--text);
    }

    .tab.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }

    .tab-badge {
      position: absolute;
      top: 8px;
      right: 4px;
      min-width: 16px;
      height: 16px;
      padding: 0 var(--space-xs);
      background: var(--accent);
      color: var(--accent-foreground);
      border-radius: var(--radius-full);
      font-size: 10px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* 主卡片 */
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--space-md) var(--space-lg);
      border-bottom: 1px solid var(--border);
      background: var(--bg-elevated);
      flex-wrap: wrap;
      gap: var(--space-md);
    }

    .card-title {
      font-size: var(--text-lg);
      font-weight: 600;
      letter-spacing: -0.02em;
      color: var(--text-strong);
    }


    /* 表格样式 */
    .table-wrap {
      overflow: auto;
      max-height: calc(100vh - 420px);
      min-height: 200px;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
    }

    .table {
      width: 100%;
      table-layout: fixed;
      border-collapse: separate;
      border-spacing: 0;
      font-size: var(--text-base);
    }

    .table th {
      position: sticky;
      top: 0;
      z-index: 3;
      padding: var(--space-md) var(--space-md);
      text-align: left;
      font-weight: 600;
      font-size: var(--text-xs);
      color: var(--muted);
      background: var(--bg-elevated);
      border-bottom: 2px solid var(--border);
      white-space: nowrap;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .table td {
      padding: var(--space-md) var(--space-md);
      border-bottom: 1px solid var(--border);
      color: var(--text);
      vertical-align: middle;
    }

    .table tbody tr {
      transition: background var(--duration-fast) ease;
    }

    .table tbody tr:hover {
      background: var(--bg-hover);
    }

    .table tbody tr:last-child td {
      border-bottom: none;
    }

    .table tbody tr.critical {
      background: var(--danger-subtle);
    }

    .table tbody tr.critical:hover {
      background: rgba(239, 68, 68, 0.12);
    }

    /* 严重程度徽章 */
    .severity-badge {
      display: inline-flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-xs) var(--space-md);
      border-radius: var(--radius-full);
      font-size: var(--text-xs);
      font-weight: 600;
    }

    .severity-badge svg {
      width: 13px;
      height: 13px;
    }

    .severity-badge.red {
      background: var(--danger-subtle);
      color: var(--danger);
    }

    .severity-badge.orange {
      background: var(--warn-subtle);
      color: var(--warn);
    }

    .severity-badge.blue {
      background: rgba(59, 130, 246, 0.12);
      color: var(--info);
    }


    .instance-badge {
      display: inline-flex;
      align-items: center;
      padding: var(--space-xs) var(--space-md);
      background: var(--secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      color: var(--text);
    }

    .type-badge {
      display: inline-flex;
      align-items: center;
      padding: var(--space-xs) var(--space-sm);
      background: rgba(59, 130, 246, 0.12);
      color: var(--info);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }


    /* 操作按钮 */
    .actions {
      display: flex;
      gap: var(--space-sm);
    }

    .action-btn {
      display: inline-flex;
      align-items: center;
      padding: 3px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      background: var(--card);
      color: var(--text);
      white-space: nowrap;
    }

    .action-btn:hover {
      background: var(--accent);
      color: var(--accent-foreground, #fff);
      border-color: var(--accent);
    }

    .action-btn.primary {
      background: var(--accent);
      color: var(--accent-foreground, #fff);
      border-color: var(--accent);
    }

    .action-btn.primary:hover {
      background: var(--accent-hover);
    }

    /* 加载和空状态 */
    .loading, .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 300px;
      color: var(--muted);
    }

    .empty__content {
      text-align: center;
    }

    .empty__icon {
      width: 48px;
      height: 48px;
      margin-bottom: var(--space-md);
      opacity: 0.6;
      color: var(--muted);
    }
    .empty__icon svg {
      width: 16px;
      height: 16px;
    }

    .empty__title {
      font-size: var(--text-lg);
      color: var(--text-strong);
      margin-bottom: var(--space-xs);
    }

    .empty__desc {
      font-size: var(--text-base);
      color: var(--muted);
    }

    /* 表单样式 */
    .form-group {
      margin-bottom: var(--space-lg);
    }

    .form-label {
      display: block;
      font-size: var(--text-base);
      font-weight: 500;
      color: var(--text-strong);
      margin-bottom: var(--space-xs);
    }

    .form-input, .form-select {
      width: 100%;
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: var(--text-base);
      color: var(--text);
      background: var(--card);
      box-sizing: border-box;
    }

    .form-input:focus, .form-select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-subtle, rgba(99, 102, 241, 0.1));
    }

    .form-actions {
      display: flex;
      gap: var(--space-sm);
      justify-content: flex-end;
      margin-top: var(--space-lg);
    }

    /* Modal overlay */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      animation: fade-in 0.2s ease;
    }

    .modal {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: var(--space-xl);
      width: 90%;
      max-width: 520px;
      max-height: 80vh;
      overflow-y: auto;
    }

    .modal-title {
      font-size: var(--text-lg);
      font-weight: 600;
      color: var(--text-strong);
      margin-bottom: var(--space-lg);
    }

    /* Toggle switch */
    .toggle-group {
      display: flex;
      gap: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }

    .toggle-btn {
      flex: 1;
      padding: var(--space-sm) var(--space-lg);
      border: none;
      background: var(--secondary);
      color: var(--text);
      font-size: var(--text-base);
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .toggle-btn.active {
      background: var(--accent);
      color: var(--accent-foreground);
    }

    .toggle-btn svg {
      width: 14px;
      height: 14px;
      vertical-align: middle;
    }

    /* Status badge */
    .status-badge-sm {
      display: inline-flex;
      align-items: center;
      padding: var(--space-xs) var(--space-md);
      border-radius: var(--radius-full);
      font-size: var(--text-xs);
      font-weight: 600;
    }

    .status-badge-sm.enabled {
      background: var(--ok-subtle);
      color: var(--ok);
    }

    .status-badge-sm.disabled {
      background: var(--muted-subtle, rgba(107, 114, 128, 0.1));
      color: var(--muted);
    }


    /* Checkbox group */
    .checkbox-group {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-sm);
    }

    .checkbox-label {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      padding: var(--space-xs) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .checkbox-label.active {
      background: var(--accent-subtle, rgba(99, 102, 241, 0.1));
      border-color: var(--accent);
      color: var(--accent);
    }


    .cfg-toggle {
      position: relative;
      width: 44px;
      height: 24px;
      flex-shrink: 0;
    }

    .cfg-toggle input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .cfg-toggle .slider {
      position: absolute;
      cursor: pointer;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--border);
      border-radius: 24px;
      transition: 0.2s;
    }

    .cfg-toggle .slider::before {
      content: '';
      position: absolute;
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background: white;
      border-radius: 50%;
      transition: 0.2s;
    }

    .cfg-toggle input:checked + .slider {
      background: var(--accent);
    }

    .cfg-toggle input:checked + .slider::before {
      transform: translateX(20px);
    }

    .help-text {
      font-size: var(--text-sm);
      color: var(--muted);
      margin-top: var(--space-xs);
    }
  `];

  @state() private alerts: Alert[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private filter: "all" | "unread" | "critical" | "warning" = "all";
  @state() private activeListTab: 'active' | 'recovered' = 'active';
  @state() private searchText = '';
  @state() private filterSeverity = '';
  @state() private analyzedStatuses: Map<number, { status: string; trigger_type: string; result?: any; sessionKey?: string }> = new Map();
  @state() private activeAnalysisRecord: { alert: Alert; record: any } | null = null;
  @state() private activeRCAAnalysis: { alertId: number; analysisId?: number; sessionKey?: string } | null = null;
  @state() private page = 0;
  @state() private total = 0;
  private readonly pageSize = 50;
  @state() private diagnosisStatus: "idle" | "running" | "completed" | "failed" = "idle";
  @state() private diagnosisResult: any = null;
  @state() private diagnosisError: string | null = null;
  private diagnosisPollTimer: ReturnType<typeof setInterval> | null = null;
  private pollRetries = 0;
  private readonly maxPollRetries = 20;  // 60 seconds max at 3s interval

  // Tab state
  @state() private activeAlertTab: 'alerts' | 'rules' | 'escalation' | 'maintenance' | 'silence' | 'baselines' = 'alerts';

  // Rules tab state
  @state() private rules: AlertRule[] = [];
  @state() private rulesLoading = false;
  @state() private showRuleModal = false;
  @state() private editingRule: AlertRule | null = null;
  @state() private ruleForm: Partial<AlertRule> = {};
  @state() private ruleFormError = '';
  @state() private _ruleToggleErrors: Map<number, string> = new Map();
  @state() private metricRegistry: any[] = [];

  // Escalation tab state
  @state() private escalationRules: any[] = [];
  @state() private escalationLoading = false;
  @state() private showEscalationModal = false;
  @state() private editingEscalation: any = null;

  // Maintenance tab state
  @state() private maintenanceWindows: any[] = [];
  @state() private maintenanceLoading = false;
  @state() private showMaintenanceModal = false;
  @state() private editingMaintenance: any = null;

  // Silence tab state
  @state() private silencePeriods: any[] = [];
  @state() private silenceLoading = false;
  @state() private showSilenceModal = false;
  @state() private instances: any[] = [];

  // Baselines tab state
  @state() private baselines: any[] = [];
  @state() private baselinesLoading = false;
  @state() private baselineComputing = false;
  @state() private baselineFilterInstance = '';
  @state() private baselineFilterMetric = '';

  override firstUpdated() {
    this.loadAlerts();
  }

  // ==================== Tab Navigation ====================

  private _renderTabs() {
    const tabs: Array<{ key: string; label: string; badge?: number }> = [
      { key: 'alerts' as const, label: '告警列表' },
      { key: 'rules' as const, label: '告警规则' },
      { key: 'escalation' as const, label: '升级规则' },
      { key: 'maintenance' as const, label: '维护窗口' },
      { key: 'silence' as const, label: '静默期' },
      { key: 'baselines' as const, label: '基线' },
    ];

    return html`
      <div class="tabs">
        ${tabs.map(tab => html`
          <button
            class="tab ${this.activeAlertTab === tab.key ? 'active' : ''}"
            @click=${() => { this.activeAlertTab = tab.key as typeof this.activeAlertTab; this._onTabSwitch(tab.key); }}
          >
            ${tab.label}
            ${tab.badge > 0 ? html`<span class="tab-badge">${tab.badge}</span>` : ''}
          </button>
        `)}
      </div>
    `;
  }

  private _onTabSwitch(tab: string) {
    switch (tab) {
      case 'rules':
        if (this.rules.length === 0) this.loadRules();
        break;
      case 'escalation':
        if (this.escalationRules.length === 0) this.loadEscalationRules();
        break;
      case 'maintenance':
        if (this.maintenanceWindows.length === 0) this.loadMaintenanceWindows();
        break;
      case 'silence':
        if (this.silencePeriods.length === 0) this.loadSilencePeriods();
        break;
      case 'baselines':
        if (this.baselines.length === 0) this.loadBaselines();
        break;
    }
  }

  // ==================== Main Render ====================

  override render() {
    return html`
      <div class="page">
        ${this._renderTabs()}
        ${this._renderCurrentTab()}
      </div>
    `;
  }

  private _renderCurrentTab() {
    const tabContent = (() => {
    switch (this.activeAlertTab) {
      case 'alerts':
        return this._renderAlertsTab();
      case 'rules':
        return this._renderRules();
      case 'escalation':
        return this._renderEscalation();
      case 'maintenance':
        return this._renderMaintenance();
      case 'silence':
        return this._renderSilence();
      case 'baselines':
        return this._renderBaselines();
      default:
        return this._renderAlertsTab();
    }
    })();

    return html`
      ${tabContent}
      <alert-detail-modal .alert=${this.detailAlert} .open=${this.detailAlert !== null}
        .activeRCAAnalysis=${this.activeRCAAnalysis} .diagnosisStatus=${this.diagnosisStatus}
        .diagnosisResult=${this.diagnosisResult} .diagnosisError=${this.diagnosisError}
        .analysisHistory=${this.analysisHistory} .analysisHistoryLoading=${this.analysisHistoryLoading}
        @close=${this._closeAlertDetail} @alert-rca=${(e: CustomEvent) => {
          const a = this.alerts.find(x => x.id === e.detail.id);
          if (a) this._startRCA(a);
        }} @alert-navigate-chat=${(e: CustomEvent) => this._navigateToChat(e.detail.sessionKey)}>
      </alert-detail-modal>
      <alert-analysis-viewer .analysis=${this.activeAnalysisRecord} .open=${this.activeAnalysisRecord !== null}
        @close=${this._closeAnalysisResult}>
      </alert-analysis-viewer>
    `;
  }

  // ==================== Alerts List (original functionality) ====================

  private async loadAlerts() {
    try {
      const offset = this.page * this.pageSize;
      const statusFilter = this.activeListTab === 'active'
        ? 'unread,read,acknowledged'
        : 'resolved,closed';
      const res = await authFetch(`/api/alerts?limit=${this.pageSize}&offset=${offset}&status=${statusFilter}`);
      if (!res.ok) throw new Error("Failed to load alerts");
      const data = await res.json();
      this.alerts = data.items ?? data;
      this.total = data.total ?? 0;
      // 只在活跃 tab 时更新统计（已恢复 tab 的 unread/critical/warning 无意义）
      if (this.activeListTab === 'active') {
        this._statsUnread = data.unread ?? 0;
        this._statsCritical = data.critical ?? 0;
        this._statsWarning = data.warning ?? 0;
        this._statsActiveTotal = data.total ?? 0;
      }
      this._statsResolved = data.resolved ?? 0; // 总是跨 tab 的
      this.loading = false;
      // Also load analyzed alert IDs for badges
      this._loadAnalyzedStatuses();
    } catch (err: any) {
      this.error = err.message;
      this.loading = false;
    }
  }

  private async _loadAnalyzedStatuses() {
    try {
      const res = await authFetch("/api/ai/analysis?analysis_type=alert_rca&limit=500");
      if (res.ok) {
        const records = await res.json();
        const statusMap = new Map<number, { status: string; trigger_type: string; result?: any; sessionKey?: string }>();
        for (const r of records) {
          if (r.related_id) {
            statusMap.set(r.related_id, {
              status: r.status,
              trigger_type: r.trigger_type,
              result: r.result,
              sessionKey: r.session_key,
            });
          }
        }
        this.analyzedStatuses = statusMap;
      }
    } catch (err) {
      console.warn('[Alerts] _loadAnalyzedStatuses failed:', err);
    }
  }

  private get filteredAlerts(): Alert[] {
    let result = this.alerts;
    // Severity dropdown filter
    if (this.filterSeverity) {
      result = result.filter((a) => a.severity === this.filterSeverity);
    }
    // Text search
    if (this.searchText.trim()) {
      const q = this.searchText.trim().toLowerCase();
      result = result.filter((a) =>
        String(a.id).includes(q) ||
        a.title.toLowerCase().includes(q) ||
        a.message.toLowerCase().includes(q) ||
        (a.instance_name || '').toLowerCase().includes(q)
      );
    }
    return result;
  }

  @state() private _statsUnread = 0;
  @state() private _statsCritical = 0;
  @state() private _statsWarning = 0;
  @state() private _statsResolved = 0;
  @state() private _statsActiveTotal = 0;

  private get stats() {
    return {
      total: this._statsActiveTotal + this._statsResolved,
      unread: this._statsUnread,
      critical: this._statsCritical,
      warning: this._statsWarning,
      resolved: this._statsResolved,
    };
  }

  private _renderAlertsTab() {
    return html`
      <alert-list .alerts=${this.filteredAlerts} .loading=${this.loading} .error=${this.error}
        .activeListTab=${this.activeListTab} .filterSeverity=${this.filterSeverity}
        .searchText=${this.searchText} .stats=${this.stats}
        .statsActiveTotal=${this._statsActiveTotal} .statsResolved=${this._statsResolved}
        .analyzedStatuses=${this.analyzedStatuses} .activeRCAAnalysis=${this.activeRCAAnalysis}
        .diagnosisStatus=${this.diagnosisStatus} .diagnosisResult=${this.diagnosisResult}
        .diagnosisError=${this.diagnosisError}
        .page=${this.page} .total=${this.total} .pageSize=${this.pageSize}
        @alert-select=${(e: CustomEvent) => { const a = this.alerts.find(x => x.id === e.detail.id); if (a) this._openAlertDetail(a); }}
        @alert-acknowledge=${(e: CustomEvent) => { const a = this.alerts.find(x => x.id === e.detail.id); if (a) this._acknowledge(a); }}
        @alert-rca=${(e: CustomEvent) => { const a = this.alerts.find(x => x.id === e.detail.id); if (a) this._startRCA(a); }}
        @alert-navigate-instance=${(e: CustomEvent) => this._navigateToInstance(e.detail.id)}
        @alert-navigate-chat=${(e: CustomEvent) => this._navigateToChat(e.detail.sessionKey)}
        @alert-create=${() => { this.activeAlertTab = 'rules'; this._openRuleModal(); }}
        @alert-filter-severity=${(e: CustomEvent) => { this.filterSeverity = e.detail.value; }}
        @alert-search=${(e: CustomEvent) => { this.searchText = e.detail.value; }}
        @alert-refresh=${() => this.loadAlerts()}
        @alert-page-change=${(e: CustomEvent) => { this.page = e.detail.page; this.loadAlerts(); }}
        @alert-list-tab-change=${(e: CustomEvent) => { this.activeListTab = e.detail.tab; this.page = 0; this.loadAlerts(); }}>
      </alert-list>
    `;
  }

  private _navigateToInstance(instanceId: number) {
    window.dispatchEvent(new CustomEvent("slide-navigate", {
      detail: { tab: "instance-detail", id: instanceId },
    }));
  }

  private _navigateToChat(sessionKey: string) {
    window.dispatchEvent(new CustomEvent("slide-navigate", {
      detail: { tab: "chat", session: sessionKey },
    }));
  }

  private _openAnalysisResult(alertId: number) {
    const alert = this.alerts.find(a => a.id === alertId);
    if (!alert) return;
    const record = this.analyzedStatuses.get(alertId);
    if (record && record.status !== 'completed' && record.status !== 'failed') return;
    if (record && (record.status === 'completed' || record.status === 'failed')) {
      this.activeAnalysisRecord = { alert, record };
      return;
    }
    // Check running analysis
    if (this.activeRCAAnalysis?.alertId === alertId) {
      this.activeAnalysisRecord = { alert, record: { status: this.diagnosisStatus, trigger_type: 'manual', result: this.diagnosisResult } };
    }
  }

  private _closeAnalysisResult() {
    this.activeAnalysisRecord = null;
  }

  private async _acknowledge(alert: Alert) {
    try {
      const res = await authFetch(`/api/alerts/${alert.id}/read`, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: "{}",
      });
      if (res.ok) {
        alert.acknowledged = true;
        alert.status = 'acknowledged';
        alert.acknowledged_at = new Date().toISOString();
        this.requestUpdate();
      }
    } catch (e) { console.warn("确认告警失败:", e); }
  }

  private _severityLabel(s: string): string {
    return ({ critical: "严重", warning: "警告", info: "提示" } as Record<string, string>)[s] || s;
  }

  @state() private detailAlert: Alert | null = null;
  @state() private analysisHistory: any[] = [];
  @state() private analysisHistoryLoading = false;

  private async _openAlertDetail(alert: Alert) {
    this.detailAlert = alert;
    this.analysisHistory = [];
    this.requestUpdate();
    await this._loadAnalysisHistory(alert.id);
  }

  private _closeAlertDetail() {
    this.detailAlert = null;
    this.analysisHistory = [];
    this.requestUpdate();
  }

  private async _loadAnalysisHistory(alertId: number) {
    this.analysisHistoryLoading = true;
    try {
      const res = await authFetch(`/api/ai/analysis?analysis_type=alert_rca&related_id=${alertId}&limit=5`);
      if (res.ok) {
        this.analysisHistory = await res.json();
      }
    } catch (err) {
      console.warn('[Alerts] _loadAnalysisHistory failed:', err);
    }
    this.analysisHistoryLoading = false;
    this.requestUpdate();
  }

  private async _startRCA(alert: Alert) {
    this.activeRCAAnalysis = { alertId: alert.id };
    this.requestUpdate();
    // Direct API call — bypasses DOM query timing issues
    try {
      const res = await authFetch("/api/ai/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysis_type: "alert_rca",
          instance_id: alert.instance_id,
          related_id: alert.id,
          trigger_type: "manual",
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.cached) {
          this.diagnosisStatus = "completed";
          this.diagnosisResult = data.result || data;
          this.diagnosisError = null;
          this.activeRCAAnalysis = { alertId: alert.id, analysisId: data.id, sessionKey: data.session_key };
          this.requestUpdate();
          return;
        }
        if (!data.id) throw new Error("Server returned no analysis ID");
        this.activeRCAAnalysis = { alertId: alert.id, analysisId: data.id, sessionKey: data.session_key };
        this.diagnosisStatus = "running";
        this.diagnosisError = null;
        this.requestUpdate();
        this._startDiagnosisPolling(data.id);
      } else {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
    } catch (e: any) {
      this.diagnosisStatus = "failed";
      this.diagnosisError = e.message || "启动 AI 分析失败";
      this.requestUpdate();
    }
  }

  private _startDiagnosisPolling(analysisId: number) {
    this._stopDiagnosisPolling();
    this.pollRetries = 0;
    this.diagnosisPollTimer = setInterval(async () => {
      try {
        const res = await authFetch(`/api/ai/analysis/${analysisId}/status`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === "completed") {
          const fullRes = await authFetch(`/api/ai/analysis/${analysisId}`);
          if (fullRes.ok) {
            const fullData = await fullRes.json();
            this.diagnosisResult = fullData.result || fullData;
            this.diagnosisStatus = "completed";
            if (this.activeRCAAnalysis?.alertId) {
              this._loadAnalysisHistory(this.activeRCAAnalysis.alertId);
              // Update analyzedStatuses so badge persists after activeRCAAnalysis changes
              this.analyzedStatuses = new Map(this.analyzedStatuses).set(
                this.activeRCAAnalysis.alertId,
                { status: 'completed', trigger_type: 'manual', result: fullData.result }
              );
            }
          } else {
            this.diagnosisStatus = "failed";
            this.diagnosisError = "获取分析结果失败";
          }
          this._stopDiagnosisPolling();
          this.requestUpdate();
        } else if (data.status === "failed") {
          this.diagnosisStatus = "failed";
          this.diagnosisError = data.error_message || "AI 分析失败";
          this._stopDiagnosisPolling();
          this.requestUpdate();
        }
      } catch {
        this.pollRetries++;
        if (this.pollRetries >= this.maxPollRetries) {
          this.diagnosisStatus = "failed";
          this.diagnosisError = "分析超时，请稍后重试";
          this._stopDiagnosisPolling();
          this.requestUpdate();
        }
      }
    }, 3000);
  }

  private _stopDiagnosisPolling() {
    if (this.diagnosisPollTimer) {
      clearInterval(this.diagnosisPollTimer);
      this.diagnosisPollTimer = null;
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._stopDiagnosisPolling();
  }

  // ==================== Task 2: Rules CRUD ====================

  async loadRules() {
    this.rulesLoading = true;
    try {
      const [rulesRes, metricsRes, instancesRes] = await Promise.all([
        authFetch("/api/alert-rules"),
        authFetch("/api/metrics/registry"),
        authFetch("/api/database/instances"),
      ]);
      if (!rulesRes.ok) throw new Error("加载规则失败");
      this.rules = await rulesRes.json();
      if (metricsRes.ok) {
        const data = await metricsRes.json();
        this.metricRegistry = Array.isArray(data) ? data : Object.values(data);
      }
      if (instancesRes.ok) {
        const data = await instancesRes.json();
        this.instances = Array.isArray(data) ? data : (data.instances || []);
      }
    } catch (err: any) {
      this.error = err.message;
    } finally {
      this.rulesLoading = false;
    }
  }

  private _openRuleModal(rule?: AlertRule) {
    this.editingRule = rule || null;
    this.ruleForm = rule ? { ...rule, threshold_template: rule.threshold_template || undefined } : {
      name: '',
      description: '',
      metric_name: '',
      operator: '>',
      threshold: 0,
      duration_seconds: 60,
      severity: 'warning',
      enabled: true,
      threshold_type: 'static',
      silence_minutes: 5,
      db_types: null,
      instance_ids: null,
    };
    this.ruleFormError = '';
    this.showRuleModal = true;
  }

  private _closeRuleModal() {
    this.showRuleModal = false;
    this.editingRule = null;
    this.ruleForm = {};
    this.ruleFormError = '';
  }

  private async _onRuleSave(e: CustomEvent) {
    const { isEdit, id, body } = e.detail;
    this.ruleFormError = '';
    try {
      let res: Response;
      if (isEdit) {
        res = await authFetch(`/api/alert-rules/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        res = await authFetch('/api/alert-rules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) {
        const err = await res.json();
        this.ruleFormError = err.error || '保存失败';
        return;
      }
      this._closeRuleModal();
      await this.loadRules();
    } catch (err: any) {
      this.ruleFormError = err.message;
    }
  }

  private async _deleteRule(rule: AlertRule) {
    if (!confirm(`确定删除规则「${rule.name}」？`)) return;
    try {
      const res = await authFetch(`/api/alert-rules/${rule.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('删除失败');
      await this.loadRules();
    } catch (err: any) {
      this.error = err.message;
    }
  }

  private async _toggleRuleEnabled(rule: AlertRule) {
    const originalEnabled = rule.enabled;
    rule.enabled = !rule.enabled;
    this.requestUpdate();

    try {
      const res = await authFetch(`/api/alert-rules/${rule.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: rule.enabled }),
      });
      if (!res.ok) throw new Error('toggle failed');
    } catch (err) {
      rule.enabled = originalEnabled;
      this.requestUpdate();
      this._ruleToggleErrors = new Map(this._ruleToggleErrors).set(rule.id, '切换失败，已回滚');
      this.requestUpdate();
      setTimeout(() => {
        const next = new Map(this._ruleToggleErrors);
        next.delete(rule.id);
        this._ruleToggleErrors = next;
        this.requestUpdate();
      }, 3000);
    }
  }

  private _updateRuleForm(field: string, value: any) {
    this.ruleForm = { ...this.ruleForm, [field]: value };
    // Auto-fill db_types from selected metric
    if (field === 'metric_name' && value) {
      const metric = this.metricRegistry.find((m: any) => (m.id || m.metric_name) === value);
      if (metric && metric.db_types && metric.db_types.length > 0) {
        this.ruleForm = { ...this.ruleForm, db_types: metric.db_types };
      }
    }
  }

  private _renderRules() {
    if (this.rulesLoading) return html`<div class="loading">加载规则...</div>`;

    return html`
      <div class="card">
        <div class="card-header">
          <span class="card-title">告警规则 (${this.rules.length})</span>
          <button class="btn primary" @click=${() => this._openRuleModal()}>
            ${icons['plus']} 新建规则
          </button>
        </div>

        ${this.rules.length > 0
          ? html`
              <div class="table-container">
                <table class="table">
                  <thead>
                    <tr>
                      <th style="width:36px;text-align:center;">#</th>
                      <th>名称 / 指标</th>
                      <th style="width:180px;">阈值</th>
                      <th style="width:60px;text-align:center;">等级</th>
                      <th style="width:55px;text-align:center;">静默</th>
                      <th style="width:60px;text-align:center;">状态</th>
                      <th style="width:100px;text-align:center;">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.rules.map(rule => html`
                      <tr>
                        <td style="color:var(--muted);font-size:11px;text-align:center;">${rule.id}</td>
                        <td>
                          <div style="font-weight:500;font-size:12px;">${rule.name}</div>
                          <div style="font-size:11px;color:var(--muted);margin-top:1px;">
                            <span class="type-badge" style="font-size:10px;">${rule.metric_name}</span>
                            ${(rule.db_types && rule.db_types.length > 0) ? html`<span style="margin-left:4px;">${rule.db_types.join(', ')}</span>` : ''}
                            ${rule.description ? html`<span style="margin-left:4px;">${rule.description.substring(0,40)}${rule.description.length>40?'...':''}</span>` : ''}
                          </div>
                        </td>
                        <td>
                          ${rule.threshold_type === 'dynamic'
                            ? html`<span style="color:var(--accent);font-size:11px;font-weight:500;">动态基线</span>`
                            : rule.threshold_template
                              ? html`<div style="display:flex;gap:3px;flex-wrap:wrap;">
                                  ${rule.threshold_template.warning != null ? html`<span style="padding:1px 6px;border-radius:3px;font-size:10px;font-weight:500;background:rgba(234,179,8,0.15);color:#eab308;">W&ge;${rule.threshold_template.warning}</span>` : ''}
                                  ${rule.threshold_template.error != null ? html`<span style="padding:1px 6px;border-radius:3px;font-size:10px;font-weight:500;background:rgba(249,115,22,0.15);color:#f97316;">E&ge;${rule.threshold_template.error}</span>` : ''}
                                  ${rule.threshold_template.critical != null ? html`<span style="padding:1px 6px;border-radius:3px;font-size:10px;font-weight:500;background:rgba(239,68,68,0.12);color:#ef4444;">C&ge;${rule.threshold_template.critical}</span>` : ''}
                                </div>`
                              : html`<span style="font-size:11px;color:var(--muted);">${rule.operator} ${rule.threshold}</span>`
                          }
                        </td>
                        <td style="text-align:center;">
                          <span style="font-size:11px;font-weight:600;color:${rule.severity==='critical'?'#ef4444':rule.severity==='error'?'#f97316':rule.severity==='warning'?'#eab308':'var(--muted)'};">${this._severityLabel(rule.severity)}</span>
                        </td>
                        <td style="font-size:11px;color:var(--muted);text-align:center;">${rule.silence_minutes ?? 5}m</td>
                        <td style="text-align:center;">
                          <label class="cfg-toggle" style="display:inline-flex;vertical-align:middle;" @click=${(e: Event) => e.stopPropagation()}>
                            <input type="checkbox" .checked=${rule.enabled} @change=${() => this._toggleRuleEnabled(rule)} />
                            <span class="slider"></span>
                          </label>
                        </td>
                        <td style="text-align:center;">
                          <button class="action-btn" @click=${() => this._openRuleModal(rule)}>编辑</button>
                          <button class="action-btn" style="color:var(--destructive);border-color:var(--destructive);margin-left:4px;" @click=${() => this._deleteRule(rule)}>删除</button>
                        </td>
                      </tr>
                    `)}
                  </tbody>
                </table>
              </div>
            `
          : html`
              <div class="empty" style="min-height: 200px;">
                <div class="empty__content">
                  <div class="empty__icon">${icons['settings']}</div>
                  <div class="empty__title">暂无告警规则</div>
                  <div class="empty__desc">点击「新建规则」创建第一条规则</div>
                </div>
              </div>
            `
        }
      </div>

      <alert-rule-editor .rule=${this.editingRule} .open=${this.showRuleModal}
        .metricRegistry=${this.metricRegistry} .instances=${this.instances}
        .error=${this.ruleFormError}
        @save=${this._onRuleSave} @close=${this._closeRuleModal}>
      </alert-rule-editor>
    `;
  }

  // ==================== Task 3: Escalation CRUD ====================

  async loadEscalationRules() {
    this.escalationLoading = true;
    try {
      const res = await authFetch("/api/alerts/escalation/rules");
      if (!res.ok) throw new Error("加载升级规则失败");
      this.escalationRules = await res.json();
    } catch (err: any) {
      this.error = err.message;
    } finally {
      this.escalationLoading = false;
    }
  }

  private _openEscalationModal(rule?: any) {
    this.editingEscalation = rule || null;
    this.ruleForm = rule ? { ...rule } : { from_level: 'warning', to_level: 'error', trigger_condition: 'timeout_minutes', trigger_value: 30, enabled: true };
    this.ruleFormError = '';
    this.showEscalationModal = true;
  }

  private _closeEscalationModal() {
    this.showEscalationModal = false;
    this.editingEscalation = null;
    this.ruleForm = {};
    this.ruleFormError = '';
  }

  private async _saveEscalationRule() {
    const form = this.ruleForm;
    if (!form.from_level || !form.to_level) {
      this.ruleFormError = '等级不能为空';
      return;
    }
    try {
      const body = {
        from_level: form.from_level,
        to_level: form.to_level,
        trigger_condition: form.trigger_condition || 'timeout_minutes',
        trigger_value: Number(form.trigger_value) || 30,
        enabled: form.enabled !== false,
      };
      let res: Response;
      if (this.editingEscalation) {
        res = await authFetch(`/api/alerts/escalation/rules/${this.editingEscalation.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        res = await authFetch('/api/alerts/escalation/rules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) {
        const err = await res.json();
        this.ruleFormError = err.error || '保存失败';
        return;
      }
      this._closeEscalationModal();
      await this.loadEscalationRules();
    } catch (err: any) {
      this.ruleFormError = err.message;
    }
  }

  private async _toggleEscalation(rule: any) {
    try {
      const res = await authFetch(`/api/alerts/escalation/rules/${rule.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      if (!res.ok) throw new Error('切换失败');
      await this.loadEscalationRules();
    } catch (err: any) {
      this.error = err.message;
    }
  }

  private async _deleteEscalation(rule: any) {
    if (!confirm(`确定删除该升级规则？`)) return;
    try {
      const res = await authFetch(`/api/alerts/escalation/rules/${rule.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('删除失败');
      await this.loadEscalationRules();
    } catch (err: any) {
      this.error = err.message;
    }
  }

  private _renderEscalation() {
    if (this.escalationLoading) return html`<div class="loading">加载升级规则...</div>`;

    const levelLabels: Record<string, string> = { info: '提示', warning: '警告', error: '错误', critical: '严重' };

    return html`
      <div class="card">
        <div class="card-header">
          <span class="card-title">升级规则 (${this.escalationRules.length})</span>
          <button class="btn primary" @click=${() => this._openEscalationModal()}>
            ${icons['plus']} 新建规则
          </button>
        </div>

        ${this.escalationRules.length > 0
          ? html`
              <div class="table-container">
                <table class="table">
                  <thead>
                    <tr>
                      <th style="width:120px;text-align:center;">从等级</th>
                      <th style="width:40px;text-align:center;"></th>
                      <th style="width:120px;text-align:center;">到等级</th>
                      <th style="width:100px;text-align:center;">超时（分钟）</th>
                      <th style="width:70px;text-align:center;">状态</th>
                      <th style="width:140px;text-align:center;">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.escalationRules.map(rule => html`
                      <tr>
                        <td style="text-align:center;">
                          <span class="severity-badge ${rule.from_level === 'critical' ? 'red' : rule.from_level === 'warning' ? 'orange' : rule.from_level === 'error' ? 'red' : 'blue'}">
                            ${levelLabels[rule.from_level] || rule.from_level}
                          </span>
                        </td>
                        <td style="color:var(--muted);font-size:18px;text-align:center;">&rarr;</td>
                        <td style="text-align:center;">
                          <span class="severity-badge ${rule.to_level === 'critical' ? 'red' : rule.to_level === 'warning' ? 'orange' : rule.to_level === 'error' ? 'red' : 'blue'}">
                            ${levelLabels[rule.to_level] || rule.to_level}
                          </span>
                        </td>
                        <td style="text-align:center;">${rule.trigger_value ?? rule.timeout_minutes}</td>
                        <td style="text-align:center;">
                          <button class="status-badge-sm ${rule.enabled ? 'enabled' : 'disabled'}" style="border:none;cursor:pointer;" @click=${() => this._toggleEscalation(rule)}>
                            ${rule.enabled ? '启用' : '停用'}
                          </button>
                        </td>
                        <td style="text-align:center;">
                          <div class="actions">
                            <button class="action-btn" @click=${() => this._openEscalationModal(rule)}>编辑</button>
                            <button class="action-btn" style="color:var(--destructive);border-color:var(--destructive);" @click=${() => this._deleteEscalation(rule)}>删除</button>
                          </div>
                        </td>
                      </tr>
                    `)}
                  </tbody>
                </table>
              </div>
            `
          : html`
              <div class="empty" style="min-height: 200px;">
                <div class="empty__content">
                  <div class="empty__icon">${icons['arrow-right']}</div>
                  <div class="empty__title">暂无升级规则</div>
                  <div class="empty__desc">点击「新建规则」创建升级策略</div>
                </div>
              </div>
            `
        }
      </div>

      ${this.showEscalationModal ? this._renderEscalationFormModal() : ''}
    `;
  }

  private _renderEscalationFormModal() {
    const form = this.ruleForm;
    const levels = ['info', 'warning', 'error', 'critical'];
    const levelLabels: Record<string, string> = { info: '提示', warning: '警告', error: '错误', critical: '严重' };

    return html`
      <div class="modal-overlay" @click=${(e: MouseEvent) => { if (e.target === e.currentTarget) this._closeEscalationModal(); }}>
        <div class="modal">
          <div class="modal-title">${this.editingEscalation ? '编辑升级规则' : '新建升级规则'}</div>

          ${this.ruleFormError ? html`<div style="color: var(--destructive); font-size: var(--text-base); margin-bottom: var(--space-md);">${this.ruleFormError}</div>` : ''}

          <div class="form-group">
            <label class="form-label">从等级</label>
            <select class="form-select" .value=${form.from_level || 'warning'} @change=${(e: any) => this._updateRuleForm('from_level', e.target.value)}>
              ${levels.map(l => html`<option value="${l}">${levelLabels[l]}</option>`)}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label">到等级</label>
            <select class="form-select" .value=${form.to_level || 'error'} @change=${(e: any) => this._updateRuleForm('to_level', e.target.value)}>
              ${levels.map(l => html`<option value="${l}">${levelLabels[l]}</option>`)}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label">超时时间（分钟）</label>
            <input type="number" class="form-input" .value=${form.trigger_value ?? 30} @input=${(e: any) => this._updateRuleForm('trigger_value', Number(e.target.value))} />
          </div>

          <div class="form-actions">
            <button class="btn" @click=${() => this._closeEscalationModal()}>取消</button>
            <button class="btn primary" @click=${() => this._saveEscalationRule()}>保存</button>
          </div>
        </div>
      </div>
    `;
  }

  // ==================== Task 3: Maintenance Windows CRUD ====================

  async loadMaintenanceWindows() {
    this.maintenanceLoading = true;
    try {
      const res = await authFetch("/api/maintenance-windows");
      if (!res.ok) throw new Error("加载维护窗口失败");
      this.maintenanceWindows = await res.json();
    } catch (err: any) {
      this.error = err.message;
    } finally {
      this.maintenanceLoading = false;
    }
  }

  private _openMaintenanceModal(win?: any) {
    this.editingMaintenance = win || null;
    this.ruleForm = win ? { ...win, _days: (win.day_of_week || '').split(',').map(Number).filter((d:number)=>!isNaN(d)) } : { name: '', start_time: '02:00', end_time: '06:00', _days: [0], enabled: true };
    this.ruleFormError = '';
    this.showMaintenanceModal = true;
  }

  private _closeMaintenanceModal() {
    this.showMaintenanceModal = false;
    this.editingMaintenance = null;
    this.ruleForm = {};
    this.ruleFormError = '';
  }

  private async _saveMaintenanceWindow() {
    const form = this.ruleForm;
    if (!form.name) {
      this.ruleFormError = '名称不能为空';
      return;
    }
    try {
      const body = {
        name: form.name,
        description: form.description || '',
        start_time: form.start_time || '02:00',
        end_time: form.end_time || '06:00',
        day_of_week: ((Array.isArray(form._days) ? form._days : [0]) as number[]).join(','),
        enabled: form.enabled !== false,
      };
      let res: Response;
      if (this.editingMaintenance) {
        res = await authFetch(`/api/maintenance-windows/${this.editingMaintenance.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        res = await authFetch('/api/maintenance-windows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) {
        const err = await res.json();
        this.ruleFormError = err.error || '保存失败';
        return;
      }
      this._closeMaintenanceModal();
      await this.loadMaintenanceWindows();
    } catch (err: any) {
      this.ruleFormError = err.message;
    }
  }

  private async _toggleMaintenance(win: any) {
    try {
      const res = await authFetch(`/api/maintenance-windows/${win.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !win.enabled }),
      });
      if (!res.ok) throw new Error('切换失败');
      await this.loadMaintenanceWindows();
    } catch (err: any) {
      this.error = err.message;
    }
  }

  private async _deleteMaintenance(win: any) {
    if (!confirm(`确定删除维护窗口「${win.name}」？`)) return;
    try {
      const res = await authFetch(`/api/maintenance-windows/${win.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('删除失败');
      await this.loadMaintenanceWindows();
    } catch (err: any) {
      this.error = err.message;
    }
  }

  private _toggleDayOfWeek(day: number) {
    const current = (this.ruleForm._days as number[]) || [];
    const next = current.includes(day) ? current.filter((d:number) => d !== day) : [...current, day];
    this._updateRuleForm('_days', next);
  }

  private _renderMaintenance() {
    if (this.maintenanceLoading) return html`<div class="loading">加载维护窗口...</div>`;

    const dayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    return html`
      <div class="card">
        <div class="card-header">
          <span class="card-title">维护窗口 (${this.maintenanceWindows.length})</span>
          <button class="btn primary" @click=${() => this._openMaintenanceModal()}>
            ${icons['plus']} 新建窗口
          </button>
        </div>

        ${this.maintenanceWindows.length > 0
          ? html`
              <div class="table-container">
                <table class="table">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th style="width:120px;text-align:center;">时间范围</th>
                      <th style="width:180px;text-align:center;">星期</th>
                      <th style="width:70px;text-align:center;">状态</th>
                      <th style="width:120px;text-align:center;">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.maintenanceWindows.map(win => {
                      const days = (win.day_of_week || '').split(',').map((d: string) => dayLabels[Number(d)] || d).join(', ');
                      return html`
                        <tr>
                          <td>
                            <span style="font-weight:500;">${win.name}</span>
                            ${win.description ? html`<br><span style="font-size:var(--text-xs);color:var(--muted);">${win.description}</span>` : ''}
                          </td>
                          <td style="text-align:center;">${win.start_time} - ${win.end_time}</td>
                          <td style="font-size:var(--text-sm);text-align:center;">${days || '—'}</td>
                          <td style="text-align:center;">
                            <button class="status-badge-sm ${win.enabled ? 'enabled' : 'disabled'}" style="border:none;cursor:pointer;" @click=${() => this._toggleMaintenance(win)}>
                              ${win.enabled ? '启用' : '停用'}
                            </button>
                          </td>
                          <td style="text-align:center;">
                            <div class="actions">
                              <button class="action-btn" @click=${() => this._openMaintenanceModal(win)}>编辑</button>
                              <button class="action-btn" style="color:var(--destructive);border-color:var(--destructive);" @click=${() => this._deleteMaintenance(win)}>删除</button>
                            </div>
                          </td>
                        </tr>
                      `;
                    })}
                  </tbody>
                </table>
              </div>
            `
          : html`
              <div class="empty" style="min-height: 200px;">
                <div class="empty__content">
                  <div class="empty__icon">${icons['calendar']}</div>
                  <div class="empty__title">暂无维护窗口</div>
                  <div class="empty__desc">创建维护窗口以在特定时段抑制告警</div>
                </div>
              </div>
            `
        }
      </div>

      ${this.showMaintenanceModal ? this._renderMaintenanceFormModal() : ''}
    `;
  }

  private _renderMaintenanceFormModal() {
    const form = this.ruleForm;
    const dayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const selectedDays = (form._days as number[]) || [];

    return html`
      <div class="modal-overlay" @click=${(e: MouseEvent) => { if (e.target === e.currentTarget) this._closeMaintenanceModal(); }}>
        <div class="modal">
          <div class="modal-title">${this.editingMaintenance ? '编辑维护窗口' : '新建维护窗口'}</div>

          ${this.ruleFormError ? html`<div style="color: var(--destructive); font-size: var(--text-base); margin-bottom: var(--space-md);">${this.ruleFormError}</div>` : ''}

          <div class="form-group">
            <label class="form-label">名称</label>
            <input class="form-input" .value=${form.name || ''} @input=${(e: any) => this._updateRuleForm('name', e.target.value)} placeholder="例如：每周例行维护" />
          </div>

          <div class="form-group">
            <label class="form-label">描述</label>
            <input class="form-input" .value=${form.description || ''} @input=${(e: any) => this._updateRuleForm('description', e.target.value)} placeholder="可选" />
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-md);">
            <div class="form-group">
              <label class="form-label">开始时间</label>
              <input type="time" class="form-input" .value=${form.start_time || '02:00'} @input=${(e: any) => this._updateRuleForm('start_time', e.target.value)} />
            </div>
            <div class="form-group">
              <label class="form-label">结束时间</label>
              <input type="time" class="form-input" .value=${form.end_time || '06:00'} @input=${(e: any) => this._updateRuleForm('end_time', e.target.value)} />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">星期</label>
            <div class="checkbox-group">
              ${dayLabels.map((label, i) => html`
                <button class="checkbox-label ${selectedDays.includes(i) ? 'active' : ''}" @click=${() => this._toggleDayOfWeek(i)}>
                  ${label}
                </button>
              `)}
            </div>
          </div>

          <div class="form-actions">
            <button class="btn" @click=${() => this._closeMaintenanceModal()}>取消</button>
            <button class="btn primary" @click=${() => this._saveMaintenanceWindow()}>保存</button>
          </div>
        </div>
      </div>
    `;
  }

  // ==================== Task 3: Silence Periods CRUD ====================

  async loadSilencePeriods() {
    this.silenceLoading = true;
    try {
      const [silenceRes, instancesRes] = await Promise.all([
        authFetch("/api/silence"),
        authFetch("/api/database/instances"),
      ]);
      if (!silenceRes.ok) throw new Error("加载静默期失败");
      this.silencePeriods = await silenceRes.json();
      if (instancesRes.ok) {
        const data = await instancesRes.json();
        this.instances = Array.isArray(data) ? data : (data.instances || []);
      }
    } catch (err: any) {
      this.error = err.message;
    } finally {
      this.silenceLoading = false;
    }
  }

  private _openSilenceModal() {
    this.ruleForm = { instance_id: undefined as any, metric_name: '', duration_minutes: 30 };
    this.ruleFormError = '';
    this.showSilenceModal = true;
  }

  private _closeSilenceModal() {
    this.showSilenceModal = false;
    this.ruleForm = {};
    this.ruleFormError = '';
  }

  private async _createSilence() {
    const form = this.ruleForm;
    if (!form.instance_id || !form.metric_name) {
      this.ruleFormError = '实例和指标不能为空';
      return;
    }
    try {
      const body = {
        instance_id: Number(form.instance_id),
        metric_name: form.metric_name,
        duration_minutes: Number(form.duration_minutes) || 30,
      };
      const res = await authFetch('/api/silence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        this.ruleFormError = err.error || '创建失败';
        return;
      }
      this._closeSilenceModal();
      await this.loadSilencePeriods();
    } catch (err: any) {
      this.ruleFormError = err.message;
    }
  }

  private async _cancelSilence(s: any) {
    try {
      const res = await authFetch(`/api/silence/${s.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('取消失败');
      await this.loadSilencePeriods();
    } catch (err: any) {
      this.error = err.message;
    }
  }

  private _formatSilenceRemaining(silencedUntil: string): string {
    const until = new Date(silencedUntil).getTime();
    const diff = until - Date.now();
    if (diff <= 0) return '已过期';
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    if (hours > 0) return `${hours}小时${mins}分钟`;
    return `${mins}分钟`;
  }

  private _renderSilence() {
    if (this.silenceLoading) return html`<div class="loading">加载静默期...</div>`;

    return html`
      <div class="card">
        <div class="card-header">
          <span class="card-title">静默期 (${this.silencePeriods.length})</span>
          <button class="btn primary" @click=${() => this._openSilenceModal()}>
            ${icons['bell-off']} 新建静默
          </button>
        </div>

        ${this.silencePeriods.length > 0
          ? html`
              <div class="table-container">
                <table class="table">
                  <thead>
                    <tr>
                      <th style="width:40px;text-align:center;">ID</th>
                      <th style="width:140px;text-align:center;">实例</th>
                      <th style="width:140px;text-align:center;">指标</th>
                      <th style="width:160px;text-align:center;">静默到</th>
                      <th style="width:100px;text-align:center;">剩余时间</th>
                      <th style="width:80px;text-align:center;">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.silencePeriods.map(s => html`
                      <tr>
                        <td style="color:var(--muted);font-size:var(--text-sm);text-align:center;">${s.id}</td>
                        <td style="text-align:center;">
                          ${s.instance_name
                            ? html`<span class="instance-badge">${s.instance_name}</span>`
                            : html`<span style="color:var(--muted);">实例 #${s.instance_id}</span>`
                          }
                        </td>
                        <td style="text-align:center;"><span class="type-badge">${s.metric_name}</span></td>
                        <td style="font-size:var(--text-sm);text-align:center;">${s.silenced_until ? new Date(s.silenced_until).toLocaleString('zh-CN') : '—'}</td>
                        <td style="text-align:center;">
                          <span class="status-badge-sm ${this._formatSilenceRemaining(s.silenced_until) === '已过期' ? 'disabled' : 'enabled'}">
                            ${this._formatSilenceRemaining(s.silenced_until)}
                          </span>
                        </td>
                        <td style="text-align:center;">
                          <div class="actions">
                            <button class="action-btn" style="color:var(--destructive);border-color:var(--destructive);" @click=${() => this._cancelSilence(s)}>取消</button>
                          </div>
                        </td>
                      </tr>
                    `)}
                  </tbody>
                </table>
              </div>
            `
          : html`
              <div class="empty" style="min-height: 200px;">
                <div class="empty__content">
                  <div class="empty__icon">${icons['bell-off']}</div>
                  <div class="empty__title">暂无静默期</div>
                  <div class="empty__desc">创建静默期以临时屏蔽特定指标的告警</div>
                </div>
              </div>
            `
        }
      </div>

      ${this.showSilenceModal ? this._renderSilenceFormModal() : ''}
    `;
  }

  private _renderSilenceFormModal() {
    const form = this.ruleForm;

    return html`
      <div class="modal-overlay" @click=${(e: MouseEvent) => { if (e.target === e.currentTarget) this._closeSilenceModal(); }}>
        <div class="modal">
          <div class="modal-title">新建静默期</div>

          ${this.ruleFormError ? html`<div style="color: var(--destructive); font-size: var(--text-base); margin-bottom: var(--space-md);">${this.ruleFormError}</div>` : ''}

          <div class="form-group">
            <label class="form-label">实例</label>
            <select class="form-select" .value=${form.instance_id || ''} @change=${(e: any) => this._updateRuleForm('instance_id', e.target.value)}>
              <option value="">请选择实例</option>
              ${this.instances.map((inst: any) => html`<option value="${inst.id}">${inst.name} (${inst.db_type})</option>`)}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label">指标名称</label>
            <input class="form-input" .value=${form.metric_name || ''} @input=${(e: any) => this._updateRuleForm('metric_name', e.target.value)} placeholder="例如：cpu_usage" />
          </div>

          <div class="form-group">
            <label class="form-label">静默时长（分钟）</label>
            <input type="number" class="form-input" .value=${form.duration_minutes ?? 30} @input=${(e: any) => this._updateRuleForm('duration_minutes', Number(e.target.value))} />
          </div>

          <div class="form-actions">
            <button class="btn" @click=${() => this._closeSilenceModal()}>取消</button>
            <button class="btn primary" @click=${() => this._createSilence()}>创建</button>
          </div>
        </div>
      </div>
    `;
  }

  // ==================== Task 4: Baselines ====================

  async loadBaselines() {
    this.baselinesLoading = true;
    try {
      const instancesRes = await authFetch("/api/database/instances");
      if (instancesRes.ok) {
        const data = await instancesRes.json();
        this.instances = Array.isArray(data) ? data : (data.instances || []);
      }
      // Don't auto-compute — user clicks button to trigger
      this.baselines = [];
    } catch (err: any) {
      this.error = err.message;
    } finally {
      this.baselinesLoading = false;
    }
  }

  async _computeAllBaselines() {
    this.baselineComputing = true;
    this.requestUpdate();
    try {
      const res = await authFetch('/api/baseline/compute', {
        method: 'POST',
      });
      if (!res.ok) throw new Error('计算失败');
      const result = await res.json();
      const nameMap = new Map<number, string>();
      for (const inst of this.instances) {
        nameMap.set(inst.id, inst.name);
      }
      this.baselines = (result.results || []).map((r: any) => ({
        ...r,
        instance_name: nameMap.get(r.instanceId) || `实例#${r.instanceId}`,
      }));
    } catch (err: any) {
      this.error = err.message;
    } finally {
      this.baselineComputing = false;
      this.requestUpdate();
    }
  }

  private _renderBaselines() {
    if (this.baselinesLoading) return html`<div class="loading">加载基线数据...</div>`;
    // v2 — no icon, clean empty state

    return html`
      <div class="card" data-baseline-v="2">
        <div class="card-header">
          <span class="card-title">指标基线</span>
          <button class="btn primary" ?disabled=${this.baselineComputing} @click=${() => this._computeAllBaselines()}>
            ${this.baselineComputing ? html`${icons['loader']} 计算中...` : html`${icons['refresh']} 重新计算全部`}
          </button>
        </div>

        ${this.baselines.length > 0
          ? html`
              ${this.baselineComputing
                ? html`<div class="loading" style="min-height: 100px;">正在计算基线，请稍候...</div>`
                : html`
                    <div class="table-container">
                      <table class="table">
                        <thead>
                          <tr>
                            <th style="width:140px;text-align:center;">实例</th>
                            <th style="width:140px;text-align:center;">指标</th>
                            <th style="width:80px;text-align:center;">均值</th>
                            <th style="width:80px;text-align:center;">下限</th>
                            <th style="width:80px;text-align:center;">上限</th>
                            <th style="width:80px;text-align:center;">样本数</th>
                            <th style="width:160px;text-align:center;">计算时间</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${this.baselines.map((b: any) => html`
                            <tr>
                              <td style="text-align:center;">
                                ${b.instance_name
                                  ? html`<span class="instance-badge">${b.instance_name}</span>`
                                  : html`<span style="color:var(--muted);">实例 #${b.instanceId}</span>`
                                }
                              </td>
                              <td style="text-align:center;"><span class="type-badge">${b.metricName || '—'}</span></td>
                              <td style="text-align:center;">${typeof b.mean === 'number' ? b.mean.toFixed(2) : '—'}</td>
                              <td style="color:var(--info);text-align:center;">${typeof b.lowerBound === 'number' ? b.lowerBound.toFixed(2) : '—'}</td>
                              <td style="color:var(--warn);text-align:center;">${typeof b.upperBound === 'number' ? b.upperBound.toFixed(2) : '—'}</td>
                              <td style="text-align:center;">${b.sampleCount || '—'}</td>
                              <td style="font-size:var(--text-sm);color:var(--muted);text-align:center;">${b.computedAt ? new Date(b.computedAt).toLocaleString('zh-CN') : '—'}</td>
                            </tr>
                          `)}
                        </tbody>
                      </table>
                    </div>
                  `
              }
            `
          : html`
              <div style="text-align:center;padding:40px 20px;color:var(--muted);">
                <div style="font-size: var(--text-md);font-weight:500;margin-bottom:var(--space-sm);">暂无基线数据</div>
                <div style="font-size: var(--text-sm);">点击上方「重新计算全部」为所有实例计算指标基线</div>
              </div>
            `
        }

        ${html`
          <div style="padding: var(--space-lg); border-top: 1px solid var(--border); background: var(--bg-elevated);">
            <div style="font-size: var(--text-sm); color: var(--muted);">
              <span style="display:inline-flex;align-items:center;width:14px;height:14px;vertical-align:middle;flex-shrink:0;">${icons['info']}</span> 基线调度：每天凌晨 2 点自动计算 | 每周日凌晨 3 点清理过期基线（保留 30 天）
            </div>
          </div>
        `}
      </div>
    `;
  }
}

try { customElements.define("alerts-page", AlertsPage); } catch {}
