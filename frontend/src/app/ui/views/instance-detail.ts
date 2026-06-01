import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { icons, renderIcon } from "../../../icons.js";
import "../components/metric-chart.js";
import "./ai-analysis-result.js";
import "./schema-management.ts";
import "./index-management.ts";
import "./sql-audit-tab.js";
import "./database-log-tab.js";
import "./query-analysis-tab.js";
import "./health-score-tab.js";
import { authFetch } from "../../../api/index.js";

interface InstanceDetail {
  id: number;
  name: string;
  db_type: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  environment: string;
  description: string;
  health_status: "healthy" | "warning" | "critical" | "unknown";
  health_score: number;
  status: string;
  created_at: string;
  updated_at: string;
}

interface MetricsData {
  cpu_usage: number;
  memory_usage: number;
  disk_usage: number;
  connections: number;
  max_connections?: number;
  qps: number;
  tps: number;
  active_transactions: number;
  slow_queries: number;
  version?: string;
  uptime_seconds?: number;
  innodb_buffer_pool_hit_rate?: number;
  replication_lag?: number;
  replication_status?: string;
  // Oracle specific
  sga_size_mb?: number;
  pga_size_mb?: number;
  tablespace_usage_percent?: number;
  library_cache_hit_rate?: number;
  pga_cache_hit_rate?: number;
  shared_pool_hit_rate?: number;
  active_sessions?: number;
  enqueue_deadlocks?: number;
  // Custom metrics stored in metrics_data JSON column
  metrics_data?: Record<string, number>;
}

interface SlowQuery {
  id: string;
  sql_text: string;
  avg_time_ms: number;
  max_time_ms: number;
  execution_count: number;
  first_seen: string;
  last_seen: string;
}

interface Session {
  id: number;
  user: string;
  host: string;
  database: string;
  command: string;
  time_seconds: number;
  state: string;
  query: string | null;
}

interface CapacityInfo {
  total_size_gb: number;
  databases?: Array<{ name: string; size_gb: number; table_count?: number }>;
  tablespaces?: Array<{ name: string; size_gb: number; max_size_gb?: number; usage_percent?: number }>;
  top_tables: Array<{ name: string; size_gb: number; row_count?: number }>;
}

