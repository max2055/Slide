# MAX-109 / W02：Cron 执行主体与实时资源授权

## 执行契约与基线

主任务 MAX-107 v2，严格串行第 4/16 项。基线 `origin/main@70a02789ad5e900883f97e90636d83ffb4730f77`；前项 MAX-121 / PR #114 已合并并由主任务确认验收，W01 / PR #112 也已合并。分支 `codex/max-109-cron-actor-scope`，保留运行目录原有 AGENTS.md 和 .multica 内容，不纳入提交。

范围仅为 Cron owner、主体类别、资源约束、实时授权、持久审计、迁移及直接相关回归/生成契约。验收覆盖 A/B 隔离、集合过滤、撤权中途生效、停用/删除 owner、目标删除/置空、跨任务身份、审计失败、真实 MySQL 保存/重载/重启及原脚本/取消行为。不修改实际 .env 或用户服务，不迁移生产数据，不调用付费模型，不扩 HA 或恢复引擎。交付 PR 至 in_review，由主任务审查八项 CI 后串行合并；本任务不自行合并或启动后继。

硬预算未设定；实际 raw input、cached input、output、费用遥测不可用。子代理 0，最大深度 0，代理并发峰值 1。

## 行为与兼容决定

- Migration 105 添加 `owner_user_id`、`principal_type`、`resource_scope`、`identity_status`、`identity_audit`；日志添加独立 `execution_authority`，不会被 Agent 的 structured result 覆盖。保留全部旧列、script_binding 和旧日志。owner 不设级联删除外键，便于留下已删除主体的 ID，并由运行时拒绝执行。
- 用户任务由经过认证的创建者持有。创建/修改的范围由后端计算；指定目标只绑定该实例，全局 Agent 任务绑定创建/显式重设目标时的有限实例清单。后来新增实例不会自动扩大授权。scope 保存独立 targetInstanceId；数据库 FK 将删除目标置 NULL 时不会转换成全局任务。
- 每次运行重新读持久任务，加载当前 active owner、角色/权限及未过期实例授权，与任务范围和仍存在的实例取交集。每次工具调用入口及持久 decision audit 之后再次校验 owner、任务绑定/暂停、目标存在和当前授权。已有处理器内正在进行的 I/O 不宣称能被撤权追回；撤权后的新处理器调用拒绝。
- 每个运行使用专属 ToolRegistry 和不可变 ActorContext/resourceBoundary。保留原 userId/username/roles 供审计，资源边界优先于管理员全局权限；DB 集合、摘要与告警使用传入 Actor 的有效范围。共享 Actor 缺失时拒绝摘要查询，移除旧服务账号全局回退。
- 当前用户 Cron 仅委派数据库只读工具和内部 completion；服务器、网络设备、跨资源 evidence/source、写/secret/delegate/execute 工具均不开放。query_metrics 显式 server/network 引用也在处理器前拒绝。scope 中服务器/网络 ID 默认为空，暂不新增授权 UI/能力。
- 执行前必须持久化尝试主体/触发者，再持久化通过授权的运行信息；普通工具与 completion 均记录 persistent decision/result audit。decision audit 失败不进入处理器，result audit 失败关闭该运行后续工具/completion，并返回失败，不能伪造已完成。授权 I/O 故障同样关闭执行。
- 手动触发 revalidate 触发者会话/权限与目标资源；管理员触发用户任务仍以 owner 执行。`PUT /api/cron/jobs/:id` 的 `owner_user_id` 为管理员显式重新绑定入口；重绑不自动启用任务。principal_type、handler_key、resource_scope、identity 字段归后端所有，客户端不能将任意 Agent 升为系统任务。
- 维护任务仅允许代码列出的六个固定 handler capability，不执行自然语言描述。HTTP 不能替换维护任务的 handler/目标/脚本/Agent 描述，手动触发还需全局实例与 cron:manage 权限；enqueue 前也必须写运行审计。无 owner 的自由 Agent seed 保持暂停。
- GET 任务暴露 identity_status/identity_audit：`owner-required` 明示需管理员重新绑定。运行权限错误返回 403；未绑定/目标变化等返回 400；授权/审计/维护运行设施不可用返回 503。运行 200 仍须查执行日志判断 Agent 结果，保留已有接口习惯。OpenAPI 和前端生成类型已更新。

