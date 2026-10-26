/* MAX-241 三类完整资源详情原型（演示数据，不连后端）。
   设计依据：docs/slide/development/MAX-241/03-detail-design.md
   共享组件只读复用 frontend/src/app，未修改任何产品代码。
   所有写操作（编辑、测试、采集、发布、备份）均为本地演示，不发出网络请求。 */

import { html, render, nothing } from 'lit';
import '../../../../../frontend/src/app/ui/components/app-card.ts';
import '../../../../../frontend/src/app/ui/components/app-dialog.ts';
import '../../../../../frontend/src/app/ui/components/app-badge.ts';
import '../../../../../frontend/src/app/ui/components/app-empty-state.ts';
import '../../../../../frontend/src/app/ui/components/app-data-table.ts';
import '../../../../../frontend/src/app/ui/components/app-form-field.ts';
import '../../../../../frontend/src/app/ui/components/app-toast-container.ts';
import { showToast } from '../../../../../frontend/src/app/ui/components/app-toast-container.ts';

const APP_VERSION = 'MAX-241 设计原型 · 2026-10-26';

/* ---------------- 权限模型（仅前端演示；生产同时由服务端校验） ---------------- */

const PERMISSION_PRESETS = {
  full: {
    db: ['view', 'update', 'delete', 'manage', 'ai'],
    server: ['view', 'manage'],
    network: ['view', 'manage', 'backup'],
  },
  view: { db: ['view'], server: ['view'], network: ['view'] },
  manager: { db: ['view', 'manage'], server: ['view', 'manage'], network: ['view', 'manage'] },
  backup: { db: ['view'], server: ['view'], network: ['view', 'backup'] },
  none: { db: [], server: [], network: [] },
};

const PERMISSION_LABEL = {
  db: { view: 'instance:view', update: 'instance:update', delete: 'instance:delete', manage: 'instance:manage', ai: 'ai:manage' },
  server: { view: 'servers:view', manage: 'servers:manage' },
  network: { view: 'network_devices:view', manage: 'network_devices:manage', backup: 'network_devices:backup' },
};

/* ---------------- 监控模板（演示目录；生产来自 metric registry） ---------------- */

const TEMPLATES = {
  db: [
    { id: 'mysql-basic', name: 'MySQL 基础采集', version: 'v2.4.1', digest: 'sha256:8f2c…41d7', engine: 'MySQL 8.0',
      params: [
        { key: 'interval', label: '采集周期', def: '60s', source: '模板默认', type: 'text' },
        { key: 'connectTimeout', label: '连接超时', def: '3s', source: '模板默认', type: 'text' },
        { key: 'slowQueryMs', label: '慢查询阈值', def: '1000ms', source: '模板默认', type: 'text' },
        { key: 'readonlyUser', label: '只读账号', def: 'cred://mysql-order-ro', source: '凭据引用', type: 'text' },
      ] },
    { id: 'mysql-replica', name: 'MySQL 只读副本采集', version: 'v2.1.0', digest: 'sha256:21ab…9c03', engine: 'MySQL 8.0',
      params: [
        { key: 'interval', label: '采集周期', def: '120s', source: '模板默认', type: 'text' },
        { key: 'connectTimeout', label: '连接超时', def: '3s', source: '模板默认', type: 'text' },
        { key: 'replicationLag', label: '复制延迟阈值', def: '30s', source: '模板默认', type: 'text' },
        { key: 'readonlyUser', label: '只读账号', def: 'cred://mysql-report-ro', source: '凭据引用', type: 'text' },
      ] },
    { id: 'pg-basic', name: 'PostgreSQL 基础采集', version: 'v3.0.2', digest: 'sha256:6b90…d2e8', engine: 'PostgreSQL 14+',
      params: [
        { key: 'interval', label: '采集周期', def: '60s', source: '模板默认', type: 'text' },
        { key: 'connectTimeout', label: '连接超时', def: '3s', source: '模板默认', type: 'text' },
        { key: 'slowQueryMs', label: '慢查询阈值', def: '1000ms', source: '模板默认', type: 'text' },
        { key: 'readonlyUser', label: '只读账号', def: 'cred://pg-billing-ro', source: '凭据引用', type: 'text' },
      ] },
    { id: 'dm-basic', name: '达梦基础采集', version: 'v1.4.0', digest: 'sha256:c4d1…7a55', engine: 'DM8',
      params: [
        { key: 'interval', label: '采集周期', def: '60s', source: '模板默认', type: 'text' },
        { key: 'connectTimeout', label: '连接超时', def: '5s', source: '模板默认', type: 'text' },
        { key: 'readonlyUser', label: '只读账号', def: 'cred://dm-archive-ro', source: '凭据引用', type: 'text' },
      ] },
  ],
  server: [
    { id: 'linux-basic', name: 'Linux 主机基础', version: 'v1.8.0', digest: 'sha256:93aa…10bf', engine: 'Linux / Kylin / CentOS',
      params: [
        { key: 'interval', label: '采集周期', def: '60s', source: '模板默认', type: 'text' },
        { key: 'sshTimeout', label: 'SSH 超时', def: '5s', source: '模板默认', type: 'text' },
        { key: 'diskThreshold', label: '磁盘告警阈值', def: '85%', source: '策略组', type: 'text' },
        { key: 'credential', label: '采集账号', def: 'cred://linux-ops-ro', source: '凭据引用', type: 'text' },
      ] },
    { id: 'linux-minimal', name: 'Linux 最小采集', version: 'v1.2.0', digest: 'sha256:5e77…2c41', engine: 'Linux',
      params: [
        { key: 'interval', label: '采集周期', def: '300s', source: '模板默认', type: 'text' },
        { key: 'sshTimeout', label: 'SSH 超时', def: '8s', source: '模板默认', type: 'text' },
        { key: 'credential', label: '采集账号', def: 'cred://linux-ops-ro', source: '凭据引用', type: 'text' },
      ] },
  ],
  network: [
    { id: 'huawei-snmp', name: '华为交换机 SNMP', version: 'v2.0.3', digest: 'sha256:aa01…83ed', engine: 'Huawei VRP V200',
      params: [
        { key: 'snmpInterval', label: 'SNMP 周期', def: '60s', source: '模板默认', type: 'text' },
        { key: 'snmpVersion', label: 'SNMP 版本', def: 'v3', source: '模板默认', type: 'text' },
        { key: 'ifPollCount', label: '接口轮询数', def: '48', source: '模板默认', type: 'text' },
        { key: 'credential', label: '凭据引用', def: 'cred://snmp-core-ro', source: '凭据引用', type: 'text' },
      ] },
    { id: 'cisco-snmp', name: 'Cisco SNMP', version: 'v1.9.1', digest: 'sha256:70c2…4b6a', engine: 'Cisco IOS / NX-OS',
      params: [
        { key: 'snmpInterval', label: 'SNMP 周期', def: '60s', source: '模板默认', type: 'text' },
        { key: 'snmpVersion', label: 'SNMP 版本', def: 'v2c', source: '模板默认', type: 'text' },
        { key: 'ifPollCount', label: '接口轮询数', def: '24', source: '模板默认', type: 'text' },
        { key: 'credential', label: '凭据引用', def: 'cred://snmp-edge-ro', source: '凭据引用', type: 'text' },
      ] },
    { id: 'huawei-fw-snmp', name: '华为防火墙 SNMP', version: 'v1.2.0', digest: 'sha256:d9f0…6e12', engine: 'Huawei USG',
      params: [
        { key: 'snmpInterval', label: 'SNMP 周期', def: '120s', source: '模板默认', type: 'text' },
        { key: 'snmpVersion', label: 'SNMP 版本', def: 'v3', source: '模板默认', type: 'text' },
        { key: 'credential', label: '凭据引用', def: 'cred://snmp-fw-ro', source: '凭据引用', type: 'text' },
      ] },
  ],
};

const templateById = (cls, id) => TEMPLATES[cls].find((t) => t.id === id) ?? null;

/* ---------------- 演示资源（每行都是独立对象，详情必须按选中行显示） ---------------- */

const RESOURCE_ROWS = {
  db: [
    {
      id: 12, name: 'mysql-order-prod', endpoint: '10.20.1.15:3306', version: '8.0.34', dbType: 'MySQL',
      env: '生产环境', health: '异常', healthVariant: 'warn', score: 62, healthLabel: '当前观测异常',
      collection: '正常', collectionSub: '最近 1 分钟内成功', lastSuccess: '2026-10-26 11:41',
      observedAt: '2026-10-26 11:42:07', readAt: '2026-10-26 11:43:10',
      templateId: 'mysql-basic', revision: 37, group: '生产数据库标准 · v6', formal: 'available',
      overrides: { connectTimeout: '5s' }, alerts: 2,
      gap: '慢查询采集权限不足；容量历史仅覆盖最近 7 天采样。',
      investigations: ['订单库连接数高 · 只读排查', '慢查询增长与索引缺失 · 已完成'],
      database: 'order_core', slowQueries: 12, sessions: 42,
    },
    {
      id: 9, name: 'mysql-report-readonly', endpoint: '10.20.1.18:3306', version: '8.0.34', dbType: 'MySQL',
      env: '生产环境', health: '健康', healthVariant: 'ok', score: 93, healthLabel: '当前观测未提示异常',
      collection: '正常', collectionSub: '最近 2 分钟内成功', lastSuccess: '2026-10-26 11:40',
      observedAt: '2026-10-26 11:40:12', readAt: '2026-10-26 11:43:11',
      templateId: 'mysql-replica', revision: 12, group: '只读副本标准 · v2', formal: 'available',
      overrides: { interval: '120s' }, alerts: 0,
      gap: '无复制延迟历史时，健康评分只覆盖可用性维度。',
      investigations: ['只读副本延迟抖动 · 已完成'],
      database: 'report', slowQueries: 0, sessions: 5,
    },
    {
      id: 7, name: 'pg-billing', endpoint: '10.20.2.11:5432', version: '16.4', dbType: 'PostgreSQL',
      env: '生产环境', health: '警告', healthVariant: 'warn', score: 78, healthLabel: '当前观测异常',
      collection: '部分失败', collectionSub: '2 项指标采集失败', lastSuccess: '2026-10-26 11:37',
      observedAt: '2026-10-26 11:37:44', readAt: '2026-10-26 11:43:12',
      templateId: 'pg-basic', revision: 8, group: '生产数据库标准 · v6', formal: 'pending',
      overrides: {}, alerts: 1,
      gap: '慢查询采集失败；复制槽容量未采集。',
      investigations: ['计费库复制延迟 · 排查中'],
      database: 'billing', slowQueries: 3, sessions: 18,
    },
    {
      id: 5, name: 'dm-archive', endpoint: '10.20.3.6:5236', version: 'DM8', dbType: '达梦',
      env: '归档环境', health: '未知', healthVariant: 'muted', score: null, healthLabel: '待确认',
      collection: '已停用', collectionSub: '有效开关为停用', lastSuccess: '无成功采集记录',
      observedAt: '—', readAt: '2026-10-26 11:43:13',
      templateId: null, revision: 0, group: null, formal: 'none',
      overrides: {}, alerts: 0,
      gap: '尚未绑定监控模板，没有可用的观测证据。',
      investigations: [], database: 'archive', slowQueries: 0, sessions: 0,
    },
  ],
  server: [
    {
      id: 21, name: 'app-prod-01', endpoint: '10.20.1.21:22', version: 'Kylin V10', os: 'Kylin OS V10 SP3',
      env: '生产环境', health: '健康', healthVariant: 'ok', score: 91, healthLabel: '当前观测未提示异常',
      collection: '正常', collectionSub: '最近 1 分钟内成功', lastSuccess: '2026-10-26 11:41',
      observedAt: '2026-10-26 11:41:30', readAt: '2026-10-26 11:42:05',
      templateId: 'linux-basic', revision: 21, group: 'Linux 标准 · v3', formal: 'available',
      overrides: { sshTimeout: '8s' }, alerts: 0,
      gap: '进程与服务证据尚未采集；最近一次状态检查失败 1 次。',
      investigations: ['应用节点 CPU 抖动 · 已完成'],
      hosted: ['mysql-order-prod', 'mysql-report-readonly'],
    },
    {
      id: 18, name: 'app-prod-02', endpoint: '10.20.1.22:22', version: 'Kylin V10', os: 'Kylin OS V10 SP3',
      env: '生产环境', health: '健康', healthVariant: 'ok', score: 88, healthLabel: '当前观测未提示异常',
      collection: '正常', collectionSub: '最近 1 分钟内成功', lastSuccess: '2026-10-26 11:40',
      observedAt: '2026-10-26 11:40:51', readAt: '2026-10-26 11:42:06',
      templateId: 'linux-basic', revision: 18, group: 'Linux 标准 · v3', formal: 'available',
      overrides: {}, alerts: 0,
      gap: '进程证据尚未采集。',
      investigations: ['应用节点磁盘增长 · 已完成'],
      hosted: ['pg-billing'],
    },
    {
      id: 14, name: 'backup-node-01', endpoint: '10.20.1.40:22', version: 'CentOS 7.9', os: 'CentOS 7.9',
      env: '备份环境', health: '不可用', healthVariant: 'danger', score: null, healthLabel: '当前观测异常',
      collection: '失败', collectionSub: 'SSH 认证失败', lastSuccess: '2026-10-26 09:12',
      observedAt: '2026-10-26 09:12:30', readAt: '2026-10-26 11:42:07',
      templateId: 'linux-minimal', revision: 5, group: null, formal: 'failed',
      overrides: {}, alerts: 1,
      gap: 'SSH 凭据失效，无法取得主机指标。',
      investigations: [],
      hosted: [],
    },
  ],
  network: [
    {
      id: 31, name: 'sw-core-01', endpoint: '10.20.1.1:161', version: 'S5735-L48T4X', vendor: 'Huawei V200R019C10',
      env: '生产环境', health: '异常', healthVariant: 'warn', score: 64, healthLabel: '当前观测异常',
      collection: '正常', collectionSub: '最近 1 分钟内成功', lastSuccess: '2026-10-26 11:40',
      observedAt: '2026-10-26 11:40:52', readAt: '2026-10-26 11:41:33',
      templateId: 'huawei-snmp', revision: 15, group: '网络设备标准 · v4', formal: 'available',
      overrides: { snmpVersion: 'v3' }, alerts: 1, hasSsh: true, backups: 2,
      gap: 'SNMP 超时 2 次；接口速率仅标称容量，不含实测流量。',
      investigations: ['核心交换机上行抖动 · 排查中'],
    },
    {
      id: 30, name: 'sw-agg-02', endpoint: '10.20.1.2:161', version: 'S5735-L24T4X', vendor: 'Huawei V200R019C10',
      env: '生产环境', health: '未知', healthVariant: 'muted', score: null, healthLabel: '待确认',
      collection: '等待首样本', collectionSub: '已绑定，尚未取得正式数据', lastSuccess: '无成功采集记录',
      observedAt: '—', readAt: '2026-10-26 11:41:34',
      templateId: 'huawei-snmp', revision: 3, group: '网络设备标准 · v4', formal: 'pending',
      overrides: {}, alerts: 0, hasSsh: false, backups: 0,
      gap: '绑定已应用，但尚无正式样本；未取得观测证据，不能判定设备正常。',
      investigations: [],
    },
    {
      id: 28, name: 'fw-edge-01', endpoint: '10.20.1.254:161', version: 'USG6550E', vendor: 'Huawei V600R007',
      env: '边界环境', health: '待确认', healthVariant: 'muted', score: null, healthLabel: '待确认',
      collection: '不可用', collectionSub: 'SNMP 超时', lastSuccess: '2026-10-25 22:03',
      observedAt: '2026-10-25 22:03:11', readAt: '2026-10-26 11:41:35',
      templateId: 'huawei-fw-snmp', revision: 2, group: null, formal: 'failed',
      overrides: {}, alerts: 0, hasSsh: false, backups: 0,
      gap: 'SNMP 凭据或网络策略不可用，接口与关系证据可能过期。',
      investigations: ['边界防火墙 SNMP 超时 · 已完成'],
    },
  ],
};

