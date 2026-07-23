---
phase: 139-release-qualification
verified: 2026-07-23
status: complete
production_ready: true
decision: GO
---

# Phase 139 当前验证结果

本文是对当前状态的审计，不是对各 Phase 总结的复述。仅有源码映射或单元测试，不能单独关闭 Phase 131 的发布发现项。

## 当前已执行门禁

| 门禁 | 结果 | 证据 |
|---|---|---|
| 后端单元测试 | 通过 | `pnpm --filter slide-api test`：2026-07-23 通过 98 个文件、1001 项测试，包含契约生成、Fastify schema 编译、连接超时清理和独立指标速率基线。 |
| Workspace 发布测试 | 通过 | 2026-07-23：API 98 文件/1001 tests，前端 23 文件/188 tests，Agent Core 7 文件/69 tests。 |
| 后端类型检查 | 通过 | `pnpm --filter slide-api exec tsc --noEmit`。 |
| 前端类型检查与构建 | 通过，有警告 | `pnpm --filter slide-frontend typecheck && pnpm --filter slide-frontend build`；主入口 `847.91 kB`（gzip `201.76 kB`），重页面独立 chunk；charts vendor `1034.94 kB` 仍触发非阻断 chunk warning。 |
| Agent Core 类型检查与测试 | 通过 | `pnpm --filter agent-core typecheck && pnpm --filter agent-core test`：7 个文件、69 项测试通过。 |
| RCA 失败诊断 | 通过 | 2026-07-20，DirectAdapter 18/18、`ai-agent-bridge` 1/1 以及 API/Agent Core 类型检查通过。Provider 错误现在能经过 Agent Core、`DirectAdapter.invoke()` 和 `ai-agent-bridge` 持久化完整保留，不再只剩 `Agent run ended: error`。 |
| Lint | 通过，仍有警告债务 | `pnpm lint` 以 0 退出，0 errors、249 warnings；这不代表 lint 已完全无警告。 |
| CI 工作流与 Hosted CI | 通过 | `coverage-matrix.ts --check-ci .github/workflows/ci.yml` 通过；PR #3 run `29939147753` 的五个 jobs 全绿并发布可校验 artifact。当前增量以 PR 最新 head checks 为准。 |
| 空库安装与重复初始化 | 通过 | `bootstrap-upgrade`：2026-07-20 在 51 migrations 下通过 schema invariant；此前 49-migration 契约也在用户提供的 `mysql3307` MySQL 9（端口 3307）独立通过。 |
| 健康检查持久化 schema | 通过 | Migration `048_health_check_dimensions_parity.sql` 恢复 `recordHealthCheck` 读写所需的 `health_check_history.dimensions`，由 schema invariant 强制检查，并在两个现有 MySQL 容器上通过空库/重复初始化。 |
| 告警升级 schema | 通过 | Migration `049_alert_level_p0_parity.sql` 恢复已启用 `critical → p0` 升级规则所需的 `alerts.level` 值。主库记录 migration 049 completed，information_schema 返回包含 `p0` 的 enum；真实调度周期中此前失败的 8 个 critical 告警均成功升级为 `p0`，且无截断错误。 |
| Worker lease/fencing | 通过 | `bash scripts/qualification/run-existing-mysql.sh failover`。 |
| 备份/恢复 | 通过 | `backup-restore`；一致性 dump 在同实例恢复时禁用 GTID purging。 |
| 并发持久入队 | 通过 | `stability`。 |
| 资格环境清理 | 通过 | 所有场景仅使用 `slide_qualification_existing_*` 数据库，并在退出时删除。 |
| 服务器告警/RCA 运行闭环 | 通过 | `alert-rca`：真实服务器指标生成阈值告警；数据库配置的 DeepSeek provider 调用 `slide_complete_analysis`，持久化完成且结构化的服务器主体 RCA。 |
| 失败 Agent run 数据库读回 | 通过 | `agent-run-failure`：通过 DirectAdapter WS 注入确定性 provider 失败，`agent_runs` 持久化为 `state=failed`，包含终态 payload 与 `finished_at`。 |
| 生产启动负向场景 | 通过 | `startup-negative`：弱生产 secret 和中断迁移均在 listener/worker 初始化前非零退出；在 `mysql3307:3307` 上也独立通过。 |
| 加密 key 丢失恢复 | 部分通过，需要一项运维输入 | 防护恢复脚本保持原有审计边界。当前已用存储凭据真实验证 5/5 数据库实例、DeepSeek 和 Feishu；服务器 3 旧 SSH 凭据仍无法解密，必须由运维方重新录入。 |
| 通知启用边界 | 通过 | Migration `047_notification_channel_delivery_start.sql` 为所有本地渠道回填投递起始时间。重启服务的真实 dispatch 周期没有为历史告警创建新的 `notification.deliver` job；scheduler 和 delivery handler 均强制该边界。 |
| 托管浏览器资格验证 | 通过 | 安全、关键路径与 Agent 能力套件在当前 51-migration ledger 上通过 22/22；设置 `QUALIFICATION_CANCELLATION_E2E=1` 后，取消与附件显式拒绝/零副作用另行通过 2/2，且无 skip。 |
| 外部通知实际投递 | Feishu 通过；SMTP 未声明 | 2026-07-22 修复 Mihomo/Fake-IP 与 Node DNS 兼容、卡片 payload 和凭据状态 UX 后，真实 Feishu 测试成功，运维方确认收到告警。SMTP 仍无真实成功声明；安全、脱敏、失败审计和出站策略证据保持必需。 |
| Feishu 设置 UI | 通过 | 设置页展示脱敏渠道状态，只接受 `open.feishu.cn` HTTPS bot webhook；仅在明确输入时提交新 signing secret，空字段保留既有凭据，并可调用受保护的单次测试接口。单测覆盖脱敏加载、创建/保存 payload 和 host 拒绝；Playwright 创建禁用临时渠道、确认 API 仅返回 origin 与凭据存在状态，随后删除。 |

