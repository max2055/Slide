/* MAX-241 三类完整资源详情原型（演示数据，不连后端）。
   设计依据：docs/slide/development/MAX-241/03-detail-design.md
   产品代码未修改；本文件只用于设计评审与状态演示。 */

const APP_VERSION = 'MAX-241 设计原型 · 2026-10-26';

const RESOURCES = {
  db: {
    key: 'db',
    navLabel: '数据库',
    navOrder: 4,
    listTitle: '数据库实例',
    listDesc: '四菜单与顺序保留：资源概览 / 网络设备 / 服务器 / 数据库。列表单行八列，四操作完整展开。',
    addLabel: '添加实例',
    filters: [['全部', 'all'], ['健康', 'healthy'], ['警告', 'warning'], ['异常', 'critical'], ['未知', 'unknown']],
    name: 'mysql-order-prod · 华东生产主库（订单核心交易集群）',
    meta: 'MySQL 8.0.34 · 10.20.1.15:3306 · 生产环境',
    health: { label: '当前观测异常', variant: 'warn' },
    observedAt: '2026-10-26 11:42:07',
    readAt: '2026-10-26 11:43:10',
    extraActions: ['一键诊断'],
    rows: [
      { id: 12, name: 'mysql-order-prod', address: '10.20.1.15:3306', version: '8.0.34', health: '异常', healthVariant: 'warn', collection: '正常', collectionSub: '最近 1 分钟内成功', time: '2026-10-26 11:41', healthScore: 62 },
      { id: 9, name: 'mysql-report-readonly', address: '10.20.1.18:3306', version: '8.0.34', health: '健康', healthVariant: 'ok', collection: '正常', collectionSub: '最近 2 分钟内成功', time: '2026-10-26 11:40', healthScore: 93 },
      { id: 7, name: 'pg-billing', address: '10.20.2.11:5432', version: '16.4', health: '警告', healthVariant: 'warn', collection: '部分失败', collectionSub: '2 项指标采集失败', time: '2026-10-26 11:37', healthScore: 78 },
      { id: 5, name: 'dm-archive', address: '10.20.3.6:5236', version: 'DM8', health: '未知', healthVariant: 'muted', collection: '已停用', collectionSub: '有效开关为停用', time: '无成功采集记录', healthScore: null }
    ],
    tabs: [
      ['overview', '概览'], ['collection', '监控配置'], ['metrics', '指标与趋势'], ['health', '健康评分'],
      ['topsql', '慢查询', 12], ['sessions', '会话', 42], ['capacity', '容量'], ['schema', '表结构'],
      ['indexes', '索引'], ['sqlaudit', 'SQL 审核'], ['logs', '日志'], ['qan', '查询分析'], ['diagnosis', 'AI 诊断']
    ]
  },
  server: {
    key: 'server',
    navLabel: '服务器',
    navOrder: 3,
    listTitle: '服务器',
    listDesc: '保留服务器专业页签；列表八列与四操作与数据库一致，采集状态与最近成功采集来自同一采集证据。',
    addLabel: '添加服务器',
    filters: [['全部', 'all'], ['在线', 'online'], ['离线', 'offline'], ['异常', 'error']],
    name: 'app-prod-01',
    meta: 'Kylin OS V10 SP3 · 10.20.1.21:22 · 生产环境',
    health: { label: '当前观测未提示异常', variant: 'ok' },
    observedAt: '2026-10-26 11:41:30',
    readAt: '2026-10-26 11:42:05',
    extraActions: ['一键巡检'],
    rows: [
      { id: 21, name: 'app-prod-01', address: '10.20.1.21:22', version: 'Kylin V10', health: '健康', healthVariant: 'ok', collection: '正常', collectionSub: '最近 1 分钟内成功', time: '2026-10-26 11:41' },
      { id: 18, name: 'app-prod-02', address: '10.20.1.22:22', version: 'Kylin V10', health: '健康', healthVariant: 'ok', collection: '正常', collectionSub: '最近 1 分钟内成功', time: '2026-10-26 11:41' },
      { id: 14, name: 'backup-node-01', address: '10.20.1.40:22', version: 'CentOS 7.9', health: '不可用', healthVariant: 'danger', collection: '失败', collectionSub: 'SSH 认证失败', time: '2026-10-26 09:12' }
    ],
    tabs: [
      ['overview', '概览'], ['collection', '监控配置'], ['metrics', '指标与趋势'], ['config', '配置'],
      ['diagnostics', '诊断'], ['network', '网络'], ['processes', '进程'], ['services', '服务'],
      ['logs', '日志'], ['related', '关联资源']
    ]
  },
  network: {
    key: 'network',
    navLabel: '网络设备',
    navOrder: 2,
    listTitle: '网络设备',
    listDesc: '保留接口、关联资源与配置备份能力；配置备份属于设备自身配置，不并入监控模板配置。',
    addLabel: '添加网络设备',
    filters: [['全部', 'all'], ['在线', 'online'], ['离线', 'offline'], ['不可达', 'unreachable']],
    name: 'sw-core-01',
    meta: 'Huawei V200R019C10 · 10.20.1.1:161 · SNMP v3',
    health: { label: '当前观测异常', variant: 'warn' },
    observedAt: '2026-10-26 11:40:52',
    readAt: '2026-10-26 11:41:33',
    extraActions: ['立即备份'],
    rows: [
      { id: 31, name: 'sw-core-01', address: '10.20.1.1:161', version: 'S5735-L48T4X', health: '异常', healthVariant: 'warn', collection: '正常', collectionSub: '最近 1 分钟内成功', time: '2026-10-26 11:40' },
      { id: 30, name: 'sw-agg-02', address: '10.20.1.2:161', version: 'S5735-L24T4X', health: '健康', healthVariant: 'ok', collection: '等待首样本', collectionSub: '已绑定，尚未取得正式数据', time: '无成功采集记录' },
      { id: 28, name: 'fw-edge-01', address: '10.20.1.254:161', version: 'USG6550E', health: '待确认', healthVariant: 'muted', collection: '不可用', collectionSub: 'SNMP 超时', time: '2026-10-25 22:03' }
    ],
    tabs: [
      ['overview', '概览'], ['metrics', '指标与趋势'], ['interfaces', '接口'],
      ['relations', '关联资源'], ['backups', '配置备份'], ['collection', '监控配置']
    ]
  }
};

const NAV = [
  { label: '资源概览', tab: 'dashboard', order: 1 },
  { label: '网络设备', tab: 'network', order: 2 },
  { label: '服务器', tab: 'server', order: 3 },
  { label: '数据库', tab: 'db', order: 4 }
];

const ui = {
  cls: 'db',
  view: 'list',
  tab: 'overview',
  state: 'normal',
  longName: false,
  filter: 'all',
  search: '',
  page: 1
};

/* ---------------- 基础构件 ---------------- */

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function badge(label, variant = '') {
  return `<span class="badge ${variant}">${esc(label)}</span>`;
}

function card(title, body, opts = {}) {
  const head = title ? `<div class="card-head"><h2>${title}</h2>${opts.aside ?? ''}</div>` : '';
  return `<section class="card ${opts.className ?? ''}">${head}${body}</section>`;
}

function resource() { return RESOURCES[ui.cls]; }
function resourceName(r = resource()) {
  return ui.longName ? `${r.name}（含灾备只读副本与跨机房双活链路，资源名称用于验证长名称换行与操作可达性）` : r.name;
}
function currentTab(r = resource()) { return r.tabs.some(([k]) => k === ui.tab) ? ui.tab : r.tabs[0][0]; }
function tabLabel(r = resource()) { return (r.tabs.find(([k]) => k === currentTab(r)) ?? [])[1] ?? ''; }

const EMPTY_TEXT = {
  overview: '尚未取得此资源的观测快照；这不代表资源健康。',
  collection: '此资源尚未绑定监控模板；未绑定不等于未采集，请以采集状态为准。',
  metrics: '时间窗内没有取得任何样本；缺测不补 0，也不能据此判断正常。',
  health: '尚未积累足够的有效观测天数，暂时无法计算健康评分。',
  topsql: '本次查询未返回慢查询记录；空结果不能确认采集是否完整。',
  sessions: '本次快照未返回活跃会话；不代表数据库健康。',
  capacity: '尚未取得容量数据；实例可能未连接或采集来源未就绪。',
  schema: '尚无表结构快照；请先执行一次结构采集。',
  indexes: '尚无可读取的索引建议；请先执行索引检测。',
  sqlaudit: '尚无 SQL 审核记录。',
  logs: '所选时间窗内没有读到日志；日志缺失不代表没有故障。',
  qan: '尚无查询分析记录。',
  diagnosis: '尚无 AI 诊断历史。',
  config: '配置读取为空；请检查权限或稍后重试。',
  diagnostics: '尚未取得诊断证据；页面切换和刷新不会自动采集。',
  network: '尚未取得网络诊断证据；请到“诊断”页签采集。',
  processes: '尚未取得进程证据；请到“诊断”页签采集。',
  services: '尚未取得服务证据；请到“诊断”页签采集。',
  interfaces: '尚未取得接口记录；接口缺失不等于设备没有接口。',
  relations: '暂无可访问的关联资源；缺失关系不能推断无依赖。',
  backups: '尚无配置备份；配置 SSH 凭据后可定时备份，也可立即备份。',
  related: '此服务器暂无已知的托管数据库实例关联。'
};

