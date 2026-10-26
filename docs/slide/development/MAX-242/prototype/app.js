/* MAX-242 AI 工作空间体验原型（演示数据）
 * 独立静态页；不请求后端、不调用模型、不执行任何运维动作。
 * 所有故事数据带 [样例] 前缀，状态仅保存在当前页面内存中。 */
'use strict';

// ---------------------------------------------------------------- demo data
const EVENT = {
  id: 'EVT-8821',
  title: '[样例] 订单库连接使用率过高',
  resource: { label: 'mysql-order-01', type: '数据库实例', key: 'instance:12', addr: '10.20.3.12:3306' },
  occurredAt: '2026-10-26 10:31:04 +08:00',
  from: '2026-10-26 10:16:04 +08:00',
  to: '2026-10-26 10:46:04 +08:00',
  metric: 'mysql.connection.used_percent',
  value: '92%',
  threshold: '85%',
  rule: '数据库告警 · 规则 mysql-connections-high v4',
  quality: '有效 · 30 秒采样'
};

const RELATED = [{
  label: 'order-api-02', type: '服务器', key: 'server:7', addr: '10.20.4.7',
  reason: '来自资源关系（应用→数据库，已确认） · v3 · 有效', checked: true
}];

const V1 = {
  version: 1,
  runId: 'RUN-5501',
  createdAt: '2026-10-26 10:33:12 +08:00',
  window: [EVENT.from, EVENT.to],
  summary: '连接使用率在 10:31 达到 92%，当前连接 461/500；未发现数据库侧等待事件异常。',
  sufficiency: '部分',
  facts: [
    { text: '连接使用率 92%，超过阈值 85%', evidence: 'EV-1', at: '10:16–10:46' },
    { text: '当前连接 461，上限 500', evidence: 'EV-1', at: '10:31' },
    { text: '数据库等待事件与慢查询无明显增长', evidence: 'EV-2', at: '10:16–10:46' }
  ],
  counter: [{ text: '数据库侧 CPU 与 IO 正常，不支持下层资源瓶颈', evidence: 'EV-3' }],
  gaps: [{ text: '应用侧连接池上限未知，无法判断是否已打满', code: 'config:not_read' }],
  confidence: '证据部分：事实可追溯，但连接来源仍缺应用配置。',
  next: [
    { id: 'n1', title: '确认应用连接池上限与最近变更', why: '连接占用接近上限，需区分应用泄漏与配置不足', primary: true },
    { id: 'n2', title: '比较发布前后连接数曲线', why: '10:05 有应用发布记录', primary: false }
  ]
};

const V2_BASE = {
  version: 2,
  runId: 'RUN-5502',
  createdAt: '2026-10-26 10:41:02 +08:00',
  window: [EVENT.from, EVENT.to],
  summary: '应用连接池上限为 200，10:05 发布后连接数线性增长且未见回收；判断为应用侧连接未复用。',
  sufficiency: '较充分',
  facts: [
    { text: '连接池上限 200（来源：应用配置 cmdb/app/order-api）', evidence: 'EV-4', at: '10:39' },
    { text: '10:05 发布 order-api v2.14，之后连接数线性增长', evidence: 'EV-5', at: '10:05–10:46' },
    { text: '连接建立后 30 分钟内未见集中回收', evidence: 'EV-2', at: '10:16–10:46' }
  ],
  counter: [{ text: '数据库 max_connections 500 仍有余量，容量参数本身不是直接原因', evidence: 'EV-1' }],
  gaps: [{ text: '未验证长事务是否占住连接（日志采样不足）', code: 'evidence:partial' }],
  confidence: '证据较充分：支持“连接未复用”，长事务假设仍待验证。',
  next: [
    { id: 'n1', title: '验证长事务是否占住连接', why: '日志采样不足，无法排除次要原因', primary: true },
    { id: 'n2', title: '基于当前结果创建行动计划', why: '需要受控重启演练服务并复测', primary: false }
  ]
};

const V2_UNKNOWN_POOL = {
  ...V2_BASE,
  summary: '最近有发布记录，但连接池上限标记为“不清楚”；无法判断应用侧连接是否已打满。',
  sufficiency: '不足',
  facts: V1.facts,
  gaps: [
    { text: '连接池上限：用户选择“不清楚”，保留为缺口', code: 'user:unknown' },
    { text: '未验证长事务是否占住连接', code: 'evidence:partial' }
  ],
  confidence: '证据不足：不据此给出根因结论。',
  next: [
    { id: 'n1', title: '补充确认连接池上限或读取应用配置', why: '当前缺口阻塞根因判断', primary: true },
    { id: 'n2', title: '扩大日志采样窗口', why: '现有采样不足以验证长事务', primary: false }
  ]
};

function freshState() {
  return {
    role: 'operator',
    stage: 'pending-approval',
    screen: 'home',
    event: EVENT,
    related: RELATED.map(r => ({ ...r })),
    scenario: 'connection',
    customProblem: '',
    investigation: {
      id: 'INV-2041',
      title: '[样例] 订单库连接使用率过高 · 10:31',
      goal: '排查 mysql-order-01 在 10:16–10:46 连接使用率过高的原因；只读检查，不执行变更。',
      lifecycle: 'open',
      execution: 'ready',
      problem: 'in_progress',
      versions: [V1],
      activeVersion: 1,
      running: false,
      progress: [],
      disconnected: false,
      acceptanceUnknown: false
    },
    supplement: { pool: '200', poolUnknown: false, change: 'yes', changeRef: '变更 CHG-7712 · order-api v2.14 · 10:05', symptom: 'abnormal', note: '' },
    plan: {
      id: 'PLAN-77',
      version: 3,
      state: 'draft', // draft | pending_approval | approved | rejected
      author: 'user:15coder1',
      requester: 'user:15coder1',
      target: 'server:7 · order-api-02（演练服务）',
      impact: '重启专用演练服务 order-api-canary，预计 20 秒不可用；不影响生产流量。',
      approvalId: '',
      approvalNote: '',
      execution: null,
      report: null,
      unknown: false
    },
    retests: [],
    handoffConfirmed: { gaps: false, sensitive: false },
    toast: null
  };
}

const REPORT = {
  state: 'passed', from: '10:48:04', to: '10:53:04', before: '92%', after: '61%', samples: '30', missing: '0',
  sideEffects: '无新增错误；重启期间 20 秒不可用（预期内）', evidence: ['EV-11', 'EV-12']
};
function reportFor(stage) {
  if (stage === 'retested-not-improved') return { ...REPORT, state: 'failed', after: '88%', sideEffects: '无新增错误；连接使用率仍高于阈值' };
  if (stage === 'retested-insufficient') return { ...REPORT, state: 'inconclusive', after: '未知', sideEffects: '观测窗口中断 120 秒，无法判断副作用', samples: '18', missing: '12', evidence: ['EV-11'] };
  return { ...REPORT };
}

/** 剧本阶段：让审阅者直接到达故事的任一步，不依赖连续点击。 */
function applyStage(stage) {
  const inv = S.investigation, p = S.plan;
  const v1 = { ...V1 }, v2 = { ...V2_BASE };
  S.stage = stage;
  S.retests = [];
  inv.disconnected = false; inv.acceptanceUnknown = false; inv.execution = 'completed';
  if (stage === 'after-v1') {
    inv.versions = [v1]; inv.activeVersion = 1; inv.problem = 'in_progress';
    p.state = 'draft'; p.approvalId = ''; p.execution = null; p.report = null;
    return;
  }
  inv.versions = [v1, v2]; inv.activeVersion = 2; inv.problem = 'in_progress';
  if (stage === 'after-v2') {
    p.state = 'draft'; p.approvalId = ''; p.execution = null; p.report = null;
  } else if (stage === 'pending-approval') {
    p.state = 'pending_approval'; p.approvalId = 'APP-331'; p.execution = null; p.report = null;
  } else {
    p.state = 'approved'; p.approvalId = 'APP-331';
    p.execution = { id: 'EXE-12', state: 'succeeded', at: '10:47:10' };
    p.report = reportFor(stage);
    if (stage === 'retested-not-improved') {
      inv.problem = 'in_progress';
      S.retests = [{ kind: 'not_improved', label: '未改善', at: '10:54:20', note: '连接使用率仍为 88%，业务偶发超时', from: '10:48:04', to: '10:53:04', evidence: ['EV-11', 'EV-12'] }];
    } else if (stage === 'retested-insufficient') {
      inv.problem = 'unconfirmed';
      S.retests = [{ kind: 'insufficient', label: '证据不足', at: '10:54:20', note: '观察窗口内 40% 采样缺失，无法判断', from: '10:48:04', to: '10:53:04', evidence: ['EV-11'] }];
    } else if (stage === 'retested-recovered') {
      inv.problem = 'resolved';
      S.retests = [{ kind: 'recovered', label: '恢复', at: '10:54:20', note: '业务侧确认订单成功率恢复', from: '10:48:04', to: '10:53:04', evidence: ['EV-11', 'EV-12'] }];
    }
  }
}

