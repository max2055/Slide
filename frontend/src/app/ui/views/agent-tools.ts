import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import type { Column } from '../components/app-data-table.js';
import '../components/app-card.js';
import '../components/app-data-table.js';
import '../components/app-empty-state.js';
import '../components/app-dialog.js';
import '../components/app-badge.js';
import '../components/agent-extension-manager.js';

interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  security?: { effect?: string; resource?: string; approval?: string; permissions?: string[]; audience?: string } | null;
  metadata?: { readOnly?: boolean; scope?: string[]; ownerOnly?: boolean; requiresApproval?: boolean; dangerLevel?: number };
}

export class AgentListError extends Error {
  constructor(public status: number) { super(`HTTP ${status}`); }
}

// Local to the three Agent lists. Keep the existing auth/refresh lifecycle.
export async function agentListRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await apiClient.fetchResponseWithAuth(`/api${endpoint}`, { cache: 'no-store', ...options });
  if (!response.ok) throw new AgentListError(response.status);
  return response.json() as Promise<T>;
}

export function listError(error: unknown, subject: string): string {
  return error instanceof AgentListError && [401, 403].includes(error.status)
    ? error.status === 401 ? '登录已失效，请重新登录。' : `当前没有${subject}权限，请联系管理员核对授权。`
    : `${subject}失败，请重试。`;
}

export const agentListStyles = css`
  :host { display: block; min-width: 0; color: var(--text); font-size: 14px; }
  * { box-sizing: border-box; }
  .page-header { display:flex; align-items:start; justify-content:space-between; gap:var(--space-md); margin-bottom:var(--space-xl); }
  h1 { margin:0 0 var(--space-xs); font-size:24px; color:var(--text-strong); }
  h2, h3 { font-size:16px; color:var(--text-strong); }
  p { margin:var(--space-xs) 0; }
  .caption, .sub { font-size:12px; color:var(--muted); line-height:1.6; }
  .toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-sm); margin-bottom:var(--space-md); }
  input, select { font:inherit; min-height:38px; min-width:0; max-width:100%; padding:var(--space-sm); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text); background:var(--card); }
  input { flex:1 1 260px; max-width:400px; }
  input:focus-visible, select:focus-visible, button:focus-visible, summary:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
  app-card::part(footer) { display:none; }
  .table-scroll { overflow-x:auto; min-width:0; }
  app-data-table { min-width:680px; }
  .data-table { table-layout:fixed; }
  .table-scroll .data-table td { font-size:14px; vertical-align:middle; overflow-wrap:anywhere; }
  .entity { display:block; font-weight:600; color:var(--text-strong); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .summary { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; margin-top:var(--space-xs); }
  .boundary { display:grid; gap:var(--space-xs); }
  .pagination, .actions { display:flex; align-items:center; flex-wrap:wrap; gap:var(--space-sm); }
  .pagination { justify-content:space-between; padding:var(--space-md); border-top:1px solid var(--border); font-size:12px; font-variant-numeric:tabular-nums; }
  .pagination select { font-size:12px; }
  .state { padding:var(--space-xl); }
  .detail { overflow-wrap:anywhere; min-width:0; }
  .detail p { white-space:pre-wrap; }
  .detail dl { display:grid; grid-template-columns:100px minmax(0,1fr); gap:var(--space-sm) var(--space-md); font-size:14px; }
  dt { color:var(--muted); font-size:12px; }
  dd { margin:0; white-space:pre-wrap; }
  pre { font-size:12px; font-family:var(--mono,monospace); white-space:pre-wrap; overflow-wrap:anywhere; max-height:360px; overflow:auto; padding:var(--space-md); background:var(--bg-accent); border:1px solid var(--border); border-radius:var(--radius-sm); }
  details { margin:var(--space-md) 0; }
  summary { cursor:pointer; color:var(--accent-text); }
  .extensions { margin-top:var(--space-xl); }
  @media(max-width:600px) { h1 { font-size:22px; } .toolbar input { max-width:none; flex-basis:100%; } .detail dl { grid-template-columns:80px minmax(0,1fr); } }
`;