const ERROR_TEXT = {
  default: '读取失败，无法确认当前状态。'
};

function emptyCard(message) {
  return card('', `<div class="empty" role="status"><div aria-hidden="true">◌</div><h3>暂无可用数据</h3><p>${esc(message)}</p><div class="actions" style="justify-content:center"><button class="btn" data-action="reload">重新读取</button></div></div>`);
}
function errorCard(message) {
  return card('', `<div class="empty" role="alert"><div aria-hidden="true">!</div><h3>读取失败</h3><p>${esc(message)} 这不是空数据，也不代表资源正常。</p><div class="actions" style="justify-content:center"><button class="btn" data-action="reload">重试</button><button class="btn btn-ghost" data-action="back-list">返回列表</button></div></div>`);
}
function forbiddenCard(what = '此资源') {
  return card('', `<div class="empty" role="alert"><div aria-hidden="true">⛔</div><h3>无权读取${esc(what)}</h3><p>当前账号缺少对应资源权限。页面不显示任何缓存数据；如有需要，请联系资源管理员授权。</p><div class="actions" style="justify-content:center"><button class="btn" data-action="back-list">返回列表</button></div></div>`);
}
function loadingCard() {
  return card('', `<div role="status" aria-label="正在读取"><div class="skeleton" style="height:18px;width:32%"></div><div class="skeleton" style="height:12px;width:64%;margin-top:12px"></div><div class="skeleton" style="height:12px;width:52%;margin-top:8px"></div><div class="skeleton" style="height:120px;margin-top:16px"></div></div>`);
}
function partialCard(tab) {
  const items = [
    ['采集器 · 核心指标', '成功', 'ok'],
    ['采集器 · 慢查询', '失败 · 权限不足 (ER_TABLEACCESS_DENIED)', 'danger'],
    ['采集器 · 会话快照', '成功', 'ok'],
    ['采集器 · 容量', '不支持 · 当前版本未提供', 'muted'],
    ['采集器 · 配置快照', '待验证 · 尚未取得正式样本', 'warn']
  ];
  return card('部分成功', `<p class="muted">本页 ${items.filter(i => i[2] === 'ok').length}/${items.length} 项成功。部分失败不能判定整体正常，缺失项不补 0。</p>
    <div class="list-rows">${items.map(([name, status, variant]) => `<div class="row-item"><div><div class="name">${esc(name)}</div><div class="sub">当前页签：${esc(tabLabel())}</div></div>${badge(status, variant)}</div>`).join('')}</div>
    <div class="actions"><button class="btn" data-action="reload">重试失败项</button><button class="btn btn-ghost" data-action="open-diagnostics">查看技术证据</button></div>`);
}

/* ---------------- 列表 ---------------- */

function listRows(r) {
  const rows = r.rows.filter((row) => {
    const filter = ui.filter;
    if (filter !== 'all') {
      if (filter === 'healthy' && row.health !== '健康') return false;
      if (filter === 'warning' && row.health !== '警告') return false;
      if (filter === 'critical' && !['异常', '不可用'].includes(row.health)) return false;
      if (filter === 'unknown' && !['未知', '待确认'].includes(row.health)) return false;
      if (filter === 'online' && row.health !== '健康') return false;
      if (filter === 'offline' && row.health !== '不可用') return false;
      if (filter === 'error' && row.health !== '异常') return false;
      if (filter === 'unreachable' && row.health !== '待确认') return false;
    }
    if (ui.search && !`${row.name} ${row.address} ${row.version} ${row.health} ${row.collection}`.toLowerCase().includes(ui.search.toLowerCase())) return false;
    return true;
  });
  const headers = ui.cls === 'db'
    ? ['实例', '地址', '版本'] : ui.cls === 'server' ? ['主机名称', '地址', '系统版本'] : ['设备', '地址', '型号'];
  const head = `<thead><tr>
    <th style="width:2.5rem">选择</th>
    <th style="width:3rem">序号</th>
    <th style="width:11rem">${headers[0]}</th>
    <th style="width:9.5rem">${headers[1]}</th>
    <th style="width:6.5rem">${headers[2]}</th>
    <th style="width:6.5rem">观测健康</th>
    <th style="width:7rem">采集状态</th>
    <th style="width:8.5rem">最近成功采集</th>
    <th style="width:12.5rem">操作</th>
  </tr></thead>`;
  const body = rows.map((row, index) => `<tr>
    <td><input type="checkbox" aria-label="选择 ${esc(row.name)} 用于批量绑定采集模板"></td>
    <td class="num">${index + 1}</td>
    <td><a href="#" class="cell-truncate" title="${esc(row.name)}" data-action="open-detail" data-id="${row.id}">${esc(row.name)}</a></td>
    <td class="mono">${esc(row.address)}</td>
    <td>${esc(row.version)}</td>
    <td>${badge(row.health, row.healthVariant)}<span class="cell-sub">${row.healthScore == null ? '证据不足' : `评分 ${row.healthScore}`}</span></td>
    <td>${badge(row.collection, row.collection === '正常' ? 'ok' : row.collection === '已停用' ? 'muted' : row.collection === '等待首样本' ? 'warn' : 'danger')}<span class="cell-sub">${esc(row.collectionSub)}</span></td>
    <td class="mono">${esc(row.time)}</td>
    <td><div class="actions">
      <button class="btn-sm" data-action="open-detail" data-id="${row.id}">详情</button>
      <button class="btn-sm" data-action="edit" data-id="${row.id}">编辑</button>
      <button class="btn-sm" data-action="test" data-id="${row.id}">测试</button>
      <button class="btn-sm danger" data-action="delete" data-id="${row.id}">删除</button>
    </div></td>
  </tr>`).join('');
  return { head, body, count: rows.length };
}

function renderList(r) {
  const { head, body, count } = listRows(r);
  const stateNotice = ui.state === 'forbidden'
    ? `<div class="notice danger" role="alert">无权读取该资源的采集状态；操作按钮已禁用。</div>`
    : ui.state === 'error'
      ? `<div class="notice danger" role="alert">采集状态读取失败；健康与采集列显示“暂不可用”，不判定正常。</div>`
      : '';
  const tableBody = ui.state === 'loading'
    ? `<tr><td colspan="9"><div class="skeleton" style="height:120px"></div></td></tr>`
    : ui.state === 'empty'
      ? `<tr><td colspan="9"><div class="empty"><h3>没有符合条件的资源</h3><p>调整搜索或筛选后重试。</p></div></td></tr>`
      : body;
  return `<div class="content-inner">
    <div class="page-head">
      <div><h1>${esc(r.listTitle)}</h1><p>${esc(r.listDesc)}</p></div>
      <div class="actions"><button class="btn btn-refresh" data-action="reload">刷新</button><button class="btn-primary" data-action="add">${esc(r.addLabel)}</button></div>
    </div>
    ${card('', `
      <div class="toolbar">
        <div class="search"><span aria-hidden="true">⌕</span><input id="list-search" type="search" placeholder="搜索名称、地址、版本、状态" aria-label="搜索${esc(r.listTitle)}" value="${esc(ui.search)}"></div>
        <div class="seg" role="group" aria-label="状态筛选">
          ${r.filters.map(([label, key]) => `<button class="btn" data-action="filter" data-filter="${key}" aria-pressed="${ui.filter === key}">${esc(label)}</button>`).join('')}
        </div>
        <div class="toolbar-actions">
          <button class="btn" data-action="columns">列设置</button>
          <button class="btn btn-ghost" data-action="reset-filter">重置筛选</button>
        </div>
      </div>
      <div class="toolbar-meta"><span>共 ${count} 个资源</span><span>选择列为批量绑定工具列，不计入八列</span><span>支持空格组合搜索</span></div>
      ${stateNotice}
      <p class="scroll-hint" id="scroll-help">表格在容器内横向滚动；聚焦表格后可按左右方向键。聚焦截断内容可查看全文。</p>
      <div class="table-scroll" role="region" tabindex="0" aria-label="资源表格，可横向滚动" aria-describedby="scroll-help">
        <table class="data-table">${head}<tbody>${tableBody}</tbody></table>
      </div>
      <div class="pager"><span>筛选结果 ${count} / ${r.rows.length}</span>
        <button class="btn" disabled>上一页</button><span>第 1 页</span><button class="btn" disabled>下一页</button>
      </div>`)}
  </div>`;
}

