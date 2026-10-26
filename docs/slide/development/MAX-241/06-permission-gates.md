# 资源操作权限与服务端门禁盘点

用途：为“详情页 + 列表四操作 + 监控配置 + 备份”的实施提供逐项权限对照，避免前端按钮与接口权限错位。本文只记录**当前代码事实**和据此给出的实施建议；本轮未修改产品代码。

基线：已验证 main `e11f6ba2`。权限相关文件（下表引用）在该基线与本次工作树逐字节一致（`git diff HEAD e11f6ba2 -- <file>` 为空），因此行号可用于两侧。

## 0. 两层权限模型

| 层 | 实现 | 作用 | 是否安全边界 |
|---|---|---|---|
| 前端可用性 | `frontend/src/app/ui/components/resource-list-access.ts` → `hasListPermission()` 读取 `localStorage.permissions` | 决定按钮是否 `disabled` + 原因 `title` | **否**，仅 UX |
| 服务端实时授权 | `requirePermission()`（`apps/db-ops-api/src/auth/require-permission.ts`） | 每次请求按 JWT 权限码实时判定 | 是 |
| 资源范围 | `requireInstanceAccess('read-only'\|'read-write'\|'admin')`（`apps/db-ops-api/src/auth/require-instance-access.ts`）、`canReadResource` / `canManageResource`（`apps/db-ops-api/src/resources/resource-service.ts`） | 限定具体资源 id 与读写级别 | 是 |

通配符：`*`、`resource:*`、`*:action` 均命中对应权限码（`hasPermission`）。前端 `hasListPermission` 同样处理 `*` 与 `resource:*`，但不处理 `*:action`——这是既有差异，未列入本次改动。

## 1. 列表四操作：前端门控 vs 服务端门禁

“详情 / 编辑 / 测试 / 删除”是当前真实业务四操作（`instances-db.ts:763`、`servers-page.ts:570-572`、`network-devices-page.ts:412-414`）。**不是四项都用 `:manage`**：详情只需 `:view`，数据库的编辑/删除在服务端使用独立权限码。

### 1.1 数据库

| 操作 | 前端门控 | 接口 | 服务端权限 | 资源范围 | 现状结论 |
|---|---|---|---|---|---|
| 详情 | 无（始终可点） | `GET /api/database/instances/:id`（`server.ts:1441`） | `instance:view` | `requireInstanceAccess('read-only')` | 一致 |
| 编辑 | `instance:manage`（`:763`） | `PUT /api/database/instances/:id`（`server.ts:1455`） | **`instance:update`** | `read-write` | **不一致**：只有 `instance:manage` 的用户会看到可用按钮，提交后 403 |
| 测试 | `instance:manage`（`:763`） | `POST /api/database/instances/test-connection`（`server.ts:1520-1523`） | `instance:manage` | 无（stateless，接收 host/凭据） | 权限码一致；需注意它是“按提交的连接参数测试”，不校验资源范围 |
| 删除 | `instance:manage`（`:763`） | `DELETE /api/database/instances/:id`（`server.ts:1472`） | **`instance:delete`** | `admin` | **不一致**：同上，按钮可用但服务端拒绝 |

权限种子：`apps/db-ops-api/sql/schema.sql` 中 `instance:update`（更新实例）、`instance:delete`（删除实例）、`instance:manage`（重载连接、采集容量等）是三个独立权限码，`instance:manage` **不蕴含** `instance:update` / `instance:delete`。

### 1.2 服务器

| 操作 | 前端门控 | 接口 | 服务端权限 | 资源范围 | 现状结论 |
|---|---|---|---|---|---|
| 详情 | 无 | `GET /api/servers/:id`（`server.ts:1557`） | `servers:view` | 无 per-server 资源边界 | 一致（资源边界见 §5） |
| 编辑 | `servers:manage`（`:570`） | `PUT /api/servers/:id`（`server.ts:1601`） | `servers:manage` | 无 | 一致 |
| 测试 | `servers:manage`（`:571`） | `POST /api/servers/test-connection`（`server.ts:1636-1639`） | `servers:manage` | 无（stateless） | 一致 |
| 删除 | `servers:manage`（`:572`） | `DELETE /api/servers/:id`（`server.ts:1618`） | `servers:manage` | 无 | 一致 |

### 1.3 网络设备

