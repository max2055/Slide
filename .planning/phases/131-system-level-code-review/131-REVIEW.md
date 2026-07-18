---
phase: 131-system-level-code-review
reviewed: 2026-07-16T20:35:00+08:00
depth: system
status: issues_found
production_ready: false
findings:
  confirmed_critical: 3
  confirmed_high: 13
  confirmed_medium: 7
  confirmed_low: 1
  high_risk_design: 4
  test_gaps: 6
  optimizations: 3
---

# Phase 131：Slide 系统级代码审查

## 执行结论

**Slide 当前不具备生产可用条件。** 运行中的系统存在三个会直接阻断发布的安全与控制缺陷：Agent 工具丢弃授权元数据，Chat 数据没有按租户或用户隔离，直接 SQL 接口绕过了规划中定义的审批边界。此外，全新数据库无法初始化出当前代码所需的 schema；审批执行存在并发竞态；健康度/准备度会在 80% 活跃实例处于 critical 状态时仍报告 100%；单元测试和类型检查基线也处于失败状态。

本次审计以当前代码为最终事实。规划文档和历史 Claude/GSD 报告仅用于还原设计意图；下文每项结论均已通过当前源码或运行中的系统进行核对。

## 范围与方法

审查前已读取：

- `AGENTS.md`、根目录及后端的 `CLAUDE.md`
- `.planning/PROJECT.md`、`ROADMAP.md`、`STATE.md`、`REQUIREMENTS.md`
- Phase 124-130 的 Review、Review-Fix、UAT、Verification、Context 和 Summary 证据
- `STATE.md` 引用的全部延期事项（deferred items）

已执行的验证：

- 对 Lit、Fastify、MySQL schema/migration、采集器、告警、报表、Cron、Agent Core 和 DirectAdapter WS 进行静态调用链审查
- 使用管理员和普通用户账户执行实时 API 认证与授权测试
- 对运行中的 MySQL 执行元数据和数据一致性查询
- 使用无头 Chrome 遍历 Cron、Chat、服务器、告警、SQL 控制台、审批和 Agent 页面
- 执行前端、后端和 Agent 测试，前后端类型检查，前端生产构建和 schema 校验器
- 非破坏性验证重复启动行为，并保留现有后端进程

未修改任何业务代码。

## 系统与接口地图

| 用户功能面 | 前端入口 | REST / WS 边界 | 主要服务 | 持久化状态 / 下游 |
|---|---|---|---|---|
| 登录/RBAC | `login-gate.ts`、导航权限过滤 | `/api/auth/*`、`/api/v1/rbac/*`、WS `auth` | `auth-database-service`、`rbac-service`、`verifyToken` | `users`、角色、权限、refresh token |
| 数据库实例 | `instances-db.ts`、`instance-detail.ts` | `/api/database/instances*` | `instance-database-service`、`database-service` | 加密凭据、实时连接映射、健康历史 |
| 指标/健康 | 仪表盘、实例标签页、闭环健康 | `/api/*metrics*`、`/api/health/consistency` | `monitor-collector`、`collector`、`consistency-checker` | `metrics_history`、容量和健康历史 |
| SQL/审批 | `sql-console.ts`、`approval-dashboard.ts` | `/execute`、`/api/approval/*` | `sql-executor`、`approval-service`、审计日志 | 目标数据库、审批请求/事件、SQL 历史 |
| 告警/事件 | `alerts.ts`、事件管理 | `/api/alerts*`、`/api/alert-rules*` | 实例/服务器评估器、告警引擎 | 规则、告警、聚合事件、通知渠道 |
| 报表 | `reports.ts` | `/api/reports*`、`/api/servers/reports*` | 报表服务、配置服务 | `reports`、`report_configs` |
| Cron | `cron-jobs-settings.ts` | `/api/cron/*` | `CronManager`、`CronExecutor`、AgentRunner | 任务/日志、LLM 与工具调用 |
| Chat/Agent | `app-chat.ts`、`direct-gateway.ts`、Agent 页面 | REST 历史/会话 API + `:28888` WS | `DirectAdapter`、AgentRunner、ToolRegistry | Chat 会话/消息、Agent 会话文件、目标系统 |
| 服务器/SSH | `servers-page.ts`、`server-detail.ts` | `/api/servers*` | 服务器采集器、评估器、报表服务 | 服务器、SSH 凭据、`server_metrics`、告警/报表 |

### 关键数据流

1. **SQL 写入：** Lit SQL 控制台 -> `POST /api/database/instances/:id/execute` -> 权限/实例访问中间件 -> `SqlExecutor.executeSql()` -> 目标数据库 -> SQL 历史。审批服务完全不在该路径中。
2. **审批后 SQL：** 审批 UI -> 审核接口 -> `ApprovalService.reviewRequest()` -> 目标数据库 -> 审批记录/事件。选择、执行和状态迁移不是原子操作。
3. **Chat 工具调用：** JWT WS 认证 -> 任意会话键/消息 -> DirectAdapter -> AgentRunner -> 转换后的平台工具 -> 目标数据库/平台服务。工具执行过程没有用户身份、角色、实例授权和审批策略。
4. **告警闭环：** 采集器 -> 指标历史 -> 评估器 -> 告警/事件 -> RCA -> 通知。服务器指标标识、目标过滤、RCA 持久化和通知发送均存在断点。
5. **定时报表：** 报表配置 -> 调度匹配 -> 报表生成 -> 持久化 -> 通知。UI 未渲染配置管理，种子 Cron Agent 也没有读取配置或生成报表的工具，因此流程中段不可执行。

## 已确认缺陷

### CR-01 — Agent 工具授权和审批策略被丢弃

- **严重程度 / 分类：** Critical，已确认缺陷
- **文件：** `apps/db-ops-api/src/adapter/get-agent-engine.ts:55-71`；`apps/db-ops-api/src/tools/generated/slide-self-mgmt/get_instance_connection.ts:12-70`；`apps/db-ops-api/src/tools/generated/slide-self-mgmt/update_db_config.ts:81-84`
- **证据 / 复现：** 工具转换将所有工具硬编码为 `readOnly: true`，没有传递 `ownerOnly`、`requiresApproval` 或 `dangerLevel`，并在没有用户上下文的情况下直接调用 `handler(params)`。`get_instance_connection` 声明为仅所有者可用、危险级别 4，却返回解密后的密码；`update_db_config` 声明需要审批，但仍可直接进入 handler。
- **影响：** 任何能通过 Chat 影响 Agent 的已认证用户都可能调用仅管理员可用的凭据读取工具或状态修改工具。自然语言模型取代 RBAC/审批中间件，成为实际安全边界。
- **根因：** 旧的 `AnyAgentTool` 策略模型被压平到 Agent Core 的 `Tool` 模型，迁移过程中没有实现策略执行适配器，也没有传递执行主体。
- **建议修复：** 为每次 Agent 运行加入不可变执行主体（用户 ID、角色、权限、实例授权）；保留工具策略元数据；在统一的服务端工具中间件中执行所有者/权限/实例/审批检查；禁止向模型返回明文凭据；为全部危险工具增加默认拒绝测试。

