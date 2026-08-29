import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import "./app-badge.js";
import "./app-card.js";
import "./app-empty-state.js";

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
  code: string;
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
  network: "Network",
  interfaceErrors: "Interface errors",
  listeningPorts: "Listening ports",
  processes: "Processes",
  topProcesses: "Top processes",
  services: "Services",
  serviceStatus: "Service status",
  logs: "Logs",
  systemLogs: "System logs",
  recentSystemLogs: "Recent system logs",
};

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
  try { return JSON.stringify(value); } catch { return "[unavailable]"; }
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
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
    for (const key of order) {
      const aliases = SECTION_ALIASES[key] ?? [key];
      for (const alias of aliases) {
        const section = asSection(supplied[alias] ?? this.evidence?.[alias]);
        if (section) result.push([alias === key ? key : alias, section]);
      }
    }
    for (const [key, value] of Object.entries(supplied)) {
      if ((!this.sectionFilter || key === this.sectionFilter) && !SECTION_ORDER.includes(key) && asSection(value)) result.push([key, value as ServerDiagnosticSection]);
    }
    return result;
  }

  private renderSection(key: string, section: ServerDiagnosticSection) {
    const items = Array.isArray(section.items) ? section.items : [];
    const sources = sourceList(section.source);
    const label = SECTION_LABELS[key] ?? key;
    return html`
      <app-card class="evidence-section">
        <span slot="header" class="section-header">
          <span>${label}</span>
          <app-badge variant=${this.qualityVariant(section.quality)}>${section.quality ?? "unknown"}</app-badge>
        </span>
        <div class="section-meta">
          <span>Source: ${sources.length ? sources.join(", ") : "--"}</span>
          <span>Collected: ${formatTimestamp(section.collectedAt)}</span>
          ${section.truncated ? html`<app-badge variant="warn">truncated</app-badge>` : nothing}
        </div>
        ${section.reason ? html`<p class="reason">${section.reason}</p>` : nothing}
        ${items.length
          ? html`<div class="evidence-items">
              ${items.slice(0, 100).map((item) => html`
                <div class="evidence-item">
                  ${Object.entries(item).slice(0, 12).map(([name, value]) => html`
                    <span class="item-field"><strong>${name}</strong><span>${displayValue(value)}</span></span>
                  `)}
                </div>
              `)}
            </div>`
          : html`<app-empty-state title="No observations" icon="search"></app-empty-state>`}
      </app-card>
    `;
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
        :host { display: block; }
        .loading, .error { color: var(--muted); padding: var(--space-lg); }
        .error { color: var(--danger); }
        .summary { display:flex; flex-wrap:wrap; gap:var(--space-sm); align-items:center; margin-bottom:var(--space-md); }
        .freshness { color:var(--muted); font-size:var(--text-sm); }
        .sections { display:grid; gap:var(--space-md); }
        .section-header { display:flex; align-items:center; justify-content:space-between; gap:var(--space-sm); width:100%; }
        .section-meta { display:flex; flex-wrap:wrap; gap:var(--space-md); color:var(--muted); font-size:var(--text-sm); margin-bottom:var(--space-sm); }
        .reason { color:var(--warn); font-size:var(--text-sm); margin:0 0 var(--space-sm); overflow-wrap:anywhere; }
        .evidence-items { display:grid; gap:var(--space-xs); }
        .evidence-item { display:flex; flex-wrap:wrap; gap:var(--space-sm) var(--space-md); padding:var(--space-sm) 0; border-bottom:1px solid var(--border); font-size:var(--text-sm); }
        .evidence-item:last-child { border-bottom:0; }
        .item-field { display:inline-flex; gap:var(--space-xs); min-width:0; overflow-wrap:anywhere; }
        .item-field strong { color:var(--muted); font-weight:500; }
        .gaps { margin-top:var(--space-md); display:grid; gap:var(--space-xs); }
        .gap { color:var(--warn); font-size:var(--text-sm); overflow-wrap:anywhere; }
      </style>
      ${this.loading
        ? html`<div class="loading" role="status">Loading diagnostic evidence...</div>`
        : this.error
          ? html`<div class="error" role="alert">${this.error}</div>`
          : !this.evidence
            ? html`<app-empty-state title="No diagnostic evidence" description="Collect evidence to inspect this server." icon="activity"></app-empty-state>`
            : html`
                <div class="summary">
                  <app-badge variant=${this.qualityVariant(this.evidence.quality)}>${this.evidence.quality ?? "unknown"}</app-badge>
                  ${this.evidence.truncated ? html`<app-badge variant="warn">truncated</app-badge>` : nothing}
                  <span class="freshness">Collected: ${formatTimestamp(this.evidence.collectedAt)} · Expires: ${formatTimestamp(this.evidence.expiresAt)}</span>
                </div>
                <div class="sections">${this.sections().map(([key, section]) => this.renderSection(key, section))}</div>
                ${this.evidence.gaps?.length
                  ? html`<div class="gaps" role="list" aria-label="Evidence gaps">
                      ${this.evidence.gaps.map((gap) => html`<div class="gap" role="listitem"><strong>${gap.section ? `${gap.section}: ` : ""}${gap.code}</strong>${gap.reason ? html` — ${gap.reason}` : nothing}</div>`)}
                    </div>`
                  : nothing}
              `}
    `;
  }
}