/* ---------------- 详情外壳 ---------------- */

function renderDetail(r) {
  const tabs = r.tabs.map(([key, label, count]) => `<button class="tab" role="tab" id="tab-${key}" aria-selected="${String(currentTab(r) === key)}" tabindex="${currentTab(r) === key ? '0' : '-1'}" aria-controls="tab-panel" data-action="tab" data-tab="${key}">${esc(label)}${count ? `<span class="count">${count}</span>` : ''}</button>`).join('');
  const headerActions = [
    ...r.extraActions.map((label) => `<button class="btn" data-action="extra" data-label="${esc(label)}">${esc(label)}</button>`),
    `<button class="btn" data-action="monitor-config">监控配置</button>`,
    `<button class="btn btn-refresh" data-action="reload">刷新</button>`
  ].join('');
  return `<div class="content-inner">
    <div class="detail-header">
      <div class="detail-id">
        <button class="btn btn-ghost" data-action="back-list">← 返回${esc(r.navLabel)}</button>
        <div class="title-copy">
          <h1 class="detail-title">${esc(resourceName(r))}</h1>
          <div class="detail-meta">${esc(r.meta)}</div>
          <div class="detail-meta">观测于 ${esc(r.observedAt)} · 详情成功读取 ${esc(r.readAt)}（非资源观测）</div>
        </div>
        ${badge(r.health.label, r.health.variant)}
      </div>
      <div class="detail-actions">${headerActions}</div>
    </div>
    <div class="links-row" aria-label="资源联动">
      <span>关联调查 · 最近 2 项</span><a href="#" data-action="noop">订单库连接数高 · 只读排查</a>
      <span class="sep" aria-hidden="true">|</span><a href="#" data-action="noop">查看此资源的全部调查</a>
      <span class="sep" aria-hidden="true">|</span><a href="#" data-action="noop">事件（按本资源过滤）</a>
      <span class="sep" aria-hidden="true">|</span><a href="#" data-action="noop">操作审计</a>
    </div>
    <div class="tabs" role="tablist" aria-label="${esc(r.navLabel)}详情页签" data-tablist>${tabs}</div>
    <div id="tab-panel" role="tabpanel" aria-labelledby="tab-${currentTab(r)}" tabindex="0">
      ${tabContentWithState(r)}
    </div>
  </div>`;
}

function tabContentWithState(r) {
  const tab = currentTab(r);
  if (ui.state === 'loading') return loadingCard();
  if (ui.state === 'empty') return emptyCard(EMPTY_TEXT[tab] ?? EMPTY_TEXT.overview);
  if (ui.state === 'error') return errorCard(ERROR_TEXT.default);
  if (ui.state === 'forbidden') return forbiddenCard('该资源');
  if (ui.state === 'partial') return partialCard(tab);
  return CONTENT[r.key][tab]?.(r) ?? emptyCard(EMPTY_TEXT[tab] ?? EMPTY_TEXT.overview);
}

/* ---------------- 通用内容块 ---------------- */

function evidenceBar(text) {
  return `<div class="notice info" role="status">${esc(text)}</div>`;
}

function attentionCard(r) {
  return card('当前需要关注', `
    <div class="section"><h3>存在需要核对的异常</h3>
      <p>未解决告警 2 项。状态只反映已有观测，不能代替完整健康判断。</p>
      <div class="actions"><button class="btn" data-action="go-tab" data-tab="metrics">核对指标与时间范围</button><button class="btn" data-action="go-tab" data-tab="logs">查看日志与完整事件</button></div>
    </div>
    <div class="section"><h3>证据缺口</h3>
      <p>${esc(r.key === 'db' ? '慢查询采集权限不足；容量历史仅覆盖最近 7 天采样。' : r.key === 'server' ? '进程与服务证据尚未采集；最近一次状态检查失败 1 次。' : 'SNMP 超时 2 次；接口速率仅标称容量，不含实测流量。')} 当前快照未报告全部缺口，不代表已覆盖所有信号。</p>
      <div class="actions"><button class="btn" data-action="go-tab" data-tab="collection">查看监控配置</button></div>
      <details class="disclosure"><summary>查看缺口原始标识</summary><p class="mono xs">OBSERVATIONS_STALE · ALERTS_TRUNCATED</p></details>
    </div>`);
}

function capabilityCard(r) {
  const rows = {
    db: [['类型', 'MySQL 8.0.34'], ['环境', '生产环境'], ['连接配置', '已启用（可用性需连接测试）'], ['连接地址', '10.20.1.15:3306'], ['数据库', 'order_core'], ['观测时间', r.observedAt], ['观测时效', '新鲜']],
    server: [['操作系统', 'Kylin OS V10 SP3'], ['连接状态（登记值）', '在线'], ['最近状态检查', '2026-10-26 11:41（1 次失败尝试）'], ['SSH 端口', '22'], ['认证方式', 'SSH 密钥（凭据引用）'], ['采集状态', '已启用'], ['观测时间', r.observedAt]],
    network: [['设备', '10.20.1.1:161'], ['型号', 'S5735-L48T4X'], ['厂商 / 版本', 'Huawei V200R019C10'], ['最近状态检查', '2026-10-26 11:40（2 次 SNMP 超时）'], ['可用证据', '指标、接口、关联关系、配置备份'], ['观测时间', r.observedAt], ['观测时效', '新鲜']]
  }[r.key];
  return card(r.key === 'db' ? '资源与能力' : r.key === 'server' ? '服务器状态' : '资源与能力', `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${r.key === 'db' ? '<p class="muted small" style="margin-top:12px">可用观测以指标页的能力与查询结果为准。概览提供方向，完整指标、定义和日志保留在专属页签。</p>' : ''}`);
}

function governanceCard(r) {
  return card('处理与治理（本资源）', `
    <div class="notice warn small">有效触发器、事件与操作审计尚未接入本详情；标记为“拟建”，接入前不显示 0 项，也不代表没有事件。当前可用证据见上方缺口说明。</div>
    <div class="list-rows" style="margin-top:12px">
      <div class="row-item"><div><div class="name">有效触发器</div><div class="sub">拟建 · 依赖 P1 触发器与模板契约</div></div>${badge('未接入', 'muted')}<button class="btn-sm" data-action="monitor-config">监控配置</button></div>
      <div class="row-item"><div><div class="name">最近事件</div><div class="sub">拟建 · 事件中心按本资源过滤</div></div>${badge('未接入', 'muted')}<button class="btn-sm" data-action="noop">事件中心</button></div>
      <div class="row-item"><div><div class="name">操作审计</div><div class="sub">拟建 · 审计中心按资源与时间过滤</div></div>${badge('未接入', 'muted')}<button class="btn-sm" data-action="noop">查看审计</button></div>
    </div>`);
}

function relationsDisclosure(r) {
  return `<details class="disclosure"><summary>资源关系与可信度（最多 2 跳 / 100 条边）</summary>
    <p class="small muted" style="margin-top:8px">缺失关系不代表不存在依赖；建议关系不作为已确认事实。</p>
    <div class="list-rows">
      <div class="row-item"><div><div class="name">${esc(r.key === 'server' ? 'app-prod-01' : r.key === 'db' ? 'mysql-order-prod' : 'sw-core-01')} ↔ ${esc(r.key === 'network' ? '主机 10.20.1.21（上行链路）' : 'sw-core-01（接入）')}</div><div class="sub">连接 · 来源：配置采集 · v3 · 有效期至 2026-12-31</div></div>${badge('已确认', 'ok')}<span class="xs muted">已确认</span></div>
      <div class="row-item"><div><div class="name">${esc(r.key === 'network' ? 'sw-core-01 ↔ fw-edge-01' : 'mysql-order-prod ↔ app-prod-01（托管）')}</div><div class="sub">依赖 · 来源：人工维护 · v1 · 未设截止时间</div></div>${badge('建议', 'warn')}<span class="xs muted">建议</span></div>
    </div>
  </details>`;
}