### CR-02 — Chat 会话和消息存在跨用户 IDOR，修改接口同样受影响

- **严重程度 / 分类：** Critical，已确认缺陷
- **文件：** `apps/db-ops-api/src/chat-database-service.ts:84-92,98-130,256-261,277-285`；`apps/db-ops-api/server.ts:862-885,903-980`；`apps/db-ops-api/src/adapter/direct-adapter.ts:260-357`
- **证据 / 复现：** `getSessions(userId)` 明确忽略 `userId`；消息、历史和删除查询只使用攻击者可控的 `session_id`；缺失会话被固定归属到 `user_id=1`。实时测试中，管理员和普通用户都看到相同的 9 个会话，普通用户还能读取管理员会话中的 2 条消息。REST PATCH/DELETE/cap 以及 WS history/watch 同样接受任意会话键。
- **影响：** 用户可以读取、修改、删除或订阅其他用户的运维对话，其中可能包含数据库元数据、事故上下文和工具输出；还可以向共享会话注入消息。
- **根因：** DirectAdapter 迁移保留了全局可寻址的会话键，却从数据库查询和传输处理器中移除了所有权校验。
- **建议修复：** 所有会话/消息操作必须按已认证用户过滤，或使用显式且可审计的共享会话 ACL；将 WS 身份绑定到连接，忽略客户端提供的用户 ID；使用服务端生成且不可猜测的会话键；增加所有权 FK/唯一约束；使用两个用户测试读、写、删、watch 隔离。

### CR-03 — 直接 SQL 执行绕过 DML/DDL 审批

- **严重程度 / 分类：** Critical，已确认缺陷
- **文件：** `apps/db-ops-api/server.ts:1593-1615`；`apps/db-ops-api/src/sql-executor.ts:12-83`
- **证据 / 复现：** 直接执行接口只要求 `instance:query` 和实例 `read-write` 权限，随后将任意 SQL 原样交给驱动。实时请求 `UPDATE database_instances SET name=name WHERE 1=0` 返回 HTTP 200 和 `success:true`，且未创建审批请求。
- **影响：** 获得查询权限的用户可以直接执行 UPDATE/DELETE/DDL，绕过审核、回滚准备和职责分离。
- **根因：** 路由注释和服务契约声称“仅 SELECT”，但实际执行路径中没有解析器、语句分类器或审批状态检查。
- **建议修复：** 使用支持各方言的 SQL parser；`/execute` 只允许单条只读语句；DML/DDL 必须转到审批提交接口；条件允许时使用只读数据库账户；拒绝事务控制语句和多语句；为每种支持的数据库方言增加集成测试。

### HI-01 — 全新数据库无法初始化出当前运行时所需 schema

- **严重程度 / 分类：** High，已确认缺陷
- **文件：** `apps/db-ops-api/init-db.ts:41-53`；`apps/db-ops-api/server.ts:149-167`；`apps/db-ops-api/sql/schema.sql`；迁移 `005`、`007`、`009`、`017`、`019`、`020`、`024`
- **证据 / 复现：** `init-db.ts` 只执行 `schema.sql`，该文件缺少 `refresh_tokens`、`report_configs`、Cron 系列表、`servers` 和 `server_metrics` 等核心表。启动时只自动执行 014/018/021/022，跳过创建依赖表的迁移，并吞掉所有错误。当前包含 63 张表的数据库仅因历史迁移或人工迁移已执行才可工作。
- **影响：** 新部署和灾难恢复会启动在不完整 schema 上，API 随后在运行时失败，但启动流程仍可能继续。
- **根因：** 项目没有有序迁移账本，`schema.sql`、迁移文件和启动时迁移清单分别演化，彼此失去同步。
- **建议修复：** 引入带版本表、有序 checksum 和失败即终止语义的迁移执行器；CI 必须从空数据库开始执行迁移并启动完整应用；根据迁移重新生成标准 schema，或移除 `schema.sql` 安装路径。

### HI-02 — 同一审批可能重复执行 SQL

- **严重程度 / 分类：** High，已确认缺陷
- **文件：** `apps/db-ops-api/src/approval-service.ts:133-190`
- **证据 / 复现：** 审核流程先执行 `SELECT ... status='pending'`，再执行 SQL，最后更新审批记录。全程没有事务、行锁、租约或 compare-and-swap。两个并发审核请求可以同时读到 pending，并在任一请求提交状态前各执行一次 SQL。
- **影响：** 非幂等 DML/DDL 可能执行两次，造成数据破坏；审批记录还可能隐藏其中一次执行。
- **根因：** 工作流状态迁移与外部副作用被设计成顺序调用，而不是原子状态机。
- **建议修复：** 通过 `UPDATE ... WHERE status='pending'` 原子认领 pending -> executing，并要求 `affectedRows=1`；记录执行幂等键；在事务中持久化最终状态；为 `executing` 租约设计重试和恢复机制。

### HI-03 — REST、refresh 和 WS 对用户停用/撤销的执行不一致

- **严重程度 / 分类：** High，已确认缺陷
- **文件：** `apps/db-ops-api/server.ts:96-118,401-438`；`apps/db-ops-api/src/adapter/direct-adapter.ts:230-253`
- **证据 / 复现：** REST token 校验在用户状态查询失败时采用 fail-open；即使 `getUserById()` 返回 null 或 inactive，refresh 仍会签发新 token；WS 只校验 JWT 签名，不重新加载用户状态、角色或权限。
- **影响：** 被停用或删除的用户仍可能恢复或保留访问权，WS 路径尤其明显；短暂数据库故障会扩大授权，而不是安全失败。
- **根因：** 三条认证路径实现了不同的撤销策略，JWT 中也没有撤销版本或会话版本。
- **建议修复：** 集中实现 token 校验；受保护操作必须 fail-closed；refresh 和 WS 认证时校验活跃用户及 token/会话版本；用户状态、密码或角色变更时撤销 refresh token；定期重验长连接 WS 会话。