const CLASSES = {
  db: {
    key: 'db', navLabel: '数据库', listTitle: '数据库实例',
    listDesc: '四菜单与顺序保留；列表单行八列（序号/实例/地址/版本/观测健康/采集状态/最近成功采集/操作），行内四操作完整展开。',
    addLabel: '添加实例',
    nameHeader: '实例', versionHeader: '版本',
    filters: [['全部', 'all'], ['健康', 'healthy'], ['警告', 'warning'], ['异常', 'critical'], ['未知', 'unknown']],
    editKey: 'update', deleteKey: 'delete', testKey: 'manage',
    tabs: [
      ['overview', '概览'], ['collection', '监控配置'], ['metrics', '指标与趋势'], ['health', '健康评分'],
      ['topsql', '慢查询'], ['sessions', '会话'], ['capacity', '容量'], ['schema', '表结构'],
      ['indexes', '索引'], ['sqlaudit', 'SQL 审核'], ['logs', '日志'], ['qan', '查询分析'], ['diagnosis', 'AI 诊断'],
    ],
  },
  server: {
    key: 'server', navLabel: '服务器', listTitle: '服务器',
    listDesc: '保留服务器专业页签；列表八列（序号/主机名称/地址/系统版本/观测健康/采集状态/最近成功采集/操作），行内四操作完整展开。',
    addLabel: '添加服务器',
    nameHeader: '主机名称', versionHeader: '系统版本',
    filters: [['全部', 'all'], ['健康', 'healthy'], ['异常', 'critical'], ['未知', 'unknown']],
    editKey: 'manage', deleteKey: 'manage', testKey: 'manage',
    tabs: [
      ['overview', '概览'], ['collection', '监控配置'], ['metrics', '指标与趋势'], ['config', '配置'],
      ['diagnostics', '诊断'], ['network', '网络'], ['processes', '进程'], ['services', '服务'],
      ['logs', '日志'], ['related', '关联资源'],
    ],
  },
  network: {
    key: 'network', navLabel: '网络设备', listTitle: '网络设备',
    listDesc: '保留接口、关联资源与配置备份能力；列表八列（序号/设备/地址/型号/观测健康/采集状态/最近成功采集/操作），行内四操作完整展开。',
    addLabel: '添加网络设备',
    nameHeader: '设备', versionHeader: '型号',
    filters: [['全部', 'all'], ['健康', 'healthy'], ['异常', 'critical'], ['未知', 'unknown']],
    editKey: 'manage', deleteKey: 'manage', testKey: 'manage',
    tabs: [
      ['overview', '概览'], ['metrics', '指标与趋势'], ['interfaces', '接口'],
      ['relations', '关联资源'], ['backups', '配置备份'], ['collection', '监控配置'],
    ],
  },
};

const NAV = [
  { label: '资源概览', key: 'dashboard', order: 1 },
  { label: '网络设备', key: 'network', order: 2 },
  { label: '服务器', key: 'server', order: 3 },
  { label: '数据库', key: 'db', order: 4 },
];

/* ---------------- 状态 ---------------- */

const ui = {
  cls: 'db',
  view: 'list',
  tab: 'overview',
  state: 'normal',
  perm: 'full',
  longName: false,
  filter: 'all',
  search: '',
  id: null,
  dialog: null,
  config: null,
  listContext: null,
};

const cls = () => CLASSES[ui.cls];
const rowById = (id, type = ui.cls) => RESOURCE_ROWS[type].find((r) => r.id === Number(id)) ?? null;
const selectedRow = () => rowById(ui.id ?? RESOURCE_ROWS[ui.cls][0].id) ?? RESOURCE_ROWS[ui.cls][0];
const perms = (type = ui.cls) => PERMISSION_PRESETS[ui.perm][type];
const has = (key, type = ui.cls) => perms(type).includes(key);
const canView = (type = ui.cls) => has('view', type);
const permLabel = (key, type = ui.cls) => PERMISSION_LABEL[type][key] ?? key;

const displayName = (row) => (ui.longName && (ui.view === 'detail' ? row.id === selectedRow().id : row.id === RESOURCE_ROWS[ui.cls][0].id)
  ? `${row.name}（含灾备只读副本与跨机房双活链路，资源名称用于验证长名称换行与操作可达性）`
  : row.name);

const currentTab = () => (cls().tabs.some(([key]) => key === ui.tab) ? ui.tab : cls().tabs[0][0]);
const tabLabel = (key = currentTab()) => (cls().tabs.find(([k]) => k === key) ?? [])[1] ?? '';

function badge(label, variant = 'muted') {
  return html`<app-badge variant=${variant}>${label}</app-badge>`;
}

function card(title, body, opts = {}) {
  return html`<app-card class=${opts.className ?? ''}>
    ${title ? html`<span slot="header">${title}</span>` : nothing}
    ${body}
  </app-card>`;
}

function table(columns, rows, opts = {}) {
  return html`<div class="table-scroll" role="region" tabindex="0" aria-label=${opts.label ?? '数据表格，可横向滚动'} data-testid=${opts.testId ?? nothing}>
    <app-data-table .columns=${columns} .rows=${rows} dense .loading=${Boolean(opts.loading)} .emptyMessage=${opts.emptyMessage ?? '暂无可用数据'}></app-data-table>
  </div>`;
}

function emptyState(title, description, actions = nothing, icon = '', role = '') {
  return html`<div role=${role || nothing}><app-empty-state title=${title} description=${description} icon=${icon}>
    <div slot="actions" class="actions">${actions}</div>
  </app-empty-state></div>`;
}

/* ---------------- 列表 ---------------- */

function filteredRows() {
  const type = ui.cls;
  return RESOURCE_ROWS[type].filter((row) => {
    const f = ui.filter;
    if (f !== 'all') {
      if (f === 'healthy' && row.health !== '健康') return false;
      if (f === 'warning' && row.health !== '警告') return false;
      if (f === 'critical' && !['异常', '不可用'].includes(row.health)) return false;
      if (f === 'unknown' && !['未知', '待确认'].includes(row.health)) return false;
    }
    if (ui.search && !`${row.name} ${row.endpoint} ${row.version} ${row.health} ${row.collection}`.toLowerCase().includes(ui.search.toLowerCase())) return false;
    return true;
  });
}

function editAllowed() {
  return has(cls().editKey);
}
function deleteAllowed() { return has(cls().deleteKey); }
function testAllowed() { return has(cls().testKey); }
function configAllowed() { return has('manage'); }

function rowAction(label, action, row, allowed, reason, danger = false) {
  return html`<button class=${`btn-sm${danger ? ' danger' : ''}`} data-action=${action} data-id=${row.id}
    .disabled=${!allowed} title=${allowed ? label : reason}
    @click=${allowed ? (event) => onRowAction(action, row, event) : undefined}>${label}</button>`;
}

function listView() {
  if (!canView()) return forbiddenList();

  const rows = filteredRows().map((row, index) => ({
    select: html`<input type="checkbox" aria-label=${`选择 ${row.name} 用于批量绑定采集模板`}>`,
    seq: index + 1,
    name: html`<button class="btn-ghost cell-truncate" title=${row.name} data-action="open-detail" data-id=${row.id} @click=${() => openDetail(row)}>${displayName(row)}</button>`,
    address: html`<span class="mono">${row.endpoint}</span>`,
    version: row.version,
    health: html`<div>${badge(row.health, row.healthVariant)}<span class="cell-sub">${row.score == null ? '证据不足' : `评分 ${row.score}`}</span></div>`,
    collection: html`<div>${badge(row.collection, row.collection === '正常' ? 'ok' : row.collection === '已停用' ? 'muted' : row.collection === '等待首样本' ? 'warn' : 'danger')}<span class="cell-sub">${row.collectionSub}</span></div>`,
    lastSuccess: html`<span class="mono">${row.lastSuccess}</span>`,
    actions: html`<div class="actions">
      ${rowAction('详情', 'open-detail', row, true, '详情')}
      ${rowAction('编辑', 'edit', row, editAllowed(), `需要 ${permLabel(cls().editKey)} 与资源范围`)}
      ${rowAction('测试', 'test', row, testAllowed(), `需要 ${permLabel(cls().testKey)}`)}
      ${rowAction('删除', 'delete', row, deleteAllowed(), `需要 ${permLabel(cls().deleteKey)} 与资源范围`, true)}
    </div>`,
  }));

  const columns = [
    { key: 'select', label: '选择', width: '4rem' },
    { key: 'seq', label: '序号', width: '3rem' },
    { key: 'name', label: cls().nameHeader, width: '11rem' },
    { key: 'address', label: '地址', width: '9.5rem' },
    { key: 'version', label: cls().versionHeader, width: '6.5rem' },
    { key: 'health', label: '观测健康', width: '7rem' },
    { key: 'collection', label: '采集状态', width: '8rem' },
    { key: 'lastSuccess', label: '最近成功采集', width: '8.5rem' },
    { key: 'actions', label: '操作', width: '16rem' },
  ];

  const stateNotice = ui.state === 'error'
    ? html`<div class="notice danger" role="alert">采集状态读取失败；健康与采集列显示“暂不可用”，不判定正常。</div>`
    : nothing;

  return html`<div class="content-inner">
    <div class="page-head">
      <div><h1>${cls().listTitle}</h1><p>${cls().listDesc}</p></div>
      <div class="actions">
        <button class="btn btn-refresh" @click=${() => showToast('已刷新（演示）', 'info')}>刷新</button>
        <button class="btn-primary" @click=${openAddDialog}>${cls().addLabel}</button>
      </div>
    </div>
    ${card('', html`
      <div class="toolbar">
        <div class="search"><span aria-hidden="true">⌕</span>
          <input id="list-search" type="search" placeholder="搜索名称、地址、版本、状态" aria-label=${`搜索${cls().listTitle}`}
            .value=${ui.search} @keydown=${onSearchKeydown}>
        </div>
        <div class="seg" role="group" aria-label="状态筛选">
          ${cls().filters.map(([label, key]) => html`<button class="btn" data-action="filter" data-filter=${key}
            aria-pressed=${String(ui.filter === key)} @click=${() => { ui.filter = key; update(); }}>${label}</button>`)}
        </div>
        <div class="toolbar-actions">
          <button class="btn" @click=${openColumnsDialog}>列设置</button>
          <button class="btn btn-ghost" @click=${() => { ui.filter = 'all'; ui.search = ''; update(); }}>重置筛选</button>
        </div>
      </div>
      <div class="toolbar-meta">
        <span>共 ${filteredRows().length} 个资源</span>
        <span>选择列为批量绑定工具列，不计入八列</span>
        <span>支持空格组合搜索</span>
      </div>
      ${stateNotice}
      <p class="scroll-hint" id="scroll-help">表格在容器内横向滚动；聚焦表格后可按左右方向键。主操作在容器内滚动后可达。</p>
      <div class="table-scroll list-table" role="region" tabindex="0" aria-label="资源表格，可横向滚动" aria-describedby="scroll-help">
        <app-data-table .columns=${columns} .rows=${ui.state === 'empty' ? [] : rows} dense
          .loading=${ui.state === 'loading'} .emptyMessage=${ui.state === 'empty' ? '没有符合条件的资源' : '暂无资源'}></app-data-table>
      </div>
      <div class="pager">
        <span>筛选结果 ${filteredRows().length} / ${RESOURCE_ROWS[ui.cls].length}</span>
        <button class="btn" disabled>上一页</button><span>第 1 页</span><button class="btn" disabled>下一页</button>
      </div>`)}
  </div>`;
}

