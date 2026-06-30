import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { showToast } from '../components/app-toast-container.js';
import '../components/app-data-table.js';
import '../components/app-dialog.js';
import '../components/app-badge.js';

interface Session {
  key: string;
  kind: string;
  label: string;
  updatedAt: string;
  message_count: number;
  status: string;
  instance_id: number | null;
}

interface Message {
  role: string;
  content: string;
  created_at: string;
}

@customElement('agent-sessions-page')
export class AgentSessionsPage extends LitElement {
  @state() private sessions: Session[] = [];
  @state() private loading = true;
  @state() private selectedSession: Session | null = null;
  @state() private messages: Message[] = [];
  @state() private messagesLoading = false;
  @state() private showDialog = false;

  static styles = [sharedBtnStyles, css`
    :host {
      display: block;
      animation: fade-in 0.25s var(--ease-out);
    }

    @keyframes fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .page { padding: 0; }

    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
    .page-header h1 { font-size: 22px; font-weight: 700; margin: 0 0 4px; color: var(--text-strong); }
    .page-header p { font-size: 13px; color: var(--muted); margin: 0; }
    .message-list { max-height: 500px; overflow-y: auto; padding: var(--space-md); }
    .message-item { margin-bottom: var(--space-sm); padding: var(--space-sm); background: var(--card); border-radius: var(--radius-sm); }
    .message-role { font-weight: 600; color: var(--text-strong); margin-bottom: var(--space-xs); }
    .message-content { white-space: pre-wrap; font-size: 13px; color: var(--text); }
    .message-time { font-size: 11px; color: var(--muted); margin-top: var(--space-xs); }
  `];

  async connectedCallback() {
    super.connectedCallback();
    await this.loadSessions();
  }

  async loadSessions() {
    this.loading = true;
    try {
      const res = await apiClient.get<any>('/sessions');
      this.sessions = res.sessions || [];
    } catch (err) {
      showToast('加载会话列表失败', 'error');
    } finally {
      this.loading = false;
    }
  }

  async viewMessages(session: Session) {
    this.selectedSession = session;
    this.showDialog = true;
    this.messagesLoading = true;
    try {
      const res = await apiClient.get<any>(`/chat/history?sessionKey=${session.key}`);
      this.messages = res.messages || [];
    } catch (err) {
      showToast('加载消息历史失败', 'error');
    } finally {
      this.messagesLoading = false;
    }
  }

  async deleteSession(session: Session) {
    if (!confirm(`确定删除会话 "${session.label || session.key}"？`)) return;
    try {
      await apiClient.delete(`/sessions/${session.key}`);
      showToast('会话已删除', 'success');
      await this.loadSessions();
    } catch (err) {
      showToast('删除会话失败', 'error');
    }
  }

  closeDialog() {
    this.showDialog = false;
    this.selectedSession = null;
    this.messages = [];
  }

  render() {
    const columns = [
      { key: 'label', label: '名称' },
      { key: 'kind', label: '类型' },
      { key: 'message_count', label: '消息数' },
      { key: 'status', label: '状态' },
      { key: 'updatedAt', label: '最后活跃' },
      { key: 'actions', label: '操作' },
    ];

    const rows = this.sessions.map((s) => ({
      ...s,
      label: s.label || s.key,
      message_count: s.message_count || 0,
      status: html`<app-badge variant=${s.status === 'active' ? 'ok' : 'muted'}>${s.status}</app-badge>`,
      updatedAt: s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN') : '-',
      actions: html`
        <button class="btn" @click=${() => this.viewMessages(s)}>查看</button>
        <button class="btn btn-ghost" @click=${() => this.deleteSession(s)}>删除</button>
      `,
    }));

    return html`
      <div class="page">
        <div class="page-header">
          <div>
            <h1>Agent 会话管理</h1>
            <p>查看和管理 Agent 对话会话</p>
          </div>
        </div>

      ${this.loading
        ? html`<div class="skeleton">加载中...</div>`
        : html`<app-data-table .columns=${columns} .rows=${rows}></app-data-table>`}

      <app-dialog .open=${this.showDialog} size="lg" @app-dialog-close=${this.closeDialog}>
        <h2 slot="header">${this.selectedSession?.label || this.selectedSession?.key}</h2>
        <div class="message-list">
          ${this.messagesLoading
            ? html`<div class="skeleton">加载中...</div>`
            : this.messages.length === 0
              ? html`<div style="text-align:center;color:var(--muted);padding:var(--space-lg)">暂无消息</div>`
              : this.messages.map(
                  (msg) => html`
                    <div class="message-item">
                      <div class="message-role">${msg.role}</div>
                      <div class="message-content">${msg.content}</div>
                      <div class="message-time">${new Date(msg.created_at).toLocaleString('zh-CN')}</div>
                    </div>
                  `,
                )}
        </div>
      </app-dialog>
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'agent-sessions-page': AgentSessionsPage; } }