### HI-04 — AI 分析结构化结果可触发存储型 XSS

- **严重程度 / 分类：** High，已确认缺陷
- **文件：** `frontend/src/app/ui/views/ai-analysis-result.ts:14-18,24-63,270-281`
- **证据 / 复现：** 字符串 Markdown 只经过不完整的正则清洗；对象摘要、key 和嵌套值则未经转义直接拼接为 HTML，最终字符串交给 `unsafeHTML`。持久化对象中类似 `<img src=x onerror=...>` 的值会进入 DOM。
- **影响：** 恶意数据库内容、工具输出或被攻陷的 LLM/provider 输出可在管理员已认证源中执行脚本，窃取 token 或代为调用 API。
- **根因：** 展示层通过字符串拼接 HTML，并依赖黑名单正则，而不是可信 sanitizer 和自动转义模板。
- **建议修复：** 结构化对象使用 Lit 绑定渲染；Markdown 使用按允许标签配置的 DOMPurify；非必要时禁用主动链接和图片；增加包含 XSS payload 的浏览器回归测试。

### HI-05 — 多数纳管实例 critical 时“闭环健康”仍显示全绿

- **严重程度 / 分类：** High，已确认缺陷
- **文件：** `apps/db-ops-api/src/consistency-checker.ts:66-95,181-235,575-640`；`frontend/src/app/ui/views/health-center.ts:205-229,330-350`
- **证据 / 复现：** 2026-07-16，`/api/health/consistency` 返回 9 pass、0 fail 和“全部就绪”；同时 `/api/database/instances` 返回 5 个活跃实例，其中 4 个 `health_score=0/status=critical`。`db_reachable` 实际只测试 Slide 主 MySQL；指标新鲜度只查询全局一条 `MAX(recorded_at)`；活跃实例数量将“已配置”当成“健康”。
- **影响：** 运维人员会收到错误的生产就绪信号，可能遗漏大范围数据库不可用。
- **根因：** 准备度标签和聚合语义与实际测量对象不一致，可用性按全局聚合，而不是按所有必需目标计算。
- **建议修复：** 按实例计算连接性、新鲜度和健康状态；展示分母和失败目标；区分控制面准备度与纳管目标健康；任何关键依赖或目标失败时限制总体健康度上限。

### HI-06 — 实例与服务器告警评估使用不兼容的规则语义

- **严重程度 / 分类：** High，已确认缺陷
- **文件：** `apps/db-ops-api/src/alert-evaluator.ts:333-370`；`apps/db-ops-api/src/server-alert-evaluator.ts:54-63,95-145,276-288`
- **证据 / 复现：** 实例评估器加载全部启用规则，却从不筛选 `target_type='instance'`，因此服务器规则也会对数据库实例求值。服务器评估器虽然筛选 target type，但忽略多级 `threshold_template` 和 `duration_seconds`，只用最新样本与单一数值阈值比较。
- **影响：** 告警可能作用于错误资源、使用错误级别或过早触发；恢复、去重和下游 RCA 都会基于错误事件运行。
- **根因：** 两个评估器共享同一张规则表，却没有共享标准化规则契约。
- **建议修复：** 在单一入口标准化并校验目标专属规则；在 SQL 层强制 target 过滤；复用级别、持续时间和宏解析逻辑；增加同名指标分别作用于实例和服务器的端到端 fixture。

### HI-07 — 服务器指标注册 ID 与实际采集名称不一致

- **严重程度 / 分类：** High，已确认缺陷
- **文件：** `apps/db-ops-api/src/metric-registry.ts:469-510`；`apps/db-ops-api/src/server-collector.ts:163-205`；`apps/db-ops-api/sql/migrations/022_unified_observability.sql:61-63`
- **证据 / 复现：** 注册表将服务器指标重命名为 `server_cpu_usage/server_memory_usage/server_disk_usage`，采集器和种子规则却仍使用 `cpu_usage/memory_usage/disk_usage_*`。运行数据库中存在 6,517 条以上使用实际采集名称的服务器指标，但服务器目标指标定义为 0 条。
- **影响：** 注册表 API、规则编辑器和校验逻辑无法发现或引用真实时序数据；告警和报表使用的指标与公开定义不一致。
- **根因：** Phase 129 为解决注册表 ID 冲突进行了重命名，却没有同步迁移生产者、规则和存量数据。
- **建议修复：** 定义标准的 `(target_type, metric_id)` 标识；迁移定义、规则和数据，或在入库时统一映射；在 CI 和运行时健康检查中强制校验生产者与注册表的引用关系。

### HI-08 — 服务器告警 RCA 无法创建或持久化

- **严重程度 / 分类：** High，已确认缺陷
- **文件：** `apps/db-ops-api/src/alert-rca-service.ts:39-58,107-114`；`apps/db-ops-api/sql/schema.sql:625-649`
- **证据 / 复现：** RCA 会拒绝所有没有 `instance_id` 的告警。`ai_analysis.instance_id` 为 NOT NULL，表中也没有 `server_id`；运行中的 schema 与此一致。
- **影响：** 尽管 Phase 128/129 声称完成服务器 AI 集成，服务器告警仍无法完成 AI 分析。
- **根因：** 告警 schema 增加了服务器归属，但分析 schema 和服务仍仅支持实例目标。
- **建议修复：** 显式建模分析目标：加入 `target_type`，让 `instance_id/server_id` 可空但满足互斥 CHECK；同步更新缓存键、提示词、工具上下文和 UI 筛选；迁移存量数据并增加服务器 RCA 集成测试。

### HI-09 — 定时报表和服务器范围报表没有形成业务闭环

- **严重程度 / 分类：** High，已确认缺陷
- **文件：** `frontend/src/app/ui/views/reports.ts:360-400,428-550,577-680`；`apps/db-ops-api/src/cron/cron-job-service.ts:187-200`；`apps/db-ops-api/src/server-report-service.ts:83-109,204-218`；`apps/db-ops-api/src/report-database-service.ts:188-206`
- **证据 / 复现：** 前端会加载报表配置，也实现了私有 CRUD 方法，但没有渲染定时配置列表、按钮或对话框。种子“定时报表调度”任务只是一段自然语言 Agent 提示词，注册工具中没有任何工具引用 `report_configs` 或报表生成。运行数据库中的配置数为 0。`generateAndPersist(serverIds)` 仍调用读取全部服务器的 `generateReport()`；报表列表也没有派生 `target_type`，服务器报表因此被标为实例报表。
- **影响：** 管理员无法配置定时报表；调度无法确定性执行；单服务器报表可能包含其他服务器，且归属显示错误。
- **根因：** API、隐藏的前端代码、LLM Cron 和报表持久化分别实现，没有端到端功能负责人。
- **建议修复：** 建立确定性报表调度器，读取到期配置并调用类型化报表服务；公开并测试配置 UI；让 `generateReport(serverIds)` 真正按输入过滤；派生或持久化目标类型；校验 `instance_id XOR server_id`；测试“创建 -> 到期 -> 生成 -> 列表 -> 下载/通知”全链路。

