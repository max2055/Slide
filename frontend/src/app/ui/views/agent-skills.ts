import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { apiClient } from '../../../api/index.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { showToast } from '../components/app-toast-container.js';
import '../components/app-data-table.js';
import '../components/app-badge.js';

interface Skill {
  name: string;
  description: string;
  filePath: string;
  enabled: boolean;
  frontmatter: Record<string, unknown>;
}

@customElement('agent-skills-page')
export class AgentSkillsPage extends LitElement {
  @state() private skills: Skill[] = [];
  @state() private loading = true;

  static styles = [sharedBtnStyles, css`
    :host { display: block; padding: var(--space-lg); }
    .page-header { margin-bottom: var(--space-lg); }
    .page-header h1 { font-size: 22px; font-weight: 700; margin: 0 0 var(--space-xs); color: var(--text-strong); }
    .page-header p { font-size: 13px; color: var(--muted); margin: 0; }
    .skill-description { max-width: 400px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .skill-path { font-size: 11px; color: var(--muted); font-family: monospace; }
  `];

  async connectedCallback() {
    super.connectedCallback();
    await this.loadSkills();
  }

  async loadSkills() {
    this.loading = true;
    try {
      const res = await apiClient.get<any>('/agent/skills');
      this.skills = res.skills || [];
    } catch (err) {
      showToast('加载技能列表失败', 'error');
    } finally {
      this.loading = false;
    }
  }

  async toggleSkill(skill: Skill) {
    try {
      await apiClient.post(`/agent/skills/${skill.name}/toggle`, { enabled: !skill.enabled });
      showToast(`技能 ${skill.name} 已${skill.enabled ? '禁用' : '启用'}`, 'success');
      await this.loadSkills();
    } catch (err) {
      showToast('切换技能状态失败', 'error');
    }
  }

  render() {
    const columns = [
      { key: 'name', label: '名称' },
      { key: 'description', label: '描述' },
      { key: 'filePath', label: '文件路径' },
      { key: 'enabled', label: '状态' },
      { key: 'actions', label: '操作' },
    ];

    const rows = this.skills.map((s) => ({
      ...s,
      description: html`<div class="skill-description" title=${s.description}>${s.description}</div>`,
      filePath: html`<div class="skill-path">${s.filePath}</div>`,
      enabled: html`<app-badge variant=${s.enabled ? 'ok' : 'muted'}>${s.enabled ? '已启用' : '已禁用'}</app-badge>`,
      actions: html`<button class="btn" @click=${() => this.toggleSkill(s)}>${s.enabled ? '禁用' : '启用'}</button>`,
    }));

    return html`
      <div class="page-header">
        <h1>Agent 技能管理</h1>
        <p>查看和管理 Agent 加载的技能文件</p>
      </div>

      ${this.loading
        ? html`<div class="skeleton">加载中...</div>`
        : html`<app-data-table .columns=${columns} .rows=${rows}></app-data-table>`}
    `;
  }
}

declare global { interface HTMLElementTagNameMap { 'agent-skills-page': AgentSkillsPage; } }
