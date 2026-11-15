# SQL 审核结果复用与重跑契约

SQL 审核使用持久化 analysis dispatch，与其他 AI 分析共用 worker、租约、发送前授权检查及完成写入围栏。HTTP 提交仅采集当前只读上下文并登记任务，不在请求处理进程直接调用模型。

## 复用条件

- 同一实例、同一用户、完全相同的 SQL 文本（SHA-256，包含字面量），不按归一化 SQL 全局复用。
- 当前 EXPLAIN、索引、统计信息、预检测结果及数据库方言一致。采集失败保留明确缺口，不能解释为健康。
- Provider、模型、场景路由、提示词与运行配置版本一致。
- 实时重读的用户会话版本、角色、权限、实例授权及委派边界一致，且仍具有 `sql:audit` 和该实例的读取权限。
- 分析已完成且完成时间距提交时间小于 30 分钟。历史无 dispatch 身份的结果不作为可复用缓存。

命中返回原 analysis/record ID，并始终返回当前预检测结果。命中不创建审核记录、不排新任务、不调用模型。仍需采集上下文以验证证据是否发生变化。

完成后超过 TTL 或任一身份版本变化，下次提交创建新的审核和分析。历史结果保留，不建立永久 SQL 唯一约束。未完成的同身份请求仅复用在途任务；在途任务的证据或配置已变化时返回 `SQL_AUDIT_ACTIVE_IDENTITY_CHANGED`，待原任务结算后再提交，避免静默返回旧证据结果。

未知回执不自动重放，提交返回 `ANALYSIS_PROVIDER_RESULT_UNKNOWN`，由现有分析恢复/对账流程处理；不能通过反复提交重发结果未知的模型请求。本入口不提供强制重跑参数。

## 生命周期与兼容性

审核记录与分析、dispatch、outbox 和 workflow job 在同一事务创建；登记失败整体回滚。worker 更新审核记录为 running/completed/failed。分析与审核的终态更新也使用同一事务，任一步失败整体回滚。旧审核表没有 unknown 枚举，未知回执时该表标记 failed，真实状态及恢复原因以 `ai_analysis.status/recovery_reason` 为准，不能据此自动重试。

失败日志可按 `[AnalysisDispatch] execution failed` 与 `[AnalysisDispatch] failure settlement failed` 检索，并通过 `analysisId`、`jobId`、`attempt` 和围栏信息关联。回写错误仅记录驱动错误码，不输出可能包含 SQL 或凭据的数据库错误正文；原始执行错误仍向 worker 抛出。

回写失败后沿用持久化恢复，不在 catch 内重发请求：worker 释放租约或租约过期后，由既有 `analysis.recover` 扫描（10 秒调度槽）或新领取者收敛。发送结果未知时，分析保留 unknown、审核标为 failed，后续提交继续拒绝自动重发；未发送且任务进入终态时，两表均标为 failed。数据库故障未恢复期间，扫描仍可能失败，恢复依赖数据库可用和 worker 持续运行。

完成结果保留 `raw_content`、`pre_audit_results`、`explain_plan`、`index_info` 和 `table_stats`，同时保存结构化 envelope。审核/批量审核 API 字段保持兼容。提交者身份改由认证后的 ActorContext 传入，不再以用户名字符串代替授权身份。

沿用 `sql_analysis` 场景和 Provider 配置；与统一 dispatch 相同，所选模型必须支持完成工具调用。缺少配置或工具能力时拒绝登记，不回退到无身份的直接模型调用。正常部署后重启后端与 worker 生效，不需要数据库迁移。

## 验证入口

默认单元回归：

```bash
pnpm --filter slide-api exec vitest run src/sql-audit-service.test.ts src/ai-agent-bridge.test.ts src/analysis/analysis-dispatch-store.test.ts src/analysis/analysis-dispatch-handler.test.ts
```

真实 MySQL 验收显式注入连接配置，测试创建随机独占 schema 并在结束后删除。默认测试收集不读取私人凭据。

```bash
SQL_AUDIT_MYSQL_TEST=1 SQL_AUDIT_MYSQL_HOST=127.0.0.1 SQL_AUDIT_MYSQL_PORT=3308 SQL_AUDIT_MYSQL_USER=root pnpm --filter slide-api exec vitest run src/sql-audit-service.mysql.test.ts
```

密码通过执行环境的 `SQL_AUDIT_MYSQL_PASSWORD` 注入，不写入命令、源码或日志。该套件使用真实迁移、审核服务、配置解析、授权校验、dispatch/worker handler 与事务，模型边界为受控替身，不证明厂商模型调用或实际计费。

真实套件还覆盖 #595 的分析/dispatch/job 插入失败整体回滚，以及 #596 的分析和审核更新分别失败、发送前/后恢复、失败日志与禁止未知请求重发。