## RED → GREEN 与验收证据

RED checkpoint `4608e25`：`cron-actor-scope.test.ts` 两个用例均实际执行失败。确定性假 Agent 请求 B 时真实工具 wrapper 进入处理器，Actor 为 userId=0/system；decision audit 存储失败时处理器仍执行。修复后同一用例通过，扩展为 17 个授权/审计用例。

本机环境：2026-10-03，macOS arm64，Node 24.18.0，pnpm 11.19.0，Vitest 4.1.8；frozen lockfile 安装未修改依赖文件。故障实验仅使用本次新建的 `mysql:8.4` 容器、127.0.0.1:33319、临时数据库，无应用 .env、生产凭证或外部模型。

| 验收 | 实际证据 |
| --- | --- |
| A/B 越权在工具处理器前拒绝 | 假 Agent 请求 B，处理器 spy 0 调用；持久 audit 为 owner=8 / INSTANCE_SCOPE_DENIED |
| 管理员仍受任务范围限制 | owner=* 的 DB 列表/摘要仅含 A，读取 B 拒绝 |
| 撤权中途生效 | 调用 A 后移除 grant，下一调用拒绝；另测 decision audit I/O 期间撤权，处理器 0 调用 |
| 停用/删除 owner、任务暂停/删除/重绑 | focused 拒绝第二次调用；MySQL 中真实 UPDATE/DELETE 后 manual run 为 403/error |
| 删除目标不变成全局身份 | 真实 MySQL FK ON DELETE SET NULL 后返回 CRON_TARGET_CHANGED；运行中删除与置空分别测试 |
| 跨任务身份隔离 | 两个并行独立注册表：A 的 owner 不可读 B，B 的 owner 可读 B，handler context 为各自 userId |
| 服务器/网络不继承 system | 注册表无 server/cross-resource 工具；query_metrics server/network 引用处理器 0 调用 |
| 审计失败关闭执行 | decision write 拒绝处理器；result write 故障后下一工具与 completion 拒绝；真实 MySQL trigger 拒绝运行授权审计；原 control SQL outcome 故障回滚仍通过 |
| 手动触发者与主体可区分 | MySQL execution_authority owner_user_id=8 / triggered_by=7；tool audit actor_id=8，管理员触发不提升权限 |
| 迁移与重新绑定 | numeric pinned-script authorizer 回填；unknown Agent 保持 user/NULL owner/disabled/owner-required；直接启用拒绝，管理员重绑成功且仍暂停 |
| MySQL 重载与重启 | 新 service/new scheduler 重载保留 owner/scope/script_binding；另存入测试 DB，实际 docker restart 后新 Node 进程 getJobById 与重启前整行 JSON 相同 |
| 维护能力限制 | user 主体、未知 handler、audit failure 均不 enqueue；仅 fixed audited baseline.cleanup enqueue |
| 脚本/取消兼容 | 原 cron-security、cron-cancellation、runtime-lifecycle 测试通过；保留 pinned script、control SQL 回滚和未收敛操作并发守卫 |

focused 命令：

```bash
CRON_TEST_MYSQL_PORT=33319 pnpm --filter slide-api exec vitest run src/cron/cron-actor-scope.test.ts src/cron/cron-mysql.integration.test.ts
```

37/37 通过（授权 17，真实 MySQL 20）。新增尝试主体审计后，仅重跑受影响 Cron/cancellation/runtime-lifecycle：6 文件、67/67 通过。完整 gate 统一运行后复用未受影响结果：