let S = freshState();
let timers = [];
let toastSeq = 0;

// ---------------------------------------------------------------- helpers
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const badge = (text, variant = '') => `<span class="badge ${variant}">${esc(text)}</span>`;
const EXEC_LABELS = { queued: '排队中', prechecking: '预检查', dispatching: '执行中', succeeded: '执行成功', failed: '执行失败', outcome_unknown: '结果未知', cancelled: '已取消' };
const execLabel = (state) => EXEC_LABELS[state] ?? state;
const latest = () => S.investigation.versions[S.investigation.versions.length - 1];
const canWrite = () => S.role !== 'viewer';
const isApprover = () => S.role === 'approver';
const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

function toast(message, kind = 'ok') {
  const seq = ++toastSeq;
  S.toast = { message, kind };
  render();
  const timer = setTimeout(() => {
    if (seq !== toastSeq) return;
    S.toast = null; render();
  }, 3200);
  timers.push(timer);
}
function clearTimers() { timers.forEach(clearTimeout); timers = []; }
function go(route) {
  if (location.hash === `#/${route}`) { render(); } else { location.hash = `#/${route}`; }
}
/** 保留进行中的模拟计时器（pushState 不触发 hashchange）。 */
function goKeepTimers(route) {
  history.pushState(null, '', `#/${route}`);
  render();
}

// ---------------------------------------------------------------- shared blocks
function pageHead(title, subtitle, actions = '') {
  return `<div class="page-head"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div><div class="toolbar">${actions}</div></div>`;
}
function roleHint() {
  if (S.role === 'viewer') return `<p class="notice neutral" role="status">当前为只读查看者：所有写操作在原型中禁用；真实权限由服务端实时校验。</p>`;
  if (isApprover()) return `<p class="notice info" role="status">当前演示为审批人账号：不能同时是计划作者/提交者时才能批准；真实系统由服务端校验。</p>`;
  return '';
}
function demoTag() { return badge('演示数据', 'accent'); }

function stateBadges() {
  const inv = S.investigation;
  const execStateLabel = { ready: '尚未执行', running: '运行中', completed: '执行完成', partial: '部分完成', unknown: '结果未知' }[inv.execution] ?? inv.execution;
  const progress = { open: '开放', waiting: '等待处理', closed: '已关闭', archived: '已归档' }[inv.lifecycle] ?? inv.lifecycle;
  const problem = { unconfirmed: '未确认', in_progress: '处理中', resolved: '已验证恢复', not_applicable: '不适用' }[inv.problem] ?? inv.problem;
  return `<div class="states">
    <span>本次执行 ${badge(execStateLabel, inv.execution === 'unknown' ? 'warn' : 'info')}</span>
    <span>调查进度 ${badge(progress, '')}</span>
    <span>业务问题 ${badge(problem, inv.problem === 'resolved' ? 'ok' : '')}</span>
  </div>`;
}

function evidenceBlock({ text, evidence, at, counter, gap }) {
  return `<div class="evidence ${counter ? 'counter' : gap ? 'gap' : ''}">
    <p class="copy">${esc(text)}</p>
    <p class="meta">${esc(at ? `观察窗口 ${at} · ` : '')}${esc(evidence ? `证据 ${evidence} · 来源：采集工具记录` : '缺口 · 未绑定证据')}</p>
  </div>`;
}

function capabilityChecks() {
  const items = [
    { key: '数据', state: 'ok', text: '窗口内 3 项有效观测（30 秒采样）', action: '查看样本' },
    { key: '资源/工具权限', state: 'ok', text: '可读 mysql-order-01、order-api-02；只读工具已授权', action: '' },
    { key: '模型', state: 'ok', text: '场景路由可用（ops 只读分析）', action: '' },
    { key: '执行范围', state: 'ok', text: '只读排查；变更需行动计划 + 独立审批', action: '' }
  ];
  return `<div class="stack">${items.map(item => `<div class="row between">
    <div><strong>${esc(item.key)}</strong> ${badge(item.state === 'ok' ? '可用' : '受限', item.state === 'ok' ? 'ok' : 'warn')}<p class="muted small">${esc(item.text)}</p></div>
    ${item.action ? `<button class="btn btn-sm" data-action="noop">${esc(item.action)}</button>` : ''}
  </div>`).join('')}</div>`
  + `<p class="muted small">四项分别判断，不用一个“就绪”掩盖缺口；缺数据或模型不可用时仍可阅读已授权事实。</p>`;
}

function timeline() {
  return `<ul class="timeline">
    <li><time>10:31:04</time><span>告警触发：连接使用率 92%（阈值 85%）</span></li>
    <li><time>10:32:10</time><span>自动派生调查 INV-2041（来自事件 EVT-8821）</span></li>
    <li><time>10:33:12</time><span>只读分析完成 → 结果 V1</span></li>
    <li><time>10:39:40</time><span>人工补充：连接池上限 200、发布记录 CHG-7712</span></li>
    <li><time>10:41:02</time><span>新一轮分析完成 → 结果 V2</span></li>
    ${S.plan.approvalId ? `<li><time>10:45:00</time><span>计划 PLAN-77 v${S.plan.version} 已提交审批 · ${esc(S.plan.approvalId)}</span></li>` : ''}
    ${S.plan.execution ? `<li><time>10:47:10</time><span>执行 ${esc(S.plan.execution.id)} · ${esc(execLabel(S.plan.execution.state))}</span></li>` : ''}
    ${S.retests.map(r => `<li><time>${esc(r.at)}</time><span>复测结论：${esc(r.label)}</span></li>`).join('')}
  </ul>`;
}

// ---------------------------------------------------------------- home
function attentionItems() {
  const items = [];
  const current = latest();
  if (current.gaps.length) {
    items.push({ title: '补充信息', ref: `调查 ${S.investigation.id}`, text: current.gaps[0].text, cta: '补充信息', action: 'go-supplement' });
  }
  if (S.plan.state === 'pending_approval') {
    items.push({ title: '审批行动计划', ref: `${S.plan.id} v${S.plan.version}`, text: '等待独立审批人处理；批准绑定当前版本，改版即失效。', cta: '查看计划', action: 'go-action' });
  }
  if (S.plan.report && !S.retests.length) {
    items.push({ title: '确认复测结论', ref: S.plan.execution?.id ?? '执行', text: '观察窗口 10:48–10:53 已结束，需人工确认恢复/未改善/证据不足。', cta: '确认复测', action: 'go-verify' });
  }
  return items;
}

