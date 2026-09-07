import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.js';
import { icons } from '../../../icons.js';
import { copyTextToClipboard } from '../chat/copy-as-markdown.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import '../components/app-badge.js';
import '../components/app-card.js';
import '../components/app-data-table.js';
import '../components/app-dialog.js';
import '../components/app-form-field.js';
import { showToast } from '../components/app-toast-container.js';

interface FeedbackItem {
  id: number;
  title: string;
  description: string;
  source: 'manual' | 'agent';
  status: FeedbackStatus;
  createdBy: number | null;
  createdByUsername: string | null;
  createdAt: string;
  updatedAt: string;
}

type FeedbackStatus = 'pending' | 'accepted' | 'resolved';

const FEEDBACK_STATUSES: ReadonlyArray<{ value: FeedbackStatus; label: string }> = [
  { value: 'pending', label: '未接收' },
  { value: 'accepted', label: '已接收' },
  { value: 'resolved', label: '已解决' },
];

@customElement('feedback-page')
export class FeedbackPage extends LitElement {
  @state() private items: FeedbackItem[] = [];
  @state() private loading = true;
  @state() private saving = false;
  @state() private editorOpen = false;
  @state() private editing: FeedbackItem | null = null;
  @state() private deleteTarget: FeedbackItem | null = null;
  @state() private titleValue = '';
  @state() private descriptionValue = '';
  @state() private formError = '';
  @state() private expandedIds = new Set<number>();
  @state() private statusSavingIds = new Set<number>();
  @state() private copiedId: number | null = null;
  private copyResetTimer: number | undefined;

  static styles = [sharedBtnStyles, css`
    :host { display: block; }
    .page-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-lg);
      margin-bottom: var(--space-xl);
    }
    .page-header h1 {
      margin: 0 0 var(--space-xs);
      color: var(--text-strong);
      font-size: var(--text-xl);
    }
    .page-header p {
      margin: 0;
      color: var(--muted);
      font-size: var(--text-sm);
    }
    .table-wrap { overflow-x: auto; }
    .feedback-description {
      display: block;
      min-width: 18rem;
      max-width: 34rem;
    }
    .feedback-description__text {
      display: -webkit-box;
      overflow: hidden;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      line-height: 1.5;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    .feedback-description.is-expanded .feedback-description__text {
      display: block;
    }
    .description-toggle {
      margin-top: var(--space-xs);
      padding-inline: 0;
      --btn-ghost-color: var(--accent);
    }
    .description-toggle svg { width: 1em; height: 1em; }
    .serial {
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .status-select {
      box-sizing: border-box;
      width: 100%;
      min-width: 6rem;
      padding: var(--space-xs) var(--space-sm);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--input-bg, var(--card));
      color: var(--text);
      font: inherit;
      cursor: pointer;
    }
    .status-select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-subtle);
    }
    .status-select:disabled {
      cursor: wait;
      opacity: var(--disabled-opacity, 0.45);
    }
    .status-select--pending { color: var(--muted-strong); }
    .status-select--accepted { color: var(--accent); }
    .status-select--resolved { color: var(--ok); }
    .actions {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
    }
    .actions .is-copied { color: var(--ok); }
    .actions svg, .page-header svg {
      width: 1rem;
      height: 1rem;
    }
    .field {
      box-sizing: border-box;
      width: 100%;
      padding: var(--space-sm) var(--space-md);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--input-bg, var(--card));
      color: var(--text);
      font: inherit;
    }
    .field:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-subtle);
    }
    textarea.field { min-height: 8rem; resize: vertical; line-height: 1.5; }
    .dialog-error { margin: 0 0 var(--space-md); color: var(--danger); font-size: var(--text-sm); }
    .delete-copy { margin: 0; color: var(--text); line-height: 1.6; }
    .delete-copy strong { color: var(--text-strong); }
    @media (max-width: 640px) {
      .page-header { align-items: stretch; flex-direction: column; }
      .page-header .btn-primary { justify-content: center; }
      .table-wrap { overflow-x: visible; }
      app-data-table .data-table,
      app-data-table .data-table tbody { display: block; width: 100%; }
      app-data-table .data-table thead { display: none; }
      app-data-table .data-table tr {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: var(--space-sm) var(--space-md);
        padding: var(--space-md);
        border-bottom: 1px solid var(--border);
      }
      app-data-table .data-table td {
        min-width: 0;
        padding: 0;
        border: 0;
      }
      app-data-table .data-table td:nth-child(1) {
        grid-column: 1;
        grid-row: 1;
      }
      app-data-table .data-table td:nth-child(2) {
        grid-column: 2;
        grid-row: 1;
        color: var(--text-strong);
        font-weight: 600;
      }
      app-data-table .data-table td:nth-child(3) { grid-column: 1 / -1; }
      app-data-table .data-table td:nth-child(4),
      app-data-table .data-table td:nth-child(5),
      app-data-table .data-table td:nth-child(6),
      app-data-table .data-table td:nth-child(7),
      app-data-table .data-table td:nth-child(8) {
        grid-column: 1 / -1;
        color: var(--muted);
      }
      app-data-table .data-table td:nth-child(4)::before { content: '状态：'; }
      app-data-table .data-table td:nth-child(5)::before { content: '来源：'; }
      app-data-table .data-table td:nth-child(6)::before { content: '提交人：'; }
      app-data-table .data-table td:nth-child(7)::before { content: '创建时间：'; }
      app-data-table .data-table td:nth-child(8)::before { content: '更新时间：'; }
      app-data-table .data-table td:nth-child(4) {
        display: flex;
        align-items: center;
        gap: var(--space-sm);
      }
      app-data-table .data-table td:nth-child(8) {
        grid-column: 3;
        grid-row: 1;
      }
      .feedback-description {
        min-width: 0;
        max-width: none;
      }
      .status-select { width: auto; }
    }
  `];

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  disconnectedCallback(): void {
    if (this.copyResetTimer !== undefined) window.clearTimeout(this.copyResetTimer);
    super.disconnectedCallback();
  }