## Phase 131 发现项审计

| 发现项 | 当前状态 | 证据或剩余缺口 |
|---|---|---|
| CR-01 | 已验证 | 认证 DirectAdapter WS 测试使用真实平台 catalog 和工具调用模型请求 owner-only、需审批的 `get_instance_connection`。viewer 得到 `OWNER_REQUIRED`，spy 证明密码解密服务从未被调用。 |
| CR-02 | 已验证 | 托管安全 E2E 证明 REST 与 WS 会话隔离。 |
| CR-03 | 已验证 | 托管安全 E2E 在目标 driver 产生副作用前拒绝直接 UPDATE、DDL 和多语句。 |
| HI-01 | 已验证 | 当前 51-migration 空库安装与重复初始化通过；此前 49-migration 契约在 `mysql3307:3307` 独立通过。 |
| HI-02 | 已验证 | 托管 E2E 证明两个并发审批只执行一次受控更新。 |
| HI-03 | 已验证 | 用户停用后，REST、refresh 和已建立 WS 均立即撤销。 |
| HI-04 | 已验证 | 浏览器 E2E 证明结构化与 Markdown 攻击 payload 保持惰性。 |
| HI-05 | 已验证 | 托管 API E2E 创建离线且启用采集的服务器；readiness 将其列入 failed refs，overall 不可能为 healthy。 |
| HI-06 | 已验证 | MySQL 服务器和实例指标到阈值告警链通过；浏览器覆盖连接/重载、调度持久化、scope 规则、告警展示与 RCA。服务测试证明同名实例/服务器指标目标隔离、多级阈值和 duration 语义。 |
| HI-07 | 已验证 | 服务器 collector 与 registry 使用规范 `(target_type, metric_id)` 身份。生产者一致性测试覆盖全部 Linux 指标；主库 6,517 条历史样本中的 10 个指标名称均有注册表定义。 |
| HI-08 | 已验证 | 实例与服务器告警均成功创建并读回正确资源主体和关联告警的 `alert_rca`。DeepSeek 通过 `slide_complete_analysis` 完成；浏览器独立通过新 MySQL 指标 → 调度持久化 → scope 告警 → RCA 全链路。Provider 到分析持久化的错误诊断丢失也已修复。 |
| HI-09 | 已验证 | 托管浏览器通过确定性 worker 创建服务器范围定时报表，持久化、列表、下载并读回通知结果。服务覆盖 scope、target type、幂等 occurrence、2xx 成功和审计失败。SMTP/OAuth、Feishu 签名/加密 secret 具备本地契约证据；不声明真实公网投递。 |
| HI-10 | 已验证 | 真实 DirectAdapter WS provider 失败发送 `error` 而非 `complete`；数据库中的 actor-bound run 为终态 `failed` 并带 `finished_at`。 |
| HI-11 | 已验证 | 持久通知 scheduler/worker 已启用并保存 retry/dead-letter/audit。浏览器/API 证明私网目标被拒绝、凭据只写且脱敏、dead letter 可带操作理由重放。安全覆盖 HTTPS/allowlist、DNS 失败、私网/混合解析、地址固定和禁止 3xx 跟随。 |
| HI-12 | 已验证 | 中断迁移在 listener、DirectAdapter、worker 初始化前退出；worker fencing 独立通过。 |
| HI-13 | 已验证 | DTO 脱敏通过；弱 JWT secret 的生产进程在 DB/listener 初始化前非零退出。 |
| ME-01 | 已验证 | 本地 OpenAI-compatible 流式 provider 驱动浏览器发送 Agent run、显示并点击 Stop、采用服务端 canonical ID、接收 `cancelled` 并进入 interrupted；MySQL 读回同一 run 为 `cancelled` 且存在 `finished_at`。 |
| ME-02 | 已验证 | 失败 run 持久化后，相同 actor/session/idempotency replay 返回现有终态 snapshot，不重新执行。DirectGateway 保留幂等键和附件；不支持附件时浏览器收到 `PROTOCOL_V2_INVALID`，MySQL run 数量不变。 |
| ME-03 | 已验证 | MySQL 调度状态证明首次 due、按指标独立延迟、保留成功时间和失败立即重试；collector 边界测试证明只有 scheduler 选中的 due 指标进入 provider 和持久化。 |
| ME-04 | 已验证 | 连续三次采集失败只禁用对应实例 scope 并停止后续调用，其他实例保持启用；成功会重置计数，之后两次失败不会误禁用。 |
| ME-05 | 已验证 | 浏览器读取 DirectAdapter 实际能力，Agent workspace 只显示 Overview；不支持的 Files、模型选择、Tools、Skills、Cron 控件均不再暴露。 |
| ME-06 | 已验证 | API/浏览器读取真实 adapter matrix，MySQL 为支持；MongoDB 创建在持久化前以 `DATABASE_TYPE_UNSUPPORTED:mongodb` 拒绝。PostgreSQL、Dameng、Oracle 均通过真实 adapter UAT。 |
| ME-07 | 已验证 | 并发审批仅执行一次，Operation 与不可变事件链可读回，SQL 历史通过 `approval_request_id` 关联审批。`rollback_info` 明确记录不可自动回滚。Migration 050 强制 SQL 历史→审批、审批→Operation、Operation→审批外键，主库孤儿预检为零并成功应用。 |
| LO-01 | 已验证 | 移除的 `/system`、`/appearance` 路由在认证后进入 `/chat`，不再被误判为部署 base path。 |
| DR-01 | 已验证 | 隔离进程完成所有类型化 workflow handler 并从数据库读回。主库所有自由文本 Agent Cron 均禁用，启用项仅为确定性 script；关键持久化不再依赖模型提示词。 |
| DR-02 | 已验证 | MySQL lease takeover 与 fencing 通过。 |
| DR-03 | 已验证 | 人为设置为 `running` 的迁移阻止启动且保持待显式修复。 |
| DR-04 | 已验证 | MySQL 健康聚合证明 control plane healthy、managed availability degraded、freshness critical、workflow degraded 最终得到 overall critical。 |
| TG-01 | 已验证 | 2026-07-23 批次通过 API 1001、前端 188、Agent Core 69 tests、三组类型检查、production build、lint 0 errors、37/37、CI parity 和 contract drift；hosted artifact/recovery 已由 PR #3 证明。 |
| TG-02 | 已验证 | 22/22 浏览器安全/关键路径与工具策略覆盖多主体 REST/WS、owner-only 工具、伪造审批、SQL 拒绝、并发审批、用户撤销、XSS、SSRF 和附件零副作用。 |
| TG-03 | 已验证 | 当前迁移 ledger 和 schema invariant 在真实空 MySQL 上运行。 |
| TG-04 | 已验证 | 托管套件以 UI、API、数据库状态、刷新、反馈和恢复硬断言通过 22/22；取消/附件在必需 flag 下 2/2，无 skip。 |
| TG-05 | 已验证 | MySQL 浏览器覆盖 CRUD/重载、健康、查询、原生指标、调度/告警和失败状态。PostgreSQL 18、Dameng 8、Oracle 19c 均覆盖连接、健康、只读查询、原生指标、断开和恢复。Oracle UAT 驱动共享 Oracle/Dameng AST fallback 修复；最终 Dameng 完整矩阵通过。 |
| TG-06 | 已验证 | 当前全部套件绿色；最终资格测试使用服务、数据库和浏览器行为断言，而非源码正则；37/37 矩阵和 CI parity 防止陈旧或未映射证据静默通过。 |
| OPT-01 | 历史延期，已关闭 | 2026-07-20 时尚未拆分；由下方 2026-07-23 路线收口证据关闭。 |
| OPT-02 | 历史延期，已关闭 | 2026-07-20 时尚未完成文案契约；由下方 2026-07-23 i18n 契约与运行时证据关闭。 |
| OPT-03 | 历史延期，已关闭 | 2026-07-20 时尚未生成契约；由下方 2026-07-23 TypeBox/OpenAPI 证据关闭。 |