function forbiddenList() {
  return html`<div class="content-inner">
    <div class="page-head"><div><h1>${cls().listTitle}</h1><p>${cls().listDesc}</p></div></div>
    ${card('', emptyState('无权读取该资源列表', `当前账号缺少 ${permLabel('view')}。列表不显示任何资源名称、地址、健康或采集状态；请联系资源管理员授权。`,
      html`<button class="btn" @click=${() => showToast('演示：权限不会在原型中变更', 'info')}>重新检查权限</button>`, 'lock', 'alert'))}
  </div>`;
}

/* ---------------- 详情外壳 ---------------- */

function forbiddenPage() {
  return html`<div class="content-inner" data-testid="detail-forbidden">
    ${card('', emptyState('无权读取该资源', `当前账号缺少 ${permLabel('view')}。页面不显示资源名称、地址、健康、调查或任何操作入口；也不显示缓存数据。`,
      html`<button class="btn" @click=${() => { ui.view = 'list'; ui.dialog = null; update(); }}>返回${cls().navLabel}</button>`, 'lock', 'alert'))}
  </div>`;
}

function moduleForbidden() {
  return card('', emptyState('无权读取该模块', `当前账号缺少读取「${tabLabel()}」所需的资源权限。页面身份与其它页签不受影响；该模块不显示旧数据或 0 值。`,
    html`<button class="btn" @click=${() => { ui.tab = cls().tabs[0][0]; update(); }}>返回概览</button>`, 'lock', 'alert'));
}

function detailView() {
  const row = selectedRow();
  if (ui.state === 'forbidden' || !canView()) return forbiddenPage();

  const tabs = cls().tabs.map(([key, label]) => {
    const count = key === 'topsql' && ui.cls === 'db' ? row.slowQueries : key === 'sessions' && ui.cls === 'db' ? row.sessions : 0;
    return html`<button class="tab" role="tab" id=${`tab-${key}`} aria-selected=${String(currentTab() === key)}
      tabindex=${currentTab() === key ? '0' : '-1'} aria-controls="tab-panel" data-tab=${key}
      @click=${() => goTab(key)}>${label}${count ? html`<span class="count">${count}</span>` : nothing}</button>`;
  });

  return html`<div class="content-inner">
    <div class="detail-header">
      <div class="detail-id">
        <button class="btn btn-ghost" data-action="back-list" @click=${backToList}>← 返回${cls().navLabel}</button>
        <div class="title-copy">
          <h1 class="detail-title" data-testid="detail-title" data-res-id=${row.id}>${displayName(row)}</h1>
          <div class="detail-meta" data-testid="detail-meta">${resourceMeta(row)}</div>
          <div class="detail-meta">观测于 ${row.observedAt} · 详情成功读取 ${row.readAt}（非资源观测）</div>
        </div>
        ${badge(row.healthLabel, row.healthVariant)}
      </div>
      <div class="detail-actions">${headerActions(row)}</div>
    </div>
    <div class="links-row" aria-label="资源联动" data-testid="resource-links">
      <span>关联调查${row.investigations.length ? ` · 最近 ${row.investigations.length} 项` : ''}</span>
      ${row.investigations.length
        ? html`<a href="#" @click=${(e) => { e.preventDefault(); showToast('演示：携带同资源上下文打开调查', 'info'); }}>${row.investigations[0]}</a>`
        : html`<span class="muted">暂无关联调查（缺失不代表没有调查）</span>`}
      <span class="sep" aria-hidden="true">|</span>
      <a href="#" @click=${(e) => { e.preventDefault(); showToast('演示：打开本资源全部调查', 'info'); }}>查看此资源的全部调查</a>
      <span class="sep" aria-hidden="true">|</span>
      <a href="#" @click=${(e) => { e.preventDefault(); showToast('拟建：事件中心按本资源过滤（P1）', 'info'); }}>事件（按本资源过滤）</a>
      <span class="sep" aria-hidden="true">|</span>
      <a href="#" @click=${(e) => { e.preventDefault(); showToast('拟建：审计中心按资源与时间过滤', 'info'); }}>操作审计</a>
    </div>
    <div class="tabs" role="tablist" aria-label=${`${cls().navLabel}详情页签`} data-tablist @keydown=${onTabKeydown}>${tabs}</div>
    <div id="tab-panel" role="tabpanel" aria-labelledby=${`tab-${currentTab()}`} tabindex="0">${tabPanel(row)}</div>
  </div>`;
}

function resourceMeta(row) {
  if (ui.cls === 'db') return `${row.dbType} · ${row.endpoint} · ${row.env}`;
  if (ui.cls === 'server') return `${row.os} · ${row.endpoint} · ${row.env}`;
  return `${row.vendor} · ${row.endpoint} · ${row.env}`;
}

function headerActions(row) {
  const extra = ui.cls === 'db'
    ? { label: '一键诊断', key: 'ai', run: () => openDiagnoseDialog(row) }
    : ui.cls === 'server'
      ? { label: '一键巡检', key: 'manage', run: () => showToast('演示：复用现有巡检报告入口', 'info') }
      : { label: '立即备份', key: 'backup', run: () => openBackupDialog(row) };
  const allowed = has(extra.key);
  return html`
    <button class="btn" data-action="extra" .disabled=${!allowed}
      title=${allowed ? extra.label : `需要 ${permLabel(extra.key)}`}
      @click=${allowed ? extra.run : undefined}>${extra.label}</button>
    <button class="btn" data-action="monitor-config" @click=${() => goTab('collection')}>监控配置</button>
    <button class="btn btn-refresh" @click=${() => showToast('已刷新（演示，不触发采集）', 'info')}>刷新</button>`;
}

function tabPanel(row) {
  if (ui.state === 'loading') return loadingCard();
  if (ui.state === 'module403') return moduleForbidden();
  if (ui.state === 'empty') return emptyCard(EMPTY_TEXT[currentTab()] ?? EMPTY_TEXT.overview);
  if (ui.state === 'error') return errorCard('读取失败，无法确认当前状态。');
  if (ui.state === 'partial') return partialCard(row);
  return CONTENT[ui.cls][currentTab()]?.(row) ?? emptyCard(EMPTY_TEXT[currentTab()] ?? EMPTY_TEXT.overview);
}

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
  related: '此服务器暂无已知的托管数据库实例关联。',
};

function loadingCard() {
  return card('', html`<div role="status" aria-label="正在读取">
    <div class="skeleton" style="height:18px;width:32%"></div>
    <div class="skeleton" style="height:12px;width:64%;margin-top:12px"></div>
    <div class="skeleton" style="height:12px;width:52%;margin-top:8px"></div>
    <div class="skeleton" style="height:120px;margin-top:16px"></div>
  </div>`);
}

function emptyCard(message) {
  return card('', emptyState('暂无可用数据', message,
    html`<button class="btn" @click=${() => showToast('演示：重新读取', 'info')}>重新读取</button>`, 'inbox'));
}

function errorCard(message) {
  return card('', emptyState('读取失败', `${message} 这不是空数据，也不代表资源正常。`,
    html`<button class="btn" @click=${() => showToast('演示：重试读取', 'info')}>重试</button>
      <button class="btn btn-ghost" @click=${backToList}>返回列表</button>`, 'alert-circle', 'alert'));
}

function partialCard(row) {
  const items = ui.cls === 'db'
    ? [['采集器 · 核心指标', '成功', 'ok'], ['采集器 · 慢查询', '失败 · 权限不足 (ER_TABLEACCESS_DENIED)', 'danger'], ['采集器 · 会话快照', '成功', 'ok'], ['采集器 · 容量', '不支持 · 当前版本未提供', 'muted'], ['采集器 · 配置快照', '待验证 · 尚未取得正式样本', 'warn']]
    : ui.cls === 'server'
      ? [['CPU / 内存', '成功', 'ok'], ['磁盘', '成功', 'ok'], ['网络接口', '部分失败 · 2 个接口无读取权限', 'warn'], ['进程 / 服务', '未采集', 'muted']]
      : [['接口状态', '成功', 'ok'], ['接口流量', '成功', 'ok'], ['设备温度', '模板未覆盖', 'muted'], ['SNMP 往返', '部分失败 · 2 次超时', 'warn']];
  return card('部分成功', html`
    <p class="muted">本页 ${items.filter((i) => i[2] === 'ok').length}/${items.length} 项成功。部分失败不能判定整体正常，缺失项不补 0。</p>
    <div class="list-rows">${items.map(([name, status, variant]) => html`<div class="row-item">
      <div><div class="name">${name}</div><div class="sub">当前页签：${tabLabel()} · ${row.name}</div></div>${badge(status, variant)}
    </div>`)}</div>
    <div class="actions" style="margin-top:12px">
      <button class="btn" @click=${() => showToast('演示：重试失败项', 'info')}>重试失败项</button>
      <button class="btn btn-ghost" @click=${() => showToast('演示：技术证据在同一页签折叠区', 'info')}>查看技术证据</button>
    </div>`);
}

/* ---------------- 共享内容块 ---------------- */

function attentionCard(row) {
  return card('当前需要关注', html`
    <div class="section">
      <h3>${row.alerts ? '存在需要核对的异常' : '当前没有已知未解决告警'}</h3>
      <p>${row.alerts ? `未解决告警 ${row.alerts} 项。` : '没有告警不代表资源健康；仍需核对证据缺口。'}状态只反映已有观测，不能代替完整健康判断。</p>
      <div class="actions">
        <button class="btn" @click=${() => goTab('metrics')}>核对指标与时间范围</button>
        <button class="btn" @click=${() => goTab(ui.cls === 'network' ? 'interfaces' : 'logs')}>查看日志与完整事件</button>
      </div>
    </div>
    <div class="section">
      <h3>证据缺口</h3>
      <p>${row.gap} 当前快照未报告全部缺口，不代表已覆盖所有信号。</p>
      <div class="actions"><button class="btn" @click=${() => goTab('collection')}>查看监控配置</button></div>
      <details class="disclosure"><summary>查看缺口原始标识</summary><p class="mono xs">OBSERVATIONS_STALE · ALERTS_TRUNCATED</p></details>
    </div>`);
}

function capabilityCard(row) {
  const rows = ui.cls === 'db'
    ? [['类型', `${row.dbType} ${row.version}`], ['环境', row.env], ['连接配置', '已启用（可用性需连接测试）'], ['连接地址', row.endpoint], ['数据库', row.database], ['观测时间', row.observedAt], ['观测时效', row.observedAt === '—' ? '无观测' : '新鲜']]
    : ui.cls === 'server'
      ? [['操作系统', row.os], ['连接状态（登记值）', row.health === '不可用' ? '离线（登记值）' : '在线'], ['最近状态检查', row.lastSuccess], ['SSH 端口', row.endpoint.split(':')[1]], ['认证方式', 'SSH 密钥（凭据引用）'], ['采集状态', row.collection], ['观测时间', row.observedAt]]
      : [['设备', row.endpoint], ['型号', row.version], ['厂商 / 版本', row.vendor], ['最近状态检查', row.lastSuccess], ['可用证据', '指标、接口、关联关系、配置备份'], ['观测时间', row.observedAt], ['观测时效', row.observedAt === '—' ? '无观测' : '新鲜']];
  return card(ui.cls === 'server' ? '服务器状态' : '资源与能力', html`<dl class="kv">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`);
}