### HI-10 — LLM/Agent 失败被持久化并推送为成功完成

- **严重程度 / 分类：** High，已确认缺陷
- **文件：** `packages/agent-core/src/runner.ts:333-347,404-413`；`apps/db-ops-api/src/adapter/direct-adapter.ts:432-477`；`apps/db-ops-api/src/ai-agent-bridge.ts:60-83`
- **证据 / 复现：** AgentRunner 遇到失败时返回 `{stopReason:'error', error}` 而不抛异常。DirectAdapter 忽略这两个字段，清除 checkpoint 并发送 `type:'complete'`。AI Bridge 对任何正常 resolve 的 invoke 结果都无条件调用 `completeAnalysis()`。
- **影响：** 用户会把失败或不完整回答视为已完成；失败的 RCA/诊断会被缓存为成功分析，可能阻止后续重试和升级。
- **根因：** Adapter 契约将 Promise resolve 等同于业务成功，没有解释领域结果中的失败状态。
- **建议修复：** 将终态结果改为判别联合；对于 `error`、`tool_error`、超时和达到最大迭代次数，发送并持久化 failed/partial 状态；按恢复语义保留 checkpoint；增加 provider 失败、超时和部分工具失败的端到端测试。

### HI-11 — 通知闭环被禁用，泄露敏感配置且仍可被 SSRF 绕过

- **严重程度 / 分类：** High，已确认缺陷
- **文件：** `apps/db-ops-api/server.ts:2940-2949,4600-4602`；`apps/db-ops-api/src/notification-service.ts:342-375,416-450`
- **证据 / 复现：** 列表 API 返回完整渠道 `config`，实时响应包含 webhook URL 等敏感配置；通知轮询被明确禁止启动。URL 校验只解析一次 DNS，DNS 失败仍放行；随后原生 fetch 会自动跟随重定向，却不会再次校验解析地址或重定向目标。
- **影响：** 拥有查看权限的用户可获取通知投递凭据；攻击者控制的渠道可借助重定向或 DNS rebinding 访问内网；告警也无法自动完成承诺的通知闭环。
- **根因：** 持久化 DTO 被直接作为响应返回；SSRF 校验与实际 socket/重定向链脱节；通知服务长期处于 deferred 状态。
- **建议修复：** 返回脱敏 DTO，将 secret 设计为只写；使用 allowlist，或固定解析出的公网 IP，并禁用或逐跳重验重定向；DNS 解析失败必须拒绝；启动带重试、死信和审计状态的持久 outbox worker；增加通知闭环测试接口。

### HI-12 — HTTP 端口取得前就已启动进程副作用

- **严重程度 / 分类：** High，已确认缺陷
- **文件：** `apps/db-ops-api/server.ts:4577-4660,5048-5056`
- **证据 / 复现：** Agent WS、采集器、告警评估器、升级任务、数据库重连/健康写入、Cron 和日志 reaper 都在 `fastify.listen()` 之前启动。启动第二个后端进程时，这些副作用先发生，进程最后才因 3000/28888 端口占用退出。
- **影响：** 部署竞态或误启动重复进程会重复执行任务、修改健康/日志状态和调用工具，即使该进程从未成为对外服务实例。
- **根因：** 资源获取和副作用生命周期没有顺序保证，也不能作为一个整体回滚。
- **建议修复：** 先校验配置和 schema，再取得 HTTP/WS listener 或分布式 leader lease，之后才启动 worker；任何失败都应停止已启动组件；增加优雅退出和重复启动测试。

### HI-13 — 凭据初始化和实例 API 暴露可恢复的敏感信息

- **严重程度 / 分类：** High，已确认缺陷
- **文件：** `apps/db-ops-api/src/instance-database-service.ts:53-72,82-103`；`apps/db-ops-api/server.ts:600-604,1182-1190`；`apps/db-ops-api/src/db-connection.ts:112-127`；`apps/db-ops-api/sql/schema.sql:816-823`；`apps/db-ops-api/init-db.ts:61-64`
- **证据 / 复现：** 实例列表/详情查询和返回 `password_encrypted`；列表接口只要求有效 token，不要求 `instance:view` 或实例级授权。实时响应暴露了全部 5 个实例的密文。加密在缺少配置时回退到公开常量；schema 以固定 SHA-256 密码种子化 admin 和 user，且两者 hash 相同，而初始化输出声称 user 使用另一密码。
- **影响：** 任意已认证用户都可导出密文和元数据；使用默认值或 fallback 的部署允许离线恢复明文并攻击默认账户。
- **根因：** 数据库实体直接复用为响应 DTO；启动时允许缺少 secret；开发初始化路径同时被当作生产安装路径。
- **建议修复：** 缺少强随机且独立的 secret 时拒绝启动；使用带认证的加密或 KMS，并支持密钥版本；任何响应都不得包含凭据字段；实例列表/详情强制权限检查；首次启动要求显式创建管理员并轮换密码；移除固定账户和固定 hash。

### ME-01 — Chat 停止/中止控件不会取消任务

- **严重程度 / 分类：** Medium，已确认缺陷
- **文件：** `frontend/src/app/ui/app-chat.ts:60-95,279-281`；`frontend/src/app/ui/app.ts:636-638`；`apps/db-ops-api/src/adapter/direct-adapter.ts:259-364`
- **证据 / 复现：** `/stop`、Stop 和其他 abort 别名只会调用清空 `chatMessage` 的 handler。服务端没有 `chat.abort` WS 命令，也没有 AbortController 或运行中任务注册表。
- **影响：** 长时间运行的 LLM/工具调用会继续消耗 token，并可能在操作者认为任务已停止后继续执行状态修改。
- **根因：** 保留了上游 UI 交互，但没有迁移取消协议。
- **建议修复：** 服务端按 run id 跟踪 AbortController；实现已授权、按会话限定的 abort，并发送 cancelled 终态事件；不支持时应禁用或准确标注控件；测试模型流式输出和工具执行期间的取消。