@customElement("instance-detail-page")
export class InstanceDetailPage extends LitElement {
  static override styles = css`
    :host {
      display: block;
      animation: fade-in 0.3s ease-out;
    }

    @keyframes fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .page {
      padding: 0 0 24px 0;
    }

    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--space-xl);
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: var(--space-lg);
    }

    .back-btn {
      display: inline-flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      font-size: var(--text-base);
      font-weight: 500;
      color: var(--text);
      background: var(--secondary);
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .back-btn:hover {
      background: var(--bg-hover);
      border-color: var(--border-strong);
    }

    .instance-title {
      font-size: var(--text-2xl);
      font-weight: 600;
      color: var(--text-strong);
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: var(--space-md);
    }

    .last-updated {
      font-size: var(--text-sm);
      color: var(--muted);
    }

    .refresh-toggle {
      display: inline-flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
      font-weight: 500;
      color: var(--text);
      background: var(--secondary);
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .refresh-toggle.active {
      background: var(--ok-subtle);
      border-color: var(--ok);
      color: var(--ok);
    }

    .refresh-btn {
      display: inline-flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--accent);
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
      font-weight: 500;
      color: var(--accent);
      background: transparent;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .refresh-btn:hover {
      background: var(--accent);
      color: var(--accent-foreground);
    }

    .refresh-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
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
      padding: 0 4px;
      background: var(--accent);
      color: var(--accent-foreground);
      border-radius: var(--radius-full);
      font-size: 10px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* Cards */
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
      margin-bottom: var(--space-lg);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--space-lg) var(--space-xl);
      border-bottom: 1px solid var(--border);
      background: var(--bg-elevated);
    }

    .card-title {
      font-size: var(--text-lg);
      font-weight: 600;
      color: var(--text-strong);
      display: flex;
      align-items: center;
      gap: var(--space-sm);
    }

    .card-title svg {
      width: 16px;
      height: 16px;
      opacity: 0.72;
    }

    .card-body {
      padding: var(--space-xl);
    }

    /* Status Badge */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-sm) var(--space-md);
      border-radius: var(--radius-full);
      font-size: var(--text-sm);
      font-weight: 600;
    }

    .status-badge.ok {
      background: var(--ok-subtle);
      color: var(--ok);
    }

    .status-badge.warn {
      background: var(--warn-subtle);
      color: var(--warn);
    }

    .status-badge.danger {
      background: var(--danger-subtle);
      color: var(--danger);
    }

    .status-badge.accent {
      background: var(--accent-subtle);
      color: var(--accent);
    }

    /* Overview */
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--space-lg);
    }

    .overview-item {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding: var(--space-lg);
      background: var(--bg-elevated);
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
      transition: all 0.15s ease;
    }

    .overview-item:hover {
      border-color: var(--border-strong);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
    }

    .overview-label {
      font-size: var(--text-sm);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }

    .overview-value {
      font-size: var(--text-lg);
      font-weight: 600;
      color: var(--text-strong);
    }

    .overview-value svg {
      width: 14px;
      height: 14px;
      vertical-align: -1px;
    }

    .overview-value.ok { color: var(--ok); }
    .overview-value.warn { color: var(--warn); }
    .overview-value.danger { color: var(--destructive); }

    /* Metrics Dashboard */
    .metrics-dashboard {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--space-lg);
      margin-bottom: var(--space-xl);
    }

    .metric-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: var(--space-xl);
      position: relative;
      overflow: hidden;
    }

    .metric-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: var(--accent);
    }

    .metric-card.cpu::before { background: var(--info); }
    .metric-card.memory::before { background: var(--warn); }
    .metric-card.disk::before { background: var(--destructive); }
    .metric-card.connections::before { background: var(--ok); }

    .metric-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: var(--space-md);
    }

    .metric-label {
      font-size: var(--text-sm);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .metric-trend {
      font-size: var(--text-xs);
      font-weight: 600;
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-sm);
    }

    .metric-trend.up {
      background: var(--ok-subtle);
      color: var(--ok);
    }

    .metric-trend.down {
      background: var(--danger-subtle);
      color: var(--danger);
    }

    .metric-value-row {
      display: flex;
      align-items: baseline;
      gap: var(--space-xs);
      margin-bottom: var(--space-md);
    }

    .metric-value {
      font-size: 28px;
      font-weight: 700;
      color: var(--text-strong);
    }

    .metric-unit {
      font-size: var(--text-base);
      color: var(--muted);
    }

    /* Sparkline */
    .sparkline {
      height: 40px;
      display: flex;
      align-items: flex-end;
      gap: var(--space-xs);
    }

    .sparkline-bar {
      flex: 1;
      background: var(--accent-subtle);
      border-radius: 1px;
      min-height: 2px;
      transition: height 0.3s ease;
    }

    .sparkline-bar:hover {
      background: var(--accent);
    }

    /* Progress Bar */
    .progress-bar {
      height: 8px;
      background: var(--bg-muted);
      border-radius: var(--radius-full);
      overflow: hidden;
      margin-top: var(--space-sm);
    }

    .progress-fill {
      height: 100%;
      border-radius: var(--radius-full);
      transition: width 0.5s ease;
    }

    .progress-fill.ok { background: linear-gradient(90deg, var(--ok), #22c55e); }
    .progress-fill.warn { background: linear-gradient(90deg, var(--warn), #f59e0b); }
    .progress-fill.danger { background: linear-gradient(90deg, var(--destructive), #ef4444); }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--space-lg);
    }

    .stat-box {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-lg);
      text-align: center;
    }

    .stat-value {
      font-size: var(--text-2xl);
      font-weight: 700;
      color: var(--text-strong);
      margin-bottom: var(--space-xs);
    }

    .stat-label {
      font-size: var(--text-sm);
      color: var(--muted);
    }

    /* Metric tooltip (08-01) */
    .stat-label-wrapper {
      position: relative;
      display: inline-block;
    }
    .stat-label-wrapper .metric-tooltip {
      display: none;
      position: absolute;
      bottom: calc(100% + 6px);
      left: 50%;
      transform: translateX(-50%);
      background: var(--card-bg, #1e1e2e);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: var(--space-sm) var(--space-md);
      font-size: var(--text-sm);
      max-width: 250px;
      z-index: 100;
      white-space: normal;
      text-align: left;
      color: var(--text, #cdd6f4);
      pointer-events: none;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
    .stat-label-wrapper .metric-tooltip::after {
      content: "";
      position: absolute;
      top: 100%;
      left: 50%;
      transform: translateX(-50%);
      border: 5px solid transparent;
      border-top-color: var(--border);
    }
    .stat-label-wrapper:hover .metric-tooltip,
    .stat-label-wrapper:focus-within .metric-tooltip {
      display: block;
    }
    .metric-tooltip-desc {
      display: block;
      margin-bottom: var(--space-xs);
    }
    .metric-tooltip-unit {
      display: block;
      font-size: var(--text-xs);
      opacity: 0.7;
    }

    /* Tables */
    .table-container {
      overflow-x: auto;
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
    }

    .table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: var(--text-base);
    }

    .table th {
      position: sticky;
      top: 0;
      z-index: 3;
      padding: var(--space-md) var(--space-lg);
      text-align: left;
      font-weight: 600;
      font-size: var(--text-xs);
      color: var(--muted);
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .table td {
      padding: var(--space-md) var(--space-lg);
      border-bottom: 1px solid var(--border);
      color: var(--text);
      vertical-align: middle;
    }

    .table tbody tr {
      transition: background 0.15s ease;
    }

    .table tbody tr:hover {
      background: var(--bg-hover);
    }

    .table tbody tr:last-child td {
      border-bottom: none;
    }

    /* SQL Code */
    .sql-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: var(--text-sm);
      background: var(--bg-elevated);
      padding: var(--space-md) var(--space-md);
      border-radius: var(--radius-sm);
      color: var(--text);
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      border: 1px solid var(--border);
    }

    .sql-code:hover {
      white-space: normal;
      word-break: break-all;
    }

    /* Capacity */
    .capacity-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
    }

    .capacity-item {
      display: flex;
      align-items: center;
      gap: var(--space-lg);
      padding: var(--space-md) var(--space-lg);
      background: var(--bg-elevated);
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
    }

    .capacity-icon {
      width: 40px;
      height: 40px;
      border-radius: var(--radius-md);
      background: var(--accent-subtle);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: var(--text-xl);
      color: var(--accent);
    }
    .capacity-icon svg {
      width: 18px;
      height: 18px;
    }

    .capacity-info {
      flex: 1;
      min-width: 0;
    }

    .capacity-name {
      font-size: var(--text-md);
      font-weight: 500;
      color: var(--text-strong);
      margin-bottom: var(--space-xs);
    }

    .capacity-meta {
      font-size: var(--text-sm);
      color: var(--muted);
    }

    .capacity-bar-wrap {
      width: 150px;
    }

    .capacity-percent {
      font-size: var(--text-sm);
      font-weight: 600;
      color: var(--text-strong);
      text-align: right;
      margin-bottom: var(--space-xs);
    }

    /* Loading & Empty */
    .loading, .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 300px;
      color: var(--muted);
    }

    .empty-state {
      text-align: center;
      padding: 60px var(--space-xl);
    }

    .empty-icon {
      font-size: 64px;
      margin-bottom: var(--space-lg);
      opacity: 0.5;
    }
    .empty-icon svg {
      width: 16px;
      height: 16px;
    }

    .empty-title {
      font-size: var(--text-lg);
      font-weight: 600;
      color: var(--text-strong);
      margin-bottom: var(--space-sm);
    }

    .empty-desc {
      font-size: var(--text-md);
      color: var(--muted);
    }

    /* Animations */
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .loading-pulse {
      animation: pulse 1.5s ease-in-out infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    /* Trend Period Buttons */
    .trend-period-btn {
      padding: var(--space-xs) var(--space-md);
      font-size: var(--text-sm);
      font-weight: 500;
      color: var(--muted);
      background: var(--secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .trend-period-btn:hover {
      color: var(--text);
      border-color: var(--border-strong);
    }

    .trend-period-btn.active {
      color: var(--accent);
      border-color: var(--accent);
      background: var(--accent-subtle);
    }

    .trend-period-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Diagnosis History */
    .diagnosis-history-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
    }

    .diagnosis-history-item {
      display: flex;
      align-items: center;
      gap: var(--space-md);
      padding: var(--space-sm) var(--space-md);
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .diagnosis-history-item:hover {
      background: var(--bg-hover);
    }

    .diagnosis-summary-text {
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: var(--text-sm);
      color: var(--text);
    }

    .diagnosis-time {
      font-size: var(--text-xs);
      color: var(--muted);
      white-space: nowrap;
      flex-shrink: 0;
    }

    .diagnosis-chevron {
      display: flex;
      align-items: center;
      color: var(--muted);
      flex-shrink: 0;
    }

    .diagnosis-chevron svg {
      width: 14px;
      height: 14px;
    }

    .diagnosis-close-btn {
      padding: var(--space-sm) var(--space-md);
      font-size: var(--text-sm);
      color: var(--muted);
      background: transparent;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .diagnosis-close-btn:hover {
      color: var(--text);
      border-color: var(--border-strong);
    }

    /* Modal */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: fade-in 0.2s ease;
    }

    .modal {
      background: var(--card);
      border-radius: var(--radius-lg);
      max-width: 720px;
      width: 90%;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      overflow: hidden;
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--space-xl);
      border-bottom: 1px solid var(--border);
      background: var(--bg-elevated);
    }

    .modal-title {
      font-size: var(--text-lg);
      font-weight: 600;
      color: var(--text-strong);
    }

    .modal-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      border-radius: var(--radius-sm);
      transition: all 0.15s ease;
    }

    .modal-close:hover {
      background: var(--bg-hover);
      color: var(--text);
    }

    .modal-body {
      padding: var(--space-xl);
      overflow-y: auto;
      flex: 1;
    }
  `;

  @state() private instanceId: number | null = null;
  @state() private instance: InstanceDetail | null = null;
  @state() private activeTab: "overview" | "metrics" | "topsql" | "trend" | "health" | "sessions" | "capacity" | "schema" | "indexes" | "sqlaudit" | "logs" | "qan" = "overview";
  @state() private loading = true;
  @state() private error: string | null = null;

  // Data states
  @state() private metrics: MetricsData | null = null;
  @state() private slowQueries: SlowQuery[] = [];
  @state() private sessions: Session[] = [];
  @state() private capacity: CapacityInfo | null = null;
  @state() private capHistory: { time: string[]; size: number[] } = { time: [], size: [] };
  @state() private overviewHistory: { time: string[]; metrics: Record<string, number[]> } | null = null;
  @state() private lastUpdated: Date | null = null;
  @state() private autoRefresh = true;
  @state() private isRefreshing = false;

  // Topsql loading state (pre-loaded on initial page load)
  @state() private topsqlLoading = false;

  // AI diagnosis states
  @state() private diagnosisStatus: "idle" | "running" | "completed" | "failed" = "idle";
  @state() private diagnosisResult: any = null;
  @state() private diagnosisError: string | null = null;
  private diagnosisPollTimer: ReturnType<typeof setInterval> | null = null;
  @state() private diagnosisPollingStart: number = 0;
  @state() private showDiagnosisResult = false;