function monitorConfigContent(r) {
  const triggers = r.key === 'db'
    ? [['连接使用率过高', 'avg(connection_usage) > 85% (5m) · 恢复 < 70%', '2 项已触发'], ['慢查询增长', 'sum(slow_queries) > 20 (10m)', '未触发'], ['复制延迟', 'max(replica_lag) > 30s (3m)', '无数据']]
    : r.key === 'server'
      ? [['CPU 使用率过高', 'avg(cpu.usage) > 90% (5m) · 恢复 < 70%', '未触发'], ['可用内存不足', 'min(memory.available) < 512MiB (5m)', '未触发']]
      : [['接口 down', 'count(interface.oper_up=0) > 0 (2m)', '1 项已触发'], ['SNMP 采集超时', 'nodata(snmp) > 3m', '已恢复']];
  const params = r.key === 'db'
    ? [['采集周期', '60s', '—', '60s', '模板默认'], ['连接超时', '3s', '5s', '5s', '本资源覆盖'], ['慢查询阈值', '1000ms', '—', '1000ms', '模板默认'], ['只读账号', '—', '—', 'cred://mysql-order-ro', '凭据引用']]
    : r.key === 'server'
      ? [['采集周期', '60s', '—', '60s', '模板默认'], ['SSH 超时', '5s', '—', '5s', '模板默认'], ['采集账号', '—', '—', 'cred://linux-ops-ro', '凭据引用']]
      : [['SNMP 周期', '60s', '—', '60s', '模板默认'], ['SNMP 版本', 'v3', '—', 'v3', '模板默认'], ['接口轮询数', '48', '—', '48', '模板默认'], ['社区/凭据', '—', '—', 'cred://snmp-core-ro', '凭据引用']];
  return `<div class="stack">
    ${card('监控配置', `<div class="facts">
      <div class="fact"><div class="label">当前模板</div><div class="value">${esc(r.key === 'db' ? 'MySQL 基础采集' : r.key === 'server' ? 'Linux 主机基础' : '华为交换机 SNMP')}</div><div class="sub">v2.4.1 · 配置版本 37 · 已应用</div></div>
      <div class="fact"><div class="label">有效采集开关</div><div class="value">已启用</div><div class="sub">来源：本资源覆盖 · 应用：成功</div></div>
      <div class="fact"><div class="label">最近正式样本</div><div class="value">${esc(r.observedAt)}</div><div class="sub">试采不替代正式数据</div></div>
    </div>
    <div class="actions" style="margin-top:12px">
      <button class="btn-primary" data-action="enable-flow">检查并启用</button>
      <button class="btn" data-action="trial">试采</button>
      <button class="btn btn-refresh" data-action="reload">刷新采集状态</button>
      <button class="btn btn-ghost" data-action="noop">修改模板与参数</button>
    </div>
    <p class="muted small" style="margin-top:8px">配置与只读证据使用同一来源；修改后需重新预检与试采，发布不代表全部指标可用。</p>`)}
    ${card('有效参数', `<table class="data-table" style="min-width:0"><thead><tr><th>参数</th><th>默认</th><th>资源覆盖</th><th>最终值</th><th>来源</th></tr></thead><tbody>
      ${params.map(([name, def, over, final, src]) => `<tr><td>${esc(name)}</td><td>${esc(def)}</td><td>${esc(over)}</td><td><strong>${esc(final)}</strong></td><td>${badge(src, 'muted')}</td></tr>`).join('')}
    </tbody></table><p class="muted xs" style="margin-top:8px">秘密值只显示凭据引用，不在页面、日志或导出中出现。</p>`)}
    ${card('有效触发器（只读）', `<div class="notice warn small" role="status">拟建：模板触发器与有效参数只读展示，依赖 P1 触发器与 #260 契约。以下为演示数据。</div>
      <table class="data-table" style="min-width:0;margin-top:8px"><thead><tr><th>触发器</th><th>条件（含恢复）</th><th>当前状态</th><th>来源</th></tr></thead><tbody>
      ${triggers.map(([name, cond, state]) => `<tr><td>${esc(name)}</td><td class="mono xs">${esc(cond)}</td><td>${badge(state, state.includes('已触发') ? 'danger' : state === '无数据' ? 'muted' : 'ok')}</td><td>模板 v2.4.1 · 本资源覆盖阈值</td></tr>`).join('')}
      </tbody></table>`)}
    ${card('指标覆盖与数据质量', `<div class="list-rows">
      ${(r.key === 'db' ? [['连接数与上限', '已覆盖', 'ok'], ['慢查询', '已覆盖', 'ok'], ['复制延迟', '已覆盖', 'ok'], ['InnoDB 缓冲命中', '模板未覆盖', 'muted']]
        : r.key === 'server' ? [['CPU 使用率', '已覆盖', 'ok'], ['内存可用', '已覆盖', 'ok'], ['磁盘（挂载点）', '已覆盖', 'ok'], ['网络速率（逐接口）', '版本不支持', 'muted']]
          : [['接口运行状态', '已覆盖', 'ok'], ['接口速率', '标称容量', 'warn'], ['设备温度', '模板未覆盖', 'muted']]).map(([name, state, variant]) => `<div class="row-item"><div><div class="name">${esc(name)}</div><div class="sub">覆盖不等于正式样本就绪</div></div>${badge(state, variant)}</div>`).join('')}
    </div>`)}
    ${card('最近配置事件', `<ol class="timeline">
      <li><time>2026-10-24 16:22</time><span>发布资源配置 · 版本 37 · 操作者：ops-admin（凭据引用）</span></li>
      <li><time>2026-10-24 16:19</time><span>试采成功 · 5/5 项有效样本 · 未写入正式历史</span></li>
    </ol><details class="disclosure"><summary>技术证据与配置版本</summary><p class="mono xs">published_revision=37 · applied_revision=37 · binding.state=bound · formal_visibility=available</p></details>`)}
  </div>`;
}

function metricsContent(r) {
  const rows = r.key === 'db'
    ? [['连接使用率', '82.4 %', '有效', '2026-10-26 11:42:00', 'MySQL performance_schema'], ['慢查询数', '12 次/分', '部分失败 · 权限不足', '2026-10-26 10:58:12', 'MySQL slow_log'], ['复制延迟', '4 s', '有效', '2026-10-26 11:42:00', 'SHOW SLAVE STATUS'], ['缓冲池命中率', '97.1 %', '有效', '2026-10-26 11:42:00', 'InnoDB']]
    : r.key === 'server'
      ? [['CPU 使用率', '43.2 %', '有效', '2026-10-26 11:41:00', 'SSH · /proc/stat'], ['可用内存', '3.8 GiB', '有效', '2026-10-26 11:41:00', 'SSH · /proc/meminfo'], ['磁盘使用（/data）', '71.3 %', '有效', '2026-10-26 11:41:00', 'SSH · df'], ['网络接收速率', '未取得', '不可用 · 接口未注册', '—', '—']]
      : [['接口 up 数', '46 / 48', '有效', '2026-10-26 11:40:00', 'SNMP ifOperStatus'], ['下行总流量', '182 Mbps', '标称容量', '2026-10-26 11:40:00', 'SNMP ifSpeed（标称）'], ['设备温度', '未取得', '模板未覆盖', '—', '—']];
  return `${card('指标与趋势', `<div class="toolbar" style="margin-bottom:8px"><div class="seg" role="group" aria-label="时间窗"><button class="btn" aria-pressed="true">6h</button><button class="btn">24h</button><button class="btn">7d</button><button class="btn">自定义</button></div>
    <span class="muted small" style="margin-left:auto">时间窗：2026-10-26 05:42 至 11:42（UTC+8）· 资源 ${esc(r.navLabel)} / #${r.rows[0].id}</span></div>
    <table class="data-table" style="min-width:0"><thead><tr><th>监控项</th><th>最近成功值</th><th>质量</th><th>值时间</th><th>来源</th></tr></thead><tbody>
    ${rows.map(([name, value, quality, time, source]) => `<tr><td>${esc(name)}</td><td class="mono">${esc(value)}</td><td>${badge(quality, quality === '有效' ? 'ok' : quality.startsWith('部分') ? 'danger' : 'muted')}</td><td class="mono xs">${esc(time)}</td><td class="xs muted">${esc(source)}</td></tr>`).join('')}
    </tbody></table>`)}
  <div class="stack" style="margin-top:16px">
    ${card('趋势', `<div class="chart" role="img" aria-label="演示趋势曲线：10 月 26 日 05:42 至 11:42，连接使用率在 11:30 后上升"><svg viewBox="0 0 640 150" preserveAspectRatio="none"><path d="M0 118 L60 112 L120 120 L180 104 L240 110 L300 96 L360 88 L420 70 L480 62 L540 40 L600 34 L640 30" fill="none" stroke="#265f99" stroke-width="2"/><path d="M0 118 L60 112 L120 120 L180 104 L240 110 L300 96 L360 88 L420 70 L480 62 L540 40 L600 34 L640 30 L640 150 L0 150 Z" fill="rgba(38,95,153,0.08)"/></svg></div>
      <div class="chart-legend"><span><i class="swatch"></i>连接使用率</span><span>缺口区段不插值；降采样保留峰值</span></div>
      <p class="muted small" style="margin-top:8px">图形与数值表共享同一资源、监控项、维度与时间窗；24h 每分钟 1440 个时槽为 P1 目标，当前实现受历史读取能力限制。</p>`)}
  </div>`;
}

