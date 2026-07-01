import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { showToast } from '../components/app-toast-container.js';
import '../components/app-badge.js';
import '../components/app-dialog.js';

interface PromptVersion {
  version: number;
  content: string;
  length: number;
  fileName: string;
}

interface PromptTypeInfo {
  type: string;
  versions: PromptVersion[];
  activeVersion: number;
}

const TYPE_LABELS: Record<string, string> = {
  'fault-diagnosis': '故障诊断',
  'alert-rca': '告警根因分析',
  'topsql-analysis': 'TopSQL 分析',
};

const TYPE_DESCS: Record<string, string> = {
  'fault-diagnosis': '一键诊断 Agent 使用的系统提示词',
  'alert-rca': '告警根因分析 Agent 使用的系统提示词',
  'topsql-analysis': '慢查询优化分析 Agent 使用的系统提示词',
};

@customElement('prompt-settings-page')
export class PromptSettingsPage extends LitElement {
  @state() private types: PromptTypeInfo[] = [];
  @state() private loading = true;
  @state() private selectedType: PromptTypeInfo | null = null;
  @state() private selectedVersion: PromptVersion | null = null;
  @state() private editorContent = '';
  @state() private editorSaving = false;
  @state() private optimizing = false;
  @state() private optimizeFocus = '';
  @state() private showEditor = false;
  @state() private showOptimizeDialog = false;
  @state() private optimizeResult = '';

  static styles = [sharedBtnStyles, css`
    :host { display: block; animation: fade-in 0.25s var(--ease-out); }
    @keyframes fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
    .page-header h1 { font-size: 22px; font-weight: 700; margin: 0 0 4px; color: var(--text-strong); }
    .page-header p { font-size: 13px; color: var(--muted); margin: 0; }

    .type-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); margin-bottom: var(--space-md); overflow: hidden; transition: box-shadow 0.2s; }
    .type-card:hover { box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    .type-header { display: flex; align-items: center; justify-content: space-between; padding: var(--space-md) var(--space-lg); cursor: pointer; gap: var(--space-md); }
    .type-header:hover { background: var(--bg-elevated); }
    .type-info { flex: 1; min-width: 0; }
    .type-name { font-size: 14px; font-weight: 600; color: var(--text-strong); }
    .type-desc { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .type-meta { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .expand-arrow { transition: transform 0.2s; color: var(--muted); }
    .expand-arrow.open { transform: rotate(180deg); }

    .version-list { padding: 0 var(--space-lg) var(--space-md); }
    .version-item { display: flex; align-items: center; gap: var(--space-md); padding: var(--space-sm) var(--space-md); border-radius: var(--radius-sm); transition: background 0.15s; }
    .version-item:hover { background: var(--bg-elevated); }
    .version-item.active { background: var(--accent-subtle); }
    .version-badge { flex-shrink: 0; }
    .version-size { font-size: 11px; color: var(--muted); font-family: var(--mono, monospace); min-width: 80px; }
    .version-actions { display: flex; gap: 4px; margin-left: auto; flex-shrink: 0; }

    .editor-container { padding: var(--space-lg); }
    .editor-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-md); gap: var(--space-md); flex-wrap: wrap; }
    .editor-title { font-size: 14px; font-weight: 600; color: var(--text-strong); }
    .editor-info { font-size: 11px; color: var(--muted); font-family: var(--mono, monospace); }
    textarea.editor { width: 100%; min-height: 400px; padding: var(--space-md); font-family: var(--mono, monospace); font-size: 13px; line-height: 1.6; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); resize: vertical; outline: none; box-sizing: border-box; }
    textarea.editor:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-subtle); }

    .optimize-dialog { width: 800px; max-width: 95vw; }
    .optimize-result { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-md); margin-top: var(--space-md); max-height: 400px; overflow-y: auto; white-space: pre-wrap; font-size: 13px; line-height: 1.6; }
    .optimize-input { width: 100%; padding: var(--space-sm) var(--space-md); font-size: 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--card); color: var(--text); outline: none; box-sizing: border-box; }
    .optimize-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-subtle); }
  `];

  async connectedCallback() {
    super.connectedCallback();
    await this.loadTypes();
  }

  async loadTypes() {
    this.loading = true;
    try {
      const res = await apiClient.get<any>('/ai/prompts');
      this.types = res.types || [];
    } catch (err) {
      showToast('加载提示词列表失败', 'error');
    } finally {
      this.loading = false;
    }
  }

  activeVersionOf(type: PromptTypeInfo): PromptVersion | undefined {
    return type.versions.find(v => v.version === type.activeVersion) ?? type.versions[0];
  }