### ME-02 — 附件和幂等信息在 DirectGateway/WS 链路中丢失

- **严重程度 / 分类：** Medium，已确认缺陷
- **文件：** `frontend/src/app/ui/app-chat.ts:140-180,260-341`；`frontend/src/app/ui/direct-gateway.ts:142-148,233-244`；`apps/db-ops-api/src/adapter/direct-adapter.ts:255-289`
- **证据 / 复现：** Chat 会构造附件和请求元数据，但 gateway 只发送 `sessionKey` 和 `message`。服务端幂等 Set 在每条消息回调内部重新创建，因此即使客户端发送幂等键，也无法去重下一条消息。
- **影响：** 用户附件被静默丢弃；断线重连或重试可能重复执行模型和工具调用。
- **根因：** 兼容 shim 缩窄了协议字段，去重状态的生命周期也设置错误。
- **建议修复：** 对包含附件、run id 和幂等键的共享消息 schema 进行版本化和校验；按用户/会话持久化带 TTL 的去重键；对不支持的附件类型给出明确错误。

### ME-03 — 每指标采集周期没有生效

- **严重程度 / 分类：** Medium，已确认缺陷
- **文件：** `apps/db-ops-api/src/monitor-collector.ts:129-176`；`apps/db-ops-api/src/collector.ts:39-71`
- **证据 / 复现：** 调度器从全部采集指标中取全局最小周期并赋给每个实例；每次 tick 时，`collectInstance()` 又会采集全部定义。
- **影响：** 低频指标被过度采集，增加数据库负载；操作员无法依赖所配置的采集周期进行容量规划。
- **根因：** 调度状态按实例建模，而配置粒度是指标。
- **建议修复：** 调度到期的 `(instance, metric/provider)` 工作；同一 tick 只合并真正到期的指标；公开每个指标的上次和下次采集时间。

### ME-04 — “连续三次失败自动禁用采集器”没有按描述工作

- **严重程度 / 分类：** Medium，已确认缺陷
- **文件：** `apps/db-ops-api/src/collectors/registry.ts:28-68`；`apps/db-ops-api/src/collector.ts:53-68`
- **证据 / 复现：** `getProvidersByDbType()` 调用 `list()`，仍返回注册表中已禁用 provider。`disable()` 只修改注册表包装对象，但采集器检查的是 `provider.enabled`；成功采集也从不调用 `resetFailures()`。因此禁用无效，任意时间累计三次失败都会被当成连续失败。
- **影响：** 已损坏 provider 仍持续运行和记录错误；间歇失败也可能生成误导性的禁用状态。
- **根因：** provider 和 registry 同时保存启用/失败状态，没有唯一事实来源。
- **建议修复：** 只返回 registry 中启用的条目；移除重复的 provider flag；成功后重置计数；明确计数按 provider、实例还是指标隔离；测试“失败-成功-失败”序列。

### ME-05 — Agent 管理页面暴露无效配置和不可用标签页

- **严重程度 / 分类：** Medium，已确认缺陷
- **文件：** `frontend/src/app/ui/app-render.ts:661-687`；`frontend/src/app/ui/views/agents-panels-status-files.ts:3-12`；`frontend/src/app/ui/views/agents-panels-tools-skills.ts:3-12`；`frontend/src/app/ui/views/agents-panels-overview.ts:138-218`
- **证据 / 复现：** Overview 的模型、fallback 和 reload 控件都绑定空回调，用户无法让表单进入 dirty 状态或保存选择。Files、Tools、Skills 和 Cron 标签仍可见，却只渲染“DirectAdapter 模式下此功能暂不可用”。浏览器遍历确认这些入口均可访问。
- **影响：** 操作员会误以为 Agent 策略、模型和配置可管理，但操作没有效果；同时掩盖 CR-01 的策略失效问题。
- **根因：** DirectAdapter 替换后保留了上游 UI，却没有实现基于能力的导航和适配层。
- **建议修复：** 根据协商能力隐藏不支持的功能面；将支持的模型/会话设置接入 REST 并提供反馈；移除空回调并增加按钮全链路测试。

### ME-06 — 声明支持 MongoDB、Redis 和 Elasticsearch，但没有实现兼容路径

- **严重程度 / 分类：** Medium，已确认缺陷
- **文件：** `apps/db-ops-api/src/instance-database-service.ts:7-22`；`apps/db-ops-api/src/database-service.ts:161-301`；`apps/db-ops-api/src/collectors/*.provider.ts`；`frontend/src/app/ui/views/instances-db.ts:1034-1040`
- **证据 / 复现：** 类型、schema 和文档接受 MongoDB/Redis/Elasticsearch，但前端只提供 MySQL/PostgreSQL/Oracle/Dameng；连接服务对其他类型返回不支持；采集器也没有对应 provider。
- **影响：** API 或导入数据可以包含运行时无法连接、监控、查询或健康检查的类型，产品兼容性声明具有误导性。
- **根因：** 持久化 enum 在实际 adapter 和能力门控之前被提前扩展。
- **建议修复：** 从公开契约和文档中移除未支持类型，或实现具有功能能力矩阵和集成环境的完整 adapter；创建和更新请求必须拒绝未支持类型。

### ME-07 — 核心业务关联、审批审计和回滚没有真正约束

- **严重程度 / 分类：** Medium，已确认缺陷
- **文件：** `apps/db-ops-api/sql/schema.sql:119-205,230-258,883-918,1084-1103,1281-1303`；`apps/db-ops-api/sql/migrations/024_data_loom_integration.sql:9-23,56-63`；`apps/db-ops-api/src/audit/audit-log.ts:220-243`
- **证据 / 复现：** 运行时元数据只有 18 个 FK，大多数实例指标、健康、告警、审批、Chat 和审计关联都没有约束。`approval_request_id` 只有索引；尽管存在 11 条审批记录，55 条 SQL 历史中该字段全部为空。`rollback_info` 只出现在 schema/migration 中，业务代码从未读写。
- **影响：** 删除和重试后会长期保留孤儿记录或错误审计链；操作员无法证明某次执行由哪条审批授权，也不能执行文档承诺的回滚。
- **根因：** 关联 ID 作为可选报表字段加入，却没有接入领域写入路径和数据库约束。
- **建议修复：** 定义数据保留和删除策略，并添加 FK 或显式归档约束；将审批 ID 贯穿 SqlExecutor 和审计链；在事务中记录执行与回滚尝试；增加一致性检查和数据回填/修复迁移。