/* ---------------- 各类专业页签内容 ---------------- */

const CONTENT = {
  db: {
    overview: (r) => `<div class="grid-2">${attentionCard(r)}${capabilityCard(r)}</div>
      <div class="stack" style="margin-top:16px">${governanceCard(r)}${card('资源关系', relationsDisclosure(r))}</div>`,
    collection: (r) => monitorConfigContent(r),
    metrics: (r) => metricsContent(r),
    health: (r) => `${card('健康评分', `<div class="facts"><div class="fact"><div class="label">当前评分</div><div class="value">62 / 100</div><div class="sub">较昨日 -8 · 证据不足项单独说明</div></div>
      <div class="fact"><div class="label">有效观测天数</div><div class="value">14 天</div><div class="sub">覆盖不足 90% 的日期不计入</div></div>
      <div class="fact"><div class="label">上次检查</div><div class="value">2026-10-26 11:30</div><div class="sub">评分不代替业务可用性判断</div></div></div>`)}
      <div class="stack" style="margin-top:16px">${card('评分历史（最近 7 天）', `<table class="data-table" style="min-width:0"><thead><tr><th>日期</th><th>评分</th><th>主要扣分项</th><th>证据完整性</th></tr></thead><tbody>
      <tr><td>2026-10-26</td><td class="num">62</td><td>连接使用率、慢查询</td><td>${badge('部分', 'warn')}</td></tr>
      <tr><td>2026-10-25</td><td class="num">70</td><td>连接使用率</td><td>${badge('完整', 'ok')}</td></tr>
      <tr><td>2026-10-24</td><td class="num">88</td><td>—</td><td>${badge('完整', 'ok')}</td></tr>
      </tbody></table>`)}</div>`,
    topsql: () => card('慢查询列表（Top 12）', `<p class="muted small">来源：MySQL performance_schema · 时间范围：数据库当前保留记录（统计起止未知）· 读取时间 11:43（非最近采集时间）</p>
      <div class="table-scroll" style="margin-top:8px" tabindex="0" role="region" aria-label="慢查询列表"><table class="data-table" style="min-width:0"><thead><tr><th>SQL 语句</th><th>平均耗时</th><th>最大耗时</th><th>执行次数</th><th>最后出现</th></tr></thead><tbody>
      <tr><td class="mono cell-truncate" title="SELECT o.id, o.status FROM orders o WHERE o.created_at > ?">SELECT o.id, o.status FROM orders o…</td><td class="num" style="color:var(--danger)">1820.40 ms</td><td class="num">4210.10 ms</td><td class="num">1,204</td><td class="mono xs">2026-10-26 11:38</td></tr>
      <tr><td class="mono cell-truncate" title="UPDATE order_items SET state=? WHERE id=?">UPDATE order_items SET state=? WHERE id=?</td><td class="num" style="color:var(--warn)">240.80 ms</td><td class="num">980.22 ms</td><td class="num">18,442</td><td class="mono xs">2026-10-26 11:40</td></tr>
      </tbody></table></div>
      <p class="muted xs" style="margin-top:8px">读取失败或权限不足时显示明确状态，不把空结果显示为“无慢查询”。</p>`),
    sessions: () => card('活跃会话（42）', `<p class="muted small">来源：MySQL PROCESSLIST · 本次读取时的活跃会话快照（最多 50 条）· 读取时间 11:43</p>
      <table class="data-table" style="min-width:0;margin-top:8px"><thead><tr><th>ID</th><th>用户</th><th>来源</th><th>数据库</th><th>命令</th><th>时间</th><th>当前查询</th></tr></thead><tbody>
      <tr><td class="num">1042</td><td>order_app</td><td class="mono">10.20.1.31</td><td>order_core</td><td>Query</td><td style="color:var(--danger)">128s</td><td class="mono cell-truncate" title="SELECT ... FOR UPDATE">SELECT … FOR UPDATE</td></tr>
      <tr><td class="num">1043</td><td>order_app</td><td class="mono">10.20.1.32</td><td>order_core</td><td>Sleep</td><td>2s</td><td>—</td></tr>
      </tbody></table>`),
    capacity: () => `${card('容量读取结果：1,284.52 GB', `<p class="muted small">来源：数据库容量接口 · 观测 2026-10-26 10:00 · 范围：仅统计在线表 <br>历史趋势为独立采样；结构/索引为独立快照，时间与范围可能不同。</p>
      <table class="data-table" style="min-width:0;margin-top:8px"><thead><tr><th>对象</th><th>大小</th><th>表数 / 行数</th></tr></thead><tbody>
      <tr><td>order_core</td><td class="num">820.40 GB</td><td>184 张表</td></tr>
      <tr><td>order_archive</td><td class="num">412.10 GB</td><td>62 张表</td></tr>
      <tr><td>top: order_items</td><td class="num">310.22 GB</td><td>842,190,441 行</td></tr>
      </tbody></table>`)}
      <div class="stack" style="margin-top:16px">${card('历史容量采样（过去 7 天，非当前读取）', `<div class="chart" role="img" aria-label="演示容量曲线"><svg viewBox="0 0 640 150" preserveAspectRatio="none"><path d="M0 120 L90 116 L180 110 L270 102 L360 96 L450 88 L540 80 L640 74" fill="none" stroke="#265f99" stroke-width="2"/></svg></div><div class="chart-legend"><span><i class="swatch"></i>总容量 (GB)</span></div>`)}</div>`,
    schema: () => card('表结构快照', `<div class="facts"><div class="fact"><div class="label">最近快照</div><div class="value">2026-10-26 09:00</div><div class="sub">快照 id 8821 · 184 张表</div></div>
      <div class="fact"><div class="label">最近变更</div><div class="value">3 项</div><div class="sub">新增 2 · 修改 1</div></div>
      <div class="fact"><div class="label">采集权限</div><div class="value">可读取</div><div class="sub">information_schema 只读</div></div></div>
      <div class="actions" style="margin-top:12px"><button class="btn" data-action="extra" data-label="采集表结构快照">采集表结构快照</button></div>
      <table class="data-table" style="min-width:0;margin-top:12px"><thead><tr><th>表</th><th>引擎</th><th>行数（估算）</th><th>变更</th></tr></thead><tbody>
      <tr><td class="mono">orders</td><td>InnoDB</td><td class="num">42,190,884</td><td>${badge('新增列', 'info')}</td></tr>
      <tr><td class="mono">order_items</td><td>InnoDB</td><td class="num">842,190,441</td><td>—</td></tr>
      </tbody></table>`),
    indexes: () => card('索引建议', `<p class="muted small">建议需人工确认；检测结果不代表已创建索引。</p>
      <table class="data-table" style="min-width:0;margin-top:8px"><thead><tr><th>表</th><th>建议</th><th>预期收益</th><th>风险</th><th>操作</th></tr></thead><tbody>
      <tr><td class="mono">orders</td><td class="mono xs">(created_at, status)</td><td>降低范围扫描</td><td>${badge('写放大', 'warn')}</td><td><button class="btn-sm" data-action="noop">查看详情</button></td></tr>
      <tr><td class="mono">order_items</td><td class="mono xs">(order_id)</td><td>覆盖已存在，建议删除重复索引</td><td>${badge('低', 'ok')}</td><td><button class="btn-sm" data-action="noop">查看详情</button></td></tr>
      </tbody></table>
      <div class="actions" style="margin-top:12px"><button class="btn" data-action="extra" data-label="重新检测索引">重新检测索引</button></div>`),
    sqlaudit: () => card('SQL 审核', `<table class="data-table" style="min-width:0"><thead><tr><th>提交时间</th><th>SQL 摘要</th><th>风险</th><th>状态</th><th>操作</th></tr></thead><tbody>
      <tr><td class="mono xs">2026-10-26 10:12</td><td class="mono cell-truncate" title="ALTER TABLE orders ADD COLUMN ...">ALTER TABLE orders ADD COLUMN …</td><td>${badge('高', 'danger')}</td><td>${badge('待人工确认', 'warn')}</td><td><button class="btn-sm" data-action="noop">查看</button></td></tr>
      <tr><td class="mono xs">2026-10-25 18:40</td><td class="mono cell-truncate" title="CREATE INDEX ...">CREATE INDEX idx_order_created …</td><td>${badge('中', 'warn')}</td><td>${badge('已完成', 'ok')}</td><td><button class="btn-sm" data-action="noop">查看</button></td></tr>
      </tbody></table>
      <div class="actions" style="margin-top:12px"><button class="btn-primary" data-action="noop">发起 SQL 审核</button></div>
      <p class="muted xs" style="margin-top:8px">审核结论不自动执行；执行按现有审批与权限。</p>`),
    logs: () => card('日志', `<div class="toolbar"><select class="filter" aria-label="日志级别"><option>全部级别</option><option>ERROR</option><option>WARN</option></select><select class="filter" aria-label="时间范围"><option>最近 1 小时</option><option>最近 24 小时</option></select><button class="btn" data-action="noop">查询</button></div>
      <table class="data-table" style="min-width:0;margin-top:8px"><thead><tr><th>时间</th><th>级别</th><th>内容</th></tr></thead><tbody>
      <tr><td class="mono xs">11:38:12</td><td>${badge('ERROR', 'danger')}</td><td>Deadlock found when trying to get lock; try restarting transaction</td></tr>
      <tr><td class="mono xs">11:20:03</td><td>${badge('WARN', 'warn')}</td><td>Aborted connection 1042 to db: 'order_core' (Got timeout reading communication packets)</td></tr>
      </tbody></table>
      <p class="muted xs" style="margin-top:8px">日志缺失不代表没有故障；AI 分析不改变日志事实。</p>`),
    qan: () => card('查询分析', `<table class="data-table" style="min-width:0"><thead><tr><th>SQL 摘要</th><th>总耗时</th><th>平均耗时</th><th>执行次数</th><th>最后出现</th></tr></thead><tbody>
      <tr><td class="mono cell-truncate" title="SELECT ... FROM orders WHERE created_at > ?">SELECT … FROM orders WHERE created_at > ?</td><td class="num">2,192 s</td><td class="num">1.82 s</td><td class="num">1,204</td><td class="mono xs">11:38</td></tr>
      <tr><td class="mono cell-truncate" title="UPDATE order_items SET state=?">UPDATE order_items SET state=?</td><td class="num">4,432 s</td><td class="num">0.24 s</td><td class="num">18,442</td><td class="mono xs">11:40</td></tr>
      </tbody></table>`),
    diagnosis: () => card('AI 诊断', `<p class="muted small">诊断是证据汇总与建议，不自动执行变更，也不自动宣告恢复。</p>
      <div class="actions" style="margin:12px 0"><button class="btn-primary" data-action="diagnose">一键诊断</button><button class="btn" data-action="noop">在对话中继续分析</button></div>
      <ol class="timeline">
        <li><time>2026-10-26 10:58</time><span>${badge('已完成', 'ok')} 连接使用率持续高于阈值；建议核对连接池上限与空闲连接回收。<a href="#" data-action="noop">查看结果</a></span></li>
        <li><time>2026-10-25 16:20</time><span>${badge('结果未知', 'danger')} 模型调用超时，事实证据仍可查看。<a href="#" data-action="noop">查看记录</a></span></li>
      </ol>`)
  },
  server: {
    overview: (r) => `<div class="grid-2">${attentionCard(r)}${capabilityCard(r)}</div>
      <div class="stack" style="margin-top:16px">${governanceCard(r)}${card('托管数据库实例', hostedInstances())}${card('资源关系', relationsDisclosure(r))}</div>`,
    collection: (r) => monitorConfigContent(r),
    metrics: (r) => metricsContent(r),
    config: (r) => card('服务器配置', `<div class="subgrid">
      <dl class="kv"><dt>主机地址</dt><dd>10.20.1.21</dd><dt>SSH 端口</dt><dd>22</dd><dt>标签</dt><dd>生产 · 应用节点</dd><dt>操作系统</dt><dd>Kylin OS V10 SP3</dd></dl>
      <dl class="kv"><dt>认证方式</dt><dd>SSH 密钥（凭据引用）</dd><dt>采集状态</dt><dd>已启用</dd><dt>最近状态检查</dt><dd>2026-10-26 11:41</dd><dt>最近失败尝试</dt><dd>2026-10-25 03:12 · 连接超时</dd></dl>
      </div><p class="muted small" style="margin-top:12px">编辑在列表编辑入口进行；详情只读，避免两处维护同一配置。</p>`),
    diagnostics: () => `${card('服务器诊断证据', `${evidenceBar('本次诊断证据 · 采集于 2026-10-26 11:20 · 来源 SSH · 快照不随页签切换更新')}
      <table class="data-table" style="min-width:0;margin-top:12px"><thead><tr><th>分区</th><th>采集结果</th><th>摘要</th></tr></thead><tbody>
      <tr><td>系统负载</td><td>${badge('成功', 'ok')}</td><td>load average 2.14 / 1.98 / 1.71；CPU 43.2%</td></tr>
      <tr><td>内存</td><td>${badge('成功', 'ok')}</td><td>可用 3.8 GiB；swap 使用 0</td></tr>
      <tr><td>磁盘</td><td>${badge('成功', 'ok')}</td><td>/data 使用 71.3%</td></tr>
      <tr><td>网络</td><td>${badge('部分失败', 'warn')}</td><td>2 个接口读取失败（无权限读取 eth1 统计）</td></tr>
      <tr><td>进程 / 服务</td><td>${badge('待验证', 'muted')}</td><td>未采集</td></tr>
      </tbody></table>
      <div class="actions" style="margin-top:12px"><button class="btn" data-action="collect-diagnostics">重新采集诊断证据</button><button class="btn btn-ghost" data-action="noop">查看技术证据</button></div>`)}`,
    network: () => `${card('网络证据', `${evidenceBar('本次诊断证据 · 采集于 2026-10-26 11:20 · 来源 SSH · 分区快照，不随页签切换更新')}
      <div class="notice warn small" style="margin-top:12px">网络分区部分失败：2 个接口读取失败。缺失项不补 0，也不判定网络正常。</div>
      <table class="data-table" style="min-width:0;margin-top:12px"><thead><tr><th>接口</th><th>状态</th><th>接收</th><th>发送</th></tr></thead><tbody>
      <tr><td class="mono">eth0</td><td>${badge('up', 'ok')}</td><td class="num">182.4 Mbps</td><td class="num">96.1 Mbps</td></tr>
      <tr><td class="mono">eth1</td><td>${badge('读取失败', 'danger')}</td><td>—</td><td>—</td></tr>
      </tbody></table>
      <div class="actions" style="margin-top:12px"><button class="btn" disabled title="请在诊断页签采集，避免重复采集">去诊断页签采集</button></div>`)}`,
    processes: () => `${card('进程证据', `${evidenceBar('尚未取得进程证据 · 页面切换和刷新不会自动采集')}
      <p class="muted small" style="margin-top:12px">进程列表需在诊断页签采集后查看；未采集时显示此提示，不显示 0 个进程。</p>
      <div class="actions"><button class="btn" disabled title="请在诊断页签采集，避免重复采集">去诊断页签采集</button></div>`)}`,
    services: () => `${card('服务证据', `${evidenceBar('尚未取得服务证据 · 页面切换和刷新不会自动采集')}
      <p class="muted small" style="margin-top:12px">服务状态需在诊断页签采集；未采集不等于服务正常或停止。</p>
      <div class="actions"><button class="btn" disabled title="请在诊断页签采集，避免重复采集">去诊断页签采集</button></div>`)}`,
    logs: () => `${card('系统日志', `${evidenceBar('尚未取得日志证据 · 需在诊断页签采集')}
      <p class="muted small" style="margin-top:12px">日志缺失不代表没有故障；采集为 SSH 只读命令。</p>
      <div class="actions"><button class="btn" disabled title="请在诊断页签采集，避免重复采集">去诊断页签采集</button></div>`)}`,
    related: (r) => card('关联资源', `<p class="muted small">关联资源 = 托管数据库实例 + 关系摘要；不重复第二套列表。</p>${hostedInstances()}${relationsDisclosure(r)}`)
  },
  network: {
    overview: (r) => `<div class="grid-2">${attentionCard(r)}${capabilityCard(r)}</div>
      <div class="stack" style="margin-top:16px">${governanceCard(r)}${card('资源关系', relationsDisclosure(r))}</div>`,
    metrics: (r) => metricsContent(r),
    interfaces: () => card('网络接口', `<div class="toolbar">
      <div class="search" style="min-width:12rem"><input type="search" aria-label="接口名称或别名" placeholder="名称或别名"></div>
      <select class="filter" aria-label="运行状态"><option>全部状态</option><option>已启用</option><option>已停用</option><option>下层链路中断</option></select>
      <button class="btn btn-refresh" data-action="reload">刷新接口</button>
      </div>
      <p class="muted small">显示 46 / 48 个已保存接口。速率为接口标称容量，不代表实测流量；最后发现时间不代表当前在线。</p>
      <div class="table-scroll" style="margin-top:8px" tabindex="0" role="region" aria-label="接口列表"><table class="data-table" style="min-width:0"><thead><tr><th>接口 / 别名</th><th>管理 / 运行状态</th><th>标称容量</th><th>最后发现</th></tr></thead><tbody>
      <tr><td><strong>GE0/0/1</strong><div class="cell-sub">上行核心 · #1</div></td><td>已启用 / 已启用</td><td class="num">1 Gbit/s</td><td class="mono xs">2026-10-26 11:40</td></tr>
      <tr><td><strong>GE0/0/24</strong><div class="cell-sub">订单库接入 · #24</div></td><td>已启用 / 下层链路中断</td><td class="num">1 Gbit/s</td><td class="mono xs">2026-10-26 11:40</td></tr>
      </tbody></table></div>`),
    relations: (r) => `${card('关联资源（2）', `<table class="data-table" style="min-width:0"><thead><tr><th>源资源</th><th>目标资源</th><th>关系</th><th>来源</th><th>有效期至</th></tr></thead><tbody>
      <tr><td>网络设备 #31</td><td>服务器 #21</td><td>连接</td><td>配置采集</td><td class="mono xs">2026-12-31</td></tr>
      <tr><td>网络设备 #31</td><td>网络设备 #28</td><td>依赖</td><td>人工维护</td><td>当前有效</td></tr>
      </tbody></table>`)}
      <div class="stack" style="margin-top:16px">${card('资源关系', relationsDisclosure(r))}</div>`,
    backups: (r) => `${card('每日定时备份', `<p class="muted small">默认每天 00:00（北京时间）执行。服务恢复时补做当天到期任务；当天已执行过则不重复。</p>
      <form onsubmit="return false" style="display:flex;gap:16px;align-items:end;flex-wrap:wrap;margin-top:12px">
        <label style="display:grid;gap:4px;font-size:12px;color:var(--muted)"><span>自动备份</span><input type="checkbox" checked aria-label="启用每日定时备份"></label>
        <label style="display:grid;gap:4px;font-size:12px;color:var(--muted)"><span>每日执行时间（UTC+8）</span><input type="time" value="00:00" aria-label="每日执行时间"></label>
        <button class="btn-primary" type="button" data-action="save-schedule">保存定时设置</button>
      </form>
      <p class="muted xs" style="margin-top:8px">最近自动备份：2026-10-26 00:00 · 成功</p>`)}
      <div class="stack" style="margin-top:16px">${card('加密配置备份', `<p class="muted small">备份内容加密保存，预览已脱敏。SHA-256 用于校验，不展示明文配置。</p>
      <table class="data-table" style="min-width:0;margin-top:8px"><thead><tr><th>版本</th><th>备份时间</th><th>大小</th><th>SHA-256</th><th>脱敏状态</th><th>操作</th></tr></thead><tbody>
      <tr><td>v12</td><td class="mono xs">2026-10-26 00:00</td><td class="num">184.2 KB</td><td class="mono xs">9f2c8a41d7e0…</td><td>${badge('已脱敏', 'ok')}</td><td><button class="btn-sm" data-action="backup-summary">查看摘要</button></td></tr>
      <tr><td>v11</td><td class="mono xs">2026-10-25 00:00</td><td class="num">183.9 KB</td><td class="mono xs">4a71c0d3b1f2…</td><td>${badge('已脱敏', 'ok')}</td><td><button class="btn-sm" data-action="backup-summary">查看摘要</button></td></tr>
      </tbody></table>`)}</div>`,
    collection: (r) => monitorConfigContent(r)
  }
};