function governanceCard(row) {
  return card('处理与治理（本资源）', html`
    <div class="notice warn small">
      <strong>拟建（P1）· 当前未接入。</strong> 有效触发器、事件与操作审计尚未接入本详情；不显示 0 项，也不代表没有事件。当前可用证据见上方缺口说明。
    </div>
    <div class="list-rows" style="margin-top:12px">
      <div class="row-item"><div><div class="name">有效触发器</div><div class="sub">依赖 P1 触发器与 #260 契约；未接入</div></div>${badge('未接入', 'muted')}<button class="btn-sm" @click=${() => goTab('collection')}>监控配置</button></div>
      <div class="row-item"><div><div class="name">最近事件</div><div class="sub">事件中心按本资源过滤；未接入</div></div>${badge('未接入', 'muted')}<button class="btn-sm" @click=${() => showToast('拟建：事件中心按本资源过滤', 'info')}>事件中心</button></div>
      <div class="row-item"><div><div class="name">操作审计</div><div class="sub">审计中心按资源与时间过滤；未接入</div></div>${badge('未接入', 'muted')}<button class="btn-sm" @click=${() => showToast('拟建：审计中心按资源过滤', 'info')}>查看审计</button></div>
    </div>
    <p class="muted xs" style="margin-top:8px">本资源：${row.name} · #${row.id}；跨模块链接将携带相同资源与时间窗。</p>`);
}

function relationsDisclosure(row) {
  return html`<details class="disclosure"><summary>资源关系与可信度（最多 2 跳 / 100 条边）</summary>
    <p class="small muted" style="margin-top:8px">缺失关系不代表不存在依赖；建议关系不作为已确认事实。</p>
    <div class="list-rows">
      <div class="row-item"><div><div class="name">${row.name} ↔ ${ui.cls === 'network' ? '主机 10.20.1.21（上行链路）' : 'sw-core-01（接入）'}</div><div class="sub">连接 · 来源：配置采集 · v3 · 有效期至 2026-12-31</div></div>${badge('已确认', 'ok')}</div>
      <div class="row-item"><div><div class="name">${row.name} ↔ ${ui.cls === 'network' ? 'fw-edge-01' : 'app-prod-01（托管）'}</div><div class="sub">依赖 · 来源：人工维护 · v1 · 未设截止时间</div></div>${badge('建议', 'warn')}</div>
    </div>
  </details>`;
}

/* ---------------- 监控配置（三类共用，可编辑） ---------------- */

function ensureConfig() {
  const row = selectedRow();
  if (!ui.config || ui.config.rowId !== row.id) {
    ui.config = {
      rowId: row.id,
      templateId: row.templateId,
      overrides: { ...row.overrides },
      editing: false,
      step: 0,
      compat: null,
      compatReason: '',
      trial: null,
      published: false,
      applied: false,
      dirty: false,
    };
  }
  return ui.config;
}

function effectiveParams(row) {
  const cfg = ensureConfig();
  if (!cfg.templateId) return [];
  const tpl = templateById(ui.cls, cfg.templateId);
  if (!tpl) return [];
  return tpl.params.map((p) => {
    const override = cfg.overrides[p.key];
    const final = override === undefined || override === '' ? p.def : override;
    return { ...p, override: override ?? '—', final, finalSource: override ? '本资源覆盖' : p.source };
  });
}

/* 试采样例：每项为 [采集项, 结果, 徽章变体, 说明]；试采不写正式历史。 */
const TRIAL_FIXTURES = {
  db: [
    ['核心指标', '成功', 'ok', '连接数、缓冲池命中率取得有效样本'],
    ['慢查询', '部分失败', 'warn', '权限不足 · ER_TABLEACCESS_DENIED'],
    ['会话快照', '成功', 'ok', '取得 42 个活跃会话'],
  ],
  server: [
    ['CPU / 内存', '成功', 'ok', '取得有效样本'],
    ['磁盘', '成功', 'ok', '/data 使用 71.3%'],
    ['网络速率', '待验证', 'muted', '逐接口速率依赖版本能力'],
  ],
  network: [
    ['接口状态', '成功', 'ok', '46/48 接口可用'],
    ['接口流量', '成功', 'ok', '取得标称容量'],
    ['设备温度', '模板未覆盖', 'muted', '当前模板不含温度指标'],
  ],
};

/* 兼容性规则（仅演示）：模板引擎族必须与资源引擎族一致；不一致时阻止试采与发布。 */
const ENGINE_FAMILIES = [
  [/postgresql/i, 'postgresql'],
  [/mysql/i, 'mysql'],
  [/dm8|达梦/i, 'dameng'],
  [/linux|kylin|centos|ubuntu|red ?hat/i, 'linux'],
  [/huawei/i, 'huawei'],
  [/cisco/i, 'cisco'],
];

function engineFamily(text) {
  const value = text ?? '';
  for (const [pattern, family] of ENGINE_FAMILIES) if (pattern.test(value)) return family;
  return 'unknown';
}

function resourceEngine(row) {
  const label = ui.cls === 'db' ? `${row.dbType} ${row.version}` : ui.cls === 'server' ? row.os : row.vendor;
  return { label, family: ui.cls === 'server' ? 'linux' : engineFamily(label) };
}

function compatResult(row) {
  const cfg = ensureConfig();
  const tpl = cfg.templateId ? templateById(ui.cls, cfg.templateId) : null;
  const resource = resourceEngine(row);
  if (!tpl) return { ok: false, detail: '未绑定模板', reason: '未绑定模板：无法执行兼容性检查' };
  const templateFamily = engineFamily(tpl.engine);
  if (templateFamily === 'unknown' || resource.family === 'unknown' || templateFamily !== resource.family) {
    return {
      ok: false,
      detail: `${resource.label} 与 ${tpl.name}（${tpl.engine}）不兼容`,
      reason: `模板 ${tpl.name} 面向 ${tpl.engine}，与 ${resource.label} 不兼容，不能绑定`,
    };
  }
  return { ok: true, detail: `${resource.label} 与 ${tpl.name}（${tpl.engine}）兼容` };
}

function resetFlow() {
  const cfg = ui.config;
  cfg.step = 0; cfg.compat = null; cfg.compatReason = '';
  cfg.trial = null; cfg.published = false; cfg.applied = false;
}

function markDirty(patch = {}) {
  const cfg = ensureConfig();
  Object.assign(cfg, patch);
  cfg.dirty = true;
  resetFlow();
  update();
}

function configContent(row) {
  const cfg = ensureConfig();
  const tpl = cfg.templateId ? templateById(ui.cls, cfg.templateId) : null;
  const params = effectiveParams(row);
  const editable = configAllowed();
  const manageReason = `需要 ${permLabel('manage')}`;

  const bindingCard = card('监控配置', html`
    <div class="facts">
      <div class="fact"><div class="label">当前模板</div><div class="value" data-testid="config-template-name">${tpl ? tpl.name : '未绑定模板'}</div><div class="sub">${tpl ? `${tpl.version} · ${tpl.digest} · 配置版本 ${cfg.published ? row.revision + 1 : row.revision}` : '未绑定不等于未采集，请以采集状态为准'}</div></div>
      <div class="fact"><div class="label">策略组 / 来源</div><div class="value" data-testid="config-group">${row.group ?? '—'}</div><div class="sub">来源：模板目录 · 本资源覆盖优先于策略组</div></div>
      <div class="fact"><div class="label">有效采集开关</div><div class="value">${row.collection === '已停用' ? '已停用' : '已启用'}</div><div class="sub">应用：${row.formal === 'failed' ? '应用失败' : row.formal === 'pending' ? '等待正式数据' : '成功'}</div></div>
      <div class="fact"><div class="label">最近正式样本</div><div class="value">${row.observedAt}</div><div class="sub">试采不替代正式数据</div></div>
    </div>
    <div class="actions" style="margin-top:12px">
      <button class="btn-primary" data-action="edit-config" .disabled=${!editable} title=${editable ? '修改模板与参数（复用 metric-configuration）' : manageReason}
        @click=${editable ? () => { cfg.editing = true; update(); } : undefined}>修改模板与参数</button>
      <button class="btn" data-action="trial" .disabled=${!editable} title=${editable ? '试采（必须先通过兼容性与权限检查，不绕过四步）' : manageReason} @click=${editable ? headerTrial : undefined}>试采</button>
      <button class="btn btn-refresh" @click=${() => showToast('演示：刷新采集状态', 'info')}>刷新采集状态</button>
    </div>
    ${editable ? nothing : html`<p class="notice info small" style="margin-top:12px" data-testid="config-readonly">只读：缺少 ${permLabel('manage')} 或资源范围不足；模板、参数、试采与发布均不可修改。</p>`}
    <p class="muted small" style="margin-top:8px">配置与只读证据使用同一来源（metric-configuration）；修改后需重新预检与试采，发布不代表全部指标可用。</p>`);

  const editor = cfg.editing ? card('修改模板与参数', html`
    <div class="config-editor" data-testid="config-editor">
      <div class="fields">
        <app-form-field label="监控模板" hint="同类资源可替换模板；不同资源类型不会继承其它类型的模板">
          <select class="field" data-testid="config-template" .value=${cfg.templateId ?? ''}
            @change=${(e) => markDirty({ templateId: e.target.value, overrides: {} })}>
            ${cfg.templateId ? nothing : html`<option value="">未绑定</option>`}
            ${TEMPLATES[ui.cls].map((t) => html`<option value=${t.id} ?selected=${cfg.templateId === t.id}>${t.name} ${t.version}</option>`)}
          </select>
        </app-form-field>
        ${params.map((p) => html`<app-form-field label=${p.label} hint=${p.source === '凭据引用' ? '只显示凭据引用，不展示秘密值' : `默认 ${p.def}`}>
          <input class="field" data-param=${p.key} data-testid=${`param-${p.key}`} .value=${cfg.overrides[p.key] ?? ''}
            placeholder=${p.def} @input=${(e) => { cfg.overrides = { ...cfg.overrides, [p.key]: e.target.value }; cfg.dirty = true; resetFlow(); update(); }}>
        </app-form-field>`)}
      </div>
      <div class="actions">
        <button class="btn" @click=${() => { cfg.editing = false; cfg.overrides = { ...row.overrides }; cfg.templateId = row.templateId; cfg.dirty = false; resetFlow(); update(); }}>放弃修改</button>
        <button class="btn" @click=${() => { cfg.editing = false; update(); }}>完成编辑（保留草稿）</button>
      </div>
      <p class="muted xs">草稿只在本页有效；发布前必须重新检查兼容性与权限并试采。生产环境离开页面会提示放弃未保存修改。</p>
    </div>`) : nothing;

  const paramRows = params.map((p) => ({
    name: p.label,
    def: p.def,
    override: p.override,
    final: html`<strong data-testid=${`final-${p.key}`}>${p.final}</strong>`,
    source: badge(p.finalSource, p.finalSource === '本资源覆盖' ? 'info' : 'muted'),
  }));

  const paramCard = card('有效参数', html`
    ${tpl ? table([
      { key: 'name', label: '参数' }, { key: 'def', label: '默认' }, { key: 'override', label: '本资源覆盖' },
      { key: 'final', label: '最终值' }, { key: 'source', label: '来源' },
    ], paramRows, { label: '有效参数表，可横向滚动', emptyMessage: '尚未绑定模板，没有有效参数' })
      : emptyState('尚未绑定监控模板', '未绑定不等于未采集；请先选择模板并完成检查、试采与发布。')}
    <p class="muted xs" style="margin-top:8px">秘密值只显示凭据引用，不在页面、日志或导出中出现。</p>`);

  return html`<div class="stack">
    ${bindingCard}
    ${editor}
    ${paramCard}
    ${flowCard(row)}
    ${triggerCard(row)}
    ${coverageCard(row)}
    ${configEventsCard(row)}
  </div>`;
}

