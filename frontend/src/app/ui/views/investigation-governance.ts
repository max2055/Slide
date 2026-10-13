import { LitElement, css, html, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.ts';
import type { InvestigationBudgetResponse, InvestigationPoliciesResponse, InvestigationUsageResponse } from '../../../api/generated/public-api.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { canAccessSettingsItem, settingsItemById } from '../settings-navigation.ts';
import '../components/app-card.ts';
import '../components/app-empty-state.ts';

type Kind = 'policies' | 'budget' | 'usage';
type Facts = InvestigationBudgetResponse | InvestigationPoliciesResponse | InvestigationUsageResponse;
const titles = { policies: '调查策略', budget: '有效预算', usage: '用量与成本' };
const stateLabels = { reserved: '未发送保留', sent: '已发送待用量', settled: '已结算', unknown: '结果未知保留', cancelled: '发送前取消' };
// Keep exact micro amounts alongside decimal estimates, never round unknowns to zero.
const money = (value: number, currency: string) => `${currency} ${(value / 1_000_000).toFixed(6)}（${value} micro）`;

@customElement('investigation-governance-page')
export class InvestigationGovernancePage extends LitElement {
  @property() kind: Kind = 'policies';
  @property({ attribute: false }) permissions: Set<string> | null = null;
  @state() private facts: Facts | null = null;
  @state() private loading = false;
  @state() private error = '';
  @state() private forbidden = false;
  @state() private offset = 0;
  @state() private limit = 20;
  private generation = 0;
  private invalidate() {
    this.generation++; this.facts = null; this.loading = false; this.error = ''; this.offset = 0;
  }
  private sessionExpired = () => { this.permissions = new Set(); this.invalidate(); this.forbidden = true; };
  private permissionsChanged = (event: Event) => {
    // Erase synchronously, before Lit removes/reuses the page or renders a new permission set.
    this.invalidate();
    const codes = (event as CustomEvent<{ permissions?: string[] }>).detail?.permissions;
    this.permissions = new Set(Array.isArray(codes) ? codes : []);
    this.forbidden = !this.allowed;
  };
  private get allowed() { return canAccessSettingsItem(settingsItemById(this.kind)!, this.permissions); }
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('slide-session-expired', this.sessionExpired);
    window.addEventListener('slide-permissions-loaded', this.permissionsChanged);
  }
  disconnectedCallback() {
    this.invalidate();
    window.removeEventListener('slide-session-expired', this.sessionExpired);
    window.removeEventListener('slide-permissions-loaded', this.permissionsChanged);
    super.disconnectedCallback();
  }
  protected willUpdate(changes: PropertyValues<this>) {
    if (changes.has('kind') || changes.has('permissions')) { this.invalidate(); void this.load(); }
  }
  private async load(offset = 0) {
    this.invalidate(); this.offset = offset; this.forbidden = !this.allowed;
    if (!this.allowed || !this.isConnected) return;
    const generation = this.generation, kind = this.kind;
    this.loading = true;
    try {
      const query = kind === 'usage' ? `?limit=${this.limit}&offset=${offset}` : '';
      const response = await authFetch(`/api/investigation-${kind}${query}`, { cache: 'no-store' });
      if (generation !== this.generation || !this.isConnected) return;
      if (!response.ok) {
        this.forbidden = [401, 403].includes(response.status);
        this.error = response.status === 401 ? '登录已失效，请重新登录。'
          : this.forbidden ? '当前账号无权访问此调查设置。' : '调查设置暂不可用，请稍后重试。';
        return;
      }
      const facts = await response.json() as Facts;
      if (generation === this.generation && this.isConnected && this.kind === kind) this.facts = facts;
    } catch {
      if (generation === this.generation) this.error = '调查设置暂不可用，请检查连接后重试。';
    } finally { if (generation === this.generation) this.loading = false; }
  }
  static styles = [sharedBtnStyles, css`
    :host { display:block; min-width:0; color:var(--text); }
    h1 { margin:0; font-size:var(--text-xl); color:var(--text-strong); }
    .heading,.paging { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--space-md); }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,24rem),1fr)); gap:var(--space-lg); margin-block:var(--space-lg); }
    app-card { min-width:0; }
    p { line-height:1.6; overflow-wrap:anywhere; } .note,dt { color:var(--muted); }
    dl { display:grid; grid-template-columns:minmax(5rem,auto) minmax(0,1fr); gap:var(--space-sm) var(--space-md); margin:0; }
    dd { margin:0; overflow-wrap:anywhere; }
    select { color:var(--text); background:var(--card); border:1px solid var(--border); border-radius:var(--radius-sm); padding:var(--space-sm); }
    .skeleton { min-height:8rem; }
    :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  `];
  render() {
    return html`<div class="heading"><h1>${titles[this.kind]}</h1>
      <button class="btn" ?disabled=${this.loading || !this.allowed} @click=${() => this.load()}>刷新${titles[this.kind]}</button></div>
      <p class="note">只读展示当前服务事实；刷新不会注册策略、保留预算或启动执行。</p>
      ${this.loading ? html`<div class="skeleton" role="status">正在加载调查设置…</div>`
        : this.error || this.forbidden ? html`<p role="alert">${this.error || '当前账号无权访问此调查设置。'}</p><app-empty-state icon="lock" title=${this.forbidden ? '无权访问' : '暂不可用'}></app-empty-state>`
        : this.facts ? this.kind === 'policies' ? this.renderPolicies(this.facts as InvestigationPoliciesResponse)
          : this.kind === 'budget' ? this.renderBudget(this.facts as InvestigationBudgetResponse)
          : this.renderUsage(this.facts as InvestigationUsageResponse) : ''}`;
  }
  private renderPolicies(facts: InvestigationPoliciesResponse) {
    return html`<app-card><span slot="header">生产调查策略</span><dl>
      <dt>配置状态</dt><dd>${facts.configurationStatus === 'not_configured' ? '尚未配置' : facts.configurationStatus}</dd>
      <dt>接入状态</dt><dd>${facts.integrationStatus === 'not_connected' ? '尚未接入' : facts.integrationStatus}</dd>
      <dt>事实来源</dt><dd>当前生产组合（${facts.source}）</dd>
      <dt>内部来源边界</dt><dd>${facts.originBoundary}</dd></dl>
      <p class="note">内部来源规则已实现；生产自动触发尚未连接，不能据此判断自动调查可用。</p>
      <app-empty-state icon="shield" title="尚未配置调查策略" description="当前生产组合未注册策略，尚未接入自动触发。"></app-empty-state></app-card>`;
  }
  private policyFields(policy: InvestigationBudgetResponse['policy']) {
    const fields: Array<[keyof typeof policy, string]> = [['maxConcurrent', '全局并发'], ['manualReserved', '手动并发保留'],
      ['maxPerResourceConcurrent', '每资源并发'], ['maxAutomaticRequestsPerHour', '自动每小时请求上限'],
      ['maxAutomaticTokensPerDay', '自动每日 Token 上限'], ['maxTotalTokensPerDay', '全部每日 Token 上限']];
    return html`<dl><dt>币种</dt><dd>${policy.currency}</dd>${fields.map(([key, label]) => html`<dt>${label}</dt><dd>${policy[key]}</dd>`)}
      <dt>每日成本额度</dt><dd>${money(policy.maxCostMicrosPerDay, policy.currency)}</dd></dl>`;
  }
  private renderBudget(facts: InvestigationBudgetResponse) {
    const status = { uninitialized: '尚未初始化冻结预算', matching: '当前配置与冻结预算匹配', conflict: '当前配置与冻结预算冲突，不能视为可准入' };
    return html`<p role=${facts.admissionStatus === 'conflict' ? 'alert' : 'status'}>${status[facts.admissionStatus]}</p>
      <p class="note">有效加载器配置（${facts.source}）；UTC 准入日/小时窗口。额度不等于余额或供应商收费；Profile 上限见调查 Profiles。自动触发尚未接入。</p>
      <div class="cards"><app-card data-budget="loader"><span slot="header">当前加载器预算</span>${this.policyFields(facts.policy)}
        <p>每执行保留成本：${money(facts.reserveCostMicros, facts.policy.currency)}</p></app-card>
        <app-card data-budget="frozen"><span slot="header">持久冻结预算</span>${facts.persistedPolicy ? this.policyFields(facts.persistedPolicy)
          : html`<app-empty-state icon="clipboard" title="尚无冻结预算" description="只读查询不会初始化预算域。"></app-empty-state>`}</app-card></div>`;
  }
  private renderUsage(facts: InvestigationUsageResponse) {
    return html`<p class="note">全部历史 · 全局管理汇总。费用为配置费率估算，非供应商实收；不同币种独立展示。输入 Token 包含缓存输入，不重复相加。未知用量、待返回用量和缺费率仍保留额度，不能当作零费用。</p>
      <app-card data-usage="totals"><span slot="header">持久账本汇总</span><dl>
        <dt>Reservation 总数</dt><dd>${facts.total}</dd><dt>分组总数</dt><dd>${facts.groupCount}</dd>
        ${Object.entries(stateLabels).map(([key, label]) => html`<dt>${label}</dt><dd>${facts.counts[key as keyof typeof stateLabels]}</dd>`)}
        <dt>已知用量数</dt><dd>${facts.knownUsageCount}</dd><dt>未知用量数</dt><dd>${facts.unknownUsageCount}</dd><dt>待返回用量数</dt><dd>${facts.pendingUsageCount}</dd>
        <dt>历史预留 Token</dt><dd>${facts.reservedTokens}</dd><dt>当前保留 Token</dt><dd>${facts.outstandingTokens}</dd><dt>已知结算 Token</dt><dd>${facts.settledTokens}</dd></dl></app-card>
      <div class="cards">${facts.costs.map(cost => html`<app-card data-currency=${cost.currency}><span slot="header">${cost.currency} 成本估算与额度</span><dl>
        <dt>历史预留成本</dt><dd>${money(cost.reservedCostMicros, cost.currency)}</dd><dt>当前保留成本</dt><dd>${money(cost.outstandingCostMicros, cost.currency)}</dd>
        <dt>已知结算估算</dt><dd>${money(cost.estimatedSettledCostMicros, cost.currency)}</dd></dl></app-card>`)}</div>
      <div class="paging"><label>每页分组 <select aria-label="每页分组" .value=${String(this.limit)} @change=${(e: Event) => { this.limit = Number((e.target as HTMLSelectElement).value); void this.load(); }}>${[5, 20, 50].map(n => html`<option value=${n}>${n}</option>`)}</select></label>
        <span>当前分组 ${facts.items.length ? this.offset + 1 : 0}–${this.offset + facts.items.length} / ${facts.groupCount}</span>
        <button class="btn" ?disabled=${this.offset === 0} @click=${() => this.load(Math.max(0, this.offset - this.limit))}>上一组页</button>
        <button class="btn" ?disabled=${facts.nextOffset === null} @click=${() => this.load(facts.nextOffset!)}>下一组页</button></div>
      ${!facts.items.length ? html`<app-empty-state icon="bar-chart" title=${facts.total === 0 ? '暂无持久用量' : '当前页暂无分组'} description="当前返回为空；未知用量会另行标记，不视为零费用。"></app-empty-state>`
        : html`<div class="cards">${facts.items.map(item => html`<app-card data-usage-group=${`${item.currency}/${item.state}/${item.mode}`}><span slot="header">${item.currency} · ${stateLabels[item.state]} · ${item.mode === 'manual' ? '手动' : '自动'}</span><dl>
          <dt>Reservation 数</dt><dd>${item.count}</dd><dt>已知 / 未知 / 待返回用量数</dt><dd>${item.knownUsageCount} / ${item.unknownUsageCount} / ${item.pendingUsageCount}</dd>
          <dt>已知输入 Token 小计</dt><dd>${item.knownInputTokens}</dd><dt>其中缓存输入</dt><dd>${item.knownCachedInputTokens}</dd><dt>已知输出 Token 小计</dt><dd>${item.knownOutputTokens}</dd>
          <dt>历史预留 / 当前保留 Token</dt><dd>${item.reservedTokens} / ${item.outstandingTokens}</dd><dt>已知结算 Token</dt><dd>${item.settledTokens}</dd>
          <dt>未知成本数（含缺费率）</dt><dd>${item.unknownCostCount}</dd><dt>历史预留成本</dt><dd>${money(item.reservedCostMicros, item.currency)}</dd>
          <dt>当前保留成本</dt><dd>${money(item.outstandingCostMicros, item.currency)}</dd><dt>已知结算估算</dt><dd>${money(item.estimatedSettledCostMicros, item.currency)}</dd></dl>
          <p class="note">已知 Token 仅为小计；${item.state === 'cancelled' ? '发送前取消未发送，不代表供应商返回零用量。' : '未知、待返回或缺费率部分未计入已知估算。'}</p></app-card>`)}</div>`}`;
  }
}