### LO-01 — 异常导航和登录本地化存在可见故障

- **严重程度 / 分类：** Low，已确认缺陷
- **文件：** `frontend/src/app/ui/views/health-center.ts:193-202`；`frontend/src/app/ui/app.ts:464-476`；`frontend/src/app/ui/views/settings-shell.ts:45-50`
- **证据 / 复现：** 健康页面链接发送不存在的 tab `instances` 和字段 `settingsTab`，应用实际要求 `instances-db`，设置壳要求 `settingsSubTab`。登录页显示原始 key `overview.access.username/password`；初次加载还会在认证前触发受保护的偏好/品牌接口 401。
- **影响：** 恢复建议会在系统异常时恰好无法导航，首次使用的错误反馈也显得未完成。
- **根因：** 导航事件 payload 和 i18n key 都是未测试的字符串契约。
- **建议修复：** 使用类型化导航 helper/route；修正 payload 字段；补全翻译 key；认证完成前不要发起受保护请求。

## 高风险设计问题

除非已在上文确认，这些问题不计入已确认功能缺陷；但其失败概率和影响范围过高，不适合直接进入生产。

### DR-01 — 关键业务 Cron 任务依赖自由文本 LLM 提示词

- **严重程度 / 分类：** High，高风险设计问题
- **文件：** `apps/db-ops-api/src/cron/cron-job-service.ts:187-200`；`apps/db-ops-api/src/cron/cron-manager.ts:120-187`
- **证据：** 容量、schema、索引、RCA、报表和清理任务均以自然语言描述并交由 Agent 执行；其中多项任务要求的能力没有对应工具。
- **影响：** 行为会随模型、provider 和 prompt 改变，成本高，难以幂等重试，也无法保证必需的持久化写入发生。
- **根因：** 调度编排和确定性领域执行被混合在同一机制中。
- **建议修复：** 确定性任务使用类型化 job handler；LLM 只用于边界清晰的分析步骤，并校验结构化输入/输出和明确完成条件。

### DR-02 — Worker 协调仅存在于单进程内存中

- **严重程度 / 分类：** High，高风险设计问题
- **文件：** `apps/db-ops-api/src/cron/cron-manager.ts:120-187`；`apps/db-ops-api/src/alert-rca-service.ts:60-73`；`apps/db-ops-api/src/adapter/direct-adapter.ts:130-131,255-289`
- **证据：** 运行标志、RCA 锁、订阅关系和去重缓存都只是单进程中的 Set/Map，没有持久租约或 leader election。
- **影响：** 横向扩容、进程重启或重复启动会重复执行任务/分析，并丢失取消和订阅状态。
- **根因：** 工作流正确性依赖单进程开发环境假设。
- **建议修复：** 引入基于数据库或 Redis 的租约、幂等和 outbox 状态，并明确部署模式是单 leader 还是分布式 worker。

### DR-03 — 迁移执行没有可观测状态且吞掉失败

- **严重程度 / 分类：** High，高风险设计问题
- **文件：** `apps/db-ops-api/server.ts:149-167`
- **证据：** 迁移清单为人工维护的子集；语句和文件执行都被空 catch 包裹；没有 schema 版本、checksum 或启动不变量。
- **影响：** 两套使用不同 schema 和行为的部署都可能报告健康。
- **根因：** 将“尽力兼容”逻辑错误地当成正式迁移系统。
- **建议修复：** 采用 HI-01 中的迁移账本和 fail-fast 方案，并在健康信息和构建元数据中公开 schema 版本。

### DR-04 — 健康、可用性和一致性共用一个无权重百分比

- **严重程度 / 分类：** Medium，高风险设计问题
- **文件：** `frontend/src/app/ui/views/health-center.ts:205-239`；`apps/db-ops-api/src/consistency-checker.ts:643-670`
- **证据：** 通过数量排除 deferred 项，并将孤儿数据检查与 Agent/数据库可用性赋予同等权重；准备度单独显示，但不限制健康分。
- **影响：** 即使关键依赖不可用，新增普通检查也可能提高健康百分比。
- **根因：** 健康被建模为检查清单完成率，而不是服务目标和依赖状态。
- **建议修复：** 使用带关键门禁的健康维度，显式表达 unknown/deferred，并按目标覆盖率计算，而不是使用单一通过比例。

## 用户故事与功能闭环矩阵

| 用户故事 | UI | API/认证 | 持久化状态 | 反馈/恢复 | 闭环结论 |
|---|---|---|---|---|---|
| 登录并撤销用户 | 可用 | REST 检查活跃用户；refresh/WS 不一致 | refresh token | 部分 | **未闭环**（HI-03） |
| 添加/测试/管理数据库实例 | 仅 MySQL/PG/Oracle/DM | CRUD 可用；列表授权不足 | 凭据/健康 | 可见连接错误 | **部分闭环**（HI-13、ME-06） |
| 查看实例健康 | 页面可用 | 指标 API 可用 | 已采集历史 | 健康中心错误全绿 | **未闭环**（HI-05） |
| 执行只读 SQL | 可用 | 接口可用 | 写入历史 | 返回错误 | **部分闭环**（CR-03 边界失效） |
| 提交/审批 DML | 可用 | 审批 API 可用 | 请求/事件 | 存在重复竞态，无审计关联/回滚 | **未闭环**（HI-02、ME-07） |
| 接收实例告警 | 可用 | 评估器运行 | 告警/事件 | 可能混入错误目标 | **部分闭环**（HI-06） |
| 接收服务器告警 | UI 存在 | 评估器运行 | 指标/告警 | ID、级别和持续时间不一致 | **未闭环**（HI-06、HI-07） |
| 获取告警 RCA | 有实例路径 | Agent 调用 | `ai_analysis` | 失败可能显示完成 | **部分闭环**（HI-10） |
| 获取服务器 RCA | UI 入口存在 | 无实例 ID 时被拒绝 | 无法保存目标 | 无恢复路径 | **未闭环**（HI-08） |
| 接收通知 | 设置/API 存在 | 渠道 API 可用 | 配置/记录 | worker 禁用，存在 secret/SSRF 风险 | **未闭环**（HI-11） |
| 生成实例报表 | UI/API 可用 | 有报表权限 | 报表记录 | 可查看/下载 | **基本闭环** |
| 生成单服务器报表 | UI/API 可用 | 接受服务器 ID | 报表记录 | 内容忽略范围且标签错误 | **未闭环**（HI-09） |
| 配置定时报表 | 仅有隐藏方法 | 配置 API 存在 | 已迁移数据库有表 | 无确定性执行器 | **未闭环**（HI-09） |
| 与 Agent 对话 | 浏览器可用 | JWT WS | 消息/会话 | 失败和停止处理有问题 | **安全和可靠性均未闭环**（CR-01/02、HI-10、ME-01/02） |
| 管理 Agent 模型/工具 | 控件和标签可见 | 部分 API 存在 | 配置/会话元数据 | 无操作/不可用 | **未闭环**（ME-05） |
| 配置指标采集周期 | 注册表 UI/API | 接受更新 | 指标定义 | 调度器忽略单指标周期 | **未闭环**（ME-03） |
| 全新安装/恢复 | 有初始化命令 | 启动尽力继续 | 不完整 schema | 失败延迟暴露 | **未闭环**（HI-01） |