function hostedInstances() {
  return `<div class="list-rows">
    <div class="row-item"><div><div class="name">mysql-order-prod</div><div class="sub">MYSQL · 生产环境 · active</div></div>${badge('主节点', 'info')} ${badge('warning', 'warn')}<button class="btn-sm" data-action="noop" aria-label="查看 mysql-order-prod 详情">›</button></div>
    <div class="row-item"><div><div class="name">mysql-report-readonly</div><div class="sub">MYSQL · 生产环境 · active</div></div>${badge('副本', 'info')} ${badge('healthy', 'ok')}<button class="btn-sm" data-action="noop" aria-label="查看 mysql-report-readonly 详情">›</button></div>
  </div>`;
}

/* ---------------- 渲染外壳 ---------------- */

function render() {
  const r = resource();
  const nav = NAV.map((item) => `<button class="nav-item" aria-current="${item.tab === r.key ? 'page' : 'false'}" data-action="nav" data-nav="${item.tab}"><span>${esc(item.label)}</span><span class="nav-order">${item.order}</span></button>`).join('');
  const shell = `
    <aside class="sidebar" aria-label="主导航">
      <div class="brand"><span class="brand-mark" aria-hidden="true">S</span> Slide</div>
      <div class="nav-group"><div class="nav-label">资源管理</div>${nav}</div>
      <div class="nav-group"><div class="nav-label">运维</div>
        <button class="nav-item" data-action="noop"><span>事件中心</span><span class="nav-order">5</span></button>
        <button class="nav-item" data-action="noop"><span>AI 工作空间</span><span class="nav-order">6</span></button>
        <button class="nav-item" data-action="noop"><span>审计中心</span><span class="nav-order">7</span></button>
      </div>
      <div class="nav-group"><div class="nav-label">说明</div>
        <p class="xs muted" style="padding:0 12px;line-height:1.6">四菜单及顺序保持不变；原型未展开的菜单不参与本轮交互。</p>
      </div>
    </aside>
    <div class="main">
      <div class="topbar"><span class="crumb">资源管理 / <strong>${esc(r.navLabel)}</strong>${ui.view === 'detail' ? ` / ${esc(tabLabel(r))}` : ''}</span>
        <span class="topbar-right"><span class="pill">设计评审环境</span><span>${esc(APP_VERSION)}</span></span>
      </div>
      <main class="content" id="main-content">${ui.view === 'detail' ? renderDetail(r) : renderList(r)}</main>
    </div>`;
  document.getElementById('app').innerHTML = shell;
  // 卡片内的表格统一包一层局部横滚容器，避免窄列时撑破卡片。
  document.querySelectorAll('.card > table.data-table').forEach((table) => {
    const wrap = document.createElement('div');
    wrap.className = 'table-inline';
    table.replaceWith(wrap);
    wrap.append(table);
  });
  syncControls();
}