function flowCard(row) {
  const cfg = ensureConfig();
  const editable = configAllowed();
  const manageReason = `需要 ${permLabel('manage')}`;
  const steps = [
    ['检查兼容性与权限', '不更改正式配置；确认资源类型、版本与凭据范围'],
    ['执行试采', '验证连接、权限与本次样本；不写正式历史'],
    ['发布并应用配置', '服务复核试采与配置版本后发布；应用结果需刷新确认'],
    ['等待正式采集', '试采成功不等于持续采集就绪；正式样本到达前不显示健康'],
  ];
  const trialSource = cfg.step >= 2 ? (cfg.trial ?? []) : cfg.compat === 'incompatible' ? TRIAL_FIXTURES[ui.cls] : null;
  const trialRows = (trialSource ?? []).map(([item, status, variant, detail]) => ({
    item: html`<span data-testid="trial-item">${item}</span>`,
    status: html`<span data-testid="trial-status">${badge(status, variant)}</span>`,
    detail: html`<span data-testid="trial-detail">${detail}</span>`,
  }));
  const trialFailed = (trialSource ?? []).filter(([, status]) => status !== '成功');
  const stepClass = (index) => {
    if (index < cfg.step) return 'done';
    if (index !== cfg.step) return '';
    return index === 0 && cfg.compat === 'incompatible' ? 'blocked' : 'current';
  };

  return card('检查并启用（复用 metric-configuration 四步）', html`
    <ol class="steps">${steps.map(([title, hint], i) => html`<li class=${stepClass(i)}>
      <span class="n">${i < cfg.step ? '✓' : i === 0 && cfg.compat === 'incompatible' ? '✕' : i + 1}</span><div><strong>${title}</strong><p>${hint}</p></div>
    </li>`)}</ol>
    <p class="muted small" style="margin-top:12px" data-testid="flow-state">${flowStateText(cfg)}</p>
    ${cfg.compat === 'compatible' ? html`<div class="notice info small" style="margin-top:12px" data-testid="compat-result">
      兼容性与权限：${cfg.compatReason} 影响预览：${trialImpact(row)}；只读凭据可用。检查不写正式配置。
    </div>` : cfg.compat === 'incompatible' ? html`<div class="notice danger small" style="margin-top:12px" data-testid="compat-result" role="alert">
      <strong>兼容性检查未通过，已阻止试采与发布。</strong> ${cfg.compatReason}；请改选与 ${resourceEngine(row).label} 兼容的模板后重新检查。
    </div>` : nothing}
    ${trialSource ? html`
      <p class="muted small" data-testid="trial-caption" style="margin-top:12px">${cfg.step >= 2
        ? '本次试采结果（不写正式历史）；部分失败或待验证项不能按全部成功处理。'
        : `最近一次试采结果（${templateById(ui.cls, row.templateId)?.name ?? '原模板'} · 模板已变更，已失效；仅作参考，不能作为发布依据）。`}</p>
      ${table([
        { key: 'item', label: '采集项' }, { key: 'status', label: '试采结果' }, { key: 'detail', label: '说明' },
      ], trialRows, { label: '试采结果表', emptyMessage: '本次试采未返回样本；不能发布', testId: 'trial-table' })}
      <p class="muted small" data-testid="trial-summary" style="margin-top:8px">${trialFailed.length
        ? `共 ${trialSource.length} 项，${trialSource.length - trialFailed.length} 项成功；未全部成功：${trialFailed.map(([item, status, , detail]) => `${item} · ${status}（${detail}）`).join('；')}。`
        : `共 ${trialSource.length} 项全部成功；仍需发布并由正式采集确认。`}</p>` : nothing}
    ${cfg.step >= 3 ? html`<div class="notice ${cfg.applied ? 'info' : 'warn'} small" style="margin-top:12px" data-testid="apply-state">
      ${cfg.applied ? '配置已应用；正式采集状态：等待首个正式样本（不代表已健康、不代表全部指标可用）。' : '已发布，应用状态：等待应用。发布成功不表示已开始正式采集。'}
    </div>` : nothing}
    <div class="actions" style="margin-top:12px">
      <button class="btn" data-action="check-compat" .disabled=${!editable || cfg.step > 0 || !cfg.templateId} title=${editable ? '检查兼容性与权限' : manageReason}
        @click=${editable ? runCompat : undefined}>检查兼容性与权限</button>
      <button class="btn" data-action="run-trial" .disabled=${!editable || cfg.step < 1 || cfg.step > 1} title=${editable ? '执行试采' : manageReason}
        @click=${editable ? runTrial : undefined}>执行试采</button>
      <button class="btn-primary" data-action="publish" .disabled=${!editable || cfg.step < 2 || cfg.step > 2} title=${editable ? '发布并应用配置' : manageReason}
        @click=${editable ? publishConfig : undefined}>发布并应用</button>
      <button class="btn" data-action="refresh-apply" .disabled=${!cfg.published} title=${cfg.published ? '刷新应用与正式数据状态' : '尚未发布'}
        @click=${cfg.published ? refreshApply : undefined}>刷新应用与正式数据状态</button>
    </div>`);
}

function flowStateText(cfg) {
  if (!cfg.templateId) return '未绑定模板：请先选择模板，再执行检查、试采与发布。';
  if (cfg.compat === 'incompatible') return `兼容性检查未通过：${cfg.compatReason}。已阻止试采与发布；请改选兼容模板后重新检查。`;
  if (cfg.step === 0) return cfg.dirty ? '草稿已修改：需要重新检查兼容性与权限，旧试采结果已失效。' : '未检查：检查只读取兼容性与影响，不写正式配置。';
  if (cfg.step === 1) return '兼容性与权限检查通过；尚未试采，未写正式历史。';
  if (cfg.step === 2) return '试采完成：不写正式历史；发布前请逐项核对结果。';
  if (cfg.step === 3 && !cfg.applied) return '已发布，等待应用；发布不等于全部指标可用。';
  return '已应用；正式采集等待首个正式样本，不代表已健康。';
}

function trialImpact(row) {
  return ui.cls === 'db' ? '本资源 1 个、每小时约 240 次请求' : ui.cls === 'server' ? '本资源 1 个、每小时约 240 次请求' : '本资源 1 个、每小时约 480 次 SNMP 轮询';
}

function runCompat() {
  const cfg = ensureConfig();
  const compat = compatResult(selectedRow());
  cfg.trial = null; cfg.published = false; cfg.applied = false;
  if (!compat.ok) {
    cfg.step = 0;
    cfg.compat = 'incompatible';
    cfg.compatReason = compat.reason;
    showToast(`兼容性检查未通过：${compat.reason}`, 'error');
    update();
    return false;
  }
  cfg.compat = 'compatible';
  cfg.compatReason = compat.detail;
  cfg.step = 1;
  showToast('演示：兼容性与权限检查通过，未写正式配置', 'info');
  update();
  return true;
}

function runTrial() {
  const cfg = ensureConfig();
  const compat = compatResult(selectedRow());
  if (!compat.ok || cfg.compat !== 'compatible' || cfg.step < 1) {
    showToast(`试采被阻止：${compat.ok ? '请先通过兼容性与权限检查' : compat.reason}`, 'warning');
    update();
    return false;
  }
  cfg.step = 2;
  cfg.trial = TRIAL_FIXTURES[ui.cls];
  showToast('演示：试采完成，未写正式历史', 'info');
  update();
  return true;
}

/* 页头入口不跳过前置检查：先检查兼容性与权限，再按结果决定是否试采。 */
function headerTrial() {
  const cfg = ensureConfig();
  if (!configAllowed()) return;
  const checked = cfg.compat === 'compatible' && cfg.step >= 1 ? true : runCompat();
  if (!checked) return;
  runTrial();
}

function publishConfig() {
  const cfg = ensureConfig();
  const compat = compatResult(selectedRow());
  if (!compat.ok || cfg.compat !== 'compatible' || cfg.step < 2) {
    showToast(`发布被拒绝：${compat.ok ? '请先完成试采' : compat.reason}`, 'warning');
    update();
    return false;
  }
  cfg.step = 3; cfg.published = true; cfg.applied = false; cfg.dirty = false;
  showToast('演示：配置已发布，等待应用确认', 'info');
  update();
  return true;
}

function refreshApply() {
  const cfg = ensureConfig();
  cfg.applied = true;
  showToast('演示：应用成功；正式采集等待首个正式样本', 'info');
  update();
}

function triggerCard(row) {
  return card('有效触发器（只读 · 拟建）', html`
    <div class="notice warn small" data-testid="trigger-unconnected">
      <strong>P1 未接入。</strong> 不显示触发器数量或“0 项”，也不代表没有触发器。接入后只读展示模板触发器、条件与来源，修改模板才会改变。
    </div>
    <details class="disclosure" style="margin-top:12px"><summary>未来只读示意（非现状，不会在生产显示）</summary>
      <p class="muted xs" style="margin-top:8px">演示样例：连接使用率过高 · avg(connection_usage) &gt; 85% (5m) · 来源 模板 ${row.templateId ? templateById(ui.cls, row.templateId)?.name ?? '' : '未绑定'}。P1 契约未放行前不得作为现状展示。</p>
    </details>`);
}

function coverageCard(row) {
  const items = ui.cls === 'db'
    ? [['连接数与上限', '已覆盖', 'ok'], ['慢查询', row.id === 7 ? '模板覆盖 · 采集失败' : '已覆盖', row.id === 7 ? 'danger' : 'ok'], ['复制延迟', '已覆盖', 'ok'], ['InnoDB 缓冲命中', '模板未覆盖', 'muted']]
    : ui.cls === 'server'
      ? [['CPU 使用率', '已覆盖', 'ok'], ['内存可用', '已覆盖', 'ok'], ['磁盘（挂载点）', '已覆盖', 'ok'], ['网络速率（逐接口）', '版本不支持', 'muted']]
      : [['接口运行状态', '已覆盖', 'ok'], ['接口速率', '标称容量', 'warn'], ['设备温度', '模板未覆盖', 'muted']];
  return card('指标覆盖与数据质量', html`<div class="list-rows">
    ${items.map(([name, state, variant]) => html`<div class="row-item">
      <div><div class="name">${name}</div><div class="sub">覆盖不等于正式样本就绪 · ${row.name}</div></div>${badge(state, variant)}
    </div>`)}
  </div>`);
}

function configEventsCard(row) {
  return card('最近配置事件（同资源）', html`
    <ol class="timeline">
      <li><time>2026-10-24 16:22</time><span>发布资源配置 · 版本 ${row.revision} · 操作者：ops-admin（凭据引用）· ${row.name}</span></li>
      <li><time>2026-10-24 16:19</time><span>试采成功 · 未写入正式历史 · 资源 #${row.id}</span></li>
    </ol>
    <details class="disclosure"><summary>技术证据与配置版本</summary>
      <p class="mono xs">published_revision=${row.revision} · binding.state=${row.templateId ? 'bound' : 'unbound'} · formal_visibility=${row.formal} · resource=${ui.cls}:${row.id}</p>
      <p class="muted xs">生产以服务端返回为准；本页为演示数据。</p>
    </details>`);
}

/* ---------------- 指标 / 专业页签 ---------------- */

function metricsContent(row) {
  const rows = ui.cls === 'db'
    ? [['连接使用率', row.id === 12 ? '82.4 %' : '41.2 %', row.id === 7 ? '有效' : '有效', row.observedAt, `${row.dbType} ${row.version}`], ['慢查询数', row.id === 7 ? '未取得' : `${row.slowQueries} 次/分`, row.id === 7 ? '部分失败 · 权限不足' : '有效', row.lastSuccess, 'slow_log'], ['复制延迟', '4 s', '有效', row.observedAt, 'replication'], ['缓冲池命中率', '97.1 %', '有效', row.observedAt, 'InnoDB']]
    : ui.cls === 'server'
      ? [['CPU 使用率', row.id === 14 ? '未取得' : '43.2 %', row.id === 14 ? '不可用 · SSH 认证失败' : '有效', row.lastSuccess, 'SSH · /proc/stat'], ['可用内存', '3.8 GiB', '有效', row.lastSuccess, 'SSH · /proc/meminfo'], ['磁盘使用（/data）', '71.3 %', '有效', row.lastSuccess, 'SSH · df'], ['网络接收速率', '未取得', '不可用 · 接口未注册', '—', '—']]
      : [['接口 up 数', '46 / 48', '有效', row.lastSuccess, 'SNMP ifOperStatus'], ['下行总流量', '182 Mbps', '标称容量', row.lastSuccess, 'SNMP ifSpeed（标称）'], ['设备温度', '未取得', '模板未覆盖', '—', '—']];
  const cells = rows.map(([name, value, quality, time, source]) => ({
    name, value: html`<span class="mono">${value}</span>`,
    quality: badge(quality, quality === '有效' ? 'ok' : quality.startsWith('部分') || quality.startsWith('不可用') ? 'danger' : 'muted'),
    time: html`<span class="mono xs">${time}</span>`, source: html`<span class="xs muted">${source}</span>`,
  }));
  return html`${card('指标与趋势', html`
    <div class="toolbar">
      <div class="seg" role="group" aria-label="时间窗">
        <button class="btn" aria-pressed="true">6h</button><button class="btn" aria-pressed="false">24h</button><button class="btn" aria-pressed="false">7d</button><button class="btn" aria-pressed="false">自定义</button>
      </div>
      <span class="muted small" style="margin-left:auto">时间窗：2026-10-26 05:42 至 11:42（UTC+8）· 资源 ${cls().navLabel} / #${row.id}</span>
    </div>
    ${table([{ key: 'name', label: '监控项' }, { key: 'value', label: '最近成功值' }, { key: 'quality', label: '质量' }, { key: 'time', label: '值时间' }, { key: 'source', label: '来源' }], cells, { label: '指标表，可横向滚动' })}`)}
    <div class="stack" style="margin-top:16px">
      ${card('趋势', html`
        <div class="chart" role="img" aria-label="演示趋势曲线：2026-10-26 05:42 至 11:42">
          <svg viewBox="0 0 640 150" preserveAspectRatio="none"><path d="M0 118 L60 112 L120 120 L180 104 L240 110 L300 96 L360 88 L420 70 L480 62 L540 40 L600 34 L640 30" fill="none" stroke="var(--accent)" stroke-width="2"/><path d="M0 118 L60 112 L120 120 L180 104 L240 110 L300 96 L360 88 L420 70 L480 62 L540 40 L600 34 L640 30 L640 150 L0 150 Z" fill="var(--accent-subtle)"/></svg>
        </div>
        <div class="chart-legend"><span><i class="swatch"></i>${row.name}</span><span>缺口区段不插值；降采样保留峰值</span></div>
        <p class="muted small" style="margin-top:8px">图形与数值表共享同一资源、监控项、维度与时间窗；24h 完整时槽为 P1 目标。</p>`)}
    </div>`;
}