| 操作 | 前端门控 | 接口 | 服务端权限 | 资源范围 | 现状结论 |
|---|---|---|---|---|---|
| 详情 | 无 | `GET /api/network-devices/:id`（`network-device-routes.ts:158`） | `network_devices:view` | 无 per-device 资源边界 | 一致 |
| 编辑 | `network_devices:manage`（`:412`） | `PUT /api/network-devices/:id`（`:211`） | `network_devices:manage` | 无 | 一致 |
| 测试 | **无门控**（`:413`，只在测试中禁用） | `POST /api/network-devices/test-connection`（`:103`） | **`network_devices:manage`** | 无（stateless） | **不一致**：无 manage 权限时按钮仍可点，提交后 403 |
| 删除 | `network_devices:manage`（`:414`） | `DELETE /api/network-devices/:id`（`:224`） | `network_devices:manage` | 无 | 一致 |

## 2. 详情页导航层门禁

`navigation.ts:127 TAB_REQUIRED_PERMISSIONS` 已登记：`instances-db → instance:view`、`servers → servers:view`、`network-devices → network_devices:view`、`network-device-detail → network_devices:view`。

**未登记**：`instance-detail`、`server-detail`。直接输入旧深链接时，导航层不隐藏/不拦截，只能依赖详情接口 403 兜底。实施时应补齐，并在回归项 **R-22** 验证（原文档误写为 R-33，本轮已更正）。

## 3. 详情内专业模块权限

### 3.1 数据库详情

| 模块 | 接口（示例） | 服务端权限 | 资源范围 |
|---|---|---|---|
| 指标与趋势 | `GET /api/database/instances/:id/metrics`（`server.ts:2191`） | `instance:view` | `read-only` |
| 指标历史 | `GET .../metrics/history`（`:2203`） | `instance:view` | `read-only` + 历史上下文 |
| 慢查询 | `GET .../topsql`（`instance-query-routes.ts:9`） | `instance:view` | `read-only` |
| 会话 | `GET .../sessions`（`instance-query-routes.ts:25`） | `instance:view` | `read-only` |
| 容量 / 历史 | `.../capacity`（`:2350`）、`.../capacity/history`（`:2364`） | `instance:view` | `read-only` |
| 健康评分 | `.../health-history`（`:2378`）、`.../health-checks`（`:2394`） | `instance:view` | `read-only` |
| 表结构 | `GET /api/schema/snapshots/:instanceId`（`:4569`） | **`schema:view`** | `requireInstanceAccess()` |
| 索引 | `GET /api/indexes/:instanceId`（`:4687`） | **`index:view`** | `requireInstanceAccess()` |
| SQL 审核 | `GET /api/sql/audit/instance/:instanceId`（`:4171`） | **`sql:view`** | `read-only` |
| 日志 | `GET /api/logs`（`:4295`） | **`log:view`** | 无资源范围参数（按请求 instanceId 取日志） |
| 查询分析 | `GET .../qan`（`:2238`） | `instance:view` | `read-only` |
| AI 诊断历史 | `GET /api/ai/analysis/history`（`:3847`） | **`ai:view`** | 无资源范围参数 |
| 一键诊断 | `POST /api/ai/analysis`（`:3716`） | **`ai:manage`** | 无资源范围参数 |

写操作：`schema:manage`（采集结构，`server.ts:4552`）、`index:manage`（采集/检测，`:4653`/`:4670`）、`sql:audit`（发起审核，`:4086`），均带 `requireInstanceAccess()`（schema/index）。

### 3.2 服务器详情

| 模块 | 接口 | 服务端权限 | 资源范围 |
|---|---|---|---|
| 详情 / 指标 / 诊断读取 | `GET /api/servers/:id`（`:1557`）、`.../metrics`（`:1691`）、`.../diagnostics`（`:1739`） | `servers:view` | 无 per-server 边界 |
| 采集诊断证据 | `POST /api/servers/:id/collect-diagnostics`（`:1757`） | **`servers:manage`** | 无 |
| 一键巡检 | `POST /api/servers/reports/generate`（`:1778`） | **`servers:manage`** | 无 |
| 托管实例 | `GET /api/servers/:id/instances`（`instance-host-routes.ts:191`） | `verifyToken` + 服务内资源授权 | 服务内 `listInstances(actor, id)` |

### 3.3 网络设备详情

