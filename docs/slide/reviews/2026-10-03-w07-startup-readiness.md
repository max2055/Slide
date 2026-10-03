# MAX-115 / W07 启动续租与就绪验收

范围 v1 沿用 MAX-115 已批准的 W07/A06/A15：D1 单后台执行者、启动期续租/取消、基础设施 readiness、五个开关透传、按有效 workflow ownership 恢复 Cron。基线为 `6faff9dbd6fb7213a86c2fa959abed9809ee52fb`（MAX-112 / PR #117 已合并）；实施分支 `codex/max-115-startup-readiness`。未扩 HA，不改实际 `.env`、用户服务或生产数据库，未调用付费模型。

## 最终行为与后继契约

- 先绑定 HTTP listener，获得全局 lease 后立即开始续租，再初始化 API 依赖和 leader-only 服务。默认 TTL 30 秒、周期 10 秒；每个后台启动前及共享 worker tick / Cron 触发前重新确认所有权，续租串行且最多等待 5 秒。
- 启动过程收到 AbortSignal 后不再执行下一阶段。晚到的 Agent/连接资源会释放；统一关闭已有 timer、workflow、metrics scheduler、Cron、WS、会话清理、prompt watcher、维护缓存和恢复的数据库连接。无法合作退出的驱动/初始化通过 10 秒关闭 deadline 终止进程，不释放租约后继续工作。正常路径完成资源关闭后释放 lease、关闭控制库连接。
- API 必需的安全策略、skills、prompts、LLM 配置和 metric registry 在 API-only 实例也初始化；CronManager 只在 leader 启动。CRUD 无本地 scheduler 时不解引用空值；备用不能执行本地 Cron 触发或启动 collector，返回 `503 WORKFLOW_RUNTIME_UNAVAILABLE`。备用的 Cron 配置写入只持久化，不向 leader 做跨进程热刷新；调度变更应通过 leader API 完成。
- `/api/health` 继续作为公开 liveness，语义不变。新 `/api/health/ready` 只返回 `200 {ready:true}` / `503 {ready:false}`；要求本实例后台角色完成初始化、Cron 及 worker 装配完成、控制库可访问、workflow 派发表结构可访问、全局 owner 仍有效。依赖检查有 3 秒边界并复用未完成检查，不堆积堵塞查询。全局 HTTP 安全钩子保留这一个有限布尔响应，其他内部错误继续脱敏。
- `/api/health/readiness` 仍为原有详细接口，保留 JWT + `config:view`，未拿来作 Compose 探针。生成 OpenAPI 与前端类型已更新。
- D1 备用继续提供 API，但正式 worker readiness 一直为 false；leader 退出后不自动选主。它不能作为已就绪后台实例接流量。恢复后台执行需人工重启/启动指定 worker。未来 HA 必须另行增加退避选主和共享状态验收。
- Compose 透传 `METRICS_V2_COLLECTION_ENABLED`、`SLIDE_MEMORY_PIPELINE_ENABLED`、`SLIDE_MEMORY_WORKSPACE_ID`、`SLIDE_MEMORY_RETRIEVAL_MAX_COUNT`、`SLIDE_MEMORY_RETRIEVAL_MAX_TOKENS`。两项功能默认 false；检索默认 5 / 4096；Memory 启用缺 workspace ID 时以 `MEMORY_WORKSPACE_ID_REQUIRED` 明确失败。日志只记录允许的布尔/数字摘要与 workspace 是否配置，不打印 ID、密钥或完整环境。
- 新 Cron 运行恢复仅处理无有效 workflow owner、已过期或已退出 running 的中断记录，保留已提交业务结果；活跃 owner 的运行和日志不会在启动时被清扫。UUID 关联使用二进制相等，避免控制表历史 collation 不同。没有 owner/expiry 证据的 legacy running 日志保留人工核查，不自动改终态；queued 意图保持可派发。

## 失败复现与修复

现有装配在 `await startWorkers()` 之后才创建续租 timer；全局 renew SQL 没有过期条件，旧 owner 可复活到期租约；备用 Cron 路由使用 `cronManager!`。新增生命周期用例先失败，再覆盖 45 秒初始化、续租返回 false/异常/不 settle、半途失败和晚到资源释放。

真实 Fastify 进程还复现：公开 readiness 的 503 被全局安全钩子改写为 `{error}`，与只允许 `{ready}` 的 schema 冲突，实际返回 500。补充带生产 HTTP 安全钩子的路由测试先得到 500，再修复为只输出 `{ready:false}`。首次完整模块测试的另外三项失败是契约路径清单及启动 VM/source 夹具仍引用旧装配，已更新，最终全部通过。

真实测试数据库使用空库迁移和假凭证。初次实验缺少测试 LLM 配置导致 `LLM_CREDENTIAL_NOT_CONFIGURED`，随后只在隔离库配置本地假 provider（专用 HTTP fixture 固定返回 503，不访问真实模型），未改变实际产品配置或购买资源。

## 命令与结果

环境：macOS 本地 worktree，Node 24.18.0、pnpm 11.19.0、Vitest 4.1.8、Docker 29.7.2、独立 MySQL 8.4 容器（随机 loopback 端口）。真实 API 使用各自随机 HTTP/WS 端口、临时 workspace/prompts 和测试密钥。所有 run-owned 子进程、数据库容器和 Compose probe 网络均在前台结果收集后清理。