function healthTab(row) {
  return html`${card('健康评分', html`<div class="facts">
    <div class="fact"><div class="label">当前评分</div><div class="value">${row.score ?? '—'}</div><div class="sub">${row.score == null ? '证据不足' : `资源 #${row.id} · 较昨日 -8`}</div></div>
    <div class="fact"><div class="label">有效观测天数</div><div class="value">${row.score == null ? '—' : '14 天'}</div><div class="sub">覆盖不足 90% 的日期不计入</div></div>
    <div class="fact"><div class="label">上次检查</div><div class="value">${row.lastSuccess}</div><div class="sub">评分不代替业务可用性判断</div></div>
  </div>`)}
  <div class="stack" style="margin-top:16px">${card('评分历史（最近 7 天）', table([
    { key: 'date', label: '日期' }, { key: 'score', label: '评分' }, { key: 'reason', label: '主要扣分项' }, { key: 'quality', label: '证据完整性' },
  ], [
    { date: '2026-10-26', score: row.score ?? '—', reason: row.alerts ? '连接使用率、慢查询' : '—', quality: badge(row.alerts ? '部分' : '完整', row.alerts ? 'warn' : 'ok') },
    { date: '2026-10-25', score: row.score == null ? '—' : 70, reason: '连接使用率', quality: badge('完整', 'ok') },
    { date: '2026-10-24', score: row.score == null ? '—' : 88, reason: '—', quality: badge('完整', 'ok') },
  ], { label: '评分历史表，可横向滚动' }))}</div>`;
}

function topsqlTab(row) {
  return card('慢查询列表', html`
    <p class="muted small">来源：${row.dbType} performance_schema · 资源 #${row.id} · 读取时间 ${row.readAt}（非最近采集时间）</p>
    ${row.slowQueries === 0 ? emptyState('本次未返回慢查询记录', '空结果不能确认采集是否完整。') : table([
      { key: 'sql', label: 'SQL 语句' }, { key: 'avg', label: '平均耗时' }, { key: 'max', label: '最大耗时' }, { key: 'count', label: '执行次数' }, { key: 'last', label: '最后出现' },
    ], [
      { sql: html`<span class="mono cell-truncate" title="SELECT o.id">SELECT o.id, o.status FROM orders o…</span>`, avg: '1820.40 ms', max: '4210.10 ms', count: '1,204', last: '11:38' },
      { sql: html`<span class="mono cell-truncate" title="UPDATE order_items">UPDATE order_items SET state=?</span>`, avg: '240.80 ms', max: '980.22 ms', count: '18,442', last: '11:40' },
    ], { label: '慢查询表，可横向滚动' })}
    <p class="muted xs" style="margin-top:8px">读取失败或权限不足时显示明确状态，不把空结果显示为“无慢查询”。</p>`);
}

function sessionsTab(row) {
  return card(`活跃会话（${row.sessions}）`, html`
    <p class="muted small">来源：${row.dbType} PROCESSLIST · 本次读取快照（最多 50 条）· 读取时间 ${row.readAt} · 资源 #${row.id}</p>
    ${row.sessions === 0 ? emptyState('本次快照未返回活跃会话', '不代表数据库健康。') : table([
      { key: 'id', label: 'ID' }, { key: 'user', label: '用户' }, { key: 'source', label: '来源' }, { key: 'db', label: '数据库' }, { key: 'cmd', label: '命令' }, { key: 'time', label: '时间' }, { key: 'query', label: '当前查询' },
    ], [
      { id: '1042', user: 'order_app', source: '10.20.1.31', db: row.database, cmd: 'Query', time: '128s', query: html`<span class="mono cell-truncate" title="SELECT ... FOR UPDATE">SELECT … FOR UPDATE</span>` },
      { id: '1043', user: 'order_app', source: '10.20.1.32', db: row.database, cmd: 'Sleep', time: '2s', query: '—' },
    ], { label: '会话表，可横向滚动' })}`);
}

function capacityTab(row) {
  return html`${card('容量读取结果', html`
    <p class="muted small">来源：数据库容量接口 · 资源 ${row.name} / #${row.id} · 观测 ${row.observedAt} · 范围：仅统计在线表。历史趋势为独立采样。</p>
    ${table([{ key: 'obj', label: '对象' }, { key: 'size', label: '大小' }, { key: 'tables', label: '表数 / 行数' }], [
      { obj: row.database, size: '820.40 GB', tables: '184 张表' },
      { obj: 'order_archive', size: '412.10 GB', tables: '62 张表' },
    ], { label: '容量表，可横向滚动' })}`)}
  <div class="stack" style="margin-top:16px">${card('历史容量采样（过去 7 天，非当前读取）', html`
    <div class="chart" role="img" aria-label="演示容量曲线"><svg viewBox="0 0 640 150" preserveAspectRatio="none"><path d="M0 120 L90 116 L180 110 L270 102 L360 96 L450 88 L540 80 L640 74" fill="none" stroke="var(--accent)" stroke-width="2"/></svg></div>
    <div class="chart-legend"><span><i class="swatch"></i>总容量 (GB)</span></div>`)}</div>`;
}

function schemaTab(row) {
  return card('表结构快照', html`
    <div class="facts">
      <div class="fact"><div class="label">最近快照</div><div class="value">2026-10-26 09:00</div><div class="sub">快照 id 8821 · 资源 #${row.id}</div></div>
      <div class="fact"><div class="label">最近变更</div><div class="value">3 项</div><div class="sub">新增 2 · 修改 1</div></div>
      <div class="fact"><div class="label">采集权限</div><div class="value">可读取</div><div class="sub">information_schema 只读</div></div>
    </div>
    <div class="actions" style="margin-top:12px"><button class="btn" @click=${() => showToast('演示：采集表结构快照', 'info')}>采集表结构快照</button></div>
    ${table([{ key: 'table', label: '表' }, { key: 'engine', label: '引擎' }, { key: 'rows', label: '行数（估算）' }, { key: 'change', label: '变更' }], [
      { table: html`<span class="mono">orders</span>`, engine: 'InnoDB', rows: '42,190,884', change: badge('新增列', 'info') },
      { table: html`<span class="mono">order_items</span>`, engine: 'InnoDB', rows: '842,190,441', change: '—' },
    ], { label: '表结构表，可横向滚动' })}`);
}

function indexesTab() {
  return card('索引建议', html`
    <p class="muted small">建议需人工确认；检测结果不代表已创建索引。</p>
    ${table([{ key: 'table', label: '表' }, { key: 'suggest', label: '建议' }, { key: 'gain', label: '预期收益' }, { key: 'risk', label: '风险' }, { key: 'op', label: '操作' }], [
      { table: 'orders', suggest: '(created_at, status)', gain: '降低范围扫描', risk: badge('写放大', 'warn'), op: html`<button class="btn-sm" @click=${() => showToast('演示：查看索引建议', 'info')}>查看详情</button>` },
      { table: 'order_items', suggest: '(order_id)', gain: '覆盖已存在，建议删除重复索引', risk: badge('低', 'ok'), op: html`<button class="btn-sm" @click=${() => showToast('演示：查看索引建议', 'info')}>查看详情</button>` },
    ], { label: '索引建议表，可横向滚动' })}
    <div class="actions" style="margin-top:12px"><button class="btn" @click=${() => showToast('演示：重新检测索引', 'info')}>重新检测索引</button></div>`);
}

function sqlauditTab() {
  return card('SQL 审核', html`
    ${table([{ key: 'time', label: '提交时间' }, { key: 'sql', label: 'SQL 摘要' }, { key: 'risk', label: '风险' }, { key: 'status', label: '状态' }, { key: 'op', label: '操作' }], [
      { time: '2026-10-26 10:12', sql: html`<span class="mono">ALTER TABLE orders ADD COLUMN …</span>`, risk: badge('高', 'danger'), status: badge('待人工确认', 'warn'), op: html`<button class="btn-sm" @click=${() => showToast('演示：查看审核记录', 'info')}>查看</button>` },
      { time: '2026-10-25 18:40', sql: html`<span class="mono">CREATE INDEX idx_order_created …</span>`, risk: badge('中', 'warn'), status: badge('已完成', 'ok'), op: html`<button class="btn-sm" @click=${() => showToast('演示：查看审核记录', 'info')}>查看</button>` },
    ], { label: 'SQL 审核表，可横向滚动' })}
    <div class="actions" style="margin-top:12px"><button class="btn-primary" @click=${() => showToast('演示：发起 SQL 审核', 'info')}>发起 SQL 审核</button></div>
    <p class="muted xs" style="margin-top:8px">审核结论不自动执行；执行按现有审批与权限。</p>`);
}

function logsTab(row) {
  return card('日志', html`
    <div class="toolbar">
      <select class="filter" aria-label="日志级别"><option>全部级别</option><option>ERROR</option><option>WARN</option></select>
      <select class="filter" aria-label="时间范围"><option>最近 1 小时</option><option>最近 24 小时</option></select>
      <button class="btn" @click=${() => showToast('演示：查询日志', 'info')}>查询</button>
    </div>
    ${table([{ key: 'time', label: '时间' }, { key: 'level', label: '级别' }, { key: 'content', label: '内容' }], [
      { time: '11:38:12', level: badge('ERROR', 'danger'), content: 'Deadlock found when trying to get lock; try restarting transaction' },
      { time: '11:20:03', level: badge('WARN', 'warn'), content: `Aborted connection to '${row.name}' (Got timeout reading communication packets)` },
    ], { label: '日志表，可横向滚动' })}
    <p class="muted xs" style="margin-top:8px">日志缺失不代表没有故障；日志仅来自本资源。</p>`);
}

function qanTab(row) {
  return card('查询分析', html`
    ${table([{ key: 'sql', label: 'SQL 摘要' }, { key: 'total', label: '总耗时' }, { key: 'avg', label: '平均耗时' }, { key: 'count', label: '执行次数' }, { key: 'last', label: '最后出现' }], [
      { sql: html`<span class="mono">SELECT … FROM orders WHERE created_at &gt; ?</span>`, total: '2,192 s', avg: '1.82 s', count: '1,204', last: '11:38' },
    ], { label: '查询分析表，可横向滚动' })}
    <p class="muted xs" style="margin-top:8px">资源 ${row.name} / #${row.id} · limit 50。</p>`);
}

function diagnosisTab(row) {
  return card('AI 诊断', html`
    <p class="muted small">诊断是证据汇总与建议，不自动执行变更，也不自动宣告恢复。资源 #${row.id}。</p>
    <div class="actions" style="margin:12px 0">
      <button class="btn-primary" .disabled=${!has('ai')} title=${has('ai') ? '一键诊断' : `需要 ${permLabel('ai')}`} @click=${has('ai') ? () => openDiagnoseDialog(row) : undefined}>一键诊断</button>
      <button class="btn" @click=${() => showToast('演示：在对话中继续分析', 'info')}>在对话中继续分析</button>
    </div>
    <ol class="timeline">
      <li><time>2026-10-26 10:58</time><span>${badge('已完成', 'ok')} 连接使用率持续高于阈值；建议核对连接池上限与空闲连接回收。</span></li>
      <li><time>2026-10-25 16:20</time><span>${badge('结果未知', 'danger')} 模型调用超时，事实证据仍可查看。</span></li>
    </ol>`);
}

/* ---------------- 服务器专业页签 ---------------- */

function serverConfigTab(row) {
  return card('服务器配置', html`
    <div class="subgrid">
      <dl class="kv"><dt>主机地址</dt><dd>${row.endpoint.split(':')[0]}</dd><dt>SSH 端口</dt><dd>${row.endpoint.split(':')[1]}</dd><dt>标签</dt><dd>${row.env} · 应用节点</dd><dt>操作系统</dt><dd>${row.os}</dd></dl>
      <dl class="kv"><dt>认证方式</dt><dd>SSH 密钥（凭据引用）</dd><dt>采集状态</dt><dd>${row.collection}</dd><dt>最近状态检查</dt><dd>${row.lastSuccess}</dd><dt>最近失败尝试</dt><dd>2026-10-25 03:12 · 连接超时</dd></dl>
    </div>
    <p class="muted small" style="margin-top:12px">编辑在列表编辑入口或监控配置页签进行；配置页签只读，避免两处维护同一配置。</p>`);
}