/** A bounded client-side view of endpoints that return their full authorized list. */
export abstract class AgentListPage<T> extends LitElement {
  @state() protected items: T[] = [];
  @state() protected loading = true;
  @state() protected error = '';
  @state() protected query = '';
  @state() protected filter = 'all';
  @state() protected sort = 'name';
  @state() protected page = 0;
  @state() protected pageSize = 6;
  protected generation = 0;
  protected abstract endpoint: string;
  protected abstract collection: string;
  protected abstract subject: string;
  protected clearDetails() {}
  private expired = () => {
    ++this.generation; this.items = []; this.loading = false;
    this.error = '登录已失效，请重新登录。'; this.clearDetails();
  };
  private permissionsChanged = () => { void this.load(); };
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-session-expired', this.expired);
    window.addEventListener('slide-permissions-loaded', this.permissionsChanged);
    void this.load();
  }
  disconnectedCallback() {
    ++this.generation; this.clearDetails();
    window.removeEventListener('slide-session-expired', this.expired);
    window.removeEventListener('slide-permissions-loaded', this.permissionsChanged);
    super.disconnectedCallback();
  }
  async load() {
    const generation = ++this.generation;
    this.loading = true; this.error = ''; this.items = []; this.clearDetails();
    try {
      const result = await agentListRequest<Record<string, T[]>>(this.endpoint);
      if (!Array.isArray(result[this.collection])) throw new Error('Invalid list response');
      if (generation === this.generation && this.isConnected) this.items = result[this.collection];
    } catch (error) {
      if (generation === this.generation) this.error = listError(error, this.subject);
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }
  protected list(options: {
    columns: Column[]; entries: T[]; row: (item: T) => Record<string, unknown>;
    placeholder: string; filters: [string, string][]; empty: string;
    recent?: boolean; note?: string;
  }): TemplateResult {
    const pages = Math.max(1, Math.ceil(options.entries.length / this.pageSize));
    const page = Math.min(this.page, pages - 1);
    return html`
      <div class="toolbar" role="search" aria-label="清单检索">
        <input type="search" aria-label=${options.placeholder} placeholder=${options.placeholder} .value=${this.query}
          @input=${(e: Event) => { this.query = (e.target as HTMLInputElement).value; this.page = 0; }}>
        <select aria-label="清单筛选" .value=${this.filter} @change=${(e: Event) => { this.filter = (e.target as HTMLSelectElement).value; this.page = 0; }}>
          <option value="all">全部状态</option>${options.filters.map(([value, label]) => html`<option value=${value}>${label}</option>`)}
        </select>
        <select aria-label="排序" .value=${this.sort} @change=${(e: Event) => { this.sort = (e.target as HTMLSelectElement).value; this.page = 0; }}>
          ${options.recent ? html`<option value="recent">最近活跃优先</option>` : nothing}
          <option value="name">名称升序</option><option value="name-desc">名称降序</option>
        </select>
      </div>
      <p class="caption">${options.note ?? '技术标识与全文在详情中查看。'} 检索范围为本次服务返回的全部记录。</p>
      <app-card .compact=${true}>
        ${this.loading ? html`<div class="state skeleton" role="status">正在加载${this.collection === 'tools' ? '工具' : this.collection === 'sessions' ? '会话' : '技能'}清单…</div>`
          : this.error ? html`<div class="state" role="alert"><app-empty-state title=${this.error.includes('权限') || this.error.includes('登录') ? '当前没有查看权限' : '暂时无法读取'} description=${this.error}></app-empty-state><button class="btn" @click=${this.load}>重新读取</button></div>`
          : !this.items.length ? html`<app-empty-state title=${options.empty} description="当前服务未返回可展示的记录。"></app-empty-state>`
          : html`<div class="table-scroll" tabindex="0" role="region" aria-label="清单，可横向滚动">
            <app-data-table .columns=${options.columns} .rows=${options.entries.slice(page * this.pageSize, (page + 1) * this.pageSize).map(options.row)} .dense=${true} .striped=${false} emptyMessage="没有符合条件的记录"></app-data-table>
          </div>
          <div class="pagination"><span role="status">共 ${options.entries.length} 条 · 全部 ${this.items.length} 条</span>
            <label>每页 <select aria-label="每页条数" .value=${String(this.pageSize)} @change=${(e: Event) => { this.pageSize = Number((e.target as HTMLSelectElement).value); this.page = 0; }}>${[6, 12, 24].map(n => html`<option value=${n}>${n} 条</option>`)}</select></label>
            <div class="actions"><button class="btn" ?disabled=${page === 0} @click=${() => { this.page = page - 1; }}>上一页</button><span>第 ${page + 1} / ${pages} 页</span><button class="btn" ?disabled=${page + 1 >= pages} @click=${() => { this.page = page + 1; }}>下一页</button></div>
          </div>`}
      </app-card>`;
  }
}