| 门禁 | 结果 |
| --- | --- |
| `CRON_TEST_MYSQL_PORT=33319 pnpm -r test` | Agent Core 654；frontend 554；sandbox 22/4 skipped；API 2950/123 skipped，1 个契约路径清单失败 |
| 修正新 Cron API 路径清单后 `vitest run src/contracts/public-api.test.ts` | 8/8 通过；完整 API 门禁其余用例复用，合计 2951 通过/123 skipped |
| `pnpm -r typecheck` | 4 包通过；最后生成类型后 frontend typecheck、最后审计改动后 API typecheck 通过 |
| `pnpm lint` | 0 errors / 262 warnings，与前项门禁数量相同；无新增 lint 门禁例外 |
| `pnpm --filter slide-frontend build` | 成功，CSP 通过；既有大 chunk 提示 |
| `pnpm contracts:check` | 通过，生成 OpenAPI/前端类型一致 |
| `pnpm qualification:matrix` | 37/37 映射通过 |
| `pnpm security:scan` | 通过 |
| `bash scripts/qualification/run-agent-runtime.sh --mode deterministic` | 通过，假 provider |
| `git diff --check` | 通过 |

环境门控 skipped 共 127 项不算通过；未测代码覆盖率百分比，未为本任务安装 coverage 依赖。未在生产数据、真实付费模型、跨主机或生产网络做实验。本地证据不替代 PR 当前 head 八项 CI，主任务须继续审查/合并。

## 上线前 owner 清单预览与回滚

迁移执行前，在既定部署窗口只读预览下列清单并保留管理员绑定计划。此任务只验证隔离数据库，不自行在生产库执行：

```sql
SELECT j.id, j.name, j.task_type, j.handler_key, j.target_instance_id,
       JSON_UNQUOTE(JSON_EXTRACT(j.script_binding, '$.authorizedBy')) AS pinned_authorizer,
       CASE WHEN j.task_type = 'script'
         AND JSON_UNQUOTE(JSON_EXTRACT(j.script_binding, '$.authorizedBy')) REGEXP '^[1-9][0-9]*$'
         AND EXISTS (SELECT 1 FROM users u WHERE u.id =
           CAST(JSON_UNQUOTE(JSON_EXTRACT(j.script_binding, '$.authorizedBy')) AS UNSIGNED))
         THEN 'pinned-owner-candidate'
         WHEN (j.name = '容量数据采集' AND j.handler_key = 'capacity.collect')
           OR (j.name = '基线清理' AND j.handler_key = 'baseline.cleanup')
           OR (j.name = '定时报表调度' AND j.handler_key = 'report.schedule')
           OR (j.name = '(预留) 升级规则监控' AND j.handler_key = 'alert.evaluate')
           OR (j.name = '(预留) 通知推送检查' AND j.handler_key = 'notification.dispatch')
           OR (j.name = '故障自动诊断' AND j.handler_key = 'fault.diagnose-unhealthy')
         THEN 'typed-maintenance-candidate'
         ELSE 'pause-and-admin-rebind' END AS migration_action
FROM cron_jobs j ORDER BY j.id;
```

Migration 105 不自动猜测 Agent owner，不使用迁移账号/admin/system 作为回填。可信来源仅为 W01 的 numeric server-authored pinned binding，以及现有精确 name+handler 维护种子。迁移后 `GET /api/cron/jobs` 的 owner-required 清单用于人工确认；管理员通过 PUT 提供 owner_user_id/必要 target，再审阅 scope 与 script binding，另行启用。清单/重绑不包含破坏性历史清理。

回滚保留新增列、旧列、script_binding 和审计；出现问题时暂停受影响用户 Agent Cron，维护/script 路径只在其现有授权仍成立时继续。禁止通过恢复旧固定 system Actor 版本来重新运行用户 Agent，也不删除迁移列或清空 owner-required 记录。用户权限恢复后须按当前绑定重新验收，不能把创建时快照当永久授权。