function diagnosticsTab(row, section = 'all') {
  const rows = [
    { section: '系统负载', status: badge('成功', 'ok'), summary: 'load average 2.14 / 1.98 / 1.71；CPU 43.2%' },
    { section: '内存', status: badge('成功', 'ok'), summary: '可用 3.8 GiB；swap 使用 0' },
    { section: '磁盘', status: badge('成功', 'ok'), summary: '/data 使用 71.3%' },
    { section: '网络', status: badge('部分失败', 'warn'), summary: '2 个接口读取失败（无权限读取 eth1 统计）' },
    { section: '进程 / 服务', status: badge('待验证', 'muted'), summary: '未采集' },
  ];
  const filtered = section === 'all' ? rows : rows.filter((r) => r.section.includes(section));
  const title = section === 'all' ? '服务器诊断证据' : `${section}证据`;
  return card(title, html`
    <div class="notice info" role="status">本次诊断证据 · 资源 ${row.name} / #${row.id} · 采集于 2026-10-26 11:20 · 来源 SSH · 快照不随页签切换更新</div>
    ${table([{ key: 'section', label: '分区' }, { key: 'status', label: '采集结果' }, { key: 'summary', label: '摘要' }], filtered, { label: '诊断证据表，可横向滚动' })}
    <div class="actions" style="margin-top:12px">
      <button class="btn" @click=${() => showToast('演示：诊断证据采集已提交（需要 servers:manage）', 'info')}>重新采集诊断证据</button>
      <button class="btn btn-ghost" @click=${() => showToast('演示：技术证据在同一页签折叠区', 'info')}>查看技术证据</button>
    </div>`);
}

function serverNetworkTab(row) {
  return card('网络证据', html`
    <div class="notice info">本次诊断证据 · 资源 ${row.name} · 采集于 2026-10-26 11:20 · 来源 SSH · 分区快照，不随页签切换更新</div>
    ${table([{ key: 'iface', label: '接口' }, { key: 'status', label: '状态' }, { key: 'rx', label: '接收' }, { key: 'tx', label: '发送' }], [
      { iface: 'eth0', status: badge('up', 'ok'), rx: '182.4 Mbps', tx: '96.1 Mbps' },
      { iface: 'eth1', status: badge('读取失败', 'danger'), rx: '—', tx: '—' },
    ], { label: '网络证据表，可横向滚动' })}
    <div class="actions" style="margin-top:12px"><button class="btn" disabled title="请在诊断页签采集，避免重复采集">去诊断页签采集</button></div>`);
}

function serverEvidenceTab(row, section, text) {
  return card(text, html`
    <div class="notice info">尚未取得${section}证据 · 页面切换和刷新不会自动采集 · 资源 ${row.name}</div>
    <p class="muted small" style="margin-top:12px">需在诊断页签采集后查看；未采集时显示此提示，不显示 0 个。</p>
    <div class="actions"><button class="btn" disabled title="请在诊断页签采集，避免重复采集">去诊断页签采集</button></div>`);
}

function hostedInstances(row) {
  if (!row.hosted.length) return emptyState('此服务器暂无已知的托管数据库实例', '缺失关系不能推断无依赖。');
  return html`<div class="list-rows">${row.hosted.map((name) => {
    const instance = RESOURCE_ROWS.db.find((r) => r.name === name);
    return html`<div class="row-item">
      <div><div class="name">${name}</div><div class="sub">${instance ? `${instance.dbType} · ${instance.env} · ${instance.health}` : '未知'}</div></div>
      ${badge(instance && instance.health === '健康' ? 'healthy' : 'warning', instance && instance.health === '健康' ? 'ok' : 'warn')}
      <button class="btn-sm" aria-label=${`查看 ${name} 详情`} @click=${instance ? () => { ui.cls = 'db'; ui.id = instance.id; ui.view = 'detail'; ui.tab = 'overview'; ui.config = null; update(); } : undefined}>›</button>
    </div>`;
  })}</div>`;
}

/* ---------------- 网络设备专业页签 ---------------- */

function interfacesTab(row) {
  return card('网络接口', html`
    <div class="toolbar">
      <div class="search"><input type="search" aria-label="接口名称或别名" placeholder="名称或别名"></div>
      <select class="filter" aria-label="运行状态"><option>全部状态</option><option>已启用</option><option>已停用</option><option>下层链路中断</option></select>
      <button class="btn btn-refresh" @click=${() => showToast('演示：刷新接口', 'info')}>刷新接口</button>
    </div>
    <p class="muted small">显示 46 / 48 个已保存接口 · 资源 ${row.name}。速率为接口标称容量，不代表实测流量；最后发现时间不代表当前在线。</p>
    ${table([{ key: 'iface', label: '接口 / 别名' }, { key: 'status', label: '管理 / 运行状态' }, { key: 'speed', label: '标称容量' }, { key: 'found', label: '最后发现' }], [
      { iface: html`<div><strong>GE0/0/1</strong><span class="cell-sub">上行核心 · #1</span></div>`, status: '已启用 / 已启用', speed: '1 Gbit/s', found: '2026-10-26 11:40' },
      { iface: html`<div><strong>GE0/0/24</strong><span class="cell-sub">订单库接入 · #24</span></div>`, status: '已启用 / 下层链路中断', speed: '1 Gbit/s', found: '2026-10-26 11:40' },
    ], { label: '接口表，可横向滚动' })}`);
}

function networkRelationsTab(row) {
  return html`${card('关联资源（2）', table([
    { key: 'source', label: '源资源' }, { key: 'target', label: '目标资源' }, { key: 'relation', label: '关系' }, { key: 'origin', label: '来源' }, { key: 'until', label: '有效期至' },
  ], [
    { source: `网络设备 #${row.id}`, target: '服务器 #21', relation: '连接', origin: '配置采集', until: '2026-12-31' },
    { source: `网络设备 #${row.id}`, target: '网络设备 #28', relation: '依赖', origin: '人工维护', until: '当前有效' },
  ], { label: '关联资源表，可横向滚动' }))}
  <div class="stack" style="margin-top:16px">${card('资源关系', relationsDisclosure(row))}</div>`;
}

function backupsTab(row) {
  const canWrite = has('backup');
  const canRead = has('view');
  return html`${card('每日定时备份', html`
    <p class="muted small">默认每天 00:00（北京时间）执行。服务恢复时补做当天到期任务；当天已执行过则不重复。资源 #${row.id}。</p>
    ${row.hasSsh ? nothing : html`<div class="notice warn small" style="margin-top:8px">尚未配置 SSH 凭据，自动备份暂不执行。请先编辑网络设备，配置 SSH 凭据。</div>`}
    <form onsubmit="return false" style="display:flex;gap:16px;align-items:end;flex-wrap:wrap;margin-top:12px">
      <app-form-field label="自动备份" .inline=${true}><input type="checkbox" aria-label="启用每日定时备份" .checked=${row.hasSsh} .disabled=${!canWrite}></app-form-field>
      <app-form-field label="每日执行时间" hint="北京时间（UTC+8）" .required=${true}><input type="time" value="00:00" aria-label="每日执行时间" .disabled=${!canWrite}></app-form-field>
      <button class="btn-primary" type="button" .disabled=${!canWrite} title=${canWrite ? '保存定时设置' : `需要 ${permLabel('backup')}`}
        @click=${canWrite ? () => showToast('演示：定时备份设置已保存', 'info') : undefined}>保存定时设置</button>
    </form>
    <p class="muted xs" style="margin-top:8px">最近自动备份：${row.backups ? '2026-10-26 00:00 · 成功' : '无记录'}。读写权限不同：读取需要 ${permLabel('view')}，保存与立即备份需要 ${permLabel('backup')}。</p>`)}
  <div class="stack" style="margin-top:16px">${card('加密配置备份', html`
    <p class="muted small">备份内容加密保存，预览已脱敏。SHA-256 用于校验，不展示明文配置。</p>
    ${!canRead ? emptyState('无权读取配置备份', `当前账号缺少 ${permLabel('view')}；不显示旧备份内容。`)
      : row.backups === 0 ? emptyState('尚无配置备份', '配置 SSH 凭据后可定时备份，也可点击页头“立即备份”。')
        : table([{ key: 'version', label: '版本' }, { key: 'time', label: '备份时间' }, { key: 'size', label: '大小' }, { key: 'hash', label: 'SHA-256' }, { key: 'redaction', label: '脱敏状态' }, { key: 'op', label: '操作' }], [
          { version: 'v12', time: '2026-10-26 00:00', size: '184.2 KB', hash: '9f2c8a41d7e0…', redaction: badge('已脱敏', 'ok'), op: html`<button class="btn-sm" @click=${() => openBackupSummary(row)}>查看摘要</button>` },
          { version: 'v11', time: '2026-10-25 00:00', size: '183.9 KB', hash: '4a71c0d3b1f2…', redaction: badge('已脱敏', 'ok'), op: html`<button class="btn-sm" @click=${() => openBackupSummary(row)}>查看摘要</button>` },
        ], { label: '配置备份表，可横向滚动' })}`)}</div>`;
}

/* ---------------- 三类页签内容 ---------------- */

const CONTENT = {
  db: {
    overview: (row) => html`<div class="grid-2">${attentionCard(row)}${capabilityCard(row)}</div>
      <div class="stack" style="margin-top:16px">${governanceCard(row)}${card('资源关系', relationsDisclosure(row))}</div>`,
    collection: (row) => configContent(row),
    metrics: (row) => metricsContent(row),
    health: (row) => healthTab(row),
    topsql: (row) => topsqlTab(row),
    sessions: (row) => sessionsTab(row),
    capacity: (row) => capacityTab(row),
    schema: (row) => schemaTab(row),
    indexes: () => indexesTab(),
    sqlaudit: () => sqlauditTab(),
    logs: (row) => logsTab(row),
    qan: (row) => qanTab(row),
    diagnosis: (row) => diagnosisTab(row),
  },
  server: {
    overview: (row) => html`<div class="grid-2">${attentionCard(row)}${capabilityCard(row)}</div>
      <div class="stack" style="margin-top:16px">${governanceCard(row)}${card('托管数据库实例', hostedInstances(row))}${card('资源关系', relationsDisclosure(row))}</div>`,
    collection: (row) => configContent(row),
    metrics: (row) => metricsContent(row),
    config: (row) => serverConfigTab(row),
    diagnostics: (row) => diagnosticsTab(row),
    network: (row) => serverNetworkTab(row),
    processes: (row) => serverEvidenceTab(row, '进程', '进程证据'),
    services: (row) => serverEvidenceTab(row, '服务', '服务证据'),
    logs: (row) => serverEvidenceTab(row, '日志', '系统日志'),
    related: (row) => card('关联资源', html`
      <p class="muted small">关联资源 = 托管数据库实例 + 关系摘要；不重复第二套列表。</p>
      ${hostedInstances(row)}${relationsDisclosure(row)}`),
  },
  network: {
    overview: (row) => html`<div class="grid-2">${attentionCard(row)}${capabilityCard(row)}</div>
      <div class="stack" style="margin-top:16px">${governanceCard(row)}${card('资源关系', relationsDisclosure(row))}</div>`,
    metrics: (row) => metricsContent(row),
    interfaces: (row) => interfacesTab(row),
    relations: (row) => networkRelationsTab(row),
    backups: (row) => backupsTab(row),
    collection: (row) => configContent(row),
  },
};

/* ---------------- 交互 ---------------- */

function openDetail(row) {
  const scroll = document.querySelector('.table-scroll.list-table');
  ui.listContext = {
    cls: ui.cls,
    filter: ui.filter,
    search: ui.search,
    scrollTop: scroll?.scrollTop ?? 0,
    scrollLeft: scroll?.scrollLeft ?? 0,
    focusId: row.id,
  };
  ui.id = row.id;
  ui.view = 'detail';
  ui.tab = 'overview';
  ui.config = null;
  update();
}

function backToList() {
  const context = ui.listContext;
  ui.view = 'list';
  ui.dialog = null;
  if (context && context.cls === ui.cls) { ui.filter = context.filter; ui.search = context.search; }
  update();
  if (context?.cls === ui.cls) restoreListContext(context);
}

/* 共享表格异步渲染：等行出现后再恢复横向位置与来源按钮焦点。 */
function restoreListContext(context) {
  let attempts = 0;
  const run = () => {
    const scroll = document.querySelector('.table-scroll.list-table');
    if (scroll) { scroll.scrollTop = context.scrollTop; scroll.scrollLeft = context.scrollLeft; }
    const trigger = document.querySelector(`.actions [data-action="open-detail"][data-id="${context.focusId}"]`);
    if (trigger) { trigger.focus({ preventScroll: true }); return; }
    if (attempts++ < 25) setTimeout(run, 30);
  };
  // 不用 requestAnimationFrame：无头评审环境可能不调度帧回调。
  setTimeout(run, 0);
}

function goTab(key) {
  ui.tab = key;
  update();
  requestAnimationFrame(() => document.getElementById(`tab-${currentTab()}`)?.focus());
}

function onTabKeydown(event) {
  if (!event.target.closest('[data-tablist]') && !event.target.classList.contains('tab')) return;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const keys = cls().tabs.map(([key]) => key);
  const index = keys.indexOf(currentTab());
  const next = event.key === 'Home' ? keys[0]
    : event.key === 'End' ? keys[keys.length - 1]
      : event.key === 'ArrowRight' ? keys[(index + 1) % keys.length] : keys[(index - 1 + keys.length) % keys.length];
  goTab(next);
}

function onSearchKeydown(event) {
  if (event.key === 'Enter') { ui.search = event.target.value; update(); }
  if (event.key === 'Escape') { ui.search = ''; event.target.value = ''; update(); }
}

function onRowAction(action, row, event) {
  event?.stopPropagation?.();
  if (action === 'open-detail') { openDetail(row); return; }
  if (action === 'edit') { openEditDialog(row); return; }
  if (action === 'test') { openTestDialog(row); return; }
  if (action === 'delete') { openDeleteDialog(row); return; }
}

function openDialog(title, body, footer, size = 'md') {
  ui.dialog = { title, body, footer, size };
  update();
}
function closeDialog() {
  ui.dialog = null;
  update();
}

function openAddDialog() {
  openDialog(`添加${cls().navLabel}`, html`
    <p>复用现有资源编辑与“监控与采集”页签：先保存连接，再绑定模板、试采与启用。</p>
    <div class="notice info small">编辑能力不在本次详情设计范围内改动；本弹窗只示意入口保留。</div>`,
  html`<button class="btn" @click=${closeDialog}>取消</button><button class="btn-primary" @click=${() => { closeDialog(); showToast('演示：进入现有资源编辑器', 'info'); }}>进入编辑器（演示）</button>`);
}

function openEditDialog(row) {
  openDialog(`编辑资源 · ${row.name}`, html`
    <p>打开现有资源编辑器，页签：<strong>基本信息</strong> / <strong>监控与采集</strong>。</p>
    <div class="notice info small">编辑按实际权限门控：${ui.cls === 'db' ? `${permLabel('update')} + 资源读写范围` : permLabel('manage')}；本原型不保存任何修改。</div>`,
  html`<button class="btn" @click=${closeDialog}>取消</button><button class="btn-primary" @click=${() => { closeDialog(); showToast('演示：进入编辑（不写数据）', 'info'); }}>进入编辑（演示）</button>`);
}

function openTestDialog(row) {
  openDialog(`测试连接 · ${row.name}`, html`
    <p class="muted small">测试只验证网络连通与认证，不等同于指标测试成功；失败不会修改现有采集配置。</p>
    <app-form-field label=${ui.cls === 'db' ? '登录密码（仅本次测试，不保存）' : '凭据引用'}>
      <input class="field" type=${ui.cls === 'db' ? 'password' : 'text'} value=${ui.cls === 'db' ? '' : 'cred://configured'} aria-label="测试凭据" autocomplete="off">
    </app-form-field>
    <div class="notice info small">凭据不写入页面、日志或导出。</div>`,
  html`<button class="btn" @click=${closeDialog}>取消</button><button class="btn-primary" @click=${() => { closeDialog(); showToast('演示结果：连接成功；指标可用性需试采确认', 'info'); }}>测试连接</button>`);
}

function openDeleteDialog(row) {
  openDialog('确认删除？', html`
    <p>将删除资源 ${row.name} 及其采集绑定。历史数据保留策略按现有规则执行，此操作不可撤销。</p>
    <div class="notice warn small">需要 ${permLabel(cls().deleteKey)} 与资源范围；演示环境不执行删除。</div>`,
  html`<button class="btn" @click=${closeDialog}>取消</button><button class="btn-primary btn-danger" @click=${() => { closeDialog(); showToast('演示：已取消删除（原型不执行写操作）', 'info'); }}>确认删除</button>`);
}

function openColumnsDialog() {
  openDialog('列设置', html`
    <p class="muted small">八个业务列始终显示。可增加指标列；“数据量”等能力移入可选列，不再挤占常驻八列。</p>
    <label><input type="checkbox" checked> 数据库大小 / 数据量（可选）</label>
    <label><input type="checkbox"> 运行时长</label>
    <label><input type="checkbox"> 模板绑定（可选）</label>`,
  html`<button class="btn" @click=${closeDialog}>恢复默认</button><button class="btn-primary" @click=${closeDialog}>完成</button>`);
}

function openBackupDialog(row) {
  if (!has('backup')) return;
  openDialog('立即备份', html`
    <p>将对 ${row.name} 执行一次配置备份；需要 ${permLabel('backup')}，并写入审计记录。</p>
    <div class="notice warn small">演示环境不执行备份，也不写入审计。</div>`,
  html`<button class="btn" @click=${closeDialog}>取消</button><button class="btn-primary" @click=${() => { closeDialog(); showToast('演示：备份任务已提交（不执行）', 'info'); }}>开始备份</button>`);
}

function openBackupSummary(row) {
  openDialog('配置备份 v12', html`
    <p class="muted small">${row.name} · 备份时间 2026-10-26 00:00 · SHA-256 9f2c8a41d7e0… · 已脱敏</p>
    <pre class="mono xs" style="white-space:pre-wrap;max-height:40vh;overflow:auto;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;padding:12px">sysname ${row.name}