  private async load(): Promise<void> {
    this.loading = true;
    try {
      const response = await apiClient.get<{ feedback: FeedbackItem[] }>('/feedback');
      this.items = response.feedback ?? [];
    } catch {
      showToast('加载问题反馈失败', 'error');
    } finally {
      this.loading = false;
    }
  }

  private openCreate(): void {
    this.editing = null;
    this.titleValue = '';
    this.descriptionValue = '';
    this.formError = '';
    this.editorOpen = true;
  }

  private openEdit(item: FeedbackItem): void {
    this.editing = item;
    this.titleValue = item.title;
    this.descriptionValue = item.description;
    this.formError = '';
    this.editorOpen = true;
  }

  private closeEditor(): void {
    if (this.saving) return;
    this.editorOpen = false;
    this.formError = '';
  }

  private async save(): Promise<void> {
    const title = this.titleValue.trim();
    const description = this.descriptionValue.trim();
    if (!title || !description) {
      this.formError = '请填写问题标题和问题描述';
      return;
    }
    this.saving = true;
    this.formError = '';
    try {
      if (this.editing) {
        await apiClient.put(`/feedback/${this.editing.id}`, { title, description });
        showToast('问题反馈已更新', 'success');
      } else {
        await apiClient.post('/feedback', { title, description });
        showToast('问题反馈已提交', 'success');
      }
      this.editorOpen = false;
      await this.load();
    } catch {
      this.formError = this.editing ? '更新问题反馈失败' : '提交问题反馈失败';
    } finally {
      this.saving = false;
    }
  }