/* ---------------- 弹窗 ---------------- */

let lastFocused = null;
function openDialog({ title, body, footer = '', size = '' }) {
  lastFocused = document.activeElement;
  const root = document.getElementById('dialog-root');
  root.innerHTML = `<div class="dialog-backdrop" data-action="backdrop"><div class="dialog ${size}" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
    <header><h2 id="dialog-title">${esc(title)}</h2><button class="btn-ghost" data-action="close-dialog" aria-label="关闭">✕</button></header>
    <div class="body">${body}</div>
    <footer>${footer || '<button class="btn" data-action="close-dialog">关闭</button>'}</footer>
  </div></div>`;
  const focusTarget = root.querySelector('input, select, button.btn-primary, .dialog header button');
  focusTarget?.focus();
  document.addEventListener('keydown', trapFocus, true);
}
function closeDialog() {
  document.getElementById('dialog-root').innerHTML = '';
  document.removeEventListener('keydown', trapFocus, true);
  lastFocused?.focus?.();
  lastFocused = null;
}
function trapFocus(event) {
  const dialog = document.querySelector('.dialog');
  if (!dialog) return;
  if (event.key === 'Escape') { event.preventDefault(); closeDialog(); return; }
  if (event.key !== 'Tab') return;
  const focusables = [...dialog.querySelectorAll('button, input, select, [href], [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled);
  if (!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
}

let toastTimer = 0;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/* ---------------- 交互 ---------------- */

function syncControls() {
  const cls = document.getElementById('ctl-class');
  const view = document.getElementById('ctl-view');
  const state = document.getElementById('ctl-state');
  const long = document.getElementById('ctl-long');
  const tab = document.getElementById('ctl-tab');
  if (!cls) return;
  cls.value = ui.cls; view.value = ui.view; state.value = ui.state; long.checked = ui.longName;
  const r = resource();
  tab.innerHTML = r.tabs.map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('');
  tab.value = currentTab(r);
}

function updateUrl() {
  const params = new URLSearchParams();
  params.set('class', ui.cls); params.set('view', ui.view); params.set('tab', currentTab()); params.set('state', ui.state);
  if (ui.longName) params.set('long', '1');
  history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
}

function renderAndSync() { render(); updateUrl(); }

function goTab(tab) {
  ui.tab = tab; ui.view = 'detail';
  renderAndSync();
  document.getElementById(`tab-${currentTab()}`)?.focus();
}

function handleAction(action, el) {
  switch (action) {
    case 'nav': {
      const target = el.dataset.nav;
      if (RESOURCES[target]) { ui.cls = target; ui.view = 'list'; ui.tab = 'overview'; ui.filter = 'all'; ui.search = ''; renderAndSync(); }
      else toast('原型未展开该菜单');
      return;
    }
    case 'open-detail': ui.view = 'detail'; ui.tab = 'overview'; renderAndSync(); return;
    case 'back-list': ui.view = 'list'; renderAndSync(); return;
    case 'tab': goTab(el.dataset.tab); return;
    case 'go-tab': goTab(el.dataset.tab); return;
    case 'monitor-config': goTab('collection'); return;
    case 'filter': ui.filter = el.dataset.filter; ui.search = ''; renderAndSync(); return;
    case 'reset-filter': ui.filter = 'all'; ui.search = ''; renderAndSync(); return;
    case 'reload': toast('已刷新（演示）'); return;
    case 'noop': toast('演示：该入口在生产中使用现有页面或跳转'); return;
    case 'add':
      openDialog({ title: `添加${resource().navLabel === '数据库' ? '实例' : resource().navLabel}`, body: '<p>复用现有资源编辑与“监控与采集”页签：先保存连接，再绑定模板、试采与启用。</p><div class="notice info small">编辑能力不在本次详情设计范围内改动；本弹窗只示意入口保留。</div>' });
      return;
    case 'edit':
      openDialog({ title: '编辑资源（保留现有能力）', body: `<p>打开现有资源编辑器，页签：<strong>基本信息</strong> / <strong>监控与采集</strong>。</p>
        <div class="notice info small">编辑按钮语义与权限门控保持现状：需要对应 <code>*:manage</code> 权限。详情的“监控配置”复用同一配置来源，避免两套状态。</div>`, footer: '<button class="btn" data-action="close-dialog">取消</button><button class="btn-primary" data-action="close-dialog">进入编辑（演示）</button>' });
      return;
    case 'test': {
      const db = ui.cls === 'db';
      openDialog({ title: `测试连接 · ${esc(el.closest('tr')?.querySelector('a')?.textContent ?? resourceName())}`, body: `
        <p class="muted small">测试只验证网络连通与认证，不等同于指标测试成功；失败不会修改现有采集配置。</p>
        ${db ? '<label>登录密码（仅本次测试，不保存）<input type="password" value="" aria-label="登录密码" autocomplete="off"></label>' : '<label>使用已有凭据引用<input type="text" value="cred://configured" aria-label="凭据引用" readonly></label>'}
        <div class="notice info small">凭据不写入页面、日志或导出。</div>`,
        footer: '<button class="btn" data-action="close-dialog">取消</button><button class="btn-primary" data-action="test-run">测试连接</button>' });
      return;
    }
    case 'test-run': closeDialog(); toast('演示结果：连接成功；指标可用性需试采确认'); return;
    case 'delete':
      openDialog({ title: '确认删除？', body: `<p>将删除资源及其采集绑定。历史数据保留策略按现有规则执行，此操作不可撤销。</p><div class="notice warn small">需要 <code>*:manage</code> 权限；演示环境不执行删除。</div>`, footer: '<button class="btn" data-action="close-dialog">取消</button><button class="btn-danger-outline btn-sm danger" data-action="delete-confirm">确认删除</button>' });
      return;
    case 'delete-confirm': closeDialog(); toast('演示：已取消删除（原型不执行写操作）'); return;
    case 'columns':
      openDialog({ title: '列设置', body: `<p class="muted small">八个业务列始终显示。可增加指标列；“数据量”等能力移入可选列，不再挤占常驻八列。</p>
        <label><input type="checkbox" checked> 数据库大小 / 数据量（可选）</label><label><input type="checkbox"> 运行时长</label><label><input type="checkbox"> 模板绑定（可选）</label>`,
        footer: '<button class="btn" data-action="close-dialog">恢复默认</button><button class="btn-primary" data-action="close-dialog">完成</button>' });
      return;
    case 'extra': toast(`演示：${el.dataset.label ?? '操作'}复用现有能力`); return;
    case 'enable-flow':
      openDialog({ title: '检查并启用采集', body: `<ol class="steps"><li class="done"><span class="n">✓</span>检查兼容性与权限</li><li class="current"><span class="n">2</span>执行试采</li><li><span class="n">3</span>发布并应用配置</li><li><span class="n">4</span>等待正式采集</li></ol>
        <div class="notice info small">试采不写正式历史、不发事件；发布不代表全部指标可用。当前模板：MySQL 基础采集 v2.4.1。</div>
        <div class="list-rows"><div class="row-item"><div><div class="name">兼容性</div><div class="sub">引擎与版本匹配；只读账号权限已确认</div></div>${badge('通过', 'ok')}</div>
        <div class="row-item"><div><div class="name">试采</div><div class="sub">5 项中 4 项取得有效样本</div></div>${badge('部分成功', 'warn')}</div></div>`,
        footer: '<button class="btn" data-action="close-dialog">取消</button><button class="btn" data-action="close-dialog">重新试采</button><button class="btn-primary" data-action="publish">发布</button>' });
      return;
    case 'trial': toast('演示：试采未写入正式历史'); return;
    case 'publish': closeDialog(); toast('演示：已发布，正在确认应用与正式数据状态'); return;
    case 'diagnose': openDialog({ title: 'AI 诊断', body: '<p>诊断将读取当前资源的观测证据，生成建议；不会自动执行变更，也不会自动宣告恢复。</p><div class="notice info small">模型调用受现有场景路由与预算约束；证据查看无需调用模型。</div>', footer: '<button class="btn" data-action="close-dialog">取消</button><button class="btn-primary" data-action="diagnose-run">开始诊断</button>' }); return;
    case 'diagnose-run': closeDialog(); toast('演示：诊断已提交，可在 AI 诊断页签查看轨迹'); return;
    case 'collect-diagnostics': toast('演示：诊断证据采集已提交（需要服务器管理权限）'); return;
    case 'open-diagnostics': toast('演示：技术证据在同一页签的折叠区'); return;
    case 'backup-summary': openDialog({ title: '配置备份 v12', body: `<p class="muted small">备份时间 2026-10-26 00:00 · SHA-256 9f2c8a41d7e0… · 已脱敏</p>
      <pre class="mono xs" style="white-space:pre-wrap;max-height:40vh;overflow:auto;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;padding:12px">sysname sw-core-01
interface GE0/0/1
 description 上行核心
 port link-type trunk
  <span class="muted"># 敏感字段已脱敏（snmp-agent / local-user 密码）</span></pre>` });
      return;
    case 'save-schedule': toast('演示：定时备份设置已保存'); return;
    case 'close-dialog': closeDialog(); return;
  }
}

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  event.preventDefault();
  if (el.dataset.action === 'backdrop') { if (event.target === el) closeDialog(); return; }
  handleAction(el.dataset.action, el);
});

document.addEventListener('keydown', (event) => {
  if (event.target.id === 'list-search') {
    if (event.key === 'Enter') { ui.search = event.target.value; renderAndSync(); }
    if (event.key === 'Escape') { ui.search = ''; event.target.value = ''; renderAndSync(); }
    return;
  }
  if (ui.view !== 'detail' || !event.target.closest('[data-tablist]')) return;
  const keys = event.key;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(keys)) return;
  event.preventDefault();
  const tabs = resource().tabs.map(([key]) => key);
  const index = tabs.indexOf(currentTab());
  const next = keys === 'Home' ? tabs[0] : keys === 'End' ? tabs[tabs.length - 1] : keys === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : tabs[(index - 1 + tabs.length) % tabs.length];
  goTab(next);
});