## 架构与数据流缺陷摘要

| 边界 | 断点 | 下游后果 |
|---|---|---|
| 身份 -> Agent 工具 | 执行主体和策略被移除 | 绕过 RBAC 与审批 |
| 身份 -> Chat 数据 | 未查询会话所有权 | 跨用户泄露和修改 |
| SQL 控制台 -> 审批 | 直接执行分支跳过分类器 | 可执行任意写操作 |
| 审批 -> 目标数据库 -> 审计 | 非原子；审批 ID 丢失 | 重复执行且无法归因 |
| 迁移 -> 运行时 | 缺少有序前置依赖 | schema 随环境变化 |
| 注册表 -> 服务器采集/规则 | 指标 ID 不兼容 | 指标无法发现、无法告警 |
| 告警目标 -> 评估器 | 目标和阈值语义分叉 | 事件错误或缺失 |
| 服务器告警 -> RCA | 分析 schema 仅支持实例 | 无服务器分析 |
| 报表配置 -> 调度器 | 缺少 UI 和确定性执行器 | 无定时报表 |
| AgentRunner -> adapter/持久化 | 错误结果被解释为完成 | 假成功并阻止重试 |
| 通知配置 -> fetch | 返回 secret 且目标地址未固定 | 凭据暴露和 SSRF |
| 纳管目标 -> 健康中心 | 用全局最新值/控制库替代目标状态 | 错误生产就绪结论 |

## 测试覆盖缺口

### TG-01 — 失败的测试基线没有成为发布门禁

- **严重程度 / 分类：** High，测试缺口
- **文件：** 前后端测试套件；`apps/db-ops-api/tsconfig.json:9`
- **证据：** 后端 18 失败、760 通过、4 跳过，另有 1 个测试套件无法加载；前端 41 失败、140 通过、18 跳过；Agent Core 1 失败、67 通过。后端 TypeScript 5.9.3 遇到 `ignoreDeprecations:"6.0"` 后，在检查业务代码前就失败。
- **影响 / 根因：** CI 没有强制保持干净基线，因此回归和陈旧测试持续累积。
- **建议修复：** 统一受支持的工具链；后续功能开发前，将所有必需 job 恢复为零失败。

### TG-02 — 缺少对抗性授权和并发测试

- **严重程度 / 分类：** High，测试缺口
- **文件：** `src/auth/*test.ts`、DirectAdapter 测试、审批测试
- **证据：** 没有双用户会话隔离、危险工具策略、停用用户 WS/refresh、直接 DML 拒绝或并发审批执行测试。
- **影响 / 根因：** 测试只验证组件而不验证安全边界，因此三个 Critical 问题都通过了历史 Phase 验证。
- **建议修复：** 使用真实数据库事务和 WS 客户端增加多主体集成测试和竞态测试。

### TG-03 — Schema 校验器产生错误绿灯

- **严重程度 / 分类：** Medium，测试缺口
- **文件：** `apps/db-ops-api/tests/schema-validator.ts`；`apps/db-ops-api/sql/schema.sql`
- **证据：** 全新 schema 缺少核心表和迁移依赖时，validator 仍报告 10 通过/0 失败，因为它只检查少量 enum 字面量。
- **影响 / 根因：** “Schema 一致性”没有验证可安装性，也没有覆盖运行时查询。
- **建议修复：** 在空 MySQL 上启动，执行全部迁移，对比预期表、列和 FK，再运行 repository/service 冒烟查询。

### TG-04 — 浏览器 E2E 测试不能证明工作流闭环

- **严重程度 / 分类：** Medium，测试缺口
- **文件：** `frontend/e2e/interaction.spec.ts:92-115,121-179`；`frontend/e2e/smoke.spec.ts:37-59`
- **证据：** 大量测试只打印空白/错误状态，从不通过断言使测试失败；导航 helper 会静默跳过缺失控件。未发现前端 Playwright config/baseURL，所需浏览器版本也没有安装。
- **影响 / 根因：** “遍历通过”可能只是页面空白，或关键 CRUD 步骤被跳过。
- **建议修复：** 增加确定性 fixture；对状态、API、持久化、toast 和刷新进行强断言；必需用户故事不得静默 skip。

### TG-05 — 兼容性 UAT 尚未完成

- **严重程度 / 分类：** Medium，测试缺口
- **文件：** `.planning/phases/95-dameng-database-support/95-UAT.md`；`.planning/phases/110-directadapter-switch/110-UAT.md`；`.planning/phases/84-rbac-foundation/84-UAT.md`
- **证据：** STATE 仍保留 4 项未完成的 Dameng 检查、6 项 DirectAdapter 检查和 2 项 RBAC 检查；Mongo/Redis/Elasticsearch 没有集成测试套件。
- **影响 / 根因：** 声明的兼容性和 WS 恢复行为没有形成发布证据。
- **建议修复：** 维护可复现的容器 fixture，并为每种支持的后端运行 CRUD、查询、指标、健康和失败恢复矩阵。

### TG-06 — 源码正则和陈旧 mock 测试掩盖真实行为

- **严重程度 / 分类：** Medium，测试缺口
- **文件：** `frontend/src/app/ui/views/__tests__/oracle-instance-detail.test.ts`；`frontend/src/app/ui/views/__tests__/navigation-cleanup.test.ts`；后端事件/采集器测试
- **证据：** Oracle 安全测试因代码移动到 `instance-overview-tab.ts` 而失败，但该文件实际已有 null guard；其他失败仍期待旧导航，或 mock `execute`，而当前代码使用 `query`。
- **影响 / 根因：** 失败数同时混入真实回归和过时断言，降低测试可信度并拖慢诊断。
- **建议修复：** 优先编写行为级组件/服务测试；发生有意契约变更时同步更新 fixture；删除仅匹配源码字符串的断言。

