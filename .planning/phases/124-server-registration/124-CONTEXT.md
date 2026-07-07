# Phase 124: 服务器注册与凭据管理 - Context

**Gathered:** 2026-07-07
**Status:** Ready for planning

<domain>
## Phase Boundary

实现服务器的注册管理和 SSH 凭据配置。用户可以通过表单添加服务器，配置 SSH 凭据（密码/私钥），测试连接可达性，并在服务器列表中查看所有纳管服务器的状态。

不包含指标采集、告警、巡检等功能——这些在后续 Phase 125-128。

</domain>

<decisions>
## Implementation Decisions

### 服务器表单设计
- **D-01:** 采用简洁版字段：IP/主机名、SSH端口（默认22）、标签（可选别名）、OS类型（固定选项列表：CentOS/Ubuntu/Debian/RHEL/Other）
- **D-02:** IP/主机名作为默认显示名，可选填别名
- **D-03:** 参考现有数据库实例的单列表单布局（app-dialog + app-form-field）
- **D-04:** 添加服务器后默认启用采集（添加即启用）

### 凭据管理方式
- **D-05:** SSH 凭据（密码 + 私钥）内嵌在服务器表单中，非独立管理
- **D-06:** 每台服务器独立配置 SSH 凭据，不支持凭据复用
- **D-07:** 凭据加密存储，复用 existing encryptData/decryptData（AES-256-CBC）

### 连接测试 UX
- **D-08:** 测试连接按钮放在表单底部提交按钮附近（与现有数据库实例测试连接模式一致）
- **D-09:** 连接测试显示简洁结果：成功/失败，不展示详细回显信息

### 导航结构调整
- **D-10:** 一级菜单「数据库运维」更名为「运维」
- **D-11:** 「运维」菜单下增加「服务器管理」，放在「数据库管理」上方
- **D-12:** 原「实例管理」更名为「数据库管理」,放在「服务器管理」下方

### Claude's Discretion
- 服务器列表页 UI 布局和样式（复用 app-data-table/app-badge/app-card 模式）
- 删除/编辑服务器的 API 设计（参考 instance-database-service.ts CRUD 模式）
- SSH 连接池模式的具体实现（SshSessionPool 等待 Phase 125 实现，Phase 124 先只做完连接测试）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 实例管理参考模式
- `apps/db-ops-api/src/instance-database-service.ts` — 数据库实例 CRUD 模式，Phase 124 的服务器 CRUD 应参考此实现
- `apps/db-ops-api/src/db-connection.ts` — encryptData/decryptData AES-256-CBC 凭据加密模式，Phase 124 的 SSH 凭据加密应复用此模式
- `apps/db-ops-api/server.ts` — 路由注册模式，参考现有实例管理 API 路由

### 前端参考
- `frontend/src/app/ui/views/` — 现有视图模式，服务器列表和详情页 UI 应复用 app-data-table/app-card/app-badge/app-dialog/app-form-field/app-empty-state 等共享组件
- `frontend/src/app/ui/views/settings-shell.ts` — 设置页面子标签导航模式

### 需求文档
- `.planning/REQUIREMENTS.md` — v0.8 需求，Phase 124 对应 SRV-01~06、UI-01、UI-05

### 架构调研
- `.planning/research/ARCHITECTURE.md` — 服务器实体模型、表结构建议
- `.planning/research/PITFALLS.md` — Pitfall 2 (SSH 密钥明文存储)、Pitfall 6 (不要建平行系统)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `instance-database-service.ts` — 实例 CRUD 完整模式（create/update/delete/list/getById），服务器 CRUD 可复制此模式
- `db-connection.ts` — encryptData/decryptData 函数，可直接复用 SSH 凭据加密
- `app-dialog` + `app-form-field` — 现有共享组件，服务器添加/编辑弹窗可直接使用
- `app-data-table` — 服务器列表可复用
- `app-badge` — 服务器状态指示器可复用
- `app-empty-state` — 空服务器列表状态

### Established Patterns
- 数据库实例：单表 CRUD + 独立 service 文件 + API 路由注册 + 前端 LitElement 视图
- 凭据加密：AES-256-CBC，MySQL 存储加密字符串，使用前解密
- 权限控制：JWT + requirePermission 中间件模式

### Integration Points
- `server.ts` — 注册服务器相关路由（需新增 server 路由）
- 导航组件 — 调整「数据库运维」→「运维」、新增「服务器管理」入口
- `alerts/alert_rules` 表 — 等 Phase 126 再加 server_id，Phase 124 暂不涉及

</code_context>

<specifics>
## Specific Ideas

- OS 类型使用固定选项列表：CentOS/Ubuntu/Debian/RHEL/Other
- 服务器表单参考现有实例添加弹窗的单列布局
- 测试连接按钮位置同数据库实例模式（表单底部提交按钮附近）

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 124-服务器注册与凭据管理*
*Context gathered: 2026-07-07*