function homeView() {
  const inv = S.investigation;
  return `
    ${pageHead('AI 工作空间', '围绕一个具体问题持续调查：范围、证据、判断、行动与验证都保留在同一处。', `<button class="btn" data-action="go-start">从事件发起</button>`)}
    ${roleHint()}
    <div class="grid home">
      <div>
        <section class="card" aria-labelledby="start-heading">
          <div class="card-head"><h2 id="start-heading">开始一项新调查</h2>${demoTag()}</div>
          <p class="muted small">优先带入已有上下文；常见路径不需要填写自由文本。选择不会自动发起模型分析。</p>
          <div class="notice neutral"><strong>已带入来源</strong> · ${esc(S.event.title)} ${badge('事件 EVT-8821', 'warn')}<br>
            <span class="small">对象 ${esc(S.event.resource.label)} · 窗口 ${esc(S.event.from)} — ${esc(S.event.to)}（+08:00）</span></div>
          <div class="field">
            <label for="resource-search">选择对象（可搜索，已授权范围）</label>
            <input id="resource-search" type="search" value="mysql-order-01 · instance:12 · 10.20.3.12:3306" aria-describedby="resource-hint">
            <span id="resource-hint" class="hint">重名对象同时显示地址与环境；未加载不等于不存在。</span>
          </div>
          <fieldset>
            <legend class="field-label">常见问题场景</legend>
            <div class="choice-grid" data-choice-group="scenario">
              ${[
                ['connection', '连接异常', '连接数/池占用/拒绝连接'],
                ['slow', '响应慢', '延迟、慢查询、等待事件'],
                ['capacity', '容量不足', '磁盘、内存、连接上限'],
                ['change', '变更后核验', '发布后行为是否异常'],
                ['custom', '其他问题', '只需一段描述，标题自动生成']
              ].map(([value, title, hint]) => `<label class="choice ${S.scenario === value ? 'selected' : ''}">
                <input type="radio" name="scenario" value="${value}" ${S.scenario === value ? 'checked' : ''}>
                <span><strong>${title}</strong><small>${hint}</small></span></label>`).join('')}
            </div>
          </fieldset>
          ${S.scenario === 'custom' ? `<div class="field"><label for="custom-problem">问题描述（唯一需要填写的一段）</label>
            <textarea id="custom-problem" maxlength="2000" placeholder="例如：从 10 点半开始订单写入偶发超时">${esc(S.customProblem)}</textarea>
            <span class="hint">不再要求单独填写标题；不会因描述自动扩大资源范围。</span></div>` : `<p class="muted small">该场景已带出对象与时间，必填自由文本 0 项；可在下一步核对并修改范围。</p>`}
          <div class="toolbar"><button class="btn-primary" data-action="go-start">核对范围并开始</button>
            <span class="muted small">查看页面不调用模型；开始只读排查才会创建新一轮执行。</span></div>
        </section>

        <section class="card" aria-labelledby="continue-heading">
          <div class="card-head"><h2 id="continue-heading">继续调查</h2><span class="muted small">按最近更新排序 · 仅当前授权范围</span></div>
          <ul class="list">
            ${investigationRow(inv.id, inv.title, 'mysql-order-01', '进行中', '等待补充连接池/长事务证据', '10:41', 'accent')}
            ${investigationRow('INV-2032', '[样例] 采集器延迟 · 平台异常', 'collector', '证据不足', '窗口内无有效样本', '昨天 18:20', 'warn')}
            ${investigationRow('INV-2018', '[样例] 从库复制延迟', 'mysql-report-02', '等待批准', '计划 PLAN-71 v2 待审批', '昨天 15:02', 'info')}
            ${investigationRow('INV-1998', '[样例] 备份任务失败', 'mysql-report-02', '已恢复', '复测支持恢复 · 证据 EV-31', '10-24', 'ok')}
          </ul>
        </section>
      </div>
      <aside class="stack">
        <section class="card" aria-labelledby="attention-heading">
          <div class="card-head"><h2 id="attention-heading">需要你处理</h2>${badge(`${attentionItems().length} 项`, 'accent')}</div>
          <p class="muted small">只投影原调查/审批/验证记录，不复制事件列表，不维护第二套待办状态。</p>
          <ul class="list">
            ${attentionItems().map(item => `<li class="flat"><div class="row between"><strong>${esc(item.title)}</strong>${badge(item.ref, '')}</div>
              <p class="small">${esc(item.text)}</p>
              <button class="btn btn-sm" data-action="${item.action}">${esc(item.cta)}</button></li>`).join('')}
          </ul>
          ${attentionItems().length === 0 ? '<p class="muted small">当前没有需要你处理的事项。</p>' : ''}
          <p class="muted tiny">完成或失效后自动从本区消失；点击回到原记录。</p>
        </section>
        <section class="card">
          <div class="card-head"><h3>主动分析策略</h3></div>
          <ul class="list">
            <li class="flat small">打开首页、列表、详情、刷新、切换版本：<strong>不调用模型</strong>。</li>
            <li class="flat small">只有“开始只读分析 / 继续排查 / 针对性重试”才创建 Run 并可能计费。</li>
            <li class="flat small">事件自动派生遵守服务端预算、去重与冷却；超限时在事件上显示可读原因。</li>
          </ul>
        </section>
      </aside>
    </div>`;
}

function investigationRow(id, title, subject, progress, conclusion, time, variant) {
  return `<li><div class="row between"><a class="link" href="#/detail" data-action="open-detail"><strong>${esc(title)}</strong></a>${badge(progress, variant)}</div>
    <p class="small muted">${esc(id)} · 主对象 ${esc(subject)} · ${esc(conclusion)}</p>
    <p class="meta">更新于 ${esc(time)}</p></li>`;
}

// ---------------------------------------------------------------- start
function startView() {
  const inv = S.investigation;
  return `
    <a class="step-back" href="#/home" data-action="go-home">← 返回工作空间</a>
    ${pageHead('核对范围并开始（从事件进入）', '对象与时间已带入；确认后开始只读排查。必填自由文本 0 项。', demoTag())}
    <div class="grid two">
      <div>
        <section class="card">
          <div class="card-head"><h2>本次调查范围</h2>${badge('来源：事件 EVT-8821', 'warn')}</div>
          <div class="field"><label for="inv-title">问题标题（系统生成，可改）</label>
            <input id="inv-title" type="text" value="${esc(inv.title)}"></div>
          <div class="field"><label for="inv-goal">调查目标（由事件事实生成，可改）</label>
            <textarea id="inv-goal">${esc(inv.goal)}</textarea></div>
          <dl class="facts inline">
            <div><dt>主对象</dt><dd>${esc(S.event.resource.label)}${badge('主资源', 'accent')}<br><span class="small muted">${esc(S.event.resource.type)} · ${esc(S.event.resource.key)} · ${esc(S.event.resource.addr)}</span></dd></div>
            <div><dt>绝对时间窗</dt><dd>${esc(S.event.from)}<br>— ${esc(S.event.to)}<br><span class="small muted">时区 +08:00 · 来源：告警观测窗口</span></dd></div>
            <div><dt>执行方式</dt><dd>只读排查${badge('不执行变更', 'ok')}<br><span class="small muted">创建调查不授予写操作或审批权限</span></dd></div>
          </dl>
          <details><summary>关联对象与纳入理由（1 项）</summary>
            ${S.related.map(item => `<div class="row between"><div><strong>${esc(item.label)}</strong> ${badge(item.type, '')}
              <p class="small muted">${esc(item.reason)}</p></div>
              <label class="small"><input type="checkbox" ${item.checked ? 'checked' : ''} data-action="toggle-related"> 纳入</label></div>`).join('')}
            <p class="muted tiny">推测关联不会冒充已确认依赖；不会自动扩大范围。</p>
          </details>
        </section>
        <section class="card">
          <div class="card-head"><h2>启动前能力检查</h2>${badge('四项独立', 'info')}</div>
          ${capabilityChecks()}
        </section>
      </div>
      <aside class="stack">
        <section class="card">
          <div class="card-head"><h3>将使用的证据与工具</h3></div>
          <ul class="list">
            <li class="flat small">指标：${esc(S.event.metric)}（30 秒采样，质量有效）</li>
            <li class="flat small">日志：慢查询 / 错误日志（只读）</li>
            <li class="flat small">配置：连接相关参数（只读，敏感值不回显）</li>
            <li class="flat small">关联：资源关系 1 项（已确认）</li>
          </ul>
        </section>
        <section class="card">
          <div class="card-head"><h3>不会发生的事</h3></div>
          <ul class="list">
            <li class="flat small">不调用模型生成标题/资源（标题由模板生成）</li>
            <li class="flat small">不执行任何变更或重启</li>
            <li class="flat small">不自动关闭事件或宣告恢复</li>
            <li class="flat small">不扩大资源或工具权限</li>
          </ul>
        </section>
      </aside>
    </div>
    <div class="toolbar"><button class="btn" data-action="go-home">取消</button>
      <button class="btn-primary" ${canWrite() ? '' : 'disabled'} data-action="start-run">开始只读排查</button>
      <span class="muted small">将创建第 1 轮执行；提交结果未知时会锁定输入并可核对原请求。</span></div>`;
}

// ---------------------------------------------------------------- detail
function nextStepBlock() {
  const current = latest();
  const primary = current.next.find(n => n.primary) ?? current.next[0];
  return `<section class="card" aria-labelledby="next-heading">
    <div class="card-head"><h2 id="next-heading">下一步</h2>${badge('一次一个优先动作', 'info')}</div>
    ${primary ? `<div class="notice info"><strong>${esc(primary.title)}</strong><br><span class="small">${esc(primary.why)}</span></div>
      <div class="toolbar"><button class="btn-primary" data-action="go-supplement">${esc(primary.title)}</button>
        <button class="btn" data-action="go-action">基于当前结果创建行动草案</button></div>
      <details><summary>其他合理路径</summary><ul class="list">${current.next.filter(n => n !== primary).map(n => `<li class="flat"><strong>${esc(n.title)}</strong><p class="small muted">${esc(n.why)}</p></li>`).join('') || '<li class="flat muted">暂无其他路径</li>'}</ul></details>`
      : '<p class="muted">暂无推荐路径；请先核对证据与缺口。</p>'}
  </section>`;
}