  // Diagnosis history states
  @state() private diagnosisHistory: any[] = [];
  @state() private diagnosisHistoryLoading = false;
  @state() private activeDiagnosisRecord: any = null;
  @state() private showDiagnosisModal = false;

  // Trend chart states
  @state() private trendTab = "1h";
  @state() private trendLoading = false;
  @state() private trendData: { time: string[]; metrics: Record<string, number[]> } | null = null;
  @state() private trendLoaded = false;

  // Chart data history for sparklines
  @state() private metricsHistory: Record<string, number[]> = {};

  // Metric registry for tooltips and thresholds
  @state() private metricRegistry: Array<{
    id: string;
    name: string;
    description: string;
    unit: string;
    db_types?: string[];
    threshold_template?: { warning: number | string; error: number | string; critical: number | string };
    higher_is_worse?: boolean;
    is_collected: boolean;
    category?: string;
    value_type?: string;
  }> = [];

  private refreshTimer: number | null = null;
  private readonly REFRESH_INTERVAL = 30000; // 30 seconds

  override firstUpdated() {
    this.loadFromUrl();

    // Listen for navigation events
    window.addEventListener("slide-navigate", (e: any) => {
      if (e.detail.tab === "instance-detail" && e.detail.id) {
        this.instanceId = e.detail.id;
        this.activeTab = "overview";
        this.loadData();
      }
    });

    // Listen for popstate (browser back/forward)
    window.addEventListener("popstate", () => {
      this.loadFromUrl();
    });

    // Start auto refresh
    this.startAutoRefresh();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.stopAutoRefresh();
    this._stopDiagnosisPolling();
  }

