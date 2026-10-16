import { html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { showToast } from '../components/app-toast-container.js';
import { AgentListPage, AgentListError, agentListStyles, agentListRequest, listError } from './agent-tools.js';

interface Session {
  key: string; kind: string; label: string; updatedAt: number | null;
  message_count: number; status: string; instance_id: number | null;
}
interface Message { id?: string; role: string; content: unknown; timestamp: number; messageParts?: unknown; }
interface MessagePage { messages: Message[]; nextBefore: number | null; }
const statuses: Record<string, string> = { active: '进行中', completed: '已完成', idle: '空闲', failed: '失败', archived: '已归档' };
const roles: Record<string, string> = { user: '用户', assistant: '助手', tool: '工具', system: '系统' };
const title = (session: Session) => session.label && session.label !== session.key ? session.label : '未命名会话';
const status = (session: Session) => statuses[session.status] || `未知状态（${session.status || '未提供'}）`;
function time(value: number | null) { return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString('zh-CN') : '未记录'; }
function content(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => {
    if (part && typeof part === 'object') {
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      if (part.type === 'thinking' && typeof part.thinking === 'string') return `思考记录：\n${part.thinking}`;
    }
    return JSON.stringify(part, null, 2);
  }).join('\n\n');
  return value == null ? '' : JSON.stringify(value, null, 2);
}