function detailView() {
  const inv = S.investigation;
  const current = inv.versions.find(v => v.version === inv.activeVersion) ?? latest();
  const running = inv.execution === 'running';
  const statusText = running
    ? '正在读取连接指标并检查慢查询日志…离开页面后仍可继续查看'
    : inv.execution === 'unknown'
      ? '正在核对原请求，暂不重复提交'
      : inv.problem === 'resolved'
        ? '复测支持恢复；验证证据与观察窗口可核对'
        : '本轮分析已结束，故障恢复尚未验证';
  const statusBadge = running ? badge('执行中', 'info') : inv.execution === 'unknown' ? badge('结果未知', 'warn') : inv.problem === 'resolved' ? badge('已恢复', 'ok') : badge('分析结束', '');
  return `
    <a class="step-back" href="#/home" data-action="go-home">← 返回工作空间</a>
    ${pageHead(inv.title, `调查 ${inv.id} · ${S.event.resource.label} · ${S.event.from} — ${S.event.to}（+08:00）`, demoTag())}
    ${roleHint()}
    <div class="grid two">
      <div>
        <section class="card">
          <div class="status-line">${statusText} ${statusBadge}</div>
          ${stateBadges()}
          <div class="toolbar" style="margin-top:12px">
            ${running ? `<button class="btn" disabled>取消本轮</button><span class="muted small">取消本轮不等于关闭调查或停止正式采集</span>` : ''}
            ${inv.execution === 'completed' ? `<button class="btn" data-action="simulate-unknown">模拟提交结果未知</button><button class="btn" data-action="simulate-disconnect">模拟断线</button>` : ''}
            ${inv.execution === 'unknown' ? `<button class="btn-primary" data-action="resolve-unknown">核对原请求（同一请求）</button><button class="btn" data-action="noop" disabled>重新提交</button><span class="muted small">未知提交不重发</span>` : ''}
            ${inv.disconnected ? `<button class="btn-primary" data-action="reconnect">重新连接并从服务端恢复</button>` : ''}
          </div>
          ${inv.disconnected ? `<div class="notice warn" role="status">连接中断，内容已隐藏；重新连接后将按服务端快照恢复，不使用本地缓存冒充事实。</div>` : ''}
        </section>

        <section class="card" aria-labelledby="judgment-heading">
          <div class="card-head"><h2 id="judgment-heading">当前判断</h2>${badge(`证据${current.sufficiency}`, current.sufficiency === '不足' ? 'warn' : 'info')}</div>
          <div class="version-tabs" role="group" aria-label="结果版本">
            ${inv.versions.map(v => `<button data-action="switch-version" data-version="${v.version}" aria-pressed="${v.version === inv.activeVersion}">V${v.version} · ${esc(v.runId)}</button>`).join('')}
          </div>
          <p class="copy">${esc(current.summary)}</p>
          <p class="small muted">${esc(current.confidence)} 结果版本 V${current.version} · ${esc(current.createdAt)}</p>
          <h3 style="margin-top:16px">支持证据</h3>
          ${current.facts.map(f => evidenceBlock(f)).join('')}
          <h3>反证</h3>
          ${current.counter.map(c => evidenceBlock({ ...c, counter: true })).join('') || '<p class="muted small">暂无记录反证。</p>'}
          <h3>缺口</h3>
          ${current.gaps.map(g => evidenceBlock({ text: g.text, gap: true })).join('') || '<p class="muted small">暂无明确缺口。</p>'}
          <p class="muted tiny">事实、推断、假设分开；不展示无校准依据的“根因置信度”。</p>
        </section>

        <section class="card" aria-labelledby="collab-heading">
          <div class="card-head"><h2 id="collab-heading">协作过程</h2><span class="muted small">真实检查摘要，不暴露模型内部推理</span></div>
          <div class="progress-list">${(inv.progress.length ? inv.progress : [
            { text: '已读取连接使用率与当前连接数', state: 'done' },
            { text: '已读取等待事件与慢查询样本', state: 'done' }
          ]).map(p => `<div class="progress-item ${p.state}"><span class="dot"></span><span>${esc(p.text)}</span></div>`).join('')}</div>
          <details><summary>工具原文与技术详情（折叠）</summary>
            <pre class="copy">${esc(JSON.stringify({ runId: current.runId, window: current.window, tools: ['metrics.query', 'logs.search', 'config.read'], provenance: { modelVersion: 'demo-unavailable', usageStatus: 'unavailable' } }, null, 2))}</pre>
            <p class="muted tiny">工具返回不代表根因或恢复已验证。</p>
          </details>
        </section>
      </div>
      <aside class="stack">
        ${nextStepBlock()}
        <section class="card">
          <div class="card-head"><h3>证据清单</h3><span class="muted small">${current.facts.length} 条有效 · 1 条过期示例</span></div>
          <ul class="list">
            <li class="flat small"><strong>EV-1 连接使用率</strong><br>对象 mysql-order-01 · 窗口 10:16–10:46<br>来源 metrics.query · 采集 10:31 · 质量有效</li>
            <li class="flat small"><strong>EV-4 应用配置</strong><br>对象 order-api（配置）· 读取 10:39<br>来源 config.read · 敏感值未回显</li>
            <li class="flat small"><strong>EV-6 历史日志样本</strong> ${badge('原文已过期', 'warn')}<br>元数据与哈希保留；不能作为新复测依据</li>
          </ul>
        </section>
        <section class="card">
          <div class="card-head"><h3>行动与验证</h3>${planBadge()}</div>
          <dl class="facts">
            <dt>计划</dt><dd>${esc(S.plan.id)} · v${S.plan.version}</dd>
            <dt>审批</dt><dd>${S.plan.approvalId ? esc(S.plan.approvalId) : '尚未提交'}</dd>
            <dt>执行</dt><dd>${S.plan.execution ? `${esc(S.plan.execution.id)} · ${esc(execLabel(S.plan.execution.state))}` : '尚未执行'}</dd>
            <dt>复测</dt><dd>${S.retests.length ? esc(S.retests[S.retests.length - 1].label) : '尚未复测'}</dd>
          </dl>
          <div class="toolbar"><button class="btn" data-action="go-action">查看行动计划</button>
            ${S.plan.report ? `<button class="btn" data-action="go-verify">查看/确认复测</button>` : ''}</div>
          <p class="muted tiny">分析完成、执行成功、事件恢复分别判断；三者互不替代。</p>
        </section>
      </aside>
    </div>`;
}

function planBadge() {
  const state = { draft: ['草案', ''], pending_approval: ['等待批准', 'warn'], approved: ['已批准', 'ok'], rejected: ['已驳回', 'danger'] }[S.plan.state];
  return badge(state[0], state[1]);
}

// ---------------------------------------------------------------- supplement
function supplementView() {
  const sup = S.supplement;
  return `
    <a class="step-back" href="#/detail" data-action="go-detail">← 返回调查</a>
    ${pageHead('结构化补充', '先查再问；选择/数值优先，无法确定时可选“不清楚”，保留缺口而不是堵住调查。', demoTag())}
    <div class="grid two">
      <div>
        <section class="card">
          <div class="card-head"><h2>本轮需要确认</h2>${badge('来自结果 V1 的缺口', 'info')}</div>
          <p class="muted small">问题由结果缺口生成，不是通用问卷；已自动读取的配置会显示来源。</p>

          <div class="field">
            <span class="field-label">1. 应用连接池上限</span>
            <p class="small">已读取：<strong>200</strong> <span class="muted">（来源：应用配置 cmdb/app/order-api · 读取于 10:39）</span></p>
            <div class="row"><input id="pool-value" type="number" min="1" value="${esc(sup.pool)}" ${sup.poolUnknown ? 'disabled' : ''} aria-label="连接池上限数值" style="max-width:180px">
              <label class="small"><input type="checkbox" data-action="toggle-pool-unknown" ${sup.poolUnknown ? 'checked' : ''}> 不清楚</label></div>
            <span class="hint">“不清楚”不会填入默认值，也不会被当作 200。</span>
          </div>

          <div class="field">
            <span class="field-label">2. 最近是否有变更</span>
            <div class="choice-grid">
              ${[['yes', '有'], ['no', '无'], ['unknown', '不清楚']].map(([value, label]) => `<label class="choice ${sup.change === value ? 'selected' : ''}">
                <input type="radio" name="change" value="${value}" ${sup.change === value ? 'checked' : ''}><span><strong>${label}</strong></span></label>`).join('')}
            </div>
            ${sup.change === 'yes' ? `<div class="field"><label for="change-ref">关联变更记录</label>
              <select id="change-ref"><option>${esc(sup.changeRef)}</option><option>其他变更（搜索授权记录）</option></select></div>` : ''}
          </div>

          <div class="field">
            <span class="field-label">3. 业务症状现状</span>
            <div class="choice-grid">
              ${[['recovered', '已恢复'], ['abnormal', '仍异常'], ['unknown', '无法确认']].map(([value, label]) => `<label class="choice ${sup.symptom === value ? 'selected' : ''}">
                <input type="radio" name="symptom" value="${value}" ${sup.symptom === value ? 'checked' : ''}><span><strong>${label}</strong></span></label>`).join('')}
            </div>
            <span class="hint">业务症状确认不会替代指标复测，也不会自动把问题标为已恢复。</span>
          </div>

          <div class="field">
            <label for="sup-note">可选补充说明</label>
            <textarea id="sup-note" maxlength="2000" placeholder="例如：10:05 发布了 order-api v2.14，之后连接数持续上涨">${esc(sup.note)}</textarea>
          </div>
          <div class="toolbar"><button class="btn" data-action="go-detail">取消</button>
            <button class="btn-primary" ${canWrite() ? '' : 'disabled'} data-action="submit-supplement">提交补充并生成下一轮</button>
            <span class="muted small">提交会创建新的 Run；不会改写正在执行的窗口或历史结果。</span></div>
        </section>
      </div>
      <aside class="stack">
        <section class="card">
          <div class="card-head"><h3>提交后会发生什么</h3></div>
          <ul class="list">
            <li class="flat small">生成新的结果版本 V2，旧版 V1 保留可切换查看。</li>
            <li class="flat small">“不清楚”会作为缺口写入 V2，不编造数值。</li>
            <li class="flat small">不会自动执行变更、审批或宣告恢复。</li>
            <li class="flat small">提交结果未知时锁定输入，并可用同一请求核对。</li>
          </ul>
        </section>
        <section class="card">
          <div class="card-head"><h3>当前缺口（V1）</h3></div>
          ${latest().gaps.map(g => `<p class="small">• ${esc(g.text)}</p>`).join('')}
        </section>
      </aside>
    </div>`;
}

