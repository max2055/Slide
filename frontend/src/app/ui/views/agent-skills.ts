import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { showToast } from '../components/app-toast-container.js';
import { readCachedPermissions } from '../permissions.js';
import { AgentListPage, AgentListError, agentListStyles, agentListRequest, listError } from './agent-tools.js';

interface Skill {
  name: string; description: string; filePath: string; enabled: boolean;
  frontmatter: Record<string, unknown>; source?: string; digest?: string; trusted?: boolean;
}

@customElement('agent-skills-page')
export class AgentSkillsPage extends AgentListPage<Skill> {
  protected endpoint = '/agent/skills';
  protected collection = 'skills';
  protected subject = '读取技能清单';
  @state() private selected: Skill | null = null;
  @state() private pending: string | null = null;
  @state() private toggleError = '';
  static styles = [sharedBtnStyles, agentListStyles];
  protected clearDetails() { this.selected = null; this.pending = null; this.toggleError = ''; }
  private canManage() { const permissions = readCachedPermissions(); return !!permissions && (permissions.has('*') || permissions.has('config:manage')); }
  async toggleSkill(skill: Skill) {
    if (this.pending || !this.canManage()) return;
    const generation = this.generation, enabled = !skill.enabled;
    this.pending = skill.name; this.toggleError = '';
    try {
      const result = await agentListRequest<{ ok: boolean }>(`/agent/skills/${encodeURIComponent(skill.name)}/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
      if (generation !== this.generation || !this.isConnected) return;
      if (result.ok !== true) throw new Error('Toggle not acknowledged');
      const refreshed = await agentListRequest<{ skills: Skill[] }>('/agent/skills');
      if (generation !== this.generation || !this.isConnected) return;
      if (!Array.isArray(refreshed.skills)) throw new Error('Invalid list response');
      this.items = refreshed.skills;
      this.selected = this.selected ? refreshed.skills.find(s => s.name === this.selected!.name) ?? null : null;
      if (refreshed.skills.find(s => s.name === skill.name)?.enabled !== enabled) throw new Error('Toggle readback mismatch');
      showToast(`技能 ${skill.name} 已${enabled ? '启用' : '禁用'}`, 'success');
    } catch (error) {
      if (generation !== this.generation) return;
      this.toggleError = `${listError(error, '切换技能状态')} 状态尚未确认，请重新读取后核对。`;
      if (error instanceof AgentListError && [401, 403].includes(error.status)) { this.items = []; this.selected = null; this.error = this.toggleError; }
    } finally { if (generation === this.generation) this.pending = null; }
  }
  render() {
    const selected = this.selected, canManage = this.canManage();
    const entries = this.items.filter(s => [s.name, s.description, s.filePath, s.source, s.enabled ? '已启用' : '已禁用'].join(' ').toLowerCase().includes(this.query.trim().toLowerCase()) && (this.filter === 'all' || (this.filter === 'enabled' ? s.enabled === true : this.filter === 'disabled' ? s.enabled === false : typeof s.enabled !== 'boolean')))
      .sort((a, b) => (this.sort === 'name-desc' ? -1 : 1) * (a.name.localeCompare(b.name, 'zh-CN') || a.filePath.localeCompare(b.filePath)));
    return html`
      <header class="page-header"><div><h1>技能清单</h1><p class="caption">先看用途与启停状态，路径和原始配置按需查看。</p></div><button class="btn" ?disabled=${this.loading || !!this.pending} @click=${this.load}>刷新</button></header>
      ${this.toggleError && !this.error ? html`<p role="alert">${this.toggleError} <button class="btn" @click=${this.load}>重新读取</button></p>` : nothing}
      ${this.list({ entries, placeholder: '查找技能名称、用途、路径或状态', empty: '暂无已加载技能', filters: [['enabled', '已启用'], ['disabled', '已禁用'], ['unknown', '状态未知']],
        columns: [{ key: 'name', label: '技能与用途', width: '60%' }, { key: 'status', label: '状态', width: '16%' }, { key: 'actions', label: '操作', width: '24%' }],
        row: s => ({ name: html`<span class="entity" title=${s.name}>${s.name}</span><div class="sub summary">${s.description || '暂无用途说明'}</div>`, status: html`<app-badge variant=${s.enabled === true ? 'ok' : 'muted'}>${s.enabled === true ? '已启用' : s.enabled === false ? '已禁用' : '状态未知'}</app-badge>`,
          actions: html`<div class="actions"><button class="btn btn-ghost" aria-label=${`查看 ${s.name} 详情`} @click=${() => { this.selected = s; }}>查看详情</button>${canManage && typeof s.enabled === 'boolean' ? html`<button class="btn" ?disabled=${!!this.pending} aria-label=${`${s.enabled ? '禁用' : '启用'} ${s.name}`} @click=${() => this.toggleSkill(s)}>${this.pending === s.name ? '确认中…' : s.enabled ? '禁用' : '启用'}</button>` : html`<span class="caption">${canManage ? '需核对状态' : '需配置管理权限'}</span>`}</div>` }) })}
      ${!this.loading && !this.error ? html`<div class="extensions"><agent-extension-manager kind="skill"></agent-extension-manager></div>` : nothing}
      <app-dialog .open=${!!selected} size="xl" title="技能详情" @app-dialog-close=${() => { this.selected = null; }}>
        ${selected ? html`<div class="detail"><h2>${selected.name}</h2><p>${selected.description || '暂无用途说明'}</p><dl><dt>状态</dt><dd>${selected.enabled === true ? '已启用' : selected.enabled === false ? '已禁用' : '未知'}</dd><dt>完整路径</dt><dd>${selected.filePath}</dd><dt>来源</dt><dd>${selected.source ?? '未提供'}</dd><dt>信任声明</dt><dd>${selected.trusted === true ? '受信任' : selected.trusted === false ? '不受信任' : '未提供'}</dd><dt>摘要校验值</dt><dd>${selected.digest ?? '未提供'}</dd></dl><h3>Frontmatter</h3><pre>${JSON.stringify(selected.frontmatter, null, 2)}</pre><details><summary>完整技术信息</summary><pre>${JSON.stringify(selected, null, 2)}</pre></details></div>` : nothing}
        <button class="btn" slot="footer" @click=${() => { this.selected = null; }}>关闭</button>
      </app-dialog>`;
  }
}

declare global { interface HTMLElementTagNameMap { 'agent-skills-page': AgentSkillsPage; } }