interface GE0/0/1
 description 上行核心
 port link-type trunk
 <span class="muted"># 敏感字段已脱敏（snmp-agent / local-user 密码）</span></pre>`);
}

function openDiagnoseDialog(row) {
  if (!has('ai')) return;
  openDialog('AI 诊断', html`
    <p>诊断将读取 ${row.name} 的观测证据并生成建议；不会自动执行变更，也不会自动宣告恢复。</p>
    <div class="notice info small">模型调用受现有场景路由与预算约束；证据查看无需调用模型。原型不发起模型请求。</div>`,
  html`<button class="btn" @click=${closeDialog}>取消</button><button class="btn-primary" @click=${() => { closeDialog(); showToast('演示：诊断已提交（不调用模型）', 'info'); }}>开始诊断</button>`);
}

/* ---------------- 根渲染 ---------------- */

function navigation() {
  const items = NAV.map((item) => html`<button class="nav-item" aria-current=${item.key === ui.cls ? 'page' : 'false'}
    @click=${() => {
      if (item.key === 'dashboard') { showToast('原型未展开资源概览菜单；四菜单顺序保留', 'info'); return; }
      ui.cls = item.key; ui.view = 'list'; ui.tab = 'overview'; ui.filter = 'all'; ui.search = ''; ui.id = null; ui.config = null; update();
    }}>
    <span>${item.label}</span><span class="nav-order">${item.order}</span>
  </button>`);
  return html`<aside class="sidebar" aria-label="主导航">
    <div class="brand"><span class="brand-mark" aria-hidden="true">S</span> Slide</div>
    <div class="nav-group"><div class="nav-label">资源管理</div>${items}</div>
    <div class="nav-group"><div class="nav-label">运维</div>
      <button class="nav-item" @click=${() => showToast('原型未展开事件中心', 'info')}><span>事件中心</span><span class="nav-order">5</span></button>
      <button class="nav-item" @click=${() => showToast('原型未展开 AI 工作空间', 'info')}><span>AI 工作空间</span><span class="nav-order">6</span></button>
      <button class="nav-item" @click=${() => showToast('原型未展开审计中心', 'info')}><span>审计中心</span><span class="nav-order">7</span></button>
    </div>
    <div class="nav-group"><div class="nav-label">说明</div>
      <p class="xs muted" style="padding:0 12px;line-height:1.6">四菜单及顺序保持不变；原型未展开的菜单不参与本轮交互。</p>
    </div>
  </aside>`;
}

function dialogView() {
  const d = ui.dialog;
  return html`<app-dialog .open=${Boolean(d)} .title=${d?.title ?? ''} .size=${d?.size ?? 'md'} @app-dialog-close=${closeDialog}>
    ${d ? d.body : nothing}
    <div slot="footer">${d ? d.footer ?? html`<button class="btn" @click=${closeDialog}>关闭</button>` : nothing}</div>
  </app-dialog>`;
}

function view() {
  const forbidden = !canView() || ui.state === 'forbidden';
  const body = ui.view === 'detail'
    ? (forbidden ? forbiddenPage() : detailView())
    : (forbidden ? forbiddenList() : listView());
  return html`${navigation()}
    <div class="main">
      <div class="topbar">
        <span class="crumb">资源管理 / <strong>${cls().navLabel}</strong>${ui.view === 'detail' && !forbidden ? ` / ${tabLabel()}` : ''}</span>
        <span class="topbar-right"><span class="pill">设计评审环境</span><span>${APP_VERSION}</span></span>
      </div>
      <main class="content" id="main-content">${body}</main>
    </div>
    <app-toast-container></app-toast-container>
    ${dialogView()}`;
}

function syncUrl() {
  const params = new URLSearchParams();
  params.set('class', ui.cls);
  params.set('view', ui.view);
  params.set('tab', currentTab());
  params.set('state', ui.state);
  params.set('perm', ui.perm);
  if (ui.id != null) params.set('id', String(ui.id));
  if (ui.filter !== 'all') params.set('filter', ui.filter);
  if (ui.longName) params.set('long', '1');
  history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
}

// 仅用于设计评审/自动化检查读取原型状态；不是产品 API。
window.__max241 = ui;

const root = document.getElementById('app');
function update() {
  render(view(), root);
  syncControls();
  syncUrl();
}

/* ---------------- 评审控制条 ---------------- */

function syncControls() {
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
  set('ctl-class', ui.cls); set('ctl-view', ui.view); set('ctl-state', ui.state); set('ctl-perm', ui.perm);
  const long = document.getElementById('ctl-long'); if (long) long.checked = ui.longName;
  const tab = document.getElementById('ctl-tab');
  if (tab) {
    tab.innerHTML = cls().tabs.map(([key, label]) => `<option value="${key}">${label}</option>`).join('');
    tab.value = currentTab();
  }
}

document.getElementById('ctl-class').addEventListener('change', (e) => {
  ui.cls = e.target.value; ui.view = 'list'; ui.tab = 'overview'; ui.filter = 'all'; ui.search = ''; ui.id = null; ui.config = null; update();
});
document.getElementById('ctl-view').addEventListener('change', (e) => { ui.view = e.target.value; update(); });
document.getElementById('ctl-tab').addEventListener('change', (e) => { ui.tab = e.target.value; ui.view = 'detail'; update(); });
document.getElementById('ctl-state').addEventListener('change', (e) => { ui.state = e.target.value; update(); });
document.getElementById('ctl-perm').addEventListener('change', (e) => { ui.perm = e.target.value; update(); });
document.getElementById('ctl-long').addEventListener('change', (e) => { ui.longName = e.target.checked; update(); });

/* ---------------- 初始化（URL 优先；兼容旧深链接参数） ---------------- */

(function init() {
  const params = new URLSearchParams(location.search);
  const type = params.get('class');
  if (CLASSES[type]) ui.cls = type;
  // 兼容既有的详情深链接参数名；不改变参数含义。
  const legacy = { 'instance-detail': 'db', 'server-detail': 'server', 'network-device-detail': 'network' };
  const legacyTab = params.get('tab');
  if (legacy[legacyTab]) {
    ui.cls = legacy[legacyTab];
    ui.view = 'detail';
    ui.tab = 'overview';
    const legacyId = params.get('id') ?? params.get('networkDeviceId');
    const legacyRow = legacyId ? rowById(legacyId, ui.cls) : null;
    ui.id = legacyRow ? legacyRow.id : RESOURCE_ROWS[ui.cls][0].id;
  }
  const viewParam = params.get('view');
  if (viewParam === 'list' || viewParam === 'detail') ui.view = viewParam;
  const tab = params.get('tab');
  if (tab && cls().tabs.some(([key]) => key === tab)) ui.tab = tab;
  const state = params.get('state');
  if (['normal', 'empty', 'loading', 'error', 'partial', 'forbidden', 'module403'].includes(state)) ui.state = state;
  const perm = params.get('perm');
  if (PERMISSION_PRESETS[perm]) ui.perm = perm;
  const filter = params.get('filter');
  if (filter) ui.filter = filter;
  if (params.get('long') === '1') ui.longName = true;
  const id = params.get('id');
  if (id && rowById(id)) ui.id = Number(id);
  if (ui.id == null || !rowById(ui.id)) ui.id = RESOURCE_ROWS[ui.cls][0].id;
  if (params.get('full') === '1') document.documentElement.classList.add('shot-full');
  update();
  syncControls();
})();
