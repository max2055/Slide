/**
 * Alert detail modal showing alert info, timeline, AI analysis section, and analysis history.
 * Wraps content in <app-dialog size="lg">.
 *
 * Properties:
 *   .alert=${Alert|null} .open=${boolean} .activeRCAAnalysis=${object|null}
 *   .diagnosisStatus=${string} .diagnosisResult=${any} .diagnosisError=${string|null}
 *   .analysisHistory=${any[]} .analysisHistoryLoading=${boolean}
 *
 * Events: close, alert-rca, alert-navigate-chat
 */
import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { icons } from "../../../icons.js";
import "./app-dialog.js";
import "./app-badge.js";

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

@customElement("alert-detail-modal")
export class AlertDetailModal extends LitElement {
  @property({ type: Object }) alert: Alert | null = null;
  @property({ type: Boolean }) open = false;
  @property({ type: Object }) activeRCAAnalysis: Record<string, any> | null = null;
  @property() diagnosisStatus = 'idle';
  @property({ type: Object }) diagnosisResult: any = null;
  @property() diagnosisError: string | null = null;
  @property({ type: Array }) analysisHistory: any[] = [];
  @property({ type: Boolean }) analysisHistoryLoading = false;

  private _emit(name: string, detail?: any) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  override render() {
    if (!this.alert || !this.open) return nothing;
    const a = this.alert;
    const isAnalyzing = this.activeRCAAnalysis?.alertId === a.id;
    const analysisRunning = isAnalyzing && this.diagnosisStatus === 'running';
    const analysisComplete = isAnalyzing && this.diagnosisStatus === 'completed';
    const analysisFailed = isAnalyzing && this.diagnosisStatus === 'failed';
    const canAnalyze = a.severity !== 'info' && !analysisRunning;

    return html`
      <app-dialog size="lg" .open=${this.open} title="告警详情" @app-dialog-close=${() => this._emit('close')}>
        <!-- Header -->
        <div style="margin-bottom:var(--space-lg);">
          <div style="display:flex;align-items:center;gap:var(--space-sm);flex-wrap:wrap;">
            <span style="font-size:var(--text-xs);color:var(--muted);">#${a.id}</span>
            <app-badge variant=${a.severity === 'critical' ? 'danger' : a.severity === 'warning' ? 'warn' : 'info'}>${this._severityLabel(a.severity)}</app-badge>
            <span class="type-badge" style="display:inline-flex;align-items:center;padding:var(--space-xs) var(--space-sm);background:rgba(59,130,246,0.12);color:var(--info);border-radius:var(--radius-sm);font-size:var(--text-xs);font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">${this._typeLabel(a.alert_type)}</span>
          </div>
          <div style="font-size:var(--text-lg);font-weight:600;margin-top:var(--space-xs);">${this._cleanTitle(a.title)}</div>
        </div>

        <!-- Metadata grid -->
        <div style="display:grid;grid-template-columns:80px 1fr;gap:var(--space-sm) var(--space-md);font-size:var(--text-base);margin-bottom:var(--space-lg);padding:var(--space-md);background:var(--bg-elevated);border-radius:var(--radius-sm);">
          <span style="color:var(--muted);">实例</span><span>${a.instance_name || '—'}</span>
          <span style="color:var(--muted);">时间</span><span>${new Date(a.created_at).toLocaleString('zh-CN')}</span>
          <span style="color:var(--muted);">状态</span><span><app-badge variant="${this._statusVariant(a.status)}">${this._statusLabel(a)}</app-badge></span>
          <span style="color:var(--muted);">描述</span><span style="line-height:1.5;">${a.message || '—'}</span>
        </div>

        <!-- Status timeline -->
        <div style="display:flex;align-items:center;gap:var(--space-md);margin-bottom:var(--space-lg);padding:var(--space-md);background:var(--bg-elevated);border-radius:var(--radius-sm);font-size:var(--text-sm);overflow-x:auto;">
          <div style="display:flex;align-items:center;gap:var(--space-xs);flex-shrink:0;"><span style="color:var(--ok);">●</span><span style="color:var(--muted);">触发</span><span>${new Date(a.created_at).toLocaleString('zh-CN')}</span></div>
          <span style="color:var(--border);">→</span>
          ${a.acknowledged_at ? html`
            <div style="display:flex;align-items:center;gap:var(--space-xs);flex-shrink:0;"><span style="color:var(--accent);">●</span><span style="color:var(--muted);">确认</span><span>${new Date(a.acknowledged_at).toLocaleString('zh-CN')}</span></div>
            <span style="color:var(--border);">→</span>
          ` : ''}
          ${a.resolved_at ? html`
            <div style="display:flex;align-items:center;gap:var(--space-xs);flex-shrink:0;"><span style="color:var(--ok);">●</span><span style="color:var(--muted);">${a.resolved_by === 'auto' ? '自动恢复' : '已解决'}</span><span>${new Date(a.resolved_at).toLocaleString('zh-CN')}</span></div>
          ` : html`<span style="color:var(--muted);">—</span>`}
        </div>

        <!-- AI Analysis Section -->
        <div style="margin-bottom:var(--space-lg);padding:var(--space-md);border:1px solid var(--border);border-radius:var(--radius-md);">
          <div style="font-weight:600;font-size:var(--text-md);margin-bottom:var(--space-md);">AI 根因分析</div>
          ${analysisRunning ? html`
            <div style="display:flex;align-items:center;gap:var(--space-sm);padding:var(--space-md);background:var(--bg-elevated);border-radius:var(--radius-sm);">
              <span style="color:var(--accent);">⟳</span> AI 分析运行中...
              ${this.activeRCAAnalysis?.sessionKey ? html`<a href="#" @click=${(e: Event) => { e.preventDefault(); this._emit('alert-navigate-chat', { sessionKey: this.activeRCAAnalysis!.sessionKey }); }} style="margin-left:auto;font-size:var(--text-sm);color:var(--accent);">查看过程 →</a>` : ''}
            </div>
          ` : analysisComplete ? html`
            <div style="padding:var(--space-md);background:var(--bg-elevated);border-radius:var(--radius-sm);">
              <div style="display:flex;align-items:center;gap:var(--space-sm);margin-bottom:var(--space-sm);">
                <span style="color:var(--ok);font-weight:600;">✅ 分析完成</span>
                ${this.activeRCAAnalysis?.sessionKey ? html`<button class="btn primary" @click=${() => this._emit('alert-navigate-chat', { sessionKey: this.activeRCAAnalysis!.sessionKey })} style="display:inline-flex;align-items:center;padding:var(--space-sm) var(--space-md);border:none;border-radius:var(--radius-sm);font-size:var(--text-sm);font-weight:500;cursor:pointer;background:var(--accent);color:var(--accent-foreground,#fff);">查看详情</button>` : ''}
              </div>
              ${this._renderAnalysisSummary()}
            </div>
          ` : analysisFailed ? html`
            <div style="padding:var(--space-md);background:var(--danger-subtle);border-radius:var(--radius-sm);color:var(--destructive);">❌ ${this.diagnosisError || 'AI 分析失败'}</div>
          ` : html`
            <div style="color:var(--muted);font-size:var(--text-base);margin-bottom:var(--space-md);">点击「开始分析」让 AI 自动采集指标、诊断根因。</div>
          `}
          ${canAnalyze ? html`<button class="btn primary" @click=${() => this._emit('alert-rca', { id: a.id })} style="margin-top:var(--space-sm);width:100%;justify-content:center;display:flex;align-items:center;gap:var(--space-sm);padding:var(--space-sm) var(--space-md);border:none;border-radius:var(--radius-sm);font-size:var(--text-sm);font-weight:500;cursor:pointer;background:var(--accent);color:var(--accent-foreground,#fff);">开始 AI 分析</button>` : ''}
        </div>

        <!-- Analysis History -->
        <div style="border-top:1px solid var(--border);padding-top:12px;">
          <div style="font-weight:600;font-size:var(--text-base);margin-bottom:var(--space-sm);color:var(--muted);">分析历史</div>
          ${this.analysisHistoryLoading ? html`<div style="color:var(--muted);font-size:var(--text-sm);">加载中...</div>`
            : this.analysisHistory.length > 0 ? html`
              <div style="display:flex;flex-direction:column;gap:var(--space-sm);">
                ${this.analysisHistory.map((r: any) => html`
                  <div style="display:flex;align-items:center;justify-content:space-between;padding:var(--space-sm) var(--space-md);background:var(--bg-elevated);border-radius:var(--radius-sm);font-size:var(--text-sm);">
                    <span><span style="color:var(--muted);">${new Date(r.created_at).toLocaleString('zh-CN')}</span>
                      ${r.status === 'completed' ? html`<span style="color:var(--ok);margin-left:var(--space-sm);">已完成</span>`
                        : r.status === 'failed' ? html`<span style="color:var(--destructive);margin-left:var(--space-sm);">失败</span>`
                        : html`<span style="color:var(--muted);margin-left:var(--space-sm);">${r.status}</span>`}
                    </span>
                    ${r.session_key ? html`<a href="#" @click=${(e: Event) => { e.preventDefault(); this._emit('alert-navigate-chat', { sessionKey: r.session_key }); }} style="color:var(--accent);font-size:var(--text-xs);">查看 →</a>` : ''}
                  </div>
                `)}
              </div>
            ` : html`<div style="color:var(--muted);font-size:var(--text-sm);">暂无分析记录</div>`
          }
        </div>
      </app-dialog>
    `;
  }