// ---------------------------------------------------------------- action
function actionView() {
  const plan = S.plan;
  const current = latest();
  const approverCanApprove = isApprover() && plan.state === 'pending_approval';
  return `
    <a class="step-back" href="#/detail" data-action="go-detail">← 返回调查</a>
    ${pageHead('行动计划与独立审批', '从确切结果版本生成草案；预检查、审批、执行、复测各自独立。', demoTag())}
    ${roleHint()}
    <div class="grid two">
      <div>
        <section class="card">
          <div class="card-head"><h2>行动草案</h2>${planBadge()}</div>
          <div class="steps"><span class="done">1 确认计划</span><span class="${plan.state === 'pending_approval' ? 'current' : plan.state === 'approved' ? 'done' : ''}">2 独立审批</span><span class="${plan.state === 'approved' ? 'current' : ''}">3 受控执行</span><span class="${plan.report ? 'current' : ''}">4 效果验证</span></div>
          <dl class="facts">
            <dt>来源调查</dt><dd>${S.investigation.id} · 结果版本 V${current.version} ${badge('已绑定', 'accent')}</dd>
            <dt>目标对象</dt><dd>server:7 · order-api-02（演练服务，授权范围内）</dd>
            <dt>注册动作</dt><dd>重启演练服务（受控）· 唯一可用动作</dd>
            <dt>计划版本</dt><dd>v${plan.version} · 内容摘要 9f2c…（改版即失效）</dd>
          </dl>
          <div class="field"><label for="plan-impact">预计影响（系统生成，可改）</label>
            <textarea id="plan-impact" ${plan.state !== 'draft' ? 'disabled' : ''}>${esc(plan.impact)}</textarea>
            <span class="hint">未知业务影响单列为待确认项，不编造。</span></div>
          <h3>执行前置与验证标准</h3>
          <ul class="list">
            <li class="flat small">预检查：演练服务在线；近 5 分钟无进行中的变更；连接使用率仍 &gt; 85%。</li>
            <li class="flat small">执行前观测 120 秒 · 就绪等待 60 秒 · 恢复观察 300 秒 · 每 10 秒采样。</li>
            <li class="flat small">回退：重启失败时保持原服务，不再次自动重启；额外重启上限 1 次需新计划。</li>
          </ul>
          <div class="toolbar">
            ${plan.state === 'draft' ? `<button class="btn-primary" ${canWrite() ? '' : 'disabled'} data-action="submit-approval">提交当前版本审批</button>` : ''}
            ${plan.state === 'pending_approval' ? `<span class="muted small">已提交审批 ${esc(plan.approvalId)}；等待独立审批人。</span>` : ''}
            ${plan.state === 'approved' ? `<button class="btn-primary" ${canWrite() ? '' : 'disabled'} data-action="confirm-execute">执行当前批准版本</button>` : ''}
            ${plan.rejected ? `<span class="muted small">已驳回：可修改为新版本后重新提交。</span>` : ''}
          </div>
        </section>

        ${plan.approvalId ? `<section class="card" aria-labelledby="approval-heading">
          <div class="card-head"><h2 id="approval-heading">独立人工审批</h2>${badge(plan.state === 'approved' ? '已批准' : plan.state === 'rejected' ? '已驳回' : '等待处理', plan.state === 'approved' ? 'ok' : 'warn')}</div>
          <dl class="facts"><dt>审批记录</dt><dd>${esc(plan.approvalId)}（服务端返回，自动绑定）</dd>
            <dt>绑定版本</dt><dd>PLAN-77 v${plan.version} · 摘要 9f2c…</dd>
            <dt>作者 / 提交者</dt><dd>${esc(plan.author)} / ${esc(plan.requester)}</dd></dl>
          ${plan.state === 'pending_approval' ? `
            <p class="small">作者与提交者不能自批；批准只绑定当前版本。</p>
            <div class="field"><span class="field-label">审批理由（常用可选，其他补文字）</span>
              <div class="choice-grid">${['影响可控，同意演练', '需补充回退说明', '其他理由'].map((label, i) => `<label class="choice"><input type="radio" name="approve-note" value="${i}" ${i === 0 ? 'checked' : ''}><span><strong>${label}</strong></span></label>`).join('')}</div>
              <input id="approve-other" type="text" placeholder="选择“其他理由”时填写（可选）" aria-label="其他审批理由">
            </div>
            ${isApprover() ? `<div class="toolbar"><button class="btn-primary" data-action="approve">批准当前版本</button><button class="btn" data-action="reject">驳回</button></div>`
              : `<p class="notice warn" role="status">当前演示角色是计划作者/提交者，不能自批。请在左侧切换为“审批人（另一账号）”。</p>`}
          ` : `<p class="small">${plan.state === 'approved' ? '批准已绑定 v' + plan.version + '；仍需显式执行。' : '已驳回；旧版本不可再执行。'}</p>`}
        </section>` : ''}

        ${plan.execution ? `<section class="card" aria-labelledby="execution-heading">
          <div class="card-head"><h2 id="execution-heading">执行与回执</h2>${badge(plan.execution.state === 'succeeded' ? '执行成功' : plan.execution.state === 'outcome_unknown' ? '结果未知' : '执行中', plan.execution.state === 'outcome_unknown' ? 'warn' : 'ok')}</div>
          <dl class="facts"><dt>执行记录</dt><dd>${esc(plan.execution.id)} · 绑定计划 v${plan.version}</dd>
            <dt>发送时间</dt><dd>${esc(plan.execution.at)}</dd>
            <dt>业务恢复</dt><dd>${plan.report ? badge(plan.report.state === 'passed' ? '已恢复（复测通过）' : '待复测', plan.report.state === 'passed' ? 'ok' : 'warn') : '尚未验证'}</dd></dl>
          ${plan.execution.state === 'outcome_unknown' ? `<p class="notice warn">发送结果未知不等于未执行或已取消。只核对原 operation，不创建新行动。</p>
            <button class="btn" data-action="reconcile">核对原回执（不重发）</button>` : ''}
          <p class="muted small">执行成功不替代恢复验证；报告仅证明观测关联。</p>
        </section>` : ''}
      </div>
      <aside class="stack">
        <section class="card">
          <div class="card-head"><h3>职责分离</h3></div>
          <ul class="list">
            <li class="flat small">作者/提交者不能批准自己的计划。</li>
            <li class="flat small">批准绑定版本 + 内容摘要；改版使旧批准失效。</li>
            <li class="flat small">无执行权限或批准过期时，执行按钮禁用。</li>
          </ul>
        </section>
        <section class="card">
          <div class="card-head"><h3>来源与版本</h3></div>
          <p class="small">本次计划引用结果 V${current.version}（${esc(current.runId)}）。若结果出现新版本，需显式重新绑定，不静默替换。</p>
          <button class="btn btn-sm" data-action="noop" disabled>查看版本差异（演示未展开）</button>
        </section>
      </aside>
    </div>`;
}