| 模块 | 接口 | 服务端权限 | 资源范围 |
|---|---|---|---|
| 详情 / 指标 / 接口 / 关联读取 | `GET /:id`、`/metrics`、`/interfaces`、`/relations`（`:158`、`:232`、`:241`、`:347`） | `network_devices:view` | 无 per-device 边界 |
| 只读探测 | `POST /:id/probe`（`:167`） | `network_devices:view` | 无 |
| 连接测试 | `POST /test-connection`（`:103`） | `network_devices:manage` | 无 |
| 备份列表 / 摘要 / 差异 | `GET .../config-backups`、`/:backupId`、`/:backupId/diff`、`GET .../backup-schedule`（`:273`、`:295`、`:306`、`:332`） | `network_devices:view` | 无 |
| 立即备份 | `POST .../config-backups`（`:252`） | **`network_devices:backup`** | 无 |
| 保存定时备份 | `PUT .../backup-schedule`（`:282`） | **`network_devices:backup`** | 无 |
| 原始备份内容 | `GET .../config-backups/:backupId?raw=true`（`:311`） | `network_devices:view` **且** 额外检查 `network_devices:backup` | 拒绝时写 `read_denied` 审计 |

**读写分离结论**：备份读取 = `view`，备份写入 = `backup`；前端当前两处写入口（页头“立即备份”、备份页“保存定时设置”）都未按 `network_devices:backup` 禁用，属于需修复的前后端不一致。

## 4. 监控配置（metric-configuration）授权

- 路由：`apps/db-ops-api/src/metrics/config/routes.ts:30-35` 对所有操作只用 `verifyToken`，再在服务内判定：
  - `resource()` 返回 `can_manage`（`service.ts:72` → `canManageResource`，`resource-service.ts:51-65`）；
  - `status/attempts/catalog` 走 `assertAccess` / 允许 `metric:*` 或三类 `:view`/`:manage` 的目录读取（`service.ts:65`）；
  - `trial` / `activate` 会重新校验实时权限、清点和 CAS（`service.ts` 注释与 `activate` 实现）。
- 因此 UI 不应自行用“`instance:manage` 就一定能编辑”推断；应以 `GET /api/metrics/config/resources/:type/:id/access` 的 `can_manage` 为准，服务端仍是最终裁决。
- 数据库 `canManageResource` 还要求资源范围为 `read-write` 或 `admin`；服务器/网络设备只检查 `servers:manage` / `network_devices:manage`。

## 5. 资源级边界现状（事实，不擅自扩展）

- 数据库：读/写接口带 `requireInstanceAccess`，`canReadResource`/`canManageResource` 也检查 `instanceScopes` / `resourceBoundary.instanceIds`。
- 服务器 / 网络设备：路由只有全局权限码检查，没有按 `serverId` / `networkDeviceId` 的边界参数；`canReadResource`/`canManageResource` 虽支持 `serverIds` / `networkDeviceIds`，但这些列表/详情路由未调用。是否需要资源级边界属于产品/安全决策，**本设计不默认新增**；实施前需明确并补负例（R-82）。

## 6. 实施建议（供详情页实施阶段）

| ID | 建议 |
|---|---|
| P-01 | 列表编辑/删除按**实际接口码**门控：数据库 `instance:update` / `instance:delete`（并提示资源范围），服务器/网络设备仍为 `:manage`。不要用单一 `:manage` 统一四操作。 |
| P-02 | 详情始终只需 `:view`；进入详情不得因缺少写权限而阻断。 |
| P-03 | 页面级 403 清空**全部**资源上下文（名称、地址、健康、调查、页签、操作），仅保留返回；模块级 403 只影响当前页签，页面身份仍可显示。 |
| P-04 | 网络设备备份：读取按 `network_devices:view`，立即备份/保存定时按 `network_devices:backup`；无 `backup` 时禁用并给出权限码原因，读取仍可用。 |
| P-05 | 监控配置的可编辑性以 `/access` 的 `can_manage` 为准；无权限时保留只读证据，不展示旧草稿。 |
| P-06 | 权限/登录变更时清空上下文；前端禁用不是防线，服务端 403 必须映射为明确无权限状态而非空数据。 |

## 7. 本轮未修复的既有不一致（记录，不扩大范围）

1. 数据库列表编辑（`instance:manage`）与 `PUT`（`instance:update`）不一致。
2. 数据库列表删除（`instance:manage`）与 `DELETE`（`instance:delete` + admin 范围）不一致。
3. 网络设备列表“测试”无前端门控，接口要求 `network_devices:manage`。
4. 网络设备详情“立即备份 / 保存定时设置”无 `network_devices:backup` 门控。
5. `instance-detail` / `server-detail` 未登记导航层权限（R-22）。
6. 服务器/网络设备缺少 per-resource 边界（需产品决策）。

以上均需在实施阶段按 P-01…P-06 修正，并以真实 403 负例（R-81/R-82）验证；本轮原型仅演示正确门控行为。