| 验证 | 命令/方法 | 结果 |
|---|---|---|
| 生命周期与路由聚焦回归 | `pnpm --filter slide-api exec vitest run src/lifecycle/worker-startup.test.ts src/lifecycle/infrastructure-readiness.test.ts src/health-routes.test.ts src/security/http-security.test.ts src/cron/cron-run-contract.test.ts src/cron/cron-security.test.ts src/cron/cron-native-results.test.ts src/metrics-v2/scheduler/lifecycle.test.ts` | 8 文件，77 用例通过 |
| 最终 backend 模块 | `pnpm --filter slide-api typecheck`；`pnpm --filter slide-api test` | typecheck 通过；310 文件通过，23 opt-in 文件跳过；2958 用例通过，155 opt-in 用例跳过 |
| 其他模块 | `pnpm --filter slide-frontend typecheck`；`pnpm --filter agent-core typecheck`；`pnpm --filter slide-sandbox-controller typecheck`；`pnpm -r test` 中对应模块 | 全部通过；frontend 563、agent-core 654 用例通过；sandbox 通过。未变化模块复用第一次完整门禁结果 |
| 静态与产物 | `pnpm lint`；`pnpm --filter slide-frontend build`；`git diff --check` | 通过；保留已有 lint 警告和构建 chunk 大小警告 |
| 契约/覆盖/安全 | `pnpm contracts:check`；`pnpm qualification:matrix`；`pnpm security:scan`；`pnpm security:deployment` | 通过；37/37 finding 映射完整；secret scan 和部署不变量通过 |
| 真实启动/故障/Compose | `pnpm --filter slide-api exec tsx ../../tests/qualification/startup-readiness.test.ts` | 最终候选通过，细项见下表；已加入 recovery-qualification CI job |

| 真实验收项 | 实验与结果 |
|---|---|
| 初始化超过 30 秒 | 对隔离库 `agent_security_policies` 加 WRITE 锁，真实 API 在安全策略加载时等待；35 秒后相同 owner 仍有效，证明初始化期间续租。解锁后 readiness 200 |
| 两个 API 进程 | 第二个进程在慢初始化期间进入 API-only；两进程均有独立 HTTP listener，只有 leader 输出一次 Agent/WS 后台启动；备用 readiness 503 |
| leader 退出 | SIGTERM 后租约删除；备用仍 liveness 200、readiness 503；已认证 Cron run 返回 `503 WORKFLOW_RUNTIME_UNAVAILABLE`，没有自动接管 |
| 已过期 owner | 在隔离库将 owner expiry 设为过去，真实 `WorkerLease.renew()` 返回 false，不复活 lease |
| Cron reaper | 真实有效 workflow owner 的 started run 保持 running；过期 owner 的 run 恢复 unknown；重复 recover 保持同样状态；无 owner 的 legacy log 保留 running |
| 初始化失败 | Memory 缺 ID 明确 exit 1；非法 WS 端口导致资源装配中途失败，进程退出且 lease 释放 |
| 控制库失联/续租阻塞 | 对自己的测试 MySQL 容器 pause；readiness 在边界内返回 503；日志记录 `WORKER_LEASE_TIMEOUT`，取消任务，关闭 deadline 保证进程退出；unit fake timers 同时覆盖初始化阶段的同类失败 |
| Compose 透传 | 用 `.env.production.example` 的假值在临时目录渲染 JSON（不输出包含假 secrets 的完整结果）；Compose 自己启动 `node:22-alpine` probe 容器，确认五个变量实际为 true / true / 假 workspace / 3 / 512 |

最终真实验收 API PID 为 18263、18269、18271、18272、18273；均由前台 qualification 直接启动和等待退出，cwd 为本分支的 `apps/db-ops-api`，启动命令 `node --import tsx server.ts`。测试使用基线上的当前变更候选，源代码、配置和回归测试在验证后提交；最终 head SHA 随 PR 回写任务。

## 回滚、限制与资源

本包无新迁移，不重写历史 schema ledger，也不删除旧运行/日志数据。关闭两个开关可以停用新功能；保留新的 readiness 探针（start period 30 秒、15 秒周期、12 次重试），不能退回恒 200 来掩盖未就绪。回退启动代码前先停止触发并排空或保留未知运行记录，避免重新引入旧 reaper 对活跃日志的覆盖。

未验证真实付费模型、生产部署、完整 HA，也未在本地重复不受影响的浏览器和发布产物 job；八项仓库 CI 的最终结果由 MAX-107 对 PR 当前 head 核验后合并。本地 opt-in 关系库/其他故障实验跳过不等于通过，W07 需要的实际 MySQL/多进程/Compose 验收由专门 qualification 完成。

硬预算未设定；主线程 raw input / cached input / output / 实际费用遥测不可用，不用内部估算冒充实测。子代理 0、最大深度 0、代理并发峰值 1。原 runtime worktree 的 baseline、AGENTS.md 未提交修改和 `.multica` 文件均保留，本 PR 只包含 W07 和直接必要回归。
