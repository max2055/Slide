# 三类完整资源详情现状盘点

盘点对象：`frontend/src/app/ui/` 与 `apps/db-ops-api`。基线为已验证 main `e11f6ba2`；权限相关文件与本次工作树逐字节一致。只记录**当前真实实现**；未实现能力统一标注“拟建”，不因原型或类型声明写成现状。完整权限/资源门禁逐项对照见 [06-permission-gates.md](06-permission-gates.md)。

相关入口：`frontend/src/app/ui/navigation.ts:3`（资源管理四菜单顺序）、`frontend/src/app/ui/app-render.ts:784`（三类详情渲染）、各详情视图文件。

## 0. 全局结构

### 0.1 资源管理导航（保持不变）

`navigation.ts:10-14`：`dashboard`（资源概览）、`network-devices`（网络设备）、`servers`（服务器）、`instances-db`（数据库）。四菜单名称与顺序为现有实现，本设计不调整。

### 0.2 资源概览四子标签

`dashboard.ts:374` 使用 `['all', ...resourceTypes]` 渲染 `scope-switch`（综合态势 / 数据库 / 服务器 / 网络设备）；`dashboard.ts:222` 按 scope 过滤健康面板。现有专业模块、筛选联动保留。

### 0.3 三类详情页签与深链接

| 类 | 组件 | 页签数 | 深链接 |
|---|---|---|---|
| 数据库 | `instance-detail.ts`（`instance-detail-page`） | 13 | `/?tab=instance-detail&id=N`；也兼容 `/instance-detail?id=N`（`instance-detail.ts:230`）；指标锚点 `metricResource=instance:N&metric=&metricFrom=&metricTo=` |
| 服务器 | `server-detail.ts`（`server-detail`） | 10 | `/?tab=server-detail&id=N`（`server-detail.ts:222` 要求查询参数 `tab=server-detail` 或路径 `/server-detail`） |
| 网络设备 | `network-device-detail.ts`（`network-device-detail`） | 6 | `/?tab=network-device-detail&networkDeviceId=N`（`network-device-detail.ts:92`）；指标锚点 `metricResource=network_device:N` |

公共深链接助手：`components/resource-investigation-links.ts:6` `resourceDetailUrl()`；`dashboard-model.ts:91` `returnToDashboard()` 支持 `returnTo=` 返回来源。

返回列表：三类详情当前都只回跳到列表根路径（数据库额外写入 `?tab=instances-db`），**不恢复列表筛选与翻页位置**；从资源概览进入时依赖 `returnTo`。

### 0.4 列表页（导航与四操作的实际语义）

三列表均复用 `components/resource-metrics-table.ts`。该组件已固定注入以下列（`resource-metrics-table.ts:284`）：

```
选择（批量） | 序号 | <各页传入业务列> | 采集状态 | 最近采集时间 | 操作 | <可选指标列>
```

| 类 | 传入业务列 | 业务列数 | 合计业务列（含自动列） |
|---|---|---|---|
| 数据库 | 实例、地址、版本、数据量、观测健康（`instances-db.ts:758`） | 5 | 9（含序号/采集状态/最近采集时间/操作 → 实际 9 个业务列，多出“数据量”） |
| 服务器 | 主机名称、地址、系统版本、观测健康（`servers-page.ts:550`） | 4 | 8 ✅ |
| 网络设备 | 设备、地址、型号、观测健康（`network-devices-page.ts:392`） | 4 | 8 ✅ |

采集状态列取值来源：优先 `blockers` 文案 → `effective_enabled=false` → `binding.application=failed` → `collection.state`（`resource-metrics-table.ts:288`）。最近采集时间取 `collection.last_success_at`，无记录显示“无成功采集记录”，读取异常显示“时间暂不可用”。

局部横滚与提示已具备：`.scroll` 容器 `role="region" tabindex="0" aria-label="资源表格，可横向滚动"` + 滚动提示 + 列设置（`resource-metrics-table.ts:300` 附近）。分页 20 条/页，偏好存 `sessionStorage`。

**四操作（当前业务真实语义，三类一致）**：