// ---------------------------------------------------------------- verify
function verifyView() {
  const report = S.plan.report;
  const lastRetest = S.retests[S.retests.length - 1];
  return `
    <a class="step-back" href="#/detail" data-action="go-detail">← 返回调查</a>
    ${pageHead('恢复验证与三类复测结论', '依据后续实际观测、明确窗口与副作用；分析完成和命令成功都不自动恢复。', demoTag())}
    ${roleHint()}
    <div class="grid two">
      <div>
        <section class="card">
          <div class="card-head"><h2>本次复测</h2>${report ? badge({ passed: '报告：通过', failed: '报告：未通过', inconclusive: '报告：证据不足', observing: '观察中', pending: '待观察' }[report.state] ?? '报告已生成', report.state === 'passed' ? 'ok' : 'warn') : badge('等待执行', '')}</div>
          ${report ? `
            <dl class="facts inline">
              <div><dt>观察窗口</dt><dd>${esc(report.from)}<br>— ${esc(report.to)}<br><span class="small muted">时区 +08:00 · 300 秒观察</span></dd></div>
              <div><dt>关键观测</dt><dd>连接使用率 ${esc(report.before)} → <strong>${esc(report.after)}</strong><br><span class="small muted">阈值 85% · 采样 ${esc(report.samples ?? '30')} 次 / 缺失 ${esc(report.missing ?? '0')}</span></dd></div>
              <div><dt>副作用</dt><dd>${esc(report.sideEffects)}<br><span class="small muted">来自执行与观测记录</span></dd></div>
            </dl>
            <p class="small">证据：${report.evidence.map(e => badge(e, '')).join(' ')} · 报告 REP-5 v1 · 不可变，有效期至 11:10</p>
            <h3>请确认结论</h3>
            <div class="choice-grid" data-choice-group="verdict">
              ${[['recovered', '恢复', '窗口内指标回到阈值内，无新增负作用'],
                 ['not_improved', '未改善', '指标仍越界或症状持续'],
                 ['insufficient', '证据不足', '窗口无有效样本/质量不足/观测中断']].map(([value, label, hint]) => `<label class="choice ${S.pendingVerdict === value ? 'selected' : ''}">
                <input type="radio" name="verdict" value="${value}" ${S.pendingVerdict === value ? 'checked' : ''}><span><strong>${label}</strong><small>${hint}</small></span></label>`).join('')}
            </div>
            <div class="field"><label for="verify-note">补充说明（可选）</label><textarea id="verify-note" maxlength="1000" placeholder="例如：业务侧确认订单成功率已恢复">${esc(S.verifyNote ?? '')}</textarea></div>
            <div class="toolbar"><button class="btn-primary" ${canWrite() ? '' : 'disabled'} data-action="submit-verdict">保存复测结论</button>
              <span class="muted small">结论追加保存，不覆盖历史；不会自动关闭事件。</span></div>
          ` : `<div class="empty"><strong>尚无可复测的执行</strong>复测必须在行动执行后，以实际观测为准；缺少观测时只能给出“证据不足”。<br><br>
            <button class="btn" data-action="demo-executed">演示：跳到“已执行、待复测”阶段</button></div>`}
        </section>
        ${lastRetest ? `<section class="card">
          <div class="card-head"><h2>最新结论</h2>${badge(lastRetest.label, lastRetest.kind === 'recovered' ? 'ok' : lastRetest.kind === 'not_improved' ? 'warn' : '')}</div>
          <p class="copy">${esc(lastRetest.note || '无补充说明')} · ${esc(lastRetest.at)}</p>
          ${lastRetest.kind === 'not_improved' ? '<div class="notice warn">行动记为无效，可回到同一调查继续排查（创建新 Run，保留本结论）。</div><button class="btn" data-action="go-detail">回同一调查继续</button>' : ''}
          ${lastRetest.kind === 'insufficient' ? '<div class="notice warn">证据不足：不计为恢复或未改善；需补充采集或调整窗口后重新复测。</div>' : ''}
          ${lastRetest.kind === 'recovered' ? '<div class="notice ok">复测支持恢复；业务问题状态需要人工确认后才可关闭调查。</div>' : ''}
        </section>` : ''}
      </div>
      <aside class="stack">
        <section class="card">
          <div class="card-head"><h3>复测历史</h3><span class="muted small">追加记录，不改写</span></div>
          ${S.retests.length ? `<ul class="list">${S.retests.map(r => `<li class="flat small"><strong>${esc(r.label)}</strong> · ${esc(r.at)}<br><span class="muted">窗口 ${esc(r.from)} — ${esc(r.to)} · 证据 ${esc(r.evidence.join('、'))}</span></li>`).join('')}</ul>`
            : '<p class="muted small">尚无复测记录。</p>'}
        </section>
        <section class="card">
          <div class="card-head"><h3>三类结论的边界</h3></div>
          <ul class="list">
            <li class="flat small"><strong>恢复</strong>：指标回到基线/阈值内且无新增负作用。</li>
            <li class="flat small"><strong>未改善</strong>：仍越界；行动可标记无效并继续排查。</li>
            <li class="flat small"><strong>证据不足</strong>：不能算作恢复或未改善。</li>
          </ul>
        </section>
      </aside>
    </div>`;
}

// ---------------------------------------------------------------- handoff
function handoffView() {
  const current = latest();
  const confirmed = S.handoffConfirmed.gaps && S.handoffConfirmed.sensitive;
  return `
    <a class="step-back" href="#/detail" data-action="go-detail">← 返回调查</a>
    ${pageHead('交接摘要（从记录生成，不调用模型）', '草案只拼装已有记录；用户确认缺口与敏感信息后才可分享。', demoTag())}
    <div class="grid two">
      <div>
        <section class="card">
          <div class="card-head"><h2>交接草案</h2>${badge(`来源：结果 V${current.version}`, 'info')}</div>
          <h3>问题与影响</h3><p class="copy">订单库连接使用率在 10:31 达 92%，影响订单写入成功率；主对象 mysql-order-01。</p>
          <h3>时间线</h3>${timeline()}
          <h3>证据支持的结论</h3><p class="copy">${esc(current.summary)}</p>
          <h3>未解决疑点</h3><ul>${current.gaps.map(g => `<li class="small">${esc(g.text)}</li>`).join('')}</ul>
          <h3>已执行动作</h3><p class="copy">${S.plan.execution ? '重启演练服务 order-api-canary（PLAN-77 v' + S.plan.version + '，执行 ' + esc(S.plan.execution.id) + '）' : '尚未执行变更。'}</p>
          <h3>效果验证</h3><p class="copy">${S.retests.length ? esc(S.retests[S.retests.length - 1].label) + ' · 窗口 ' + esc(S.retests[S.retests.length - 1].from) + ' — ' + esc(S.retests[S.retests.length - 1].to) : '尚未复测。'}</p>
          <h3>下一位处理人</h3><p class="copy">待选择（从授权名单搜索；演示未展开）。</p>
          <p class="muted tiny">生成来源：${S.investigation.id} · 结果 V${current.version} · 证据 EV-1、EV-2、EV-4、EV-5。未使用模型生成新事实。</p>
        </section>
      </div>
      <aside class="stack">
        <section class="card">
          <div class="card-head"><h3>分享前确认</h3></div>
          <label class="small" style="display:block;margin:6px 0"><input type="checkbox" data-action="confirm-gap" ${S.handoffConfirmed.gaps ? 'checked' : ''}> 我已核对缺口与未验证项</label>
          <label class="small" style="display:block;margin:6px 0"><input type="checkbox" data-action="confirm-sensitive" ${S.handoffConfirmed.sensitive ? 'checked' : ''}> 我已确认无未脱敏敏感信息</label>
          <button class="btn-primary" ${confirmed && canWrite() ? '' : 'disabled'} data-action="copy-handoff">生成并复制交接摘要</button>
          <p class="muted tiny">分享不扩大访问权限；无权限者打开原记录时仍按实时权限校验。</p>
        </section>
        <section class="card">
          <div class="card-head"><h3>案例候选</h3></div>
          <p class="small">从这一确切结果版本整理；需脱敏与审核后才进入知识库。</p>
          <button class="btn" data-action="noop">整理案例候选（演示未展开）</button>
          <p class="muted tiny">案例是参考材料，不能作为当前故障已发生/已恢复的事实。</p>
        </section>
      </aside>
    </div>`;
}

