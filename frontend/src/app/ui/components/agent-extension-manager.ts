import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { showToast } from './app-toast-container.js';
import './app-dialog.js';

type ExtensionKind = 'tool' | 'skill';
type Extension = { id: number; kind: ExtensionKind; name: string; description: string; definition: Record<string, unknown>; sourceText: string | null; status: string; version: number };

function isAdmin(): boolean {
  try {
    const permissions = JSON.parse(localStorage.getItem('permissions') || '[]');
    return Array.isArray(permissions) && (permissions.includes('*') || permissions.includes('admin:*'));
  } catch { return false; }
}

@customElement('agent-extension-manager')
export class AgentExtensionManager extends LitElement {
  @property() kind: ExtensionKind = 'tool';
  @state() private extensions: Extension[] = [];
  @state() private open = false;
  @state() private editing: Extension | null = null;
  @state() private name = '';
  @state() private description = '';
  @state() private definition = '{}';
  @state() private sourceText = '';
  @state() private saving = false;

  static styles = [sharedBtnStyles, css`
    :host { display: block; margin-bottom: 20px; }
    .header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .title { font-size: 14px; font-weight: 600; color: var(--text-strong); }
    .item { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
    .item-name { min-width: 150px; font-weight: 600; }
    .item-desc { flex: 1; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status { color: var(--muted); }
    .form { display: grid; gap: 12px; }
    label { display: grid; gap: 5px; font-size: 12px; color: var(--muted); }
    input, textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px; color: var(--text); background: var(--card); font: inherit; }
    textarea { min-height: 100px; font-family: var(--mono, monospace); }
  `];

  connectedCallback() { super.connectedCallback(); void this.load(); }

  private async load() {
    if (!isAdmin()) return;
    try {
      const result = await apiClient.get<{ extensions: Extension[] }>(`/agent/extensions?kind=${this.kind}`);
      this.extensions = result.extensions || [];
    } catch { showToast('加载扩展列表失败', 'error'); }
  }

  private beginCreate() { this.editing = null; this.name = ''; this.description = ''; this.definition = this.kind === 'tool' ? '{\n  "parameters": { "type": "object", "properties": {} }\n}' : '{\n  "frontmatter": {}\n}'; this.sourceText = ''; this.open = true; }
  private beginEdit(extension: Extension) { this.editing = extension; this.name = extension.name; this.description = extension.description; this.definition = JSON.stringify(extension.definition, null, 2); this.sourceText = extension.sourceText || ''; this.open = true; }
  private close() { this.open = false; }

  private async save() {
    let definition: Record<string, unknown>;
    try { definition = JSON.parse(this.definition) as Record<string, unknown>; } catch { showToast('定义必须是合法 JSON', 'error'); return; }
    this.saving = true;
    try {
      const body = { kind: this.kind, name: this.name.trim(), description: this.description, definition, sourceText: this.sourceText || null };
      if (this.editing) await apiClient.put(`/agent/extensions/${this.editing.id}`, body);
      else await apiClient.post('/agent/extensions', body);
      showToast('扩展草稿已保存', 'success'); this.close(); await this.load();
    } catch { showToast('保存扩展失败', 'error'); } finally { this.saving = false; }
  }

  private async publish(extension: Extension) { try { await apiClient.post(`/agent/extensions/${extension.id}/publish`, {}); showToast('扩展已发布', 'success'); await this.load(); } catch { showToast('发布扩展失败', 'error'); } }
  private async archive(extension: Extension) { if (!window.confirm(`确认归档 ${extension.name}？`)) return; try { await apiClient.delete(`/agent/extensions/${extension.id}`); showToast('扩展已归档', 'success'); await this.load(); } catch { showToast('归档扩展失败', 'error'); } }

  render() {
    if (!isAdmin()) return nothing;
    const label = this.kind === 'tool' ? 'Tool 扩展' : 'Skill 扩展';
    return html`
      <div class="header"><span class="title">${label}</span><button class="btn" @click=${this.beginCreate}>新增</button></div>
      ${this.extensions.map(extension => html`<div class="item"><span class="item-name">${extension.name}</span><span class="item-desc">${extension.description}</span><span class="status">${extension.status === 'published' ? '已发布' : '草稿'} · v${extension.version}</span><button class="btn" @click=${() => this.beginEdit(extension)}>编辑</button>${extension.status === 'draft' ? html`<button class="btn-primary" @click=${() => this.publish(extension)}>发布</button>` : nothing}<button class="btn-ghost" @click=${() => this.archive(extension)}>归档</button></div>`)}
      <app-dialog .open=${this.open} size="lg" title="${this.editing ? '编辑' : '新增'}${label}" @app-dialog-close=${this.close}>
        <div class="form">
          <label>名称<input .value=${this.name} @input=${(e: Event) => this.name = (e.target as HTMLInputElement).value} maxlength="128"></label>
          <label>描述<input .value=${this.description} @input=${(e: Event) => this.description = (e.target as HTMLInputElement).value} maxlength="2000"></label>
          <label>声明式定义（JSON）<textarea .value=${this.definition} @input=${(e: Event) => this.definition = (e.target as HTMLTextAreaElement).value}></textarea></label>
          <label>说明文本（可选）<textarea .value=${this.sourceText} @input=${(e: Event) => this.sourceText = (e.target as HTMLTextAreaElement).value}></textarea></label>
        </div>
        <div slot="footer"><button class="btn" @click=${this.close}>取消</button><button class="btn-primary" ?disabled=${this.saving} @click=${this.save}>${this.saving ? '保存中...' : '保存草稿'}</button></div>
      </app-dialog>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'agent-extension-manager': AgentExtensionManager; } }