| 操作 | 行为 | 前端门控（现状） | 服务端实际要求 | 备注 |
|---|---|---|---|---|
| 详情 | 进入完整详情页 | 无（始终可点） | `instance:view` / `servers:view` / `network_devices:view`（数据库另需资源 read-only 范围） | 四操作中只有详情不需要写权限 |
| 编辑 | 打开资源编辑（数据库为整页编辑器，含“基本信息 / 监控与采集”两页签） | 数据库 `instance:manage`；服务器/网络设备 `:manage`；无权限时 `disabled` + title | 数据库 **`instance:update`** + 资源 read-write；服务器/网络设备 `:manage` | **数据库前后端不一致**：manage 不含 update |
| 测试 | 连接测试；数据库弹出输入密码的测试对话框 | 数据库/服务器 `:manage`；网络设备**无门控** | 三类均为 `:manage`（stateless，接收 host/凭据） | 网络设备前端缺少禁用（详见 06） |
| 删除 | 确认后删除 | 数据库 `instance:manage`；服务器/网络设备 `:manage` | 数据库 **`instance:delete`** + 资源 admin；服务器/网络设备 `:manage` | 数据库前后端不一致 |

> V4 原型列表示意动作为“详情 / 监控配置 / 测试连接 / 编辑”（`outputs/.../prototype/main.ts:96`）。按 Issue 要求以**当前业务语义**为准，不删现有“删除”，也不机械照搬原型四按钮。差异与建议见 [02-diff-table.md](02-diff-table.md) D-05。

### 0.5 “监控配置”现状

当前没有独立“监控配置”入口，配置能力分为两处，且是**同一配置来源**：

- 只读证据：详情页“采集配置”页签 → `components/resource-collection-section.ts`（`mode="summary"`）。展示模板绑定、有效开关、最近正式样本、缺口、指标覆盖、最近配置事件与技术证据；按钮“刷新采集状态”“修改监控与采集 →”。
- 编辑能力：`components/metric-configuration.ts`（由 `resource-collection-section` 的 `mode="edit"` 承载），提供模板选择/推荐、指标覆盖（继承/启用/停用）、策略组、预检与影响预览、试采、发布、“检查并启用”四步流程；发布后轮询应用与正式数据状态。唯一入口是资源编辑对话框的“监控与采集”页签，或从只读页“修改监控与采集 →”跳回列表编辑器。

`resource-collection-section.ts:86` 明示“配置统一在资源编辑中维护”。因此“监控配置直达”应**复用** `metric-configuration`，不新建第二套配置 UI（见 D-05）。

### 0.6 权限模型（前端实际使用）

| 层级 | 数据库 | 服务器 | 网络设备 |
|---|---|---|---|
| 列表/详情可见 | `instance:view`（`navigation.ts:144`） | `servers:view` | `network_devices:view`（详情页在 `navigation.ts:147` 有独立门禁） |
| 编辑/测试/删除 | `instance:manage` | `servers:manage` | `network_devices:manage` |
| 只读查询 | `instance:query`（SQL 控制台） | — | — |
| 采集配置管理 | `CollectionStatus.can_manage`（服务端返回，`/api/metrics/config/resources/:type/:id/access`） | 同 | 同 |
| 配置备份读取 | — | — | `network_devices:view`（列表/摘要/差异/定时设置读取） |
| 配置备份写入 | — | — | `network_devices:backup`（立即备份、保存定时设置、原始内容） |

已知现状风险（本次只记录，不在设计前置内修复）：`TAB_REQUIRED_PERMISSIONS` 未登记 `instance-detail` / `server-detail`（`navigation.ts:127-152`），仅登记了 `network-device-detail`；直接输入 URL 时页面依靠接口 401/403 兜底，而非导航层隐藏。实施阶段需实测并在回归清单 **R-22** 验证（原文误写 R-33）。网络设备详情“立即备份 / 保存定时设置”未按 `network_devices:backup` 门控，数据库编辑/删除前端使用 `instance:manage` 而服务端要求 `instance:update` / `instance:delete`，均见 [06](06-permission-gates.md)。

## 1. 数据库完整详情（13 页签）

文件：`frontend/src/app/ui/views/instance-detail.ts`。页头操作：返回列表、一键诊断、刷新（30s 自动刷新，仅可见页签刷新）；健康徽章按接口状态 + 资源概览合成（`_healthBadge`）；“详情成功读取时间”与“观测于”分离展示（非资源观测）。页头下固定 `resource-investigation-links`（关联调查 / 全部调查）。