// ---------------------------------------------------------------- exceptions
function exceptionsView() {
  const rows = [
    ['无数据', '启动前与结果区提示“窗口内无有效样本”，列出缺失项', '补采集、调整窗口、查看历史', '输出当前健康/根因'],
    ['缺模型', '事实可读；分析按钮禁用并说明原因', '查看事实、检查模型配置', '假装正在分析'],
    ['无权限', '明确缺失的权限/对象，不显示内容', '重新确认权限、返回原入口', '用缓存内容顶替'],
    ['部分失败', '保留已完成项，列失败项与原因', '针对性重试（新 Run）', '重放原执行'],
    ['证据过期', '标注“原文已过期”，保留哈希/元数据', '重新采集、缩小窗口', '用过期证据支撑结论'],
    ['结果版本变化', '当前引用版本与最新版本并列显示差异', '切到指定版本、重新绑定行动', '静默用最新版替换原判断'],
    ['断线重连', '立即隐藏内容，重连后从服务端快照恢复', '重新连接、刷新', '用本地缓存冒充服务端事实'],
    ['提交结果未知', '锁定输入，显示“正在核对原请求”', '核对原请求（同一 idempotency key）', '重复提交新请求'],
    ['撤权/会话失效', '清空敏感内容，回到无权态', '重新登录/申请权限', '保留旧内容继续操作'],
    ['越权/过期批准', '计划标注已过期/无权；执行禁用', '重新提交审批', '用旧批准执行'],
    ['行动无效', '复测“未改善”，行动记录保留', '回同一调查继续排查（新 Run）', '自动重试同一变更']
  ];
  return `
    ${pageHead('异常与边界分支', '以下分支必须在实现阶段逐条可用；本页为设计对照，不是运行结果。', demoTag())}
    <section class="card">
      <div class="card-head"><h2>分支矩阵</h2><span class="muted small">与 acceptance-matrix A3/A5 对应</span></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>场景</th><th>界面表现</th><th>可用动作</th><th>禁止</th></tr></thead>
        <tbody>${rows.map(([scene, ui, action, forbidden]) => `<tr><td><strong>${scene}</strong></td><td>${ui}</td><td>${action}</td><td class="muted">${forbidden}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>可现场试的分支</h2></div>
      <div class="toolbar">
        <button class="btn" data-action="simulate-unknown">模拟提交结果未知</button>
        <button class="btn" data-action="simulate-disconnect">模拟断线</button>
        <button class="btn" data-action="simulate-expired">模拟证据过期</button>
        <button class="btn" data-action="simulate-nomodel">模拟模型不可用</button>
      </div>
      ${S.exceptionDemo ? `<div class="notice ${S.exceptionDemo.kind}" role="status"><strong>${esc(S.exceptionDemo.title)}</strong><br>${esc(S.exceptionDemo.text)}</div>` : '<p class="muted small">选择一项，观察对应提示与可用动作。</p>'}
    </section>`;
}

// ---------------------------------------------------------------- compat
function compatView() {
  const rows = [
    ['AI 工作空间 /investigations', '?investigation / ?resource / ?query,state,profile', '保留为唯一调查入口；新增发起区、需要你处理、继续列表', '旧筛选参数语义不变'],
    ['关注事项 /attention', '告警事件列表', '保留；不改成调查待办，“需要你处理”只引用原记录', '不得变成第二套待办'],
    ['事件中心 /events', '?view=active/aggregate/rules/notifications/system', '保留；事件详情新增发起/打开调查并携带对象、窗口、返回位置', '五个 view 值继续有效'],
    ['跨资源诊断 /resource-diagnosis', '选择资源 + 四页签 + 旧分析链接', '保留只读证据浏览，不再作为独立诊断主线；增加“带入 AI 调查”', '删除页面会破坏历史证据入口'],
    ['资源详情关联调查', '/investigations?resource=type:id、?investigation=', '保留；新增发起调查入口', '三类资源共享组件需一起回归'],
    ['实例 AI 诊断弹窗', '旧 ai_analysis，只读兼容', '保留历史查看，不补跑；新入口引导调查', '旧结果归属与权限不被替代'],
    ['告警详情“开始分析”', '旧触发入口', '保留；是否派生调查仍由服务端 lane 决定', '前端改道会绕过锁/去重/预算'],
    ['行动中心 /operations-actions', '?plan、?sourceInvestigation、?resultVersion', '保留；草案从结果带入，手输 ID 降为高级入口', '计划版本绑定不变'],
    ['案例库 /operations-knowledge', '?sourceInvestigation、?resultVersion', '保留；从确切结果版本整理候选', '案例不反写调查'],
    ['统一审批 /approval', '审批记录', '保留；调查/首页投影同一记录', '不复制审批状态'],
    ['审计中心 /audit', '审计记录', '保留；调查/行动/执行关联展示', '不新增第二套审计'],
    ['报告 /reports', '历史报告', '保留；与调查结果版本分别展示', '不合并两套版本号'],
    ['对话 /chat', '“转为调查”', '保留；原对话作来源引用', '不复制两套执行会话']
  ];
  return `
    ${pageHead('旧入口与深链接兼容', '取消独立跨资源诊断主线，但旧页面、深链接与历史记录继续可用。', demoTag())}
    <section class="card">
      <div class="table-wrap"><table class="data">
        <thead><tr><th>旧入口</th><th>现有深链接/形态</th><th>本轮设计要求</th><th>兼容风险</th></tr></thead>
        <tbody>${rows.map(([entry, link, design, risk]) => `<tr><td><strong>${esc(entry)}</strong></td><td class="small">${esc(link)}</td><td class="small">${esc(design)}</td><td class="small muted">${esc(risk)}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>新增深链接约束</h2></div>
      <ul class="list">
        <li class="flat small"><code>returnTo</code> 必须是同源相对 URL；外部地址拒绝，无权时回退列表并说明。</li>
        <li class="flat small"><code>?investigation=</code> 无效或无权时显示明确空态，不静默回列表。</li>
        <li class="flat small">多值 <code>?resource=</code> 合计不得伪造全局总数（沿用现有“已加载去重”语义）。</li>
        <li class="flat small">旧 <code>ai_analysis</code> 只读展示，不补跑、不重绑证据、不改写为当前事实。</li>
      </ul>
    </section>`;
}

// ---------------------------------------------------------------- dialogs
function dialog() {
  if (!S.dialog) return '';
  const { title, body, confirm, cancel = '取消' } = S.dialog;
  return `<div class="dialog-backdrop" role="presentation"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
    <h2 id="dlg-title">${esc(title)}</h2>${body}
    <div class="actions"><button class="btn" data-action="close-dialog">${esc(cancel)}</button>
      <button class="btn-primary" data-action="confirm-dialog">${esc(confirm)}</button></div>
  </div></div>`;
}

// ---------------------------------------------------------------- render
const VIEWS = {
  home: homeView, start: startView, detail: detailView, supplement: supplementView,
  action: actionView, verify: verifyView, handoff: handoffView, exceptions: exceptionsView, compat: compatView
};

function render() {
  const route = (location.hash.replace(/^#\/?/, '') || 'home').split('?')[0];
  const view = VIEWS[route] ? route : 'home';
  S.screen = view;
  document.querySelectorAll('.nav nav a').forEach(a => {
    if (a.dataset.nav === view) a.classList.add('active'); else a.classList.remove('active');
    if (a.dataset.nav === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const main = document.getElementById('main');
  const hidden = S.investigation.disconnected && view === 'detail';
  main.innerHTML = VIEWS[view]() + dialog();
  if (hidden) {
    main.innerHTML = `<a class="step-back" href="#/home" data-action="go-home">← 返回工作空间</a>
      <section class="card"><div class="empty"><strong>连接中断</strong>内容已隐藏，请重新连接；不使用本地缓存冒充服务端事实。<br><br>
      <button class="btn-primary" data-action="reconnect">重新连接并从服务端恢复</button></div></section>` + dialog();
  }
  const role = document.getElementById('role');
  if (role) role.value = S.role;
  const stage = document.getElementById('stage');
  if (stage) stage.value = S.stage;
  const toastEl = document.getElementById('toast');
  if (toastEl) toastEl.remove();
  if (S.toast) {
    const el = document.createElement('div');
    el.id = 'toast';
    el.className = `toast ${S.toast.kind}`;
    el.setAttribute('role', 'status');
    el.textContent = S.toast.message;
    document.body.appendChild(el);
  }
}

// ---------------------------------------------------------------- actions
const actions = {
  noop() {},

  'go-home': () => go('home'),
  'go-start': () => go('start'),
  'go-detail': () => go('detail'),
  'go-supplement': () => go('supplement'),
  'go-action': () => go('action'),
  'go-verify': () => go('verify'),
  'open-detail': () => go('detail'),

  'start-run'() {
    if (!canWrite()) return;
    const inv = S.investigation;
    inv.title = document.getElementById('inv-title')?.value || inv.title;
    inv.goal = document.getElementById('inv-goal')?.value || inv.goal;
    inv.execution = 'running'; inv.running = true;
    inv.versions = [{ ...V1 }]; inv.activeVersion = 1; inv.problem = 'in_progress';
    S.plan = { ...S.plan, state: 'draft', approvalId: '', execution: null, report: null };
    S.retests = [];
    S.stage = 'after-v1';
    inv.progress = [
      { text: '正在读取连接使用率与当前连接数', state: 'running' },
      { text: '等待读取等待事件与慢查询样本', state: 'pending' },
      { text: '等待核对资源关系', state: 'pending' }
    ];
    goKeepTimers('detail');
    const step1 = setTimeout(() => {
      inv.progress[0].state = 'done';
      inv.progress[1].state = 'running';
      render();
    }, 700);
    const step2 = setTimeout(() => {
      inv.progress[1].state = 'done';
      inv.progress[2].state = 'running';
      render();
    }, 1400);
    const step3 = setTimeout(() => {
      inv.progress[2].state = 'done';
      inv.execution = 'completed'; inv.running = false;
      inv.progress.push({ text: '已生成结果版本 V1', state: 'done' });
      if (!inv.versions.some(v => v.version === 1)) inv.versions = [V1];
      render();
    }, 2200);
    timers.push(step1, step2, step3);
  },

  'switch-version'(el) {
    S.investigation.activeVersion = Number(el.dataset.version);
    render();
  },

  'toggle-related'(el) {
    const item = S.related[0];
    item.checked = el.checked;
    render();
  },

  'toggle-pool-unknown'(el) {
    S.supplement.poolUnknown = el.checked;
    if (el.checked) S.supplement.pool = '';
    render();
  },

  'submit-supplement'() {
    if (!canWrite()) return;
    const poolEl = document.getElementById('pool-value');
    const noteEl = document.getElementById('sup-note');
    if (poolEl && !S.supplement.poolUnknown) S.supplement.pool = poolEl.value;
    if (noteEl) S.supplement.note = noteEl.value;
    const unknown = S.supplement.poolUnknown;
    const version = Math.max(...S.investigation.versions.map(v => v.version)) + 1;
    const next = { ...(unknown ? V2_UNKNOWN_POOL : V2_BASE), version, runId: `RUN-${5500 + version}` };
    S.investigation.versions = [...S.investigation.versions.filter(v => v.version !== version), next];
    S.investigation.activeVersion = version;
    S.stage = 'after-v2';
    S.investigation.execution = 'completed';
    toast(unknown ? '已生成结果 V2；连接池上限保留为缺口。' : '已生成结果 V2（连接池上限 200，发布记录已关联）。', 'ok');
    go('detail');
  },

  'submit-approval'() {
    if (!canWrite()) return;
    S.plan.state = 'pending_approval';
    S.plan.approvalId = 'APP-331';
    S.plan.approvalNote = '';
    S.stage = 'pending-approval';
    toast('计划 v3 已提交审批 APP-331；等待独立审批人。', 'ok');
    render();
  },

  approve() {
    if (!isApprover()) return;
    S.plan.state = 'approved';
    S.plan.approvalNote = '影响可控，同意演练';
    toast('已批准当前版本 v3；批准不会自动执行。', 'ok');
    render();
  },

  reject() {
    if (!isApprover()) return;
    S.plan.state = 'rejected';
    toast('已驳回当前版本；如有修改需创建新版本并重新提交。', 'warn');
    render();
  },

  'confirm-execute'() {
    if (!canWrite() || S.plan.state !== 'approved') return;
    S.dialog = {
      title: '确认执行当前批准版本',
      body: `<dl class="facts"><dt>目标</dt><dd>${esc(S.plan.target)}</dd><dt>计划版本</dt><dd>v${S.plan.version} · 已批准</dd><dt>影响</dt><dd>${esc(S.plan.impact)}</dd></dl>
        <p class="notice warn">重启不能恢复原进程状态；再次重启属于新的行动，需要新计划和新批准。</p>`,
      confirm: '确认执行一次'
    };
    render();
  },

  'confirm-dialog'() {
    S.dialog = null;
    S.plan.execution = { id: 'EXE-12', state: 'dispatching', at: now() };
    render();
    const t1 = setTimeout(() => {
      if (!S.plan.execution) return;
      S.plan.execution.state = 'succeeded';
      S.plan.report = { state: 'passed', from: '10:48:04', to: '10:53:04', before: '92%', after: '61%', sideEffects: '无新增错误；重启期间 20 秒不可用（预期内）', evidence: ['EV-11', 'EV-12'] };
      S.stage = 'after-execution';
      toast('执行成功，效果报告已生成；仍需人工确认复测结论。', 'ok');
      render();
    }, 1600);
    timers.push(t1);
  },

  'close-dialog'() { S.dialog = null; render(); },

  'demo-executed'() { applyStage('after-execution'); render(); },

  'simulate-unknown'() {
    S.investigation.execution = 'unknown';
    S.investigation.acceptanceUnknown = true;
    toast('演示：提交结果未知，已锁定输入；不得重发。', 'warn');
    if (S.screen !== 'detail') go('detail'); else render();
  },

  'resolve-unknown'() {
    S.investigation.execution = 'completed';
    S.investigation.acceptanceUnknown = false;
    toast('已用同一请求核对原提交：该请求已被接受，未重复创建。', 'ok');
    render();
  },

  'simulate-disconnect'() {
    S.investigation.disconnected = true;
    toast('演示：连接中断，内容已隐藏。', 'warn');
    if (S.screen !== 'detail') go('detail'); else render();
  },

  'reconnect'() {
    S.investigation.disconnected = false;
    toast('已重新连接，内容从服务端快照恢复。', 'ok');
    render();
  },

  'simulate-expired'() {
    S.exceptionDemo = { kind: 'warn', title: '证据 EV-6 原文已过期', text: '保留元数据与内容哈希，不能作为新复测依据；可重新采集或缩小窗口。' };
    go('exceptions');
  },

  'simulate-nomodel'() {
    S.exceptionDemo = { kind: 'info', title: '模型当前不可用', text: '已授权事实仍可阅读；“开始只读分析”禁用并说明原因。查看事实不会调用模型。' };
    go('exceptions');
  },

  'submit-verdict'() {
    if (!canWrite()) return;
    const verdict = S.pendingVerdict;
    if (!verdict) { toast('请选择恢复 / 未改善 / 证据不足。', 'warn'); return; }
    const label = { recovered: '恢复', not_improved: '未改善', insufficient: '证据不足' }[verdict];
    const noteEl = document.getElementById('verify-note');
    S.retests.push({
      kind: verdict, label, at: now(), note: noteEl?.value || '',
      from: '10:48:04', to: '10:53:04', evidence: ['EV-11', 'EV-12']
    });
    if (verdict === 'recovered') { S.investigation.problem = 'resolved'; S.stage = 'retested-recovered'; }
    else if (verdict === 'not_improved') { S.investigation.problem = 'in_progress'; S.stage = 'retested-not-improved'; }
    else { S.investigation.problem = 'unconfirmed'; S.stage = 'retested-insufficient'; }
    toast(`已保存复测结论：${label}（追加记录，不覆盖历史）。`, verdict === 'recovered' ? 'ok' : 'warn');
    render();
  },

  'confirm-gap'(el) { S.handoffConfirmed.gaps = el.checked; render(); },
  'confirm-sensitive'(el) { S.handoffConfirmed.sensitive = el.checked; render(); },
  'copy-handoff'() { toast('交接摘要已生成（演示未写入剪贴板）。', 'ok'); },

  'reconcile'() {
    if (!S.plan.execution) return;
    S.plan.execution.state = 'succeeded';
    if (!S.plan.report) S.plan.report = { state: 'passed', from: '10:48:04', to: '10:53:04', before: '92%', after: '61%', sideEffects: '无新增错误', evidence: ['EV-11', 'EV-12'] };
    toast('已核对原回执：执行已成功；未创建新行动。', 'ok');
    render();
  }
};

// choice groups (radio) update state
function handleChoice(event) {
  const radio = event.target.closest('input[type=radio]');
  if (!radio) return;
  const group = radio.closest('[data-choice-group]')?.dataset.choiceGroup;
  if (!group) return;
  if (group === 'scenario') S.scenario = radio.value;
  if (group === 'verdict') S.pendingVerdict = radio.value;
  render();
}

document.addEventListener('change', (event) => {
  handleChoice(event);
  const el = event.target;
  if (el.matches('[name="change"]')) { S.supplement.change = el.value; render(); }
  if (el.matches('[name="symptom"]')) { S.supplement.symptom = el.value; render(); }
  if (el.id === 'role') { S.role = el.value; render(); }
  if (el.id === 'stage') { applyStage(el.value); render(); }
});

document.addEventListener('input', (event) => {
  const el = event.target;
  if (el.id === 'custom-problem') S.customProblem = el.value;
  if (el.id === 'sup-note') S.supplement.note = el.value;
  if (el.id === 'verify-note') S.verifyNote = el.value;
});

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (el.tagName === 'A') {
    // internal anchors are handled by hash routing; avoid double navigation
  }
  if (actions[action]) {
    event.preventDefault();
    actions[action](el);
  }
});

window.addEventListener('hashchange', () => { clearTimers(); render(); });
window.addEventListener('beforeunload', clearTimers);

// initial route
applyStage(S.stage);
const initialParams = new URLSearchParams((location.hash.replace(/^#\/?/, '').split('?')[1]) || '');
if (initialParams.get('stage')) applyStage(initialParams.get('stage'));
if (initialParams.get('role')) S.role = initialParams.get('role');
if (!location.hash) location.hash = '#/home';
render();
