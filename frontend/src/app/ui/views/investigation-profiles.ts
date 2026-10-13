import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.ts';
import type { InvestigationProfilesResponse } from '../../../api/generated/public-api.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import '../components/app-card.ts';
import '../components/app-empty-state.ts';

@customElement('investigation-profiles-page')
export class InvestigationProfilesPage extends LitElement {
  @state() private facts: InvestigationProfilesResponse | null = null;
  @state() private loading = false;
  @state() private error = '';
  @state() private forbidden = false;
  private generation = 0;
  private invalidate = () => {
    this.generation++; this.facts = null; this.loading = false; this.error = ''; this.forbidden = true;
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
    this.facts = null; this.loading = true; this.error = ''; this.forbidden = false;
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
  static styles = [sharedBtnStyles, css`
    :host { display:block; min-width:0; color:var(--text); }
    h1 { margin:0; font-size:var(--text-xl); color:var(--text-strong); }
    .heading { display:flex; justify-content:space-between; align-items:center; gap:var(--space-md); flex-wrap:wrap; }
    p { line-height:1.6; }
    .note { color:var(--muted); }
    .profiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,24rem),1fr)); gap:var(--space-lg); }
    app-card { min-width:0; }
    dl { display:grid; grid-template-columns:minmax(5rem,auto) minmax(0,1fr); gap:var(--space-sm) var(--space-md); margin:0; }
    dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
    ul { padding-inline-start:var(--space-lg); margin:0; } li { overflow-wrap:anywhere; }
    .skeleton { min-height:8rem; }
    [role=alert] { overflow-wrap:anywhere; }
  `];
  render() {
    return html`
      <div class="heading"><h1>调查 Profiles</h1><button class="btn" ?disabled=${this.loading} @click=${this.load}>刷新 Profiles</button></div>
      <p class="note">仓库版本化预置，只读展示。工具白名单是权限上限；实际执行还需主体、全部资源和工具策略授权。工具与模型就绪尚未评估。</p>
      ${this.loading ? html`<div class="skeleton" role="status" aria-label="正在加载 Profiles">正在加载…</div>`
        : this.error || this.forbidden ? html`<p role="alert">${this.error}</p><app-empty-state icon="lock" title=${this.forbidden ? '无权访问' : '加载失败'} description=${this.error}></app-empty-state>`
        : !this.facts?.items.length ? html`<app-empty-state icon="brain" title="尚未配置 Profiles" description="当前服务没有返回可展示的 Profile 事实。"></app-empty-state>`
        : html`<div class="profiles">${this.facts.items.map(item => {
          const p = item.profile;
          const limits: Array<[keyof typeof p.budget, string]> = [
            ['deadlineMs', '执行期限（毫秒）'], ['maxToolCalls', '工具调用次数'], ['maxProviderAttempts', 'Provider 尝试次数'],
            ['maxTokens', 'Token 数'], ['maxRows', '读取行数'], ['maxBytes', '读取字节'], ['maxWindowMs', '观察窗口（毫秒）'],
          ];
          return html`<app-card data-profile=${p.id}><span slot="header">${p.id} · V${p.version} · 预置</span>
            <p>${p.responsibility}</p><dl>
              <dt>Profile Hash</dt><dd>${item.profileHash}</dd>
              <dt>对象类型</dt><dd>${p.supportedSubjectKinds.join('、')}</dd>
              <dt>资源边界</dt><dd>${p.resourceBoundary === 'all_required_scopes' ? '覆盖全部必需资源 scope' : p.resourceBoundary} · ${p.readonly ? '只读' : '非只读'}</dd>
              <dt>模型场景引用</dt><dd>${p.modelScene}（就绪尚未评估）</dd>
              <dt>Prompt</dt><dd>${p.prompt.version} · ${p.prompt.hash}</dd>
              <dt>Skills</dt><dd>${p.skills.length ? html`<ul>${p.skills.map(s => html`<li>${s.id} · ${s.version} · ${s.hash}</li>`)}</ul>` : '无预置技能'}</dd>
              <dt>工具权限上限</dt><dd><ul>${p.toolAllowlist.map(tool => html`<li>${tool}</li>`)}</ul></dd>
              <dt>工具可用性</dt><dd>${item.toolAvailability === 'not_evaluated' ? '尚未评估' : item.toolAvailability}</dd>
              <dt>输出契约</dt><dd>${item.outputSchemaId} · V${p.outputSchemaVersion} · ${p.outputLanguage}</dd>
            </dl>
            <p class="note">以下为 Profile 预算上限；有效预算与持久用量、成本需另行读取，不能据此判断剩余额度或费用。</p>
            <dl>${limits.map(([key, label]) => html`<dt>${label}</dt><dd>${p.budget[key]}</dd>`)}</dl>
          </app-card>`;
        })}</div>`}
    `;
  }
}