## 决策

**GO。** 所有 Critical 和 High 发现项均有当前行为证据并完成验证。所有 Medium/Low 项均已验证，或仅作为非阻断优化明确延期。必需本地发布门禁、四数据库 adapter 证据、恢复场景、安全矩阵和托管浏览器工作流均为绿色。本文取代 `139-03-SUMMARY.md` 中已过时的 `CONDITIONAL GO` 表述。

## 后续事项

历史 GO 时不存在发布阻断项；当时延期的 OPT-01/02/03 已由 2026-07-23 路线收口关闭。当前仅剩服务器 3 SSH 凭据补录这一运维输入。

运维方批准的无公网出口豁免，仅排除本地环境中的真实 SMTP/Feishu 投递和公网重定向链分发。该豁免不允许弱化出站策略、凭据保护、脱敏或失败审计，也不得被表述为外部投递成功证据。

## 2026-07-21 发布后增量：容量一致性与闭环健康

| 验证项 | 结果 | 当前证据 |
|---|---|---|
| 仪表盘与实例管理容量口径 | 通过 | 真实 `/api/database/instances` 五个受管实例容量合计 `2.71 GB`；`/api/dashboard/capacity-trend` 的 `current_total_gb` 同为 `2.71`。仪表盘保留两位小数。 |
| 闭环健康主动发现 | 通过 | 修复前真实返回“0.9GB 与 0.4GB 一致”；修复后按全部受管实例逐项比较、容差 `0.01 GB`、缺失采集记录必告警。首次复查准确列出 MySQL `0.45 vs 0` 与达梦 `0.39 vs 0.40`。 |
| 容量采集根因闭环 | 通过 | MySQL/达梦改为原始字节求和并只在最终总量舍入；主动执行容量采集后 `capacity_sum_match=pass`，摘要为“实例总容量 2.7GB 与容量历史 2.7GB 一致”。 |
| 自动验证 | 通过（增量范围） | 后端 3 files / 20 tests；后端和前端 TypeScript typecheck；Dashboard 定向 test；Vite production build；`git diff --check`。 |
| 完整发布门禁 | 未重跑 | 本次没有重跑 Phase 139 的 API 982、前端 182、Agent Core 69、37/37 matrix 与 22/22 托管浏览器全集。不得把本节当作新的完整 release qualification。 |

