import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.ts';
import type { InvestigationProfilesResponse } from '../../../api/generated/public-api.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { workspaceStyles, fmt, badge, table, pairs } from './workspace-ui.js';
import '../components/app-empty-state.ts';

@customElement('investigation-profiles-page')
export class InvestigationProfilesPage extends LitElement {
  @state() private facts: InvestigationProfilesResponse | null = null;
  @state() private loading = false;
  @state() private error = '';
  @state() private forbidden = false;
  @state() private selected: InvestigationProfilesResponse['items'][number] | null = null;
  private generation = 0;
  private invalidate = () => {
    this.generation++; this.selected = null; this.facts = null; this.loading = false; this.error = ''; this.forbidden = true;
  };
  private permissionsChanged = (event: Event) => {
    this.invalidate();
    const permissions = (event as CustomEvent<{ permissions?: string[] }>).detail?.permissions;
    if (permissions?.some(p => ['ai:view', 'ai:*', 'admin:*', '*'].includes(p))) void this.load();
  };
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-session-expired', this.invalidate);
    window.addEventListener('slide-permissions-loaded', this.permissionsChanged);
    void this.load();
  }
  disconnectedCallback() {
    this.invalidate();
    window.removeEventListener('slide-session-expired', this.invalidate);
    window.removeEventListener('slide-permissions-loaded', this.permissionsChanged);
    super.disconnectedCallback();
  }
  private async load() {
    const generation = ++this.generation;
    this.selected = null; this.facts = null; this.loading = true; this.error = ''; this.forbidden = false;
    try {
      const response = await authFetch('/api/investigation-profiles', { cache: 'no-store' });
      if (generation !== this.generation || !this.isConnected) return;
      if (!response.ok) {
        this.forbidden = [401, 403].includes(response.status);
        this.error = response.status === 401 ? '登录已失效，请重新登录。'
          : this.forbidden ? '当前账号无权访问调查 Profiles。' : '加载 Profiles 失败，请稍后重试。';
        return;
      }
      const facts = await response.json() as InvestigationProfilesResponse;
      if (generation === this.generation && this.isConnected) this.facts = facts;
    } catch {
      if (generation === this.generation) this.error = '连接失败，请稍后重试。';
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }
  static styles = [sharedBtnStyles, workspaceStyles];
  private profileName(id: string) { return id === 'ops' ? '资源调查' : id === 'system' ? '平台调查' : id; }
  private toolName(id: string) {
    const names: Record<string,string> = { get_instance_summary:'实例摘要', query_metrics:'查询指标', list_active_alerts:'活跃告警', get_server_metrics:'服务器指标', get_server_alerts:'服务器告警', get_resource_observations:'资源观测', get_resource_relations:'资源关系', get_platform_observations:'平台观测', get_deployment_manifest:'部署清单', search_source:'搜索源码', read_source_region:'读取源码片段', get_symbol_definition:'查询符号定义' };
    return names[id] ?? id;
  }
  render() {
    const item = this.selected, p = item?.profile;
    return html`<div class="page-header"><div><h1>调查 Profiles</h1><p class="muted small">按调查对象查看预置职责、工具权限上限与执行限制。</p></div><button aria-busy=${String(this.loading)} class="btn btn-refresh" ?disabled=${this.loading} @click=${this.load}>刷新 Profiles</button></div>
      ${this.loading ? html`<app-card><div class="state-box" role="status">正在加载 Profiles…</div></app-card>`
        : this.error || this.forbidden ? html`<app-card><div role="alert"><app-empty-state icon="lock" title=${this.forbidden ? '无权访问' : '加载失败'} description=${this.error}></app-empty-state></div></app-card>`
        : !this.facts?.items.length ? html`<app-card><app-empty-state icon="brain" title="尚未配置 Profiles" description="当前服务没有返回可展示的 Profile 事实。"></app-empty-state></app-card>`
        : html`<app-card .compact=${true}>${table([{key:'profile',label:'预置与职责',width:'41%'},{key:'scope',label:'调查对象',width:'16%'},{key:'tools',label:'工具上限',width:'16%'},{key:'action',label:'详情',width:'27%'}],this.facts.items.map(item => ({ profile:html`<div class="row entity" data-profile=${item.profile.id} data-profile-version=${item.profile.version}>${this.profileName(item.profile.id)} ${badge('只读')}</div><div class="entity-sub">${item.profile.id} · V${item.profile.version} · ${item.profile.responsibility}</div>`,scope:item.profile.supportedSubjectKinds.map(kind => kind === 'resource' ? '纳管资源' : '平台').join('、'),tools:`${fmt(item.profile.toolAllowlist.length)} 项工具`,action:html`<button class="link" @click=${() => { this.selected = item; }}>查看${this.profileName(item.profile.id)} V${item.profile.version} 预置详情 →</button>` })))}</app-card>
          <div class="section-head"><h2>执行前仍需校验</h2>${badge('就绪尚未评估','warn')}</div><app-card><div class="definitions-grid"><div><h3>授权边界</h3><p class="caption">工具白名单是权限上限；实际执行还需主体、全部资源和工具策略授权。</p></div><div><h3>运行与预算</h3><p class="caption">工具与模型就绪尚未评估。Profile 执行上限不代表剩余额度。</p></div></div></app-card><p class="detail-note">仓库版本化预置，只读展示。Prompt、Hash、输出契约与工具标识在详情中保留。</p>`}
      <app-dialog .open=${!!item} size="xl" title=${p ? `${this.profileName(p.id)} · ${p.id} V${p.version}` : ''} @app-dialog-close=${() => { this.selected = null; }}>
        ${p && item ? html`<div class="dialog-section"><div class="row">${badge('只读预置')}${badge('就绪尚未评估','warn')}</div><p class="detail-note">覆盖全部必需资源 scope；工具白名单不代表实际授权。</p>${pairs([['模型场景',p.modelScene],['调查对象',p.supportedSubjectKinds.map(kind => kind === 'resource' ? '纳管资源' : '平台').join('、')],['输出',`${item.outputSchemaId} · V${p.outputSchemaVersion} · ${p.outputLanguage}`]])}</div>
        <div class="dialog-section"><h3>执行限制</h3><div class="definitions-grid">${pairs([['执行期限',`${fmt(p.budget.deadlineMs / 1000)} 秒`],['工具调用',`${fmt(p.budget.maxToolCalls)} 次`],['Provider 尝试',`${fmt(p.budget.maxProviderAttempts)} 次`]])}${pairs([['Token 上限',fmt(p.budget.maxTokens)],['读取行数',`${fmt(p.budget.maxRows)} 行`],['读取数据',`${fmt(p.budget.maxBytes / 1024 / 1024)} MiB`],['观察窗口',`${fmt(p.budget.maxWindowMs / 1000)} 秒`]])}</div><p class="caption">以上为执行预算上限，不能据此判断剩余额度或费用。</p></div>
        <div class="dialog-section"><h3>工具权限上限 · ${fmt(p.toolAllowlist.length)} 项</h3><ul class="tool-list">${p.toolAllowlist.map(tool => html`<li>${this.toolName(tool)}<details><summary>原始标识</summary><code>${tool}</code></details></li>`)}</ul></div>
        <details><summary>版本与技术标识</summary><dl class="metadata"><dt>Profile Hash</dt><dd>${item.profileHash}</dd><dt>Prompt</dt><dd>${p.prompt.version} · ${p.prompt.hash}</dd><dt>Skills</dt><dd>${p.skills.length ? p.skills.map(skill => html`<p>${skill.id} · ${skill.version} · ${skill.hash}</p>`) : '无预置技能'}</dd><dt>工具可用性</dt><dd>${item.toolAvailability}</dd><dt>原始期限 / 观察窗口 / 数据量</dt><dd>${fmt(p.budget.deadlineMs)} ms / ${fmt(p.budget.maxWindowMs)} ms / ${fmt(p.budget.maxBytes)} bytes</dd><dt>资源边界</dt><dd>${p.resourceBoundary}</dd></dl></details>` : nothing}
        <div slot="footer"><button class="btn" @click=${() => { this.selected = null; }}>关闭</button></div>
      </app-dialog>`;
  }
}