  private loadFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    const id = urlParams.get("id");
    if (id) {
      this.instanceId = parseInt(id);
      this.loadData();
    }
  }

  private startAutoRefresh() {
    this.stopAutoRefresh();
    if (this.autoRefresh) {
      this.refreshTimer = window.setInterval(() => {
        if (document.visibilityState === "visible") {
          this.refreshCurrentTab();
        }
      }, this.REFRESH_INTERVAL);
    }
  }

  private stopAutoRefresh() {
    if (this.refreshTimer) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async loadData() {
    if (!this.instanceId) return;

    this.loading = true;
    this.error = null;

    try {
      const instanceRes = await authFetch(`/api/database/instances/${this.instanceId}`);
      if (!instanceRes.ok) throw new Error("获取实例详情失败");
      this.instance = await instanceRes.json();

      // Load diagnosis history
      this.loadDiagnosisHistory();

      await this.loadTabData();
    } catch (err: any) {
      this.error = err.message;
    } finally {
      this.loading = false;
      this.lastUpdated = new Date();
    }
  }

  private async refreshCurrentTab() {
    if (!this.instanceId || this.isRefreshing) return;

    this.isRefreshing = true;
    try {
      const instanceRes = await authFetch(`/api/database/instances/${this.instanceId}`);
      if (instanceRes.ok) {
        this.instance = await instanceRes.json();
      }

      await this.loadTabData();
      this.lastUpdated = new Date();
    } catch (err) {
      console.error("Refresh failed:", err);
    } finally {
      this.isRefreshing = false;
    }
  }

  private async loadTabData() {
    if (!this.instanceId) return;

    try {
      // Pre-load topsql data in background for badge consistency
      this._loadTopSqlData().catch(() => {});

      switch (this.activeTab) {
        case "overview":
        case "metrics":
          // Load metrics + history in parallel; registry loading is independent
          const [metricsRes, histRes] = await Promise.all([
            authFetch(`/api/database/instances/${this.instanceId}/metrics`),
            authFetch(`/api/database/instances/${this.instanceId}/metrics/history?period=24h&interval=1h`),
          ]);
          this.loadMetricRegistry(true).catch((e) => {
            console.warn('[InstanceDetail] Failed to load metric registry:', e);
          });
          if (metricsRes.ok) {
            const newMetrics = await metricsRes.json();
            this.updateMetricsHistory(newMetrics);
            this.metrics = newMetrics;
          }
          if (histRes.ok) {
            const hist = await histRes.json();
            this.overviewHistory = {
              time: hist.time || [],
              metrics: hist.metrics || {},
            };
          }
          break;
        case "topsql":
          const topsqlRes = await authFetch(`/api/database/instances/${this.instanceId}/topsql`);
          if (topsqlRes.ok) this.slowQueries = await topsqlRes.json();
          break;
        case "sessions":
          const sessionsRes = await authFetch(`/api/database/instances/${this.instanceId}/sessions`);
          if (sessionsRes.ok) this.sessions = await sessionsRes.json();
          break;
        case "capacity":
          const [capacityRes, capHistRes] = await Promise.all([
            authFetch(`/api/database/instances/${this.instanceId}/capacity`),
            authFetch(`/api/database/instances/${this.instanceId}/capacity/history?hours=168`),
          ]);
          if (capacityRes.ok) this.capacity = await capacityRes.json();
          if (capHistRes.ok) {
            const hist = await capHistRes.json();
            if (hist.history) {
              this.capHistory = {
                time: hist.history.map((h: any) => h.recorded_at?.substring(0, 16) || ""),
                size: hist.history.map((h: any) => h.total_size_gb || 0),
              };
            }
          }
          break;
        case "sqlaudit":
          // sql-audit-tab handles its own data loading
          break;
        case "logs":
          // database-log-tab handles its own data loading
          break;
      }
    } catch (err) {
      console.error("Failed to load tab data:", err);
    }
  }

  private async loadTrendData(period: string) {
    if (!this.instanceId) return;
    // Ensure registry is loaded so _filteredRegistry is populated
    if (this.metricRegistry.length === 0) {
      await this.loadMetricRegistry();
    }
    this.trendLoading = true;
    this.trendTab = period;
    try {
      const collected = this._filteredRegistry.filter(d => d.is_collected).map(d => d.id);
      const metricsParam = collected.length > 0 ? `&metrics=${collected.join(',')}` : '';
      const res = await authFetch(
        `/api/database/instances/${this.instanceId}/metrics/history?period=${period}&interval=5m${metricsParam}`
      );
      if (res.ok) {
        const data = await res.json();
        this.trendData = {
          time: data.time || [],
          metrics: data.metrics || {},
        };
        this.trendLoaded = true;
      }
    } catch (e) {
      console.error("Failed to load trend data:", e);
    }
    this.trendLoading = false;
  }

  private updateMetricsHistory(newMetrics: any) {
    const MAX_HISTORY = 20;
    const collected = this._filteredRegistry.filter(d => d.is_collected);
    for (const def of collected) {
      const value = newMetrics[def.id] ?? newMetrics.metrics_data?.[def.id];
      if (value != null) {
        if (!this.metricsHistory[def.id]) this.metricsHistory[def.id] = [];
        this.metricsHistory[def.id] = [
          ...this.metricsHistory[def.id].slice(-(MAX_HISTORY - 1)),
          Number(value),
        ];
      }
    }
  }

  // ---- Metric Registry Helpers (08-01) ----

  /** Filtered registry: only entries matching the current instance's db_type */
  private get _filteredRegistry() {
    const dbType = this.instance?.db_type;
    if (!dbType) return this.metricRegistry;
    return this.metricRegistry.filter(
      (def) => !def.db_types || def.db_types.length === 0 || def.db_types.includes(dbType),
    );
  }

  /** Fetch metric registry from API. Safe to call multiple times. */
  private async loadMetricRegistry(force = false) {
    if (!force && this.metricRegistry.length > 0) return; // already loaded
    try {
      const res = await authFetch("/api/metrics/registry");
      if (res.ok) {
        this.metricRegistry = await res.json();
      }
    } catch (e) {
      console.warn("Failed to load metric registry, tooltips will not be available:", e);
    }
  }

  /** Look up a metric definition by key (id or name). */
  private _getMetricDef(metricKey: string) {
    const key = metricKey.toLowerCase().replace(/[-\s]+/g, "_");
    return this._filteredRegistry.find(
      (d) => d.id.toLowerCase().replace(/[-\s]+/g, "_") === key ||
             d.name.toLowerCase().replace(/[-\s]+/g, "_") === key,
    );
  }

  /** Render a stat box with optional tooltip from the metric registry. */
  private _renderStatBox(value: number | string, color: string, label: string, metricId?: string) {
    const def = metricId ? this._filteredRegistry.find(
      (d) => d.id.toLowerCase() === metricId.toLowerCase(),
    ) : this._getMetricDef(label);
    const tooltipContent = def
      ? html`<span class="metric-tooltip-desc">${def.description}</span><span class="metric-tooltip-unit">unit: ${def.unit}</span>`
      : null;

    return html`
      <div class="stat-box">
        <div class="stat-value" style="color: ${color};">${value}</div>
        <div class="stat-label-wrapper" tabindex="0" role="button" aria-label="查看 ${label} 指标详情">
          <span class="stat-label">${label}</span>
          ${tooltipContent ? html`<div class="metric-tooltip">${tooltipContent}</div>` : ""}
        </div>
      </div>
    `;
  }

  // ---- Threshold Helpers (08-02) ----

  /** Parse a threshold value: handles raw numbers from backend or expression strings like ">= 80". */
  private _parseThresholdValue(expr: number | string): number | null {
    if (typeof expr === "number") return expr;
    const match = expr.match(/^\s*[><=!]*\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
    if (!match) return null;
    return parseFloat(match[1]);
  }

  /** Resolve CSS variable color names to hex for ECharts. */
  private _resolveColor(color: string): string {
    const cssVarMap: Record<string, string> = {
      "var(--warn)": "#f59e0b",
      "var(--danger)": "#ef4444",
      "var(--muted)": "#94a3b8",
    };
    return cssVarMap[color] || color;
  }

  /** Build threshold array for a given metric ID from the registry. */
  private _buildThresholds(metricId: string): Array<{ name: string; value: number; color: string }> {
    const def = this._filteredRegistry.find(
      (d) => d.id.toLowerCase().replace(/[-\s]+/g, "_") === metricId.toLowerCase().replace(/[-\s]+/g, "_"),
    );
    if (!def?.threshold_template) return [];

    const colorMap: Record<string, string> = {
      warning: "var(--warn)",
      error: "var(--danger)",
      critical: "#8b5cf6",
    };

    const result: Array<{ name: string; value: number; color: string }> = [];
    for (const [level, expr] of Object.entries(def.threshold_template)) {
      const value = this._parseThresholdValue(expr);
      if (value !== null) {
        result.push({
          name: level,
          value,
          color: this._resolveColor(colorMap[level] || "var(--muted)"),
        });
      }
    }
    return result;
  }

  /** Assign a consistent color to a metric ID using hash-based palette. */
  private _getChartColor(metricId: string): string {
    const palette = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
    let hash = 0;
    for (let i = 0; i < metricId.length; i++) {
      hash = ((hash << 5) - hash) + metricId.charCodeAt(i);
      hash |= 0;
    }
    return palette[Math.abs(hash) % palette.length];
  }

  /** Get color for a metric value based on threshold levels. */
  private _getMetricColor(value: number, metricDef?: { threshold_template?: Record<string, number | string>; higher_is_worse?: boolean }): string {
    if (!metricDef?.threshold_template) {
      return value > 80 ? 'var(--destructive)' : value > 60 ? 'var(--warn)' : 'var(--text-strong)';
    }
    const tpl = metricDef.threshold_template;
    // higher_is_worse: true (default) -> use >=, false -> use <=
    const higherIsWorse = metricDef.higher_is_worse ?? true;
    const exceeds = higherIsWorse
      ? (v: number, t: number) => v >= t
      : (v: number, t: number) => v <= t;
    // Check order: critical -> error -> warning
    if (tpl.critical != null) {
      const cv = this._parseThresholdValue(tpl.critical);
      if (cv !== null && exceeds(value, cv)) return 'var(--destructive)';
    }
    if (tpl.error != null) {
      const ev = this._parseThresholdValue(tpl.error);
      if (ev !== null && exceeds(value, ev)) return 'var(--destructive)';
    }
    if (tpl.warning != null) {
      const wv = this._parseThresholdValue(tpl.warning);
      if (wv !== null && exceeds(value, wv)) return 'var(--warn)';
    }
    return 'var(--text-strong)';
  }

  /** Get progress bar CSS class for a metric value. */
  private _getProgressClass(value: number, metricDef?: { threshold_template?: Record<string, number | string>; higher_is_worse?: boolean }): string {
    if (!metricDef?.threshold_template) {
      return value > 80 ? 'danger' : value > 60 ? 'warn' : 'ok';
    }
    const tpl = metricDef.threshold_template;
    // higher_is_worse: true (default) -> use >=, false -> use <=
    const higherIsWorse = metricDef.higher_is_worse ?? true;
    const exceeds = higherIsWorse
      ? (v: number, t: number) => v >= t
      : (v: number, t: number) => v <= t;
    if (tpl.critical != null) {
      const cv = this._parseThresholdValue(tpl.critical);
      if (cv !== null && exceeds(value, cv)) return 'danger';
    }
    if (tpl.error != null) {
      const ev = this._parseThresholdValue(tpl.error);
      if (ev !== null && exceeds(value, ev)) return 'danger';
    }
    if (tpl.warning != null) {
      const wv = this._parseThresholdValue(tpl.warning);
      if (wv !== null && exceeds(value, wv)) return 'warn';
    }
    return 'ok';
  }

  private _goBack() {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "instances-db");
    url.searchParams.delete("id");
    window.history.pushState({}, "", url);
    window.dispatchEvent(new CustomEvent("slide-navigate", { detail: { tab: "instances-db" } }));
  }

  private _setTab(tab: typeof this.activeTab) {
    this.activeTab = tab;
    this.loadTabData();
    if (tab === "trend" && !this.trendLoaded) {
      this.loadTrendData(this.trendTab);
    }
  }

  private _toggleAutoRefresh() {
    this.autoRefresh = !this.autoRefresh;
    this.startAutoRefresh();
  }

  private async _manualRefresh() {
    await this.refreshCurrentTab();
  }

  /** Pre-load topsql data in background for badge consistency. */
  private async _loadTopSqlData() {
    if (!this.instanceId) return;
    this.topsqlLoading = true;
    try {
      const res = await authFetch(`/api/database/instances/${this.instanceId}/topsql`);
      if (res.ok) this.slowQueries = await res.json();
    } catch {
      // Silently ignore preload errors; data will be fetched on tab click
    } finally {
      this.topsqlLoading = false;
    }
  }

  private async _startDiagnosis() {
    if (!this.instanceId || this.diagnosisStatus === "running") return;

    try {
      const res = await authFetch("/api/ai/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysis_type: "fault_diagnosis",
          instance_id: this.instanceId,
          trigger_type: "manual",
        }),
      });

      if (!res.ok) throw new Error("提交诊断失败");

      const data = await res.json();
      this.diagnosisStatus = "running";
      this.diagnosisError = null;
      this.showDiagnosisResult = true;
      this._startDiagnosisPolling(data.id);
    } catch (err: any) {
      this.diagnosisStatus = "failed";
      this.diagnosisError = err.message || "提交诊断失败";
      this.showDiagnosisResult = true;
    }
  }

  private _startDiagnosisPolling(analysisId: number) {
    this._stopDiagnosisPolling();
    this.diagnosisPollingStart = Date.now();
    this.diagnosisPollTimer = setInterval(async () => {
      try {
        // Check total polling duration -- timeout after 5 minutes
        const elapsed = Date.now() - this.diagnosisPollingStart;
        if (elapsed > 5 * 60 * 1000) {
          this._stopDiagnosisPolling();
          this.diagnosisStatus = "failed";
          this.diagnosisError = "诊断超时，请重试";
          return;
        }

        const res = await authFetch(`/api/ai/analysis/${analysisId}/status`);
        if (!res.ok) return;
        const data = await res.json();

        if (data.status === "completed") {
          this.diagnosisStatus = "completed";
          const fullRes = await authFetch(`/api/ai/analysis/${analysisId}`);
          if (fullRes.ok) {
            const fullData = await fullRes.json();
            this.diagnosisResult = fullData.result || fullData;
          }
          this._stopDiagnosisPolling();
          // Refresh diagnosis history to include the new result
          this.loadDiagnosisHistory();
        } else if (data.status === "failed") {
          this.diagnosisStatus = "failed";
          this.diagnosisError = data.error_message || "诊断失败";
          this._stopDiagnosisPolling();
        }
      } catch {
        // Ignore polling errors, next poll will retry
      }
    }, 3000);
  }

  private _stopDiagnosisPolling() {
    if (this.diagnosisPollTimer) {
      clearInterval(this.diagnosisPollTimer);
      this.diagnosisPollTimer = null;
    }
  }

  // ---- Diagnosis History ----

  private async loadDiagnosisHistory() {
    if (!this.instanceId) return;
    this.diagnosisHistoryLoading = true;
    try {
      const res = await authFetch(`/api/ai/analysis/recent?instance_id=${this.instanceId}&analysis_type=fault_diagnosis&limit=5`);
      if (res.ok) {
        this.diagnosisHistory = await res.json();
      }
    } catch (err) {
      console.warn('[InstanceDetail] loadDiagnosisHistory failed:', err);
    } finally {
      this.diagnosisHistoryLoading = false;
    }
  }

  private _formatDiagnosisTime(dateStr: string): string {
    const date = new Date(dateStr);
    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return "刚刚";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} 分钟前`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour} 小时前`;
    const diffDay = Math.floor(diffHour / 24);
    if (diffDay < 7) return `${diffDay} 天前`;
    return date.toLocaleDateString("zh-CN");
  }

  private _closeDiagnosisModal() {
    this.showDiagnosisModal = false;
    this.activeDiagnosisRecord = null;
  }

  private _getStatusBadge(status: string) {
    const statusMap: Record<string, { class: string; label: string }> = {
      healthy: { class: "ok", label: "健康" },
      warning: { class: "warn", label: "警告" },
      critical: { class: "danger", label: "异常" },
      unknown: { class: "warn", label: "未知" },
    };
    const s = statusMap[status] || { class: "warn", label: status };
    return html`<span class="status-badge ${s.class}">${s.label}</span>`;
  }

  private _formatTimeAgo(date: Date | null): string {
    if (!date) return "从未更新";
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return "刚刚更新";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    return `${Math.floor(seconds / 3600)} 小时前`;
  }

  private _renderSparkline(data: number[], color: string) {
    if (data.length < 2) return html`<div style="height:40px"></div>`;
    const labels = data.map((_, i) => String(i));
    return html`
      <metric-chart
        compact
        height="40px"
        .timeData=${labels}
        .series=${[{ name: "", data, color }]}
      ></metric-chart>
    `;
  }

  private _renderDiagnosisHistory() {
    if (this.diagnosisHistoryLoading) {
      return html`
        <div class="card" style="margin-bottom: var(--space-lg);">
          <div class="card-header">
            <span class="card-title">AI 诊断历史</span>
          </div>
          <div class="card-body" style="display:flex;align-items:center;justify-content:center;gap:10px;padding:40px;color:var(--muted);">
            <div class="spinner"></div>
            <span>加载中...</span>
          </div>
        </div>
      `;
    }

    return html`
      <div class="card" style="margin-bottom: var(--space-lg);">
        <div class="card-header">
          <span class="card-title">AI 诊断历史</span>
          <span style="font-size: var(--text-xs); color: var(--muted);">最近 ${this.diagnosisHistory.length} 条</span>
        </div>
        <div class="card-body">
          ${this.diagnosisHistory.length === 0 ? html`
            <div style="text-align:center;padding:40px 0;color:var(--muted);">
              <div style="margin-bottom:8px;width:32px;height:32px;margin-left:auto;margin-right:auto;color:var(--muted);">${icons['zap']}</div>
              <div style="font-size:var(--text-md);">暂无诊断记录</div>
            </div>
          ` : html`
            <div class="diagnosis-history-list">
              ${this.diagnosisHistory.map((record: any) => {
                const statusStyle = record.status === "completed"
                  ? { cls: "ok", label: "已完成" }
                  : record.status === "failed"
                    ? { cls: "danger", label: "分析失败" }
                    : { cls: "accent", label: "进行中" };
                const raw = typeof record.result === 'string' ? record.result : "";
                const summaryText = raw.replace(/^#+\s*/gm, "").trim().substring(0, 80);
                const timeStr = this._formatDiagnosisTime(record.updated_at || record.created_at);
                return html`
                  <div class="diagnosis-history-item" @click=${() => { this.activeDiagnosisRecord = record; this.showDiagnosisModal = true; }}>
                    <span class="status-badge ${statusStyle.cls}" style="font-size:var(--text-xs);padding:2px 8px;flex-shrink:0;">${statusStyle.label}</span>
                    <span class="diagnosis-time">${timeStr}</span>
                    <span class="diagnosis-summary-text" title="${summaryText}">${summaryText}${raw.length > 80 ? "..." : ""}</span>
                    <span class="diagnosis-chevron">${icons['chevron-right']}</span>
                  </div>
                `;
              })}
            </div>
          `}
        </div>
      </div>
    `;
  }

  private _renderDiagnosisModal() {
    if (!this.showDiagnosisModal || !this.activeDiagnosisRecord) return html``;

    const record = this.activeDiagnosisRecord;

    return html`
      <div class="modal-overlay" tabindex="0" @click=${(e: MouseEvent) => { if (e.target === e.currentTarget) this._closeDiagnosisModal(); }} @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") this._closeDiagnosisModal(); }}>
        <div class="modal" @click=${(e: Event) => e.stopPropagation()}>
          <div class="modal-header">
            <span class="modal-title">AI 诊断结果</span>
            <button class="modal-close" @click=${this._closeDiagnosisModal} aria-label="关闭">${icons['x']}</button>
          </div>
          <div class="modal-body">
            <ai-analysis-result
              .result=${record.result || null}
              analysisType="fault_diagnosis"
              triggerType=${record.trigger_type || "manual"}
              status=${record.status || "completed"}
              .errorMessage=${record.error_message || null}
              title="AI 诊断结果"
            ></ai-analysis-result>
          </div>
        </div>
      </div>
    `;
  }

  override render() {
    if (this.loading && !this.instance) {
      return html`<div class="loading loading-pulse">加载中...</div>`;
    }

    if (this.error) {
      return html`
        <div class="empty">
          <div class="empty-state">
            <div class="empty-icon">❌</div>
            <div class="empty-title">加载失败</div>
            <div class="empty-desc">${this.error}</div>
          </div>
        </div>
      `;
    }

    if (!this.instance) {
      return html`
        <div class="empty">
          <div class="empty-state">
            <div class="empty-icon">${icons['file-text']}</div>
            <div class="empty-title">实例不存在</div>
          </div>
        </div>
      `;
    }

    return html`
      <div class="page">
        <div class="header">
          <div class="header-left">
            <button class="back-btn" @click=${this._goBack}>← 返回列表</button>
            <span class="instance-title">${this.instance.name}</span>
            ${this._getStatusBadge(this.instance.health_status)}
          </div>
          <div class="header-right">
            <span class="last-updated">${this._formatTimeAgo(this.lastUpdated)}</span>
            <button class="refresh-btn"
              @click=${() => this._startDiagnosis()}
              ?disabled=${this.diagnosisStatus === "running" || this.isRefreshing}
              style="${this.diagnosisStatus === "running" ? "border-color: var(--warn); color: var(--warn);" : "border-color: var(--accent); color: var(--accent);"}">
              ${this.diagnosisStatus === "running" ? "诊断中..." : "一键诊断"}
            </button>
            <button class="refresh-btn" @click=${this._manualRefresh} ?disabled=${this.isRefreshing}>
              ${this.isRefreshing ? "⟳" : "↻"} 刷新
            </button>
          </div>
        </div>

        ${this._renderDiagnosisHistory()}

        <div class="tabs">
          <button class="tab ${this.activeTab === "overview" ? "active" : ""}" @click=${() => this._setTab("overview")}>
            概览
          </button>
          <button class="tab ${this.activeTab === "metrics" ? "active" : ""}" @click=${() => this._setTab("metrics")}>
            实时监控
          </button>
          <button class="tab ${this.activeTab === "topsql" ? "active" : ""}" @click=${() => this._setTab("topsql")}>
            慢查询
            ${this.slowQueries.length > 0 ? html`<span class="tab-badge">${this.slowQueries.length}</span>` : ""}
          </button>
          <button class="tab ${this.activeTab === "trend" ? "active" : ""}" @click=${() => this._setTab("trend")}>
            趋势
          </button>
          <button class="tab ${this.activeTab === "health" ? "active" : ""}" @click=${() => this._setTab("health")}>
            健康评分
          </button>
          <button class="tab ${this.activeTab === "sessions" ? "active" : ""}" @click=${() => this._setTab("sessions")}>
            会话
            ${this.sessions.length > 0 ? html`<span class="tab-badge">${this.sessions.length}</span>` : ""}
          </button>
          <button class="tab ${this.activeTab === "capacity" ? "active" : ""}" @click=${() => this._setTab("capacity")}>
            容量
          </button>
          <button class="tab ${this.activeTab === "schema" ? "active" : ""}" @click=${() => this._setTab("schema")}>
            表结构
          </button>
          <button class="tab ${this.activeTab === "indexes" ? "active" : ""}" @click=${() => this._setTab("indexes")}>
            索引
          </button>
          <button class="tab ${this.activeTab === "sqlaudit" ? "active" : ""}" @click=${() => this._setTab("sqlaudit")}>
            SQL 审核
          </button>
          <button class="tab ${this.activeTab === "logs" ? "active" : ""}" @click=${() => this._setTab("logs")}>
            日志
          </button>
          <button class="tab ${this.activeTab === "qan" ? "active" : ""}" @click=${() => this._setTab("qan")}>
            查询分析
          </button>
        </div>

        ${this._renderDiagnosisCard()}

        ${this._renderTabContent()}

        ${this._renderDiagnosisModal()}
      </div>
    `;
  }

  private _renderDiagnosisCard() {
    if (this.diagnosisStatus === "idle" && !this.showDiagnosisResult) return html``;

    return html`
      <div class="card" style="margin-bottom: var(--space-lg);">
        <div class="card-body" style="padding:0;">
          <ai-analysis-result
            .result=${typeof this.diagnosisResult === 'string' ? this.diagnosisResult : (this.diagnosisResult?.result || null)}
            analysisType="fault_diagnosis"
            triggerType="manual"
            .loading=${this.diagnosisStatus === "running"}
            status=${this.diagnosisStatus}
            .errorMessage=${this.diagnosisError}
            title="AI 诊断结果"
          ></ai-analysis-result>
          ${this.diagnosisStatus !== "running" ? html`
            <div style="text-align:center;padding:var(--space-md);border-top:1px solid var(--border);">
              <button class="diagnosis-close-btn" @click=${() => { this.showDiagnosisResult = false; this.diagnosisStatus = "idle"; }}>关闭</button>
            </div>
          ` : nothing}
        </div>
      </div>
    `;
  }

  private _renderTabContent() {
    switch (this.activeTab) {
      case "overview":
        return this._renderOverview();
      case "metrics":
        return this._renderMetrics();
      case "topsql":
        return this._renderTopSQL();
      case "trend":
        return this._renderTrend();
      case "health":
        return html`<health-score-tab .instanceId=${this.instanceId}></health-score-tab>`;
      case "sessions":
        return this._renderSessions();
      case "capacity":
        return this._renderCapacity();
      case "schema":
        return html`<schema-management-page .instanceId=${this.instanceId}></schema-management-page>`;
      case "indexes":
        return html`<index-management-page .instanceId=${this.instanceId}></index-management-page>`;
      case "sqlaudit":
        return this._renderSqlAuditTab();
      case "logs":
        return html`<database-log-tab .instanceId=${this.instanceId}></database-log-tab>`;
      case "qan":
        return html`<query-analysis-tab .instanceId=${this.instanceId}></query-analysis-tab>`;
      default:
        return this._renderOverview();
    }
  }

  private _renderOverview() {
    const inst = this.instance!;
    const envLabels: Record<string, string> = {
      development: "开发环境",
      testing: "测试环境",
      staging: "预发布环境",
      production: "生产环境",
    };

    return html`
      <div class="card">
        <div class="card-header">
          <span class="card-title">${icons['database']} 实例信息</span>
        </div>
        <div class="card-body">
          <div class="overview-grid">
            <div class="overview-item">
              <span class="overview-label">数据库类型</span>
              <span class="overview-value">${inst.db_type.toUpperCase()}</span>
            </div>
            <div class="overview-item">
              <span class="overview-label">主机地址</span>
              <span class="overview-value">${inst.host}:${inst.port}</span>
            </div>
            <div class="overview-item">
              <span class="overview-label">数据库名</span>
              <span class="overview-value">${inst.database_name || "—"}</span>
            </div>
            <div class="overview-item">
              <span class="overview-label">环境</span>
              <span class="overview-value">${envLabels[inst.environment || "development"] || inst.environment}</span>
            </div>
            <div class="overview-item">
              <span class="overview-label">用户名</span>
              <span class="overview-value">${inst.username || "—"}</span>
            </div>
            <div class="overview-item">
              <span class="overview-label">健康评分</span>
              <span class="overview-value ${inst.health_score >= 80 ? "ok" : inst.health_score >= 60 ? "warn" : "danger"}">
                ${inst.health_score} / 100
              </span>
            </div>
            <div class="overview-item">
              <span class="overview-label">运行状态</span>
              <span class="overview-value">${inst.status === "active" ? html`${icons['check-circle']} 活跃` : html`${icons['pause']} 停用`}</span>
            </div>
            <div class="overview-item">
              <span class="overview-label">创建时间</span>
              <span class="overview-value">${new Date(inst.created_at).toLocaleDateString("zh-CN")}</span>
            </div>
            ${inst.db_type === 'oracle' && this.metrics ? html`
              ${this.metrics.version ? html`
                <div class="overview-item">
                  <span class="overview-label">Oracle 版本</span>
                  <span class="overview-value" style="font-size: var(--text-sm); word-break: break-all;">${this.metrics.version}</span>
                </div>
              ` : ''}
              ${this.metrics.sga_size_mb ? html`
                <div class="overview-item">
                  <span class="overview-label">SGA 大小</span>
                  <span class="overview-value">${this.metrics.sga_size_mb} MB</span>
                </div>
              ` : ''}
              ${this.metrics.pga_size_mb ? html`
                <div class="overview-item">
                  <span class="overview-label">PGA 大小</span>
                  <span class="overview-value">${this.metrics.pga_size_mb} MB</span>
                </div>
              ` : ''}
              ${this.metrics.tablespace_usage_percent != null ? html`
                <div class="overview-item">
                  <span class="overview-label">表空间使用率</span>
                  <span class="overview-value ${this.metrics.tablespace_usage_percent >= 90 ? 'danger' : this.metrics.tablespace_usage_percent >= 80 ? 'warn' : 'ok'}">
                    ${(this.metrics.tablespace_usage_percent ?? 0).toFixed(1)}%
                  </span>
                </div>
              ` : ''}
            ` : ''}
          </div>

          ${inst.description ? html`
            <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--border);">
              <span class="overview-label">描述</span>
              <p style="margin: 8px 0 0 0; font-size: var(--text-md); color: var(--text); line-height: 1.6;">${inst.description}</p>
            </div>
          ` : ""}
        </div>
      </div>

      ${this.metrics ? html`
        <div class="card">
          <div class="card-header">
            <span class="card-title">${icons['trending-up']} 实时指标</span>
          </div>
          <div class="card-body">
            <div class="stats-grid">
              ${this._renderStatBox(this.metrics.qps, "var(--info)", "QPS", "qps")}
              ${this._renderStatBox(this.metrics.tps, "var(--warn)", "TPS", "tps")}
              ${this._renderStatBox(this.metrics.connections, "var(--ok)", "活跃连接", "connections")}
            </div>
            ${this.overviewHistory && this.overviewHistory.time.length > 0 ? html`
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:var(--space-lg)">
                ${this._filteredRegistry.filter(d => d.is_collected).slice(0, 4).map(def => {
                  const data = this.overviewHistory!.metrics[def.id];
                  if (!data || data.length === 0) return nothing;
                  return html`
                    <metric-chart compact height="60px"
                      .timeData=${this.overviewHistory!.time}
                      .series=${[{ name: def.name, data, color: this._getChartColor(def.id) }]}
                    ></metric-chart>
                  `;
                })}
              </div>
            ` : nothing}
          </div>
        </div>
      ` : ""}
    `;
  }

  /** Render dynamic metric cards, grouped by category, from _filteredRegistry. */
  private _renderDynamicMetrics() {
    const collected = this._filteredRegistry.filter(d => d.is_collected);
    if (collected.length === 0) {
      return html`
        <div class="card">
          <div class="card-body">
            <div class="empty-state">
              <div class="empty-icon">${icons['monitor']}</div>
              <div class="empty-title">暂无监控数据</div>
              <div class="empty-desc">暂无已采集的指标</div>
            </div>
          </div>
        </div>
      `;
    }

    // Group by category
    const groups = new Map<string, typeof collected>();
    for (const def of collected) {
      const cat = def.category || '通用';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(def);
    }

    return html`
      ${Array.from(groups.entries()).map(([category, defs]) => html`
        <div class="card">
          <div class="card-header">
            <span class="card-title">${icons['bar-chart']} ${category}</span>
          </div>
          <div class="card-body">
            <div class="metrics-dashboard">
              ${defs.map(def => this._renderDynamicCard(def))}
            </div>
          </div>
        </div>
      `)}
    `;
  }

  /** Render a single dynamic metric card with value, sparkline, and optional progress bar. */
  private _renderDynamicCard(def: { id: string; name: string; unit: string; threshold_template?: Record<string, number | string>; higher_is_worse?: boolean }) {
    const value = this.metrics?.[def.id] ?? this.metrics?.metrics_data?.[def.id];

    if (value == null) {
      const chartColor = this._getChartColor(def.id);
      return html`
        <div class="metric-card" style="opacity:0.5;">
          <div class="metric-header">
            <span class="metric-label">${def.name}</span>
          </div>
          <div class="metric-value-row">
            <span class="metric-value" style="color:var(--muted);font-size:16px;">暂无数据</span>
          </div>
          ${this.metricsHistory[def.id]?.length >= 2
            ? this._renderSparkline(this.metricsHistory[def.id], chartColor)
            : html`<div style="height:40px"></div>`}
        </div>
      `;
    }

    const val = Number(value);
    const chartColor = this._getChartColor(def.id);
    const sparklineData = this.metricsHistory[def.id] || [];
    const isPercent = def.unit === '%';

    return html`
      <div class="metric-card">
        <div class="metric-header">
          <span class="metric-label">${def.name}</span>
        </div>
        <div class="metric-value-row">
          <span class="metric-value" style="color: ${this._getMetricColor(val, def)};">${val.toFixed(1)}</span>
          <span class="metric-unit">${def.unit}</span>
        </div>
        ${sparklineData.length >= 2 ? this._renderSparkline(sparklineData, chartColor) : html`<div style="height:40px"></div>`}
        ${isPercent ? html`
          <div class="progress-bar">
            <div class="progress-fill ${this._getProgressClass(val, def)}" style="width: ${Math.min(val, 100)}%"></div>
          </div>
        ` : ''}
      </div>
    `;
  }

  private _renderMetrics() {
    if (!this.metrics) {
      return html`
        <div class="card">
          <div class="card-body">
            <div class="empty-state">
              <div class="empty-icon">${icons['monitor']}</div>
              <div class="empty-title">暂无监控数据</div>
              <div class="empty-desc">实例可能未连接或暂无数据</div>
            </div>
          </div>
        </div>
      `;
    }
    return this._renderDynamicMetrics();
  }

  /** Render dynamic trend charts from _filteredRegistry. */
  private _renderDynamicTrend() {
    const periods = [
      { key: "1h", label: "1小时" },
      { key: "6h", label: "6小时" },
      { key: "24h", label: "24小时" },
      { key: "7d", label: "7天" },
    ];

    return html`
      <div class="card">
        <div class="card-header">
          <span class="card-title">${icons['trending-up']} 指标趋势</span>
          <div style="display: flex; gap: var(--space-xs);">
            ${periods.map(p => html`
              <button class="trend-period-btn ${this.trendTab === p.key ? 'active' : ''}"
                @click=${() => this.loadTrendData(p.key)}
                ?disabled=${this.trendLoading}>${p.label}</button>
            `)}
          </div>
        </div>
        <div class="card-body">
          ${this.trendLoading
            ? html`<div class="loading loading-pulse">加载趋势数据...</div>`
            : !this.trendData || this.trendData.time.length === 0
              ? html`<div class="empty-state">
                  <div class="empty-icon">${icons['bar-chart']}</div>
                  <div class="empty-title">暂无趋势数据</div>
                  <div class="empty-desc">当前时间范围内没有采集到指标数据</div>
                </div>`
              : html`
                  ${this._filteredRegistry
                    .filter(d => d.is_collected)
                    .map(def => {
                      const data = this.trendData!.metrics[def.id];
                      if (!data || data.length === 0) {
                        return html`
                          <div class="card" style="margin-bottom: var(--space-md);">
                            <div class="card-body" style="text-align:center;padding:20px;color:var(--muted);">
                              <div class="empty-title">${def.name} — 暂无趋势数据</div>
                            </div>
                          </div>`;
                      }
                      return html`
                        <div style="margin-bottom: 16px;">
                          <metric-chart
                            title="${def.name} (${def.unit})"
                            .timeData=${this.trendData!.time}
                            .series=${[{ name: def.name, data, color: this._getChartColor(def.id) }]}
                            .thresholds=${this._buildThresholds(def.id)}
                            percentage=${def.unit === '%'}
                            height="280px"
                            yAxisLabel=${def.unit}
                          ></metric-chart>
                        </div>`;
                    })}
                `}
        </div>
      </div>
    `;
  }

  private _renderTrend() {
    return this._renderDynamicTrend();
  }

  private _renderTopSQL() {
    if (this.topsqlLoading) {
      return html`
        <div class="card">
          <div class="loading loading-pulse" style="min-height: 200px;">加载慢查询数据...</div>
        </div>
      `;
    }
    if (this.slowQueries.length === 0) {
      return html`
        <div class="card">
          <div class="empty-state">
            <div class="empty-icon">${icons['party-popper']}</div>
            <div class="empty-title">暂无慢查询</div>
            <div class="empty-desc">数据库运行良好，未发现慢查询</div>
          </div>
        </div>
      `;
    }

    return html`
      <div class="card">
        <div class="card-header">
          <span class="card-title">${icons['clock']} 慢查询列表（Top ${this.slowQueries.length}）</span>
        </div>
        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>SQL 语句</th>
                <th style="width: 100px; text-align:center;">平均耗时</th>
                <th style="width: 100px; text-align:center;">最大耗时</th>
                <th style="width: 90px; text-align:center;">执行次数</th>
                <th style="width: 140px; text-align:center;">最后出现</th>
                <th style="width: 80px; text-align:center;">操作</th>
              </tr>
            </thead>
            <tbody>
              ${this.slowQueries.map((q) => html`
                <tr>
                  <td><div class="sql-code" title="${q.sql_text}">${q.sql_text.substring(0, 80)}${q.sql_text.length > 80 ? "..." : ""}</div></td>
                  <td style="text-align:center;"><span style="color: ${Number(q.avg_time_ms) > 1000 ? 'var(--destructive)' : Number(q.avg_time_ms) > 100 ? 'var(--warn)' : 'var(--ok)'}; font-weight: 600;">${Number(q.avg_time_ms).toFixed(2)} ms</span></td>
                  <td style="text-align:center;">${Number(q.max_time_ms).toFixed(2)} ms</td>
                  <td style="text-align:center;">${Number(q.execution_count).toLocaleString()}</td>
                  <td style="text-align:center;">${new Date(q.last_seen).toLocaleString("zh-CN")}</td>
                  <td style="text-align:center;">
                    <button
                      style="border: 1px solid var(--accent); color: var(--accent); font-size: var(--text-sm); padding: 4px 8px; border-radius: var(--radius-sm); cursor: pointer; background: transparent;"
                      @click=${() => this._startSqlAudit(q.sql_text)}
                    >审核</button>
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  private _renderSessions() {
    if (this.sessions.length === 0) {
      return html`
        <div class="card">
          <div class="empty-state">
            <div class="empty-icon">${icons['users']}</div>
            <div class="empty-title">无活跃会话</div>
            <div class="empty-desc">当前没有活跃的数据库会话</div>
          </div>
        </div>
      `;
    }

    return html`
      <div class="card">
        <div class="card-header">
          <span class="card-title">${renderIcon('users')} 活跃会话 (${this.sessions.length})</span>
        </div>
        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th style="width: 70px; text-align:center;">ID</th>
                <th>用户</th>
                <th>来源</th>
                <th>数据库</th>
                <th style="width: 90px; text-align:center;">命令</th>
                <th style="width: 80px; text-align:center;">时间</th>
                <th>当前查询</th>
              </tr>
            </thead>
            <tbody>
              ${this.sessions.map((s) => html`
                <tr>
                  <td style="text-align:center;">${s.id}</td>
                  <td>${s.user}</td>
                  <td>${s.host}</td>
                  <td style="text-align:center;">${s.database || "—"}</td>
                  <td style="text-align:center;"><span style="padding: 2px 8px; background: var(--bg-muted); border-radius: var(--radius-sm); font-size: var(--text-xs);">${s.command}</span></td>
                  <td style="text-align:center;"><span style="color: ${s.time_seconds > 60 ? 'var(--destructive)' : s.time_seconds > 10 ? 'var(--warn)' : 'var(--ok)'}; font-weight: 600;">${s.time_seconds}s</span></td>
                  <td><div class="sql-code" title="${s.query || ""}">${s.query ? (s.query.substring(0, 40) + (s.query.length > 40 ? "..." : "")) : "—"}</div></td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  private _renderCapacity() {
    if (!this.capacity) {
      return html`
        <div class="card">
          <div class="empty-state">
            <div class="empty-icon">${icons['hard-drive']}</div>
            <div class="empty-title">暂无容量数据</div>
            <div class="empty-desc">实例可能未连接或暂无数据</div>
          </div>
        </div>
      `;
    }

    const cap = this.capacity;

    return html`
      ${this.capHistory.time.length > 0 ? html`
      <metric-chart
        title="存储增长趋势 (过去7天)"
        height="220px"
        yAxisLabel="GB"
        .timeData=${this.capHistory.time}
        .series=${[{ name: "容量", data: this.capHistory.size, color: "#8b5cf6" }]}
      ></metric-chart>
      <div style="height:16px"></div>
      ` : nothing}
      <div class="card">
        <div class="card-header">
          <span class="card-title">${renderIcon('hard-drive')} 存储总览：${cap.total_size_gb.toFixed(2)} GB</span>
        </div>
        <div class="card-body">
          ${cap.databases && cap.databases.length > 0 ? html`
            <h4 style="font-size: var(--text-md); color: var(--text-strong); margin: 0 0 16px 0; text-transform: uppercase; letter-spacing: 0.04em;">数据库</h4>
            <div class="capacity-list">
              ${cap.databases.map((db) => html`
                <div class="capacity-item">
                  <div class="capacity-icon">${icons['database']}</div>
                  <div class="capacity-info">
                    <div class="capacity-name">${db.name}</div>
                    <div class="capacity-meta">${db.size_gb.toFixed(2)} GB${db.table_count ? ` · ${db.table_count} 张表` : ""}</div>
                  </div>
                </div>
              `)}
            </div>
          ` : ""}

          ${cap.tablespaces && cap.tablespaces.length > 0 ? html`
            <h4 style="font-size: var(--text-md); color: var(--text-strong); margin: 24px 0 16px 0; text-transform: uppercase; letter-spacing: 0.04em;">表空间</h4>
            <div class="capacity-list">
              ${cap.tablespaces.map((ts) => html`
                <div class="capacity-item">
                  <div class="capacity-icon">${renderIcon('package')}</div>
                  <div class="capacity-info">
                    <div class="capacity-name">${ts.name}</div>
                    <div class="capacity-meta">${ts.size_gb.toFixed(2)} GB / ${ts.max_size_gb?.toFixed(2) || "∞"} GB</div>
                  </div>
                  ${ts.usage_percent !== undefined ? html`
                    <div class="capacity-bar-wrap">
                      <div class="capacity-percent" style="color: ${ts.usage_percent > 90 ? 'var(--destructive)' : ts.usage_percent > 70 ? 'var(--warn)' : 'var(--ok)'}">${ts.usage_percent.toFixed(1)}%</div>
                      <div class="progress-bar">
                        <div class="progress-fill ${ts.usage_percent > 90 ? 'danger' : ts.usage_percent > 70 ? 'warn' : 'ok'}" style="width: ${ts.usage_percent}%"></div>
                      </div>
                    </div>
                  ` : ""}
                </div>
              `)}
            </div>
          ` : ""}

          <h4 style="font-size: var(--text-md); color: var(--text-strong); margin: 24px 0 16px 0; text-transform: uppercase; letter-spacing: 0.04em;">最大表（Top ${cap.top_tables.length}）</h4>
          <div class="capacity-list">
            ${cap.top_tables.map((t) => html`
              <div class="capacity-item">
                <div class="capacity-icon">${icons['file-text']}</div>
                <div class="capacity-info">
                  <div class="capacity-name">${t.name}</div>
                  <div class="capacity-meta">${t.size_gb.toFixed(2)} GB${t.row_count ? ` · ${t.row_count.toLocaleString()} 行` : ""}</div>
                </div>
              </div>
            `)}
          </div>
        </div>
      </div>
    `;
  }

  private _renderSqlAuditTab() {
    return html`
      <sql-audit-tab .instanceId=${this.instanceId}></sql-audit-tab>
    `;
  }

  private _startSqlAudit(sqlText: string) {
    this.activeTab = "sqlaudit";
    requestAnimationFrame(() => {
      const el = this.shadowRoot?.querySelector("sql-audit-tab") as any;
      if (el && el.submitAuditForSlowQuery) {
        el.submitAuditForSlowQuery(sqlText, 0);
      }
    });
  }
}

if (!customElements.get("instance-detail-page")) {
  customElements.define("instance-detail-page", InstanceDetailPage);
}
