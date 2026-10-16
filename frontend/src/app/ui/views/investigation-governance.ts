import { sharedFieldStyles } from "../../styles/shared-field-styles.ts";
import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authFetch } from '../../../api/index.ts';
import type { InvestigationBudgetResponse, InvestigationPoliciesResponse, InvestigationUsageResponse } from '../../../api/generated/public-api.ts';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.ts';
import { canAccessSettingsItem, settingsItemById } from '../settings-navigation.ts';
import { workspaceStyles, fmt, badge, stat, table, pairs } from './workspace-ui.js';
import '../components/app-empty-state.ts';

type Kind = 'policies' | 'budget' | 'usage';
type Facts = InvestigationBudgetResponse | InvestigationPoliciesResponse | InvestigationUsageResponse;
const titles = { policies: '调查策略', budget: '有效预算', usage: '用量与成本' };
const stateLabels = { reserved: '未发送保留', sent: '已发送待用量', settled: '已结算', unknown: '结果未知保留', cancelled: '发送前取消' };
const money = (value: number, currency: string) => `${currency} ${(value / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
const exactMoney = (value: number, currency: string) => `${currency} ${(value / 1_000_000).toFixed(6)}（${value} micro）`;

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
  @state() private dialog: 'policy' | 'ledger' | 'group' | '' = '';
  @state() private group: InvestigationUsageResponse['items'][number] | null = null;
  private generation = 0;
  private invalidate() {
    this.generation++; this.dialog = ''; this.group = null; this.facts = null; this.loading = false; this.error = ''; this.offset = 0;
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
  static styles = [sharedFieldStyles, sharedBtnStyles, workspaceStyles];
  render() {
    return html`<div class="page-header"><div><h1>${titles[this.kind]}</h1><p class="muted small">${{policies:'确认配置、接入与自动触发状态。',budget:'核对当前限额与持久冻结配置，不推算剩余额度。',usage:'查看已知结算、保留额度及未知用量。'}[this.kind]}</p></div><button class="btn" ?disabled=${this.loading || !this.allowed} @click=${() => this.load()}>刷新${titles[this.kind]}</button></div>
      ${this.loading ? html`<app-card><div class="state-box" role="status">正在加载调查设置…</div></app-card>`
        : this.error || this.forbidden ? html`<app-card><div role="alert"><app-empty-state icon="lock" title=${this.forbidden ? '无权访问' : '暂不可用'} description=${this.error || '当前账号无权访问此调查设置。'}></app-empty-state></div></app-card>`
        : this.facts ? this.kind === 'policies' ? this.renderPolicies(this.facts as InvestigationPoliciesResponse) : this.kind === 'budget' ? this.renderBudget(this.facts as InvestigationBudgetResponse) : this.renderUsage(this.facts as InvestigationUsageResponse) : nothing}
      <p class="detail-note">只读展示当前服务事实；刷新不会注册策略、初始化预算、保留额度或启动调查。</p>${this.renderDialog()}`;
  }
  private renderPolicies(facts: InvestigationPoliciesResponse) {
    const connected = facts.integrationStatus === 'connected';
    const enabled = facts.items.some(item => item.enabled);
    return html`<div class="metrics">${stat('策略配置',facts.configurationStatus === 'configured' ? '已配置' : '尚未配置','当前生产组合 · 版本化规则')}${stat('自动触发',!connected ? '尚未接入' : enabled ? '已开启' : '未开启',connected ? '数据库告警试点已接入' : '未建立自动触发入口')}${stat('执行模式','只读','每次执行实时核验权限与预算')}</div>
      <div class="section-head"><h2>已接入策略</h2><span class="caption">当前服务事实</span></div><app-card .compact=${true}>${facts.items.length ? table([{key:'name',label:'策略',width:'34%'},{key:'profile',label:'调用预置',width:'18%'},{key:'state',label:'自动触发',width:'22%'},{key:'action',label:'详情',width:'26%'}], facts.items.map(item => ({name:html`<div class="entity">数据库告警试点</div><div class="entity-sub">数据库事件 · 只读调查</div>`,profile:`Ops · V${item.version}`,state:badge(item.enabled ? '自动触发已开启' : '自动触发未开启',item.enabled ? 'ok' : 'muted'),action:html`<button class="link" @click=${() => { this.dialog = 'policy'; }}>查看触发边界 →</button>`}))) : html`<div class="empty-space"><app-empty-state icon="shield" title="尚未配置调查策略" description="当前生产组合未注册策略，尚未接入自动触发。"></app-empty-state></div>`}</app-card>
      <div class="section-head"><h2>触发边界</h2></div><app-card><div class="definitions-grid"><div><h3>逐次准入校验</h3><p class="caption">配置不代表服务主体拥有权限或预算；每次接入实时核验。</p></div><div><h3>防止自触发循环</h3><p class="caption">内部调查事件只持久化，不触发自身调查。</p></div></div><details><summary>查看配置来源</summary>${pairs([['事实来源',facts.source],['内部来源边界',facts.originBoundary]])}</details></app-card>`;
  }
  private renderBudget(facts: InvestigationBudgetResponse) {
    const policy = facts.policy, frozen = facts.persistedPolicy;
    const status = {uninitialized:'尚未初始化冻结预算',matching:'当前配置与冻结预算匹配',conflict:'当前配置与冻结预算冲突，不能视为可准入'};
    const fields: Array<[keyof typeof policy,string]> = [['maxTotalTokensPerDay','全部每日 Token 上限'],['maxAutomaticTokensPerDay','自动每日 Token 上限'],['currency','币种'],['maxCostMicrosPerDay','每日成本上限'],['maxConcurrent','全局并发'],['manualReserved','手动并发保留'],['maxPerResourceConcurrent','每资源并发'],['maxAutomaticRequestsPerHour','自动每小时请求上限']];
    const value = (key: keyof typeof policy, p: typeof policy) => key === 'maxCostMicrosPerDay' ? money(p.maxCostMicrosPerDay,p.currency) : typeof p[key] === 'number' ? fmt(p[key] as number) : p[key];
    return html`<div class="notice ${facts.admissionStatus === 'conflict' ? '' : 'neutral'}" role=${facts.admissionStatus === 'conflict' ? 'alert' : 'status'}><div><strong>${status[facts.admissionStatus]}</strong>${facts.admissionStatus === 'uninitialized' ? '只读查询不会创建预算域，剩余额度尚不可确定。' : '配置一致性不代表具备余额；每次执行仍需准入校验。'}</div></div>
      <div class="metrics">${stat('全部每日 Token 上限',fmt(policy.maxTotalTokensPerDay),'UTC 日窗口 · 配置额度')}${stat('自动每日 Token 上限',fmt(policy.maxAutomaticTokensPerDay),'包含在全部每日上限中')}${stat('每日成本上限',money(policy.maxCostMicrosPerDay,policy.currency),'按配置费率估算 · 非剩余余额')}</div>
      <div class="section-head"><h2>预算规则</h2><span class="caption">当前加载配置 · 只读</span></div><app-card data-budget="loader"><div class="definitions-grid"><div><h3>并发与频次</h3>${pairs([['全局并发',`${fmt(policy.maxConcurrent)} 个`],['其中手动保留',`${fmt(policy.manualReserved)} 个`],['每资源并发',`${fmt(policy.maxPerResourceConcurrent)} 个`],['自动每小时请求',`${fmt(policy.maxAutomaticRequestsPerHour)} 次`]])}</div><div><h3>成本与预留</h3>${pairs([['币种',policy.currency],['每日成本上限',money(policy.maxCostMicrosPerDay,policy.currency)],['每执行保留成本',money(facts.reserveCostMicros,policy.currency)],['窗口时区','UTC']])}</div></div><details><summary>查看精确值与配置来源</summary>${pairs([['每日成本上限',exactMoney(policy.maxCostMicrosPerDay,policy.currency)],['每执行保留成本',exactMoney(facts.reserveCostMicros,policy.currency)],['配置来源',facts.source]])}</details></app-card>
      <div class="section-head"><h2>持久冻结配置</h2>${badge(facts.admissionStatus === 'conflict' ? '配置冲突' : frozen ? '一致' : '未初始化',facts.admissionStatus === 'conflict' ? 'danger' : frozen ? 'ok' : 'muted')}</div><app-card data-budget="frozen" .compact=${!!frozen}>${frozen ? table([{key:'field',label:'关键字段',width:'40%'},{key:'loader',label:'当前配置',width:'30%'},{key:'persisted',label:'冻结配置',width:'30%'}],fields.map(([key,label]) => ({field:label,loader:value(key,policy),persisted:html`<span class=${policy[key] !== frozen[key] ? 'conflict' : ''}>${value(key,frozen)}${policy[key] !== frozen[key] ? ' · 不一致' : ''}</span>`}))) : html`<app-empty-state icon="clipboard" title="尚无冻结预算" description="预算域尚未初始化。只读刷新不会保留额度或触发调查。"></app-empty-state>`}</app-card>
      <p class="detail-note">额度不等于余额或供应商收费；Profile 上限见调查 Profiles。${facts.automaticTriggerStatus === 'connected' ? '数据库告警试点已接入；每次实时校验权限与预算。' : '自动触发尚未接入。'}</p>`;
  }
  private renderUsage(facts: InvestigationUsageResponse) {
    return html`<div class="metrics four">${stat('已知结算 Token',fmt(facts.settledTokens),`${fmt(facts.knownUsageCount)} 条已知用量`)}${stat('当前保留 Token',fmt(facts.outstandingTokens),'未释放的额度保留')}${stat('未知 / 待返回',`${fmt(facts.unknownUsageCount)} / ${fmt(facts.pendingUsageCount)}`,'不能当作零用量或零费用')}${stat('预留记录',fmt(facts.total),`${fmt(facts.groupCount)} 个账本分组`)}</div>
      ${facts.unknownUsageCount || facts.pendingUsageCount || facts.items.some(item => item.unknownCostCount) ? html`<div class="notice"><div><strong>${fmt(facts.unknownUsageCount)} 条用量未知，${fmt(facts.pendingUsageCount)} 条待返回</strong>未知用量、待返回用量和缺费率仍保留额度，不能当作零费用。</div></div>` : nothing}
      <div class="section-head"><div><h2>账本分组</h2><p class="caption">全部历史 · 全局管理汇总 · 按币种、状态及触发方式分组</p></div><button class="btn-ghost" @click=${() => { this.dialog = 'ledger'; }}>查看汇总口径</button></div>
      <app-card .compact=${true}>${facts.items.length ? table([{key:'currency',label:'币种',width:'12%'},{key:'state',label:'账本状态',width:'22%'},{key:'mode',label:'触发方式',width:'14%'},{key:'count',label:'记录数',width:'12%'},{key:'cost',label:'已知结算估算',width:'22%'},{key:'action',label:'详情',width:'18%'}],facts.items.map(item => ({currency:item.currency,state:badge(stateLabels[item.state],item.unknownUsageCount || item.pendingUsageCount || item.unknownCostCount ? 'warn' : item.knownUsageCount ? 'ok' : 'muted'),mode:item.mode === 'manual' ? '手动' : '自动',count:fmt(item.count),cost:item.knownUsageCount > 0 && item.state === 'settled' && item.unknownCostCount < item.knownUsageCount ? html`${money(item.estimatedSettledCostMicros,item.currency)}${item.unknownCostCount ? html`<div class="entity-sub">部分已知估算 · ${fmt(item.unknownCostCount)} 条缺费率</div>` : nothing}` : '—',action:html`<button class="link" data-usage-group=${`${item.currency}/${item.state}/${item.mode}`} @click=${() => { this.group = item; this.dialog = 'group'; }}>查看分组 →</button>`}))) : html`<div class="empty-space"><app-empty-state icon="bar-chart" title=${facts.total === 0 ? '暂无持久用量' : '当前页暂无分组'} description="当前返回为空；未知用量会另行标记，不视为零费用。"></app-empty-state></div>`}
      <div class="paging"><span>当前分组 ${facts.items.length ? this.offset + 1 : 0}–${this.offset + facts.items.length} / ${facts.groupCount}</span><div class="row"><label>每页分组 <select aria-label="每页分组" .value=${String(this.limit)} @change=${(event: Event) => { this.limit = Number((event.target as HTMLSelectElement).value); void this.load(); }}>${[5,20,50].map(limit => html`<option value=${limit} .selected=${this.limit === limit}>${limit}</option>`)}</select></label><button class="btn-ghost" ?disabled=${this.offset === 0} @click=${() => this.load(Math.max(0,this.offset-this.limit))}>上一组页</button><button class="btn-ghost" ?disabled=${facts.nextOffset === null} @click=${() => this.load(facts.nextOffset!)}>下一组页</button></div></div></app-card>
      ${facts.costs.length ? html`<div class="section-head"><h2>成本与额度</h2><span class="caption">不同币种独立展示</span></div><app-card .compact=${true}>${table([{key:'currency',label:'币种',width:'18%'},{key:'known',label:'已知结算估算',width:'28%'},{key:'held',label:'当前保留成本',width:'27%'},{key:'historical',label:'历史预留成本',width:'27%'}],facts.costs.map(cost => ({currency:cost.currency,known:money(cost.estimatedSettledCostMicros,cost.currency),held:money(cost.outstandingCostMicros,cost.currency),historical:money(cost.reservedCostMicros,cost.currency)})))}</app-card>` : nothing}
      <p class="detail-note">费用为配置费率估算，非供应商实收；已知数值只覆盖可计量部分。输入 Token 包含缓存输入，不重复相加。精确 micro 值在汇总及分组详情中保留。</p>`;
  }
  private renderDialog() {
    let title = '', body: unknown = nothing;
    if (this.dialog === 'policy' && this.facts && this.kind === 'policies') {
      const facts = this.facts as InvestigationPoliciesResponse;
      title = '数据库告警试点 · 触发边界'; body = html`${pairs([['接入',facts.integrationStatus === 'connected' ? '已接入' : '尚未接入'],['自动触发',facts.items.some(item => item.enabled) ? '已开启' : '未开启'],['执行模式','只读']])}<p class="detail-note">主体、全部必需资源、工具策略和预算均逐次实时核验。内部调查事件仅持久化，不触发自身调查。</p><details><summary>策略技术标识</summary><pre>${JSON.stringify(facts,null,2)}</pre></details>`;
    } else if (this.dialog === 'ledger' && this.facts && this.kind === 'usage') {
      const facts = this.facts as InvestigationUsageResponse; title = '持久账本 · 汇总口径';
      body = html`<div data-usage="totals">${pairs([['Reservation 总数',fmt(facts.total)],['分组总数',fmt(facts.groupCount)],...Object.entries(stateLabels).map(([key,label]): [string,unknown] => [label,fmt(facts.counts[key as keyof typeof stateLabels])]),['已知用量数',fmt(facts.knownUsageCount)],['未知用量数',fmt(facts.unknownUsageCount)],['待返回用量数',fmt(facts.pendingUsageCount)],['历史预留 Token',fmt(facts.reservedTokens)],['当前保留 Token',fmt(facts.outstandingTokens)],['已知结算 Token',fmt(facts.settledTokens)]])}</div><p class="detail-note">发送前取消不代表供应商返回零用量。未知、待返回或缺费率部分未计入已知估算。</p><details><summary>精确成本值</summary>${facts.costs.map(cost => html`<div data-currency=${cost.currency}>${pairs([['币种',cost.currency],['历史预留成本',exactMoney(cost.reservedCostMicros,cost.currency)],['当前保留成本',exactMoney(cost.outstandingCostMicros,cost.currency)],['已知结算估算',exactMoney(cost.estimatedSettledCostMicros,cost.currency)]])}</div>`)}</details>`;
    } else if (this.dialog === 'group' && this.group) {
      const item = this.group; title = `${item.currency} · ${stateLabels[item.state]} · ${item.mode === 'manual' ? '手动' : '自动'}`;
      body = html`${pairs([['Reservation 数',fmt(item.count)],['已知 / 未知 / 待返回用量数',`${fmt(item.knownUsageCount)} / ${fmt(item.unknownUsageCount)} / ${fmt(item.pendingUsageCount)}`],['已知输入 Token 小计',item.knownUsageCount ? fmt(item.knownInputTokens) : '未计量'],['其中缓存输入',item.knownUsageCount ? fmt(item.knownCachedInputTokens) : '未计量'],['已知输出 Token 小计',item.knownUsageCount ? fmt(item.knownOutputTokens) : '未计量'],['历史预留 / 当前保留 Token',`${fmt(item.reservedTokens)} / ${fmt(item.outstandingTokens)}`],['已知结算 Token',fmt(item.settledTokens)],['未知成本数（含缺费率）',fmt(item.unknownCostCount)]])}<p class="detail-note">${item.state === 'cancelled' ? '发送前取消未发送，不代表供应商返回零用量。' : '已知 Token 仅为小计；未知、待返回或缺费率部分未计入已知估算。'} 输入 Token 包含缓存输入，不重复相加。</p><details><summary>精确成本值</summary>${pairs([['历史预留成本',exactMoney(item.reservedCostMicros,item.currency)],['当前保留成本',exactMoney(item.outstandingCostMicros,item.currency)],['已知结算估算',item.knownUsageCount && item.unknownCostCount < item.knownUsageCount ? exactMoney(item.estimatedSettledCostMicros,item.currency) : '未计量']])}</details>`;
    }
    return html`<app-dialog .open=${!!this.dialog} size="xl" .title=${title} @app-dialog-close=${() => { this.dialog = ''; }}>${body}<div slot="footer"><button class="btn" @click=${() => { this.dialog = ''; }}>关闭</button></div></app-dialog>`;
  }
}
