import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { showToast } from '../components/app-toast-container.js';
import '../components/app-data-table.js';

interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

@customElement('agent-tools-page')
export class AgentToolsPage extends LitElement {
  @state() private tools: Tool[] = [];
  @state() private loading = true;
  @state() private expandedTool: string | null = null;

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
    .tool-description { max-width: 400px; }
    .schema-toggle { font-size: 12px; padding: 2px 8px; }
    .schema-viewer { margin-top: var(--space-sm); padding: var(--space-sm); background: var(--card); border-radius: var(--radius-sm); font-family: monospace; font-size: 12px; white-space: pre-wrap; max-height: 300px; overflow-y: auto; }
  `];

  async connectedCallback() {
    super.connectedCallback();
    await this.loadTools();
  }

  async loadTools() {
    this.loading = true;
    try {
      const res = await apiClient.get<any>('/agent/tools');
      this.tools = res.tools || [];
    } catch (err) {
      showToast('加载工具列表失败', 'error');
    } finally {
      this.loading = false;
    }
  }

  toggleSchema(toolName: string) {
    this.expandedTool = this.expandedTool === toolName ? null : toolName;
  }

  render() {
    const columns = [
      { key: 'name', label: '名称' },
      { key: 'description', label: '描述' },
      { key: 'actions', label: 'Schema' },
    ];

    const rows = this.tools.map((t) => ({
      ...t,
      description: html`<div class="tool-description">${t.description}</div>`,
      actions: html`
        <button class="btn schema-toggle" @click=${() => this.toggleSchema(t.name)}>
          ${this.expandedTool === t.name ? '收起' : '查看'}
        </button>
        ${this.expandedTool === t.name
          ? html`<div class="schema-viewer">${JSON.stringify(t.parameters, null, 2)}</div>`
          : ''}
      `,
    }));

    return html`
      <div class="page">
        <div class="page-header">
          <div>
            <h1>Agent 工具列表</h1>
            <p>查看 Agent 注册的所有工具及其 Schema 定义</p>
          </div>
        </div>

      ${this.loading
        ? html`<div class="skeleton">加载中...</div>`
        : html`<app-data-table .columns=${columns} .rows=${rows}></app-data-table>`}
      </div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'agent-tools-page': AgentToolsPage; } }