  async switchVersion(type: PromptTypeInfo, version: number) {
    try {
      await apiClient.post(`/ai/prompts/${type.type}/switch`, { version });
      type.activeVersion = version;
      this.requestUpdate();
      showToast(`已切换到 v${version}`);
    } catch (err) {
      showToast('切换版本失败', 'error');
    }
  }

  openEditor(type: PromptTypeInfo, version: PromptVersion) {
    this.selectedType = type;
    this.selectedVersion = version;
    this.editorContent = version.content;
    this.showEditor = true;
  }

  closeEditor() {
    this.showEditor = false;
    this.selectedType = null;
    this.selectedVersion = null;
    this.editorContent = '';
  }

  async saveEditor() {
    if (!this.selectedType || !this.selectedVersion) return;
    this.editorSaving = true;
    try {
      await apiClient.put(`/ai/prompts/${this.selectedType.type}/versions/${this.selectedVersion.version}`, { content: this.editorContent });
      this.selectedVersion.content = this.editorContent;
      this.selectedVersion.length = this.editorContent.length;
      this.requestUpdate();
      showToast('已保存');
      this.closeEditor();
    } catch (err) {
      showToast('保存失败', 'error');
    } finally {
      this.editorSaving = false;
    }
  }

  async createNewVersion(type: PromptTypeInfo) {
    const maxVer = Math.max(...type.versions.map(v => v.version));
    // Use the current active version's content as base
    const baseContent = type.versions.find(v => v.version === type.activeVersion)?.content ?? '';
    try {
      const res = await apiClient.post<any>(`/ai/prompts/${type.type}/versions`, { content: baseContent });
      if (res.version) {
        type.versions.push({ version: res.version, content: baseContent, length: baseContent.length, fileName: res.fileName });
        this.requestUpdate();
        showToast(`已创建 v${res.version}`);
      }
    } catch (err) {
      showToast('创建版本失败', 'error');
    }
  }

  async deleteVersion(type: PromptTypeInfo, version: PromptVersion) {
    // For now, just show what would happen — full delete via API coming later
    showToast('删除功能开发中', 'info');
  }

  openOptimize(type: PromptTypeInfo) {
    this.selectedType = type;
    this.optimizeFocus = '';
    this.optimizeResult = '';
    this.showOptimizeDialog = true;
  }

  async runOptimize() {
    if (!this.selectedType) return;
    this.optimizing = true;
    this.optimizeResult = '';
    try {
      const res = await apiClient.post<any>(`/ai/prompts/${this.selectedType.type}/optimize`, {
        focus: this.optimizeFocus || undefined,
      });
      this.optimizeResult = res.analysis || '无返回结果';
    } catch (err) {
      this.optimizeResult = `优化失败：${(err as Error).message}`;
    } finally {
      this.optimizing = false;
    }
  }

  async applyOptimizedContent() {
    if (!this.selectedType || !this.optimizeResult) return;
    // Extract markdown code block content from AI response
    const codeMatch = this.optimizeResult.match(/```markdown\n([\s\S]*?)```/);
    const content = codeMatch ? codeMatch[1].trim() : this.optimizeResult;
    // Create a new version with the optimized content
    try {
      const res = await apiClient.post<any>(`/ai/prompts/${this.selectedType.type}/versions`, { content });
      if (res.version) {
        this.selectedType.versions.push({ version: res.version, content, length: content.length, fileName: res.fileName });
        this.requestUpdate();
        showToast(`已保存优化结果为 v${res.version}`);
        this.showOptimizeDialog = false;
        this.optimizeResult = '';
      }
    } catch (err) {
      showToast('保存优化版本失败', 'error');
    }
  }