@customElement('agent-sessions-page')
export class AgentSessionsPage extends AgentListPage<Session> {
  protected endpoint = '/sessions';
  protected collection = 'sessions';
  protected subject = '读取会话清单';
  protected sort = 'recent';
  @state() private selected: Session | null = null;
  @state() private messages: Message[] = [];
  @state() private messagesLoading = false;
  @state() private messagesError = '';
  @state() private nextBefore: number | null = null;
  @state() private deleting: string | null = null;
  private messageGeneration = 0;
  static styles = [sharedBtnStyles, agentListStyles, css`
    .message { padding:var(--space-md) 0; border-top:1px solid var(--border); }
    .message-header { display:flex; flex-wrap:wrap; justify-content:space-between; gap:var(--space-sm); }
    .message-content { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.65; }
    .message-list { min-width:0; }
  `];
  protected clearDetails() {
    ++this.messageGeneration; this.selected = null; this.messages = []; this.messagesError = '';
    this.messagesLoading = false; this.nextBefore = null;
  }
  async viewMessages(session: Session) {
    this.clearDetails(); this.selected = session;
    await this.loadMessages();
  }
  async loadMessages() {
    if (!this.selected || this.messagesLoading) return;
    const session = this.selected, generation = this.messageGeneration;
    const before = this.nextBefore;
    this.messagesLoading = true; this.messagesError = '';
    try {
      const result = await agentListRequest<MessagePage>(`/chat/history?sessionKey=${encodeURIComponent(session.key)}&paged=true&limit=100${before === null ? '' : `&before=${before}`}`);
      if (!Array.isArray(result.messages) || !(result.nextBefore === null || (Number.isSafeInteger(result.nextBefore) && result.nextBefore > 0 && (before === null || result.nextBefore < before)))) throw new Error('Invalid history page');
      if (generation !== this.messageGeneration || !this.isConnected) return;
      this.messages = [...result.messages, ...this.messages]; this.nextBefore = result.nextBefore;
    } catch (error) {
      if (generation === this.messageGeneration) {
        if (error instanceof AgentListError && [401, 403].includes(error.status)) {
          this.items = []; this.error = listError(error, this.subject); this.clearDetails();
        } else this.messagesError = listError(error, '读取消息历史');
      }
    } finally {
      if (generation === this.messageGeneration) this.messagesLoading = false;
    }
  }
  async deleteSession(session: Session) {
    if (this.deleting || !confirm(`确定删除会话“${title(session)}”？`)) return;
    const generation = this.generation;
    this.deleting = session.key;
    try {
      const result = await agentListRequest<{ ok: boolean }>(`/sessions/${encodeURIComponent(session.key)}`, { method: 'DELETE' });
      if (generation !== this.generation || !this.isConnected) return;
      if (result.ok !== true) throw new Error('Deletion not confirmed');
      showToast('会话已删除', 'success'); await this.load();
    } catch (error) {
      if (generation === this.generation) {
        if (error instanceof AgentListError && [401, 403].includes(error.status)) { this.items = []; this.error = listError(error, this.subject); this.clearDetails(); }
        showToast(listError(error, '删除会话'), 'error');
      }
    } finally { this.deleting = null; }
  }
  render() {
    const selected = this.selected;
    const entries = this.items.filter(s => [s.label, s.key, s.kind, status(s), s.status, s.instance_id].join(' ').toLowerCase().includes(this.query.trim().toLowerCase()) && (this.filter === 'all' || (this.filter === 'unknown' ? !statuses[s.status] : s.status === this.filter)))
      .sort((a, b) => this.sort === 'recent' ? (b.updatedAt ?? -Infinity) - (a.updatedAt ?? -Infinity) || a.key.localeCompare(b.key) : (this.sort === 'name-desc' ? -1 : 1) * (title(a).localeCompare(title(b), 'zh-CN') || a.key.localeCompare(b.key)));
    return html`
      <header class="page-header"><div><h1>Agent 会话</h1><p class="caption">按名称、状态与最近活跃查找对话，完整消息在详情中查看。</p></div><button aria-busy=${String(this.loading)} class="btn btn-refresh" ?disabled=${this.loading || !!this.deleting} @click=${this.load}>刷新</button></header>
      ${this.list({ entries, recent: true, placeholder: '查找会话名称、资源标识或状态', empty: '暂无会话', filters: [...Object.entries(statuses), ['unknown', '未知状态']],
        columns: [{ key: 'name', label: '会话与摘要', width: '43%' }, { key: 'status', label: '状态', width: '16%' }, { key: 'updated', label: '最近活跃', width: '22%' }, { key: 'actions', label: '操作', width: '19%' }],
        row: s => ({ name: html`<span class="entity" title=${title(s)}>${title(s)}</span><div class="sub summary">${s.message_count ?? 0} 条消息 · ${s.instance_id == null ? '未关联资源' : `资源 #${s.instance_id}`}</div>`,
          status: html`<app-badge variant=${s.status === 'active' ? 'ok' : s.status === 'failed' ? 'warn' : 'muted'}>${status(s)}</app-badge>`, updated: time(s.updatedAt),
          actions: html`<div class="actions"><button class="btn btn-ghost" aria-label=${`查看 ${title(s)} 详情`} @click=${() => this.viewMessages(s)}>查看详情</button><button class="btn btn-ghost" ?disabled=${!!this.deleting} aria-label=${`删除 ${title(s)}`} @click=${() => this.deleteSession(s)}>${this.deleting === s.key ? '删除中…' : '删除'}</button></div>` }) })}
      <app-dialog .open=${!!selected} size="xl" title="会话详情" @app-dialog-close=${this.clearDetails}>
        ${selected ? html`<div class="detail"><h2>${title(selected)}</h2><dl><dt>状态</dt><dd>${status(selected)}</dd><dt>最近活跃</dt><dd>${time(selected.updatedAt)}</dd><dt>完整会话标识</dt><dd>${selected.key}</dd><dt>资源标识</dt><dd>${selected.instance_id ?? '未关联'}</dd></dl><details><summary>完整技术信息</summary><pre>${JSON.stringify(selected, null, 2)}</pre></details>
          <h3>消息历史</h3><p class="caption">已加载 ${this.messages.length} 条${this.nextBefore !== null ? '，还有更早消息' : this.messagesLoading || this.messagesError ? '' : ' · 已加载全部消息'}。</p>
          ${this.messagesError ? html`<div role="alert"><p>${this.messagesError}</p><button class="btn" @click=${this.loadMessages}>重试读取消息</button></div>` : nothing}
          ${this.messagesLoading ? html`<p role="status">正在读取消息…</p>` : this.nextBefore !== null ? html`<button class="btn" @click=${this.loadMessages}>加载更早消息</button>` : !this.messages.length && !this.messagesError ? html`<app-empty-state title="暂无消息"></app-empty-state>` : nothing}
          <div class="message-list">${this.messages.map(m => html`<article class="message"><div class="message-header"><strong>${roles[m.role] ?? `其他角色（${m.role}）`}</strong><span class="caption">${time(m.timestamp)}</span></div><div class="message-content">${content(m.content)}</div><details><summary>消息原始字段</summary><pre>${JSON.stringify(m, null, 2)}</pre></details></article>`)}</div>
        </div>` : nothing}
        <button class="btn" slot="footer" @click=${this.clearDetails}>关闭</button>
      </app-dialog>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'agent-sessions-page': AgentSessionsPage; } }