| # | 页签 key | 标签 | 专业模块 | 数据来源（真实接口） | 页内操作 |
|---|---|---|---|---|---|
| 1 | overview | 概览 | 当前需要关注（未解决告警、证据缺口、缺口原始标识）+ 资源与能力（类型/环境/连接配置/地址/数据库/观测时间/时效）+ `operations-resource-relations`（2 跳关系与可信度） | `/api/resources/overview`、`/api/database/instances/:id` | 核对指标与时间范围、查看日志与完整事件、查看采集配置、重新读取概览 |
| 2 | collection | 采集配置 | 模板绑定、有效采集开关、最近正式样本、缺口、指标覆盖、最近配置事件、技术证据折叠 | `/api/metrics/config/resources/instance/:id/status`、`policy/resources/instance/:id/audit` | 刷新采集状态、修改监控与采集 → |
| 3 | metrics | 指标与趋势 | `semantic-metrics`：核心指标、时间窗、质量、来源 | `/api/metrics/query`（`view:'core'`，含 `latest_capacity`） | 指标深链接、时间范围切换、刷新 |
| 4 | health | 健康评分 | `health-score-tab`：历史评分与检查 | `/api/database/instances/:id/health-history?days=`、`/health-checks` | 时间范围切换 |
| 5 | topsql | 慢查询 | 慢查询 Top 列表、来源与读取时间、空/错/无权限/过期状态 | `/api/database/instances/:id/topsql` | 页签角标计数 |
| 6 | sessions | 会话 | 活跃会话快照（最多 50）、来源说明 | `/api/database/instances/:id/sessions` | 页签角标计数 |
| 7 | capacity | 容量 | 总容量、库/表空间/最大表、7 天历史容量曲线 | `/capacity`、`/capacity/history?hours=168` | — |
| 8 | schema | 表结构 | 快照、变更、表结构详情、采集 | `/api/schema/snapshots/:id`、`/api/schema/snapshot/:id`、`/api/schema/changes/:id`、`/api/schema/collect/:id`、`/api/schema/table/:id/:table` | 采集快照、查看表结构 |
| 9 | indexes | 索引 | 索引建议、检测、采集 | `/api/indexes/:id`、`/api/index/collect/:id`、`/api/index/detect/:id` | 检测、采集 |
| 10 | sqlaudit | SQL 审核 | 审核记录、触发审核、轮询状态 | `/api/sql/audit`、`/api/sql/audit/instance/:id`、`/api/sql/audit/:id`、`/:id/status` | 发起审核、查看结果 |
| 11 | logs | 日志 | 日志查询、统计、AI 分析 | `/api/logs`、`/api/logs/stats`、`/api/logs/analyze`、`/api/logs/analysis/:id` | 查询、分析 |
| 12 | qan | 查询分析 | 查询分析记录（limit 50） | `/api/database/instances/:id/qan?limit=50` | 刷新 |
| 13 | diagnosis | AI 诊断 | 诊断历史列表、诊断执行轨迹、结果弹窗 | `/api/ai/analysis`（POST）、`/api/ai/analysis/status/:id`、`/api/ai/analysis/history` | 一键诊断、继续在对话中分析、查看历史 |

权限与状态：接口 401/403 → “无权读取…”；慢查询/会话区分 idle/loading/success/error/forbidden/unavailable/expired（`instance-detail.ts:387`）；权限或登录变更时清空上下文并要求重开（`onPermissionsChanged`）。

## 2. 服务器完整详情（10 页签）

文件：`frontend/src/app/ui/views/server-detail.ts`。页头操作：返回列表、一键巡检（生成巡检报告后跳“报告”）、刷新；状态徽章来自资源概览 `runState`。