  private _renderAnalysisSummary() {
    const result = this.diagnosisResult;
    if (!result) return html`<span style="color:var(--muted);font-size:var(--text-base);">无分析结果</span>`;
    const rootCauses: any[] = result.root_causes || [];
    const recommendations: string[] = result.recommendations || [];
    const summary: string = result.summary || '';
    return html`
      <div style="display:flex;flex-direction:column;gap:var(--space-md);font-size:var(--text-base);margin-top:var(--space-sm);">
        ${summary ? html`<div style="color:var(--text);line-height:1.5;">${summary}</div>` : ''}
        ${rootCauses.length > 0 ? html`
          <div><span style="font-weight:600;font-size:var(--text-sm);color:var(--muted);">根因分析</span>
          ${rootCauses.slice(0, 3).map((rc: any) => html`
            <div style="margin-top:var(--space-xs);padding:var(--space-sm) var(--space-md);background:var(--bg-elevated);border-radius:var(--radius-sm);font-size:var(--text-sm);">
              <span style="font-weight:500;">${rc.cause || rc.title || ''}</span>
              ${rc.confidence ? html`<span style="color:var(--muted);margin-left:var(--space-xs);">(${Math.round(rc.confidence * 100)}%)</span>` : ''}
              ${rc.explanation ? html`<div style="color:var(--muted);margin-top:var(--space-xs);">${rc.explanation}</div>` : ''}
            </div>
          `)}</div>
        ` : ''}
        ${recommendations.length > 0 ? html`
          <div><span style="font-weight:600;font-size:var(--text-sm);color:var(--muted);">建议操作</span>
          ${recommendations.slice(0, 5).map((rec: string) => html`
            <div style="margin-top:var(--space-xs);padding:var(--space-sm) var(--space-md);background:var(--bg-elevated);border-radius:var(--radius-sm);font-size:var(--text-sm);color:var(--text);">${rec}</div>
          `)}</div>
        ` : ''}
      </div>
    `;
  }

  private _severityLabel(s: string): string { return ({ critical: '严重', warning: '警告', info: '提示' } as Record<string, string>)[s] || s; }
  private _cleanTitle(t: string): string { return t.replace(/^\[(CRITICAL|WARNING|INFO|ERROR)\]\s*/i, ''); }
  private _typeLabel(t: string): string {
    return ({ health_check_failed: '健康检查', slow_query: '慢查询', connection_pool_exhausted: '连接池', replication_lag: '复制延迟', disk_space_low: '磁盘空间', cpu_high: 'CPU', memory_high: '内存' } as Record<string, string>)[t] || t;
  }
  private _statusLabel(a: Alert): string {
    return ({ unread: '未读', read: '已读', acknowledged: '已确认', resolved: a.resolved_by === 'auto' ? '自动恢复' : '已恢复', closed: '已关闭' } as Record<string, string>)[a.status] || a.status;
  }
  private _statusVariant(s: string): string {
    return ({ unread: 'danger', read: 'muted', acknowledged: 'info', resolved: 'ok', closed: 'muted' } as Record<string, string>)[s] || 'muted';
  }
}

try { customElements.define("alert-detail-modal", AlertDetailModal); } catch (e: any) { if (!(e instanceof DOMException)) throw e; }