## 延期事项审计

| STATE 项目 | 当前证据 | 处理结论 |
|---|---|---|
| `cron-jobs-all-disabled` | 实时数据库中 3 个任务已启用、7 个已禁用；日志有 1,157 次成功、20 次错误 | 原始事件已不再是当前状态；记录预期启用的任务集合后可关闭调试文档 |
| `dashboard-capacity-and-alert-events` | Capacity 有 16,682 行且时间戳为当前时间；告警事件有效，但最新事件已陈旧 | Capacity 症状由环境造成；事件 API 无边界的问题仍需通过分页测试和修复解决 |
| `null-metrics-database-instances` | 5 个活跃实例中仍有 4 个处于 critical/不可达状态 | 环境状态真实存在；应用缺陷是错误全绿的聚合逻辑（HI-05） |
| Phase 110 UAT | 6 项待处理 | 仍未关闭；CR-01/02 和 ME-01/02 导致当前不能安全验收 |
| Phase 95 UAT | 4 项待处理 | 仍未关闭；声称支持 DM 前必须完成集成矩阵 |
| Phase 84 UAT | 2 项阻塞/跳过 | 使用多用户 RBAC fixture 重新执行 |
| 可配置 Cron TODO | 已有数据库 CRUD/UI，但固定 seed 提示词和独立的硬编码定时器仍然存在 | 仅部分完成；应使用显式任务 handler/配置替换领域定时器和提示词 |

## 文档与实现偏差

1. `STATE.md` 声称 v0.8 已完成且全部六个 Phase 均通过，但 `REQUIREMENTS.md` 仍将 v0.8 的 31 项需求中的 24 项标记为待处理。
2. Phase 129 Verification 声称有六项服务器指标可用；当前数据库返回的服务器指标定义为零，实际采集名称也已与注册表名称不一致。
3. Phase 129 Review-Fix 声称单服务器报表生成问题已修复；当前服务生成内容时仍忽略 `serverIds`。
4. Phase 128/129 声称已完成服务器 RCA/AI 集成；当前 RCA 会拒绝服务器告警，schema 也无法存储其目标。
5. Phase 127 声称定时报表已闭环；当前 UI 没有渲染配置入口，Cron 也没有确定性的报表配置或生成工具路径。
6. Phase 130 UAT 声称验证结果干净；当前源码测试仍大面积失败，schema 仍创建已弃用的指标模板表，而运行时模型与之不同。
7. AGENTS/项目架构列出 MySQL、Elasticsearch、MongoDB 和 Redis，但只有 MySQL、PostgreSQL、Oracle 和 Dameng 存在连接与采集路径。
8. `SqlExecutor` 注释称仅允许 SELECT，规划又将 DML 定义为必须审批，但公共执行接口实际会运行任意语句。

## 优化建议（非缺陷）

### OPT-01 — 拆分前端生产包

- **严重程度 / 分类：** Low，仅优化建议
- **文件 / 证据：** Vite 构建生成的 `index-*.js` 为 2,776.59 kB（gzip 后 827.21 kB），并对超过 500 kB 的 chunk 发出警告。
- **影响 / 根因：** 首次加载较慢；大量页面和组件被静态引入应用壳层。
- **建议：** 在功能和安全缺陷修复后，引入路由级懒加载和稳定的 vendor chunk。

### OPT-02 — 移除无效的兼容 UI 和中英文混杂文案

- **严重程度 / 分类：** Low，仅优化建议
- **文件 / 证据：** Agents/Sessions 上游功能界面和大量英文标签仍保留在中文运维产品中。
- **影响 / 根因：** 增加认知和维护成本，但本身不属于正确性缺陷。
- **建议：** 只保留已协商支持的 DirectAdapter 能力，并补齐 i18n 覆盖。

### OPT-03 — 生成类型化 API 契约

- **严重程度 / 分类：** Low，仅优化建议
- **文件 / 证据：** 导航事件、REST DTO 和报表目标类型以重复的字符串契约分散在 `server.ts` 和 Lit 中。
- **影响 / 根因：** `settingsTab/settingsSubTab` 以及缺失 `target_type` 一类契约漂移会反复发生。
- **建议：** 引入 OpenAPI/TypeBox schema，并逐步生成前端客户端和类型。

## 建议的修复 Phase

| 建议 Phase | 优先级 / 依赖 | 范围与退出门禁 |
|---|---|---|
| **132 — 安全边界** | P0，首先执行 | 修复 CR-01/02、HI-03/04/11/13；双用户、危险工具、XSS 和敏感信息脱敏测试通过 |
| **133 — SQL 安全与审批状态机** | P0，依赖 132 的身份上下文 | 修复 CR-03、HI-02、ME-07；实现方言分类器、原子认领、审计/回滚关联和并发测试 |
| **134 — 确定性 schema 初始化** | P0，可与 132 并行 | 替换启动期迁移；空数据库安装/升级/回滚 CI；迁移失败不得被吞掉 |
| **135 — Agent/WS 正确性** | P1，依赖 132 | 修复 HI-10、ME-01/02/05；支持取消、附件、持久化幂等、失败状态及按能力控制的 UI |
| **136 — 可观测性真实状态模型** | P1，依赖 134 | 修复 HI-05/06/07、ME-03/04；实现按目标健康度、规范化指标标识和共享阈值/持续时间引擎 |
| **137 — 报表/RCA/通知闭环** | P1，依赖 135-136 | 修复 HI-08/09/11 的功能闭环；通过“确定性调度 -> 报表/RCA -> 持久化 -> 通知”UAT |
| **138 — 兼容性与 UX 契约** | P2，依赖 134/136 | 明确支持的数据库矩阵，完成 DM/Oracle UAT，移除或拒绝未支持类型，类型化导航/API DTO |
| **139 — 发布资格验证** | 最终门禁 | 测试和类型检查零失败；通过空数据库部署、重启/故障转移、浏览器工作流、安全回归、负载及备份恢复验证 |

## 生产可用性结论

**结论：NO-GO。** 至少在 Phase 132-134 完成、所有 Critical 缺陷关闭、审批/SQL 安全具备并发证据、全新数据库可复现安装、健康状态不再掩盖目标故障且必要测试/类型检查流水线全部通过前，必须阻止生产使用。当前实时健康接口和以往 Phase 的验证标签不足以作为发布依据。