| # | 页签 key | 标签 | 专业模块 | 数据来源 | 页内操作 |
|---|---|---|---|---|---|
| 1 | overview | 概览 | 当前需要关注 + 证据缺口 + 服务器状态（OS、连接状态登记值、最近状态检查）+ 托管数据库实例列表 + `operations-resource-relations` | `/api/servers/:id`、`/api/servers/:id/instances`、`/api/resources/overview` | 核对指标、查看系统日志证据、查看采集配置、跳实例详情、重试托管实例 |
| 2 | collection | 采集配置 | 同数据库的只读采集证据 | 同上（server 资源类型） | 刷新采集状态、修改监控与采集 → |
| 3 | metrics | 指标与趋势 | `semantic-metrics`（CPU/内存/磁盘/网络等由模板决定） | `/api/metrics/query` | 指标深链接、时间范围 |
| 4 | config | 配置 | 主机地址、SSH 端口、标签、OS、认证方式、采集状态、最近状态检查 | `/api/servers/:id` | 无编辑（编辑在列表编辑对话框） |
| 5 | diagnostics | 诊断 | `server-diagnostic-panel` 全量证据 | `POST /api/servers/:id/collect-diagnostics` | 采集诊断证据 |
| 6 | network | 网络 | 同一证据快照的 network 分区 | 同上（`sectionFilter="network"`） | 采集诊断证据 |
| 7 | processes | 进程 | 同一证据快照的 processes 分区 | 同上 | 采集诊断证据 |
| 8 | services | 服务 | 同一证据快照的 services 分区 | 同上 | 采集诊断证据 |
| 9 | logs | 日志 | 同一证据快照的 logs 分区 | 同上 | 采集诊断证据 |
| 10 | related | 关联资源 | 托管数据库实例（角色、健康状态、跳详情） | `/api/servers/:id/instances` | 查看实例详情 |

关键现状：5–9 五个页签是**同一份诊断证据**的不同分区过滤，页面不自动采集；未采集时显示“当前页面尚未取得诊断证据…页面切换和刷新不会自动采集”。设计需保留这一事实边界，避免把分区页签误读为持续实时数据。

## 3. 网络设备完整详情（6 页签）

文件：`frontend/src/app/ui/views/network-device-detail.ts`（Light DOM，样式在 render 内注入）。页头操作：返回网络设备列表、刷新、立即备份（主操作）。页头展示“观测于”与“详情成功读取”两条时间。

| # | 页签 key | 标签 | 专业模块 | 数据来源 | 页内操作 |
|---|---|---|---|---|---|
| 1 | overview | 概览 | 当前需要关注 + 证据缺口 + 资源与能力（地址/SNMP 端口、型号、最近状态检查、可用证据） | `/api/network-devices/:id`、`/api/resources/overview` | 核对指标、查看接口维度、查看采集配置 |
| 2 | metrics | 指标与趋势 | `semantic-metrics`（接口状态、流量等） | `/api/metrics/query` | 指标深链接、时间范围 |
| 3 | interfaces | 接口 | 接口列表（管理/运行状态、标称容量、最后发现）+ 名称/别名搜索 + 运行状态筛选 | `/api/network-devices/:id/interfaces` | 刷新接口 |
| 4 | relations | 关联资源 | 关系表（源/目标/关系/来源/有效期）+ `operations-resource-relations` 折叠区 | `/api/network-devices/:id/relations` | — |
| 5 | backups | 配置备份 | 每日定时备份设置（启用、时间、最近执行）+ 备份列表（版本/时间/大小/SHA-256/脱敏状态）+ 备份摘要弹窗 | `/backup-schedule`（GET/PUT）、`/config-backups`（GET/POST）、`/config-backups/:id` | 保存定时设置、立即备份、查看摘要 |
| 6 | collection | 采集配置 | 只读采集证据（同框架） | 同上（network_device 资源类型） | 刷新采集状态、修改监控与采集 → |

## 4. 设计输入结论（供 02/03 使用）

1. **三类专业能力集中在详情页签**，不能在“详情”入口换成简化弹窗或通用页；V4 `resource-detail` 弹窗只是入口占位。
2. 列表八列的框架（序号、采集状态、最近采集时间）**已存在**；数据库列表多出的“数据量”是唯一超出八列口径的常驻业务列。
3. 列表四操作的真实语义是“详情 / 编辑 / 测试 / 删除”；**只有编辑/测试/删除需要写权限，详情只需 `:view`**，且数据库编辑/删除的服务端权限码是 `instance:update` / `instance:delete` 而非 `instance:manage`。原型示意的“监控配置”在当前实现中位于详情页签与资源编辑器。
4. 详情缺少三项信息职责：**有效触发器、资源事件、操作审计**；触发器 / 事件 / 审计的新增依赖 P1 与契约 Issue，本轮只做设计占位。
5. 返回列表不保留筛选与位置，是现有真实缺口（数据库/服务器/网络设备均如此）。