const effects: Record<string, string> = { read: '只读', write: '写入变更', execute: '受限执行', secret: '凭据访问', delegate: '委派执行' };
const resources: Record<string, string> = { none: '无固定资源', instance: '数据库实例', server: '服务器', network_device: '网络设备', 'database-target': '数据库目标', 'network-scan': '网络扫描', cron: '定时任务', analysis: '分析记录' };
const approvals: Record<string, string> = { never: '无需审批', 'on-risk': '按风险审批', always: '必须审批' };
function effect(tool: Tool) { return tool.security?.effect ?? (tool.metadata?.readOnly === true ? 'read' : 'unknown'); }
function approval(tool: Tool) { return tool.security?.approval ? approvals[tool.security.approval] ?? '审批策略未知' : tool.metadata?.requiresApproval ? '必须审批' : '审批策略未知'; }
function scope(tool: Tool) { return tool.security?.resource ? resources[tool.security.resource] ?? tool.security.resource : tool.metadata?.scope?.map(s => resources[s] ?? s).join(' / ') || '范围未声明'; }

@customElement('agent-tools-page')
export class AgentToolsPage extends AgentListPage<Tool> {
  protected endpoint = '/agent/tools';
  protected collection = 'tools';
  protected subject = '读取工具清单';
  @state() private selected: Tool | null = null;
  static styles = [sharedFieldStyles, sharedBtnStyles, agentListStyles];
  protected clearDetails() { this.selected = null; }
  render() {
    const selected = this.selected;
    const entries = this.items.filter(tool => [tool.name, tool.description, scope(tool), effects[effect(tool)] ?? '边界未知', approval(tool), ...(tool.security?.permissions ?? [])].join(' ').toLowerCase().includes(this.query.trim().toLowerCase()) && (this.filter === 'all' || effect(tool) === this.filter))
      .sort((a, b) => (this.sort === 'name-desc' ? -1 : 1) * a.name.localeCompare(b.name, 'zh-CN'));
    return html`
      <header class="page-header"><div><h1>工具清单</h1><p class="caption">先看用途与执行边界，完整参数按需查看。</p></div><button class="btn" ?disabled=${this.loading} @click=${this.load}>刷新</button></header>
      ${this.list({ entries, placeholder: '查找工具名称、用途或资源', empty: '暂无已注册工具', filters: [...Object.entries(effects), ['unknown', '边界未知']],
        note: '已注册不代表当前可执行；执行时仍需校验资源权限与审批。',
        columns: [{ key: 'name', label: '工具与用途', width: '38%' }, { key: 'scope', label: '适用范围', width: '18%' }, { key: 'boundary', label: '执行边界', width: '31%' }, { key: 'actions', label: '操作', width: '13%' }],
        row: tool => ({ name: html`<span class="entity" title=${tool.name}>${tool.name}</span><div class="sub summary">${tool.description || '暂无用途说明'}</div>`, scope: html`<div class="summary">${scope(tool)}</div>`,
          boundary: html`<div class="boundary"><div><app-badge variant=${effect(tool) === 'read' ? 'muted' : 'warn'}>${effects[effect(tool)] ?? '边界未知'}</app-badge> <span class="caption">${approval(tool)}</span></div><span class="caption">${tool.security?.permissions?.length ? `需 ${tool.security.permissions.join('、')}` : tool.security ? '仍需资源授权校验' : '授权条件未声明'}${tool.metadata?.ownerOnly ? ' · 仅主 Agent' : ''}${tool.metadata?.dangerLevel ? ` · 风险级别 ${tool.metadata.dangerLevel}` : ''}</span>${tool.security?.effect && tool.metadata?.readOnly !== undefined && (tool.security.effect === 'read') !== tool.metadata.readOnly ? html`<span class="caption">读写声明不一致，以安全策略为准</span>` : nothing}</div>`,
          actions: html`<button class="btn btn-ghost" aria-label=${`查看 ${tool.name} 详情`} @click=${() => { this.selected = tool; }}>查看详情</button>` }) })}
      ${!this.loading && !this.error ? html`<div class="extensions"><agent-extension-manager kind="tool"></agent-extension-manager></div>` : nothing}
      <app-dialog .open=${!!selected} size="xl" title="工具详情" @app-dialog-close=${() => { this.selected = null; }}>
        ${selected ? html`<div class="detail"><h2>${selected.name}</h2><p>${selected.description || '暂无用途说明'}</p><dl><dt>适用范围</dt><dd>${scope(selected)}</dd><dt>执行边界</dt><dd>${effects[effect(selected)] ?? '未知'} · ${approval(selected)}</dd><dt>权限条件</dt><dd>${selected.security?.permissions?.join('、') || (selected.security ? '执行时校验资源授权' : '未声明，不能据此推断可执行')}</dd></dl><h3>参数 Schema</h3><pre>${JSON.stringify(selected.parameters, null, 2)}</pre><details><summary>完整技术信息</summary><pre>${JSON.stringify(selected, null, 2)}</pre></details></div>` : nothing}
        <button class="btn" slot="footer" @click=${() => { this.selected = null; }}>关闭</button>
      </app-dialog>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'agent-tools-page': AgentToolsPage; } }