  render() {
    if (this.loading) return html`<div style="padding:40px;text-align:center;color:var(--muted);font-size:13px;">加载中...</div>`;

    return html`
      <div class="page-header">
        <div>
          <h1>AI 提示词管理</h1>
          <p>查看、编辑和优化 AI 分析 Agent 的系统提示词，支持多版本管理和 AI 辅助优化</p>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn" @click=${this.loadTypes} title="刷新列表">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            刷新
          </button>
        </div>
      </div>

      ${this.types.length === 0 ? html`<div style="padding:40px;text-align:center;color:var(--muted);font-size:13px;">暂无提示词数据</div>` : ''}

      ${this.types.map(type => {
        const activeV = this.activeVersionOf(type);
        const isExpanded = this._expandedTypes?.has(type.type) ?? false;
        const toggleExpand = () => {
          if (!this._expandedTypes) this._expandedTypes = new Set();
          if (this._expandedTypes.has(type.type)) this._expandedTypes.delete(type.type);
          else this._expandedTypes.add(type.type);
          this.requestUpdate();
        };

        return html`
          <div class="type-card">
            <div class="type-header" @click=${toggleExpand}>
              <div class="type-info">
                <div class="type-name">${TYPE_LABELS[type.type] || type.type}</div>
                <div class="type-desc">${TYPE_DESCS[type.type] || ''}</div>
              </div>
              <div class="type-meta">
                <app-badge variant="info">${type.versions.length} 个版本</app-badge>
                ${activeV ? html`<app-badge variant="ok">v${activeV.version} 使用中</app-badge>` : ''}
                <span class="expand-arrow ${isExpanded ? 'open' : ''}">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                </span>
              </div>
            </div>

            ${isExpanded ? html`
              <div class="version-list">
                ${type.versions.sort((a, b) => b.version - a.version).map(v => html`
                  <div class="version-item ${v.version === type.activeVersion ? 'active' : ''}">
                    <div class="version-badge">
                      ${v.version === type.activeVersion
                        ? html`<app-badge variant="ok">v${v.version}</app-badge>`
                        : html`<app-badge variant="muted">v${v.version}</app-badge>`}
                    </div>
                    <span class="version-size">${v.length} chars · ${v.fileName}</span>
                    <div class="version-actions">
                      ${v.version !== type.activeVersion ? html`
                        <button class="btn-ghost" @click=${() => this.switchVersion(type, v.version)} title="切换到此版本">使用</button>
                      ` : ''}
                      <button class="btn-ghost" @click=${() => this.openEditor(type, v)} title="编辑此版本">编辑</button>
                    </div>
                  </div>
                `)}

                <div style="display:flex;gap:8px;margin-top:var(--space-md);padding-top:var(--space-md);border-top:1px solid var(--border);">
                  <button class="btn" @click=${() => this.createNewVersion(type)}>+ 新建版本</button>
                  <button class="btn" @click=${() => this.openOptimize(type)} title="使用 AI 分析并优化当前提示词">AI 优化</button>
                </div>
              </div>
            ` : ''}
          </div>
        `;
      })}

      ${this.showEditor ? html`
        <app-dialog .open=${true} size="xl" title="编辑提示词 — ${TYPE_LABELS[this.selectedType!.type] || this.selectedType!.type} v${this.selectedVersion!.version}" @app-dialog-close=${this.closeEditor}>
          <div class="editor-container">
            <div class="editor-toolbar">
              <span class="editor-title">${this.selectedVersion!.fileName}</span>
              <span class="editor-info">${this.editorContent.length} 字符</span>
            </div>
            <textarea class="editor" .value=${this.editorContent} @input=${(e: InputEvent) => { this.editorContent = (e.target as HTMLTextAreaElement).value; }}></textarea>
          </div>
          <div slot="footer">
            <button class="btn" @click=${this.closeEditor} ?disabled=${this.editorSaving}>取消</button>
            <button class="btn-primary" @click=${this.saveEditor} ?disabled=${this.editorSaving}>${this.editorSaving ? '保存中...' : '保存'}</button>
          </div>
        </app-dialog>
      ` : ''}

      ${this.showOptimizeDialog ? html`
        <app-dialog .open=${true} size="xl" title="AI 优化提示词 — ${TYPE_LABELS[this.selectedType!.type] || this.selectedType!.type}" @app-dialog-close=${() => { this.showOptimizeDialog = false; this.optimizeResult = ''; }}>
          <div style="padding:var(--space-md);">
            <div class="editor-toolbar">
              <span class="editor-info">将使用项目的 AI Agent 分析当前提示词并给出优化建议</span>
            </div>
            <div style="margin-bottom:var(--space-md);">
              <label style="font-size:12px;font-weight:600;color:var(--text);display:block;margin-bottom:4px;">优化重点（可选）</label>
              <input class="optimize-input" placeholder="例如：增加具体工具使用的示例、优化输出格式要求…" .value=${this.optimizeFocus} @input=${(e: InputEvent) => { this.optimizeFocus = (e.target as HTMLInputElement).value; }} />
            </div>
            <button class="btn-primary" @click=${this.runOptimize} ?disabled=${this.optimizing}>
              ${this.optimizing ? 'AI 分析中...' : '开始优化'}
            </button>

            ${this.optimizeResult ? html`
              <div class="optimize-result">${this.optimizeResult}</div>
              <div style="margin-top:var(--space-md);text-align:right;">
                <button class="btn-primary" @click=${this.applyOptimizedContent}>
                  应用优化结果（创建新版本）
                </button>
              </div>
            ` : ''}
          </div>
        </app-dialog>
      ` : ''}
    `;
  }

  private _expandedTypes: Set<string> | null = null;
}

declare global {
  interface HTMLElementTagNameMap {
    'prompt-settings-page': PromptSettingsPage;
  }
}