document.getElementById('ctl-class').addEventListener('change', (e) => {
  ui.cls = e.target.value; ui.view = 'list'; ui.tab = 'overview'; ui.filter = 'all'; ui.search = ''; renderAndSync();
});
document.getElementById('ctl-view').addEventListener('change', (e) => { ui.view = e.target.value; renderAndSync(); });
document.getElementById('ctl-tab').addEventListener('change', (e) => { ui.tab = e.target.value; ui.view = 'detail'; renderAndSync(); });
document.getElementById('ctl-state').addEventListener('change', (e) => { ui.state = e.target.value; renderAndSync(); });
document.getElementById('ctl-long').addEventListener('change', (e) => { ui.longName = e.target.checked; renderAndSync(); });

/* 初始化：URL 参数优先，便于逐状态截图。 */
(function init() {
  const params = new URLSearchParams(location.search);
  const cls = params.get('class');
  if (cls && RESOURCES[cls]) ui.cls = cls;
  const view = params.get('view');
  if (view === 'list' || view === 'detail') ui.view = view;
  const tab = params.get('tab');
  if (tab && RESOURCES[ui.cls].tabs.some(([k]) => k === tab)) ui.tab = tab;
  const state = params.get('state');
  if (['normal', 'empty', 'loading', 'error', 'partial', 'forbidden'].includes(state)) ui.state = state;
  ui.longName = params.get('long') === '1';
  if (params.get('full') === '1') document.documentElement.classList.add('shot-full');
  renderAndSync();
})();