本节记录 shipped v0.9 之后的增量修复，不改变 2026-07-20 的历史 GO 决策；下一次发布产物仍需按 Phase 139 完整门禁重新验证。

## 2026-07-23 路线收口与重新验证

本节是 2026-07-21 “完整发布门禁未重跑”边界的后续证据，旧边界不再代表当前状态。

| 验证项 | 结果 | 当前证据 |
|---|---|---|
| Hosted CI / 产物 / 回滚 | 通过 | PR #3 hosted run `29939147753` 的 backend、frontend、agent-core、recovery、release-artifact 全绿。Artifact `8537488077` 独立下载并通过 SHA256；`RELEASE.json` 记录 commit `5dfaeb02a6ebd09cab2fb539c7183e77a8d6141c`。原子 `previous -> current -> previous` 回滚演练通过。当前增量提交以 PR 最新 head checks 为准。 |
| 完整本地门禁 | 通过 | API 98 files/1001 tests；frontend 23/188；Agent Core 7/69；三组 typecheck；production build；lint 0 errors/249 warnings；37/37 matrix；CI parity；`contracts:check`。 |
| 容量长期回归与告警 | 通过 | `capacity.consistency` 每 5 分钟持久自调度，漂移创建去重告警、恢复自动关闭。2026-07-23 容器恢复后五实例实时合计与 Dashboard 均为 `2.59 GB`，`capacity_sum_match=pass`，摘要为“实例总容量 2.6GB 与容量历史 2.6GB 一致”。 |
| 启动与采集隔离 | 通过 | 达梦连接/探测增加受控超时和迟到连接清理；真实离线重启不再阻塞 28888/worker。MySQL 全表扫描与 aborted-connect rate 使用独立计数器基线，修复共享毫秒窗口导致的 `DECIMAL(10,2)` 溢出。API 行为测试和真实首次采集均通过。 |
| 前端性能 OPT-01 | 通过 | 主入口由 `2759.79 kB` 降至 `847.91 kB`（约 69.3%）；ECharts、CodeMirror 和 dashboard/server-detail/instance-detail/cron/sql-console/approval 按需加载。浏览器 5 个拆分路由无 page error/5xx，桌面/移动无横向溢出。 |
| 文案/i18n OPT-02 | 通过（约定范围） | en/zh-CN key、placeholder 和静态 `t()` key 契约通过；服务端同步 locale 现在通过统一 `applySettings` 触发 i18n 重渲染。浏览器验证中文偏好下应用壳与 Dashboard 不再混合语言。不声明所有历史中文业务正文已完整英译。 |
| 生成式契约 OPT-03 | 通过 | TypeBox 为 health、adapter capabilities、redacted database instances 的事实源；实际 Fastify routes 使用响应 schema；确定性生成 `docs/slide/openapi.json` 与前端 `public-api.ts`，实例页消费生成类型，CI `contracts:check` 防漂移。 |
| 真实凭据恢复 | 部分通过，需运维输入 | 存储凭据下 5/5 数据库、DeepSeek 和 Feishu 测试通过；Feishu 真实消息由运维方确认收到。服务器 3 (`192.168.64.5`) 返回“无法解密凭据”，不得推断或伪造，必须重新录入 SSH 用户名/密码后复验采集和健康。 |

当前工程路线仅剩服务器 3 的人工凭据补录与其后的真实健康复验。该外部输入不推翻历史 v0.9 GO，但在补录前不得宣称“所有恢复凭据均已完成真实环境验证”。
