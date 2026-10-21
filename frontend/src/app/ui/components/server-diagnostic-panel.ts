import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import "./app-badge.js";
import "./app-card.js";
import "./app-empty-state.js";
import "./app-data-table.js";
import { diagnosisLabels, gapExplanation, displayTime } from "../views/diagnosis-presentation.ts";

export type DiagnosticQuality = "good" | "partial" | "unknown" | "unsupported" | string;

export interface ServerDiagnosticSection {
  source?: string[] | string;
  collectedAt?: string | null;
  quality?: DiagnosticQuality;
  reason?: string | null;
  truncated?: boolean;
  items?: Array<Record<string, unknown>>;
  values?: Record<string, unknown>;
}

export interface ServerDiagnosticGap {
  section?: string;
  code?: string;
  reason?: string | null;
}

export interface ServerDiagnosticEvidence {
  serverId?: number;
  collectedAt?: string | null;
  expiresAt?: string | null;
  quality?: DiagnosticQuality;
  truncated?: boolean;
  sections?: Record<string, ServerDiagnosticSection>;
  gaps?: ServerDiagnosticGap[];
  // Keep compatibility with an API that returns sections at the top level.
  network?: ServerDiagnosticSection;
  processes?: ServerDiagnosticSection;
  services?: ServerDiagnosticSection;
  logs?: ServerDiagnosticSection;
  [key: string]: unknown;
}

const SECTION_ORDER = ["network", "processes", "services", "logs"];
const SECTION_ALIASES: Record<string, string[]> = {
  network: ["network", "interfaceErrors", "listeningPorts"],
  processes: ["processes", "topProcesses"],
  services: ["services", "serviceStatus"],
  logs: ["logs", "systemLogs", "recentSystemLogs"],
};
const SECTION_LABELS: Record<string, string> = {
  network: '网络概况', interfaceErrors: '网卡流量与丢包', listeningPorts: '监听端口',
  processes: '进程样本', topProcesses: 'CPU 占用前 20 个进程',
  services: '运行中的服务', serviceStatus: '运行中的服务', logs: '系统日志', systemLogs: '系统日志', recentSystemLogs: '系统日志',
};
const FIELDS: Record<string, string> = {
  interface: '网卡', rxBytes: '接收字节', txBytes: '发送字节', rxErrors: '接收错误数', txErrors: '发送错误数', rxDrops: '接收丢包数', txDrops: '发送丢包数',
  protocol: '协议', address: '监听地址', port: '端口', process: '进程', pid: '进程号', command: '命令', cpuPercent: 'CPU (%)', memoryPercent: '内存 (%)',
  name: '服务名', activeState: '运行状态', subState: '子状态', description: '说明',
  timestamp: '日志时间', severity: '级别', unit: '服务单元', identifier: '来源标识', message: '日志内容',
};
const VALUE_LABELS: Record<string, string> = {
  active: '运行中', inactive: '未运行', failed: '失败', running: '运行中', exited: '已退出', dead: '已停止',
  warning: '警告', error: '错误', critical: '严重', info: '信息', debug: '调试', notice: '通知', alert: '告警', emergency: '紧急',
  unavailable: '暂不可用', not_covered: '尚未覆盖', unknown: '未知', loaded: '已加载',
};
const qualityLabel = (quality?: string) => diagnosisLabels[quality ?? 'unknown'] ?? '质量待确认';
function fieldValue(key: string, value: unknown) {
  if (key === 'timestamp') return displayTime(typeof value === 'string' ? value : null);
  if (['activeState', 'subState', 'severity'].includes(key)) return VALUE_LABELS[String(value)] ?? '状态待确认（见技术详情）';
  return displayValue(value);
}

function asSection(value: unknown): ServerDiagnosticSection | null {
  return value && typeof value === "object" ? value as ServerDiagnosticSection : null;
}

function sourceList(source: ServerDiagnosticSection["source"]): string[] {
  if (Array.isArray(source)) return source.filter((item): item is string => typeof item === "string");
  return typeof source === "string" ? [source] : [];
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "--";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return "内容暂不可用"; }
}

@customElement("server-diagnostic-panel")
export class ServerDiagnosticPanel extends LitElement {
  @property({ attribute: false }) evidence: ServerDiagnosticEvidence | null = null;
  @property({ type: Boolean }) loading = false;
  @property() error: string | null = null;
  @property({ attribute: false }) sectionFilter: string | null = null;

  private sections(): Array<[string, ServerDiagnosticSection]> {
    if (!this.evidence) return [];
    const supplied = this.evidence.sections ?? {};
    const result: Array<[string, ServerDiagnosticSection]> = [];
    const order = this.sectionFilter ? [this.sectionFilter] : SECTION_ORDER;
    const seen = new Set<unknown>();
    for (const key of order) {
      const aliases = SECTION_ALIASES[key] ?? [key];
      for (const alias of aliases) {
        // The API supplies both named aliases and sections; render each source once.
        const canonical = alias === 'serviceStatus' ? 'services' : alias === 'recentSystemLogs' ? 'systemLogs' : alias;
        const section = asSection(supplied[canonical] ?? supplied[alias] ?? this.evidence?.[alias]);
        if (section && !seen.has(section)) { result.push([canonical, section]); seen.add(section); }
      }
    }
    if (!this.sectionFilter) {
      const aliases = new Set(Object.values(SECTION_ALIASES).flat());
      for (const [key, value] of Object.entries(supplied)) {
        if (!aliases.has(key) && asSection(value)) result.push([key, value]);
      }
    }
    return result;
  }

