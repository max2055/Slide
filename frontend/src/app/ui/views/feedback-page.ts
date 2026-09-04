import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.js';
import { icons } from '../../../icons.js';
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
  createdBy: number | null;
  createdByUsername: string | null;
  createdAt: string;
  updatedAt: string;
}

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
      max-width: 32rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .actions { display: inline-flex; align-items: center; gap: var(--space-xs); }
    .actions svg, .page-header svg { width: 1rem; height: 1rem; }
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
        grid-template-columns: minmax(0, 1fr) auto;
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
        color: var(--text-strong);
        font-weight: 600;
      }
      app-data-table .data-table td:nth-child(2) { grid-column: 1 / -1; }
      app-data-table .data-table td:nth-child(3),
      app-data-table .data-table td:nth-child(4),
      app-data-table .data-table td:nth-child(5) {
        grid-column: 1 / -1;
        color: var(--muted);
      }
      app-data-table .data-table td:nth-child(3)::before { content: '来源：'; }
      app-data-table .data-table td:nth-child(4)::before { content: '提交人：'; }
      app-data-table .data-table td:nth-child(5)::before { content: '更新时间：'; }
      app-data-table .data-table td:nth-child(6) {
        grid-column: 2;
        grid-row: 1;
      }
      .feedback-description {
        max-width: none;
        white-space: normal;
        overflow-wrap: anywhere;
        line-height: 1.5;
      }
    }
  `];

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
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

  private formatTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN');
  }

  private rows(): Record<string, unknown>[] {
    return this.items.map((item) => ({
      title: item.title,
      description: html`<span class="feedback-description" title=${item.description}>${item.description}</span>`,
      source: html`<app-badge variant=${item.source === 'agent' ? 'info' : 'muted'}>${item.source === 'agent' ? 'Agent' : '手动'}</app-badge>`,
      author: item.createdByUsername ?? '已删除用户',
      updatedAt: this.formatTime(item.updatedAt),
      actions: html`<span class="actions">
        <button class="btn-icon" type="button" title="编辑" aria-label="编辑 ${item.title}" @click=${() => this.openEdit(item)}>${icons.pencil}</button>
        <button class="btn-icon" type="button" title="删除" aria-label="删除 ${item.title}" @click=${() => { this.deleteTarget = item; }}>${icons.trash}</button>
      </span>`,
    }));
  }

  render() {
    const columns = [
      { key: 'title', label: '标题', width: '20%' },
      { key: 'description', label: '问题描述' },
      { key: 'source', label: '来源', width: '6rem' },
      { key: 'author', label: '提交人', width: '8rem' },
      { key: 'updatedAt', label: '更新时间', width: '11rem' },
      { key: 'actions', label: '操作', width: '5rem' },
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