  private async deleteFeedback(): Promise<void> {
    if (!this.deleteTarget || this.saving) return;
    this.saving = true;
    try {
      await apiClient.delete(`/feedback/${this.deleteTarget.id}`);
      showToast('问题反馈已删除', 'success');
      this.deleteTarget = null;
      await this.load();
    } catch {
      showToast('删除问题反馈失败', 'error');
    } finally {
      this.saving = false;
    }
  }

  private toggleDescription(id: number): void {
    const expandedIds = new Set(this.expandedIds);
    if (expandedIds.has(id)) expandedIds.delete(id);
    else expandedIds.add(id);
    this.expandedIds = expandedIds;
  }

  private async copyDescription(item: FeedbackItem): Promise<void> {
    const copied = await copyTextToClipboard(item.description);
    if (!copied) {
      showToast('复制问题描述失败', 'error');
      return;
    }
    this.copiedId = item.id;
    showToast('问题描述已复制', 'success');
    if (this.copyResetTimer !== undefined) window.clearTimeout(this.copyResetTimer);
    this.copyResetTimer = window.setTimeout(() => {
      this.copiedId = null;
      this.copyResetTimer = undefined;
    }, 1500);
  }

  private async updateStatus(item: FeedbackItem, status: FeedbackStatus): Promise<void> {
    if (status === item.status || this.statusSavingIds.has(item.id)) return;
    this.statusSavingIds = new Set([...this.statusSavingIds, item.id]);
    try {
      const response = await apiClient.put<{ feedback: FeedbackItem }>(`/feedback/${item.id}`, {
        title: item.title,
        description: item.description,
        status,
      });
      this.items = this.items.map((current) => current.id === item.id ? response.feedback : current);
      showToast('问题状态已更新', 'success');
    } catch {
      showToast('更新问题状态失败', 'error');
    } finally {
      const statusSavingIds = new Set(this.statusSavingIds);
      statusSavingIds.delete(item.id);
      this.statusSavingIds = statusSavingIds;
    }
  }