  private renderSection(key: string, section: ServerDiagnosticSection) {
    const items = Array.isArray(section.items) ? section.items : [];
    const sources = sourceList(section.source);
    const fieldKeys = Object.keys(FIELDS).filter(field => items.some(item => field in item));
    const reason = section.reason ? gapExplanation(section.reason) : ['本次没有可展示的观测', '核对采集来源、时间与权限后重新采集'];
    return html`<app-card class="evidence-section">
      <span slot="header" class="section-header"><span>${SECTION_LABELS[key] ?? '其他诊断证据'}</span><app-badge variant=${this.qualityVariant(section.quality)}>${qualityLabel(section.quality)}</app-badge></span>
      <div class="section-meta"><span>来源：${sources.length ? sources.join('、') : '来源未知'}</span><span>采集于：${displayTime(section.collectedAt)}</span>
        ${section.truncated || items.length > 100 ? html`<app-badge variant="warn">仅展示部分结果</app-badge>` : nothing}</div>
      ${section.reason ? html`<p class="reason">${reason[0]}。下一步：${reason[1]}。</p>` : nothing}
      ${items.length && fieldKeys.length ? html`<div class="table-scroll" tabindex="0" role="region" aria-label=${`${SECTION_LABELS[key] ?? '诊断'}数据，可横向滚动`}>
        <app-data-table .dense=${true} .columns=${fieldKeys.map(field => ({ key: field, label: FIELDS[field] }))}
          .rows=${items.slice(0, 100).map(item => Object.fromEntries(fieldKeys.map(field => [field, fieldValue(field, item[field])]))) }></app-data-table></div>`
        : html`<app-empty-state title="暂无可展示的观测" description=${`${reason[0]}。下一步：${reason[1]}。`} icon="search"></app-empty-state>`}
      <details><summary>技术详情（原始字段与标识）</summary><pre>${JSON.stringify({ section: key, ...section }, null, 2)}</pre></details>
    </app-card>`;
  }

  private qualityVariant(quality: DiagnosticQuality | undefined): "ok" | "warn" | "danger" | "muted" {
    if (quality === "good") return "ok";
    if (quality === "partial") return "warn";
    if (quality === "unsupported") return "danger";
    return "muted";
  }

  render() {
    return html`
      <style>
        :host { display: block; min-width:0; }
        .table-scroll { max-width:100%; overflow:auto; }
        app-data-table { min-width:520px; }
        pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:var(--text-sm); }
        details { margin-top:var(--space-sm); }
        summary { cursor:pointer; color:var(--accent-text); }
        .loading, .error { color: var(--muted); padding: var(--space-lg); }
        .error { color: var(--danger); }
        .summary { display:flex; flex-wrap:wrap; gap:var(--space-sm); align-items:center; margin-bottom:var(--space-md); }
        .freshness { color:var(--muted); font-size:var(--text-sm); }
        .sections { display:grid; grid-template-columns:minmax(0,1fr); gap:var(--space-md); }
        .evidence-section { min-width:0; }
        .section-header { display:flex; align-items:center; justify-content:space-between; gap:var(--space-sm); width:100%; }
        .section-meta { display:flex; flex-wrap:wrap; gap:var(--space-md); color:var(--muted); font-size:var(--text-sm); margin-bottom:var(--space-sm); }
        .reason { color:var(--warn); font-size:var(--text-sm); margin:0 0 var(--space-sm); overflow-wrap:anywhere; }
        .gaps { margin-top:var(--space-md); display:grid; gap:var(--space-xs); }
        .gap { color:var(--warn); font-size:var(--text-sm); overflow-wrap:anywhere; }
      </style>
      ${this.loading
        ? html`<div class="loading" role="status">正在读取诊断证据…</div>`
        : this.error
          ? html`<div class="error" role="alert">${this.error}</div>`
          : !this.evidence
            ? html`<app-empty-state title="尚无诊断证据" description="请采集只读诊断证据后核对服务器；缺少证据不能判断正常。" icon="activity"></app-empty-state>`
            : html`
                <div class="summary">
                  <app-badge variant=${this.qualityVariant(this.evidence.quality)}>${qualityLabel(this.evidence.quality)}</app-badge>
                  ${this.evidence.truncated ? html`<app-badge variant="warn">仅展示部分结果</app-badge>` : nothing}
                  <span class="freshness">采集于：${displayTime(this.evidence.collectedAt)} · 有效期截止：${displayTime(this.evidence.expiresAt)}</span>
                </div>
                <div class="sections">${this.sections().map(([key, section]) => this.renderSection(key, section))}</div>
                ${this.evidence.gaps?.length
                  ? html`<div class="gaps" role="list" aria-label="证据缺口">
                      ${this.evidence.gaps.filter(gap => !this.sectionFilter || (SECTION_ALIASES[this.sectionFilter] ?? [this.sectionFilter]).includes(gap.section ?? '')).map(gap => {
                        const explanation = gapExplanation(gap.code ?? gap.reason ?? 'unknown');
                        return html`<div class="gap" role="listitem"><strong>${SECTION_LABELS[gap.section ?? ''] ?? '诊断证据'}：${explanation[0]}</strong><p>下一步：${explanation[1]}</p><details><summary>缺口技术详情</summary><pre>${JSON.stringify(gap, null, 2)}</pre></details></div>`;
                      })}
                    </div>`
                  : nothing}
              `}
    `;
  }
}