  private formatTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN');
  }

  private rows(): Record<string, unknown>[] {
    return this.items.map((item) => {
      const expanded = this.expandedIds.has(item.id);
      const canExpand = item.description.length > 48;
      const statusSaving = this.statusSavingIds.has(item.id);
      return {
        serial: html`<span class="serial">${item.id}</span>`,
        title: item.title,
        description: html`
          <div class="feedback-description ${expanded ? 'is-expanded' : ''}">
            <span class="feedback-description__text" id="feedback-description-${item.id}">${item.description}</span>
            ${canExpand ? html`
              <button
                class="btn-ghost description-toggle"
                type="button"
                aria-controls="feedback-description-${item.id}"
                aria-expanded=${expanded ? 'true' : 'false'}
                aria-label="${expanded ? '收起' : '展开'} ${item.title} 的问题描述"
                @click=${() => this.toggleDescription(item.id)}
              >
                ${expanded ? '收起' : '展开'}
                ${expanded ? icons['chevron-up'] : icons['chevron-down']}
              </button>
            ` : nothing}
          </div>
        `,
        status: html`
          <select
            class="status-select status-select--${item.status}"
            aria-label="更新 ${item.title} 的状态"
            .value=${item.status}
            .disabled=${statusSaving}
            @change=${(event: Event) => {
              void this.updateStatus(item, (event.currentTarget as HTMLSelectElement).value as FeedbackStatus);
            }}
          >
            ${FEEDBACK_STATUSES.map((option) => html`
              <option value=${option.value} .selected=${option.value === item.status}>${option.label}</option>
            `)}
          </select>
        `,
        source: html`<app-badge variant=${item.source === 'agent' ? 'info' : 'muted'}>${item.source === 'agent' ? 'Agent' : '手动'}</app-badge>`,
        author: item.createdByUsername ?? '已删除用户',
        createdAt: this.formatTime(item.createdAt),
        updatedAt: this.formatTime(item.updatedAt),
        actions: html`<span class="actions">
          <button
            class="btn-icon ${this.copiedId === item.id ? 'is-copied' : ''}"
            type="button"
            title="复制问题描述"
            aria-label="复制 ${item.title} 的问题描述"
            @click=${() => { void this.copyDescription(item); }}
          >${this.copiedId === item.id ? icons.check : icons.copy}</button>
          <button class="btn-icon" type="button" title="编辑" aria-label="编辑 ${item.title}" @click=${() => this.openEdit(item)}>${icons.pencil}</button>
          <button class="btn-icon" type="button" title="删除" aria-label="删除 ${item.title}" @click=${() => { this.deleteTarget = item; }}>${icons.trash}</button>
        </span>`,
      };
    });
  }

  render() {
    const columns = [
      { key: 'serial', label: '序号', width: '3rem' },
      { key: 'title', label: '标题', width: '8rem' },
      { key: 'description', label: '问题描述' },
      { key: 'status', label: '状态', width: '6.5rem' },
      { key: 'source', label: '来源', width: '5rem' },
      { key: 'author', label: '提交人', width: '6rem' },
      { key: 'createdAt', label: '创建时间', width: '9rem' },
      { key: 'updatedAt', label: '更新时间', width: '9rem' },
      { key: 'actions', label: '操作', width: '6.5rem' },
    ];

    return html`
      <div class="page-header">
        <div>
          <h1>问题反馈</h1>
          <p>提交、修改和查看问题反馈，Agent 代为记录的问题也会显示在这里。</p>
        </div>
        <button class="btn-primary" type="button" @click=${this.openCreate}>${icons.plus} 新增反馈</button>
      </div>

      <app-card .compact=${true}>
        <div class="table-wrap">
          <app-data-table
            .columns=${columns}
            .rows=${this.rows()}
            .loading=${this.loading}
            .dense=${true}
            emptyMessage="暂无问题反馈"
          ></app-data-table>
        </div>
      </app-card>

      <app-dialog
        .open=${this.editorOpen}
        size="md"
        title=${this.editing ? '编辑问题反馈' : '新增问题反馈'}
        .closeOnOverlay=${false}
        @app-dialog-close=${this.closeEditor}
      >
        ${this.formError ? html`<p class="dialog-error" role="alert">${this.formError}</p>` : nothing}
        <app-form-field label="问题标题" .required=${true}>
          <input class="field" maxlength="160" .value=${this.titleValue} @input=${(event: Event) => { this.titleValue = (event.target as HTMLInputElement).value; }}>
        </app-form-field>
        <app-form-field label="问题描述" hint="请说明遇到的现象、预期结果和必要的复现条件" .required=${true}>
          <textarea class="field" maxlength="5000" .value=${this.descriptionValue} @input=${(event: Event) => { this.descriptionValue = (event.target as HTMLTextAreaElement).value; }}></textarea>
        </app-form-field>
        <button slot="footer" class="btn" type="button" @click=${this.closeEditor} .disabled=${this.saving}>取消</button>
        <button slot="footer" class="btn-primary" type="button" @click=${this.save} .disabled=${this.saving}>${icons.save} ${this.saving ? '保存中' : '保存'}</button>
      </app-dialog>

      <app-dialog
        .open=${Boolean(this.deleteTarget)}
        size="sm"
        title="删除问题反馈"
        @app-dialog-close=${() => { if (!this.saving) this.deleteTarget = null; }}
      >
        <p class="delete-copy">确定删除“<strong>${this.deleteTarget?.title ?? ''}</strong>”吗？此操作无法撤销。</p>
        <button slot="footer" class="btn" type="button" @click=${() => { this.deleteTarget = null; }} .disabled=${this.saving}>取消</button>
        <button slot="footer" class="btn-primary btn-danger" type="button" @click=${this.deleteFeedback} .disabled=${this.saving}>${icons.trash} ${this.saving ? '删除中' : '删除'}</button>
      </app-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'feedback-page': FeedbackPage;
  }
}
