# Cron 控制库 SQL 边界（MAX-50）

任务创建或重新绑定脚本时，服务端保存 SQL 原文、SHA-256、script ID、目标实例、能力版本和授权 actor ID。运行只使用该快照，不再读取共享脚本最新内容。共享脚本更新、删除检查全部引用任务（包括停用任务）的实例读写权限；全局引用要求不受限实例权限。并发编辑即使发生在引用检查与绑定之间，也不能改变已绑定 SQL。

## 升级与授权

先通过现有 MigrationRunner 应用 `092_cron_script_binding.sql`，再启动新版服务。迁移为已有 SQL 任务绑定当时的内容和目标，但只授予 `read-only`；已有合法只读任务继续执行，旧维护写默认拒绝。不要跳过迁移直接运行新代码。

全局任务创建、修改、手动执行仍要求 `cron:manage` 与不受限实例权限。控制库只读 SQL 经过 AST 分类、只读事务和独立连接执行；连接设置查询超时和 SELECT 默认行数上限，并在结束时销毁以隔离 session 状态。超时主动取消 MySQL 服务端连接，最长执行时间为 30 秒；取消连接另设 1 秒连接超时和 1 秒命令超时。

只有以下两个应用内固定版本的维护能力可以写控制库，SQL 必须逐字相同（含末尾分号）：

| `control_sql_capability` | SQL |
| --- | --- |
| `baseline-cleanup-v1` | `DELETE FROM metric_baselines WHERE computed_at < NOW() - INTERVAL 30 DAY;` |
| `silence-cleanup-v1` | `DELETE FROM silence_periods WHERE silenced_until < NOW();` |

具备上述权限的操作者通过 `POST /api/cron/jobs` 或 `PUT /api/cron/jobs/:id` 显式传入 `control_sql_capability`。例如，为已有基线清理任务授权的请求体：

```json
{
  "task_type": "script",
  "script_id": 123,
  "target_instance_id": null,
  "control_sql_capability": "baseline-cleanup-v1"
}
```

其中 `123` 必须替换为内容与能力精确匹配的实际脚本 ID。不能通过该字段授权任意 SQL、DDL、批量语句或被管理实例写入。当前 UI 未增加维护授权控件，维护授权使用上述 API。

脚本编辑不会自动更新任务快照；通过任务更新 API 明确提交 `script_id` 重新绑定。维护任务重新绑定时同时提交维护能力；只改调度时间等非执行字段会保留已有绑定。删除目标实例后，绑定中的原目标与 null 不匹配，执行拒绝，不能降级成控制库权限。

## 审计与失败行为

执行前必须持久化授权审计，失败则不执行 SQL。日志 `structured_result` 包含 `script_id`、`sha256`、`capability`、`authorized_by` 和执行结果。维护写及成功审计在同一 InnoDB 事务内提交；结果审计失败会回滚维护写。拒绝、SQL 错误和超时记录为任务失败。

维护能力是任务级持久授权，随任务快照保留；撤销方式是停用/删除任务，或明确重新绑定为只读能力。这里只约束 script 任务，不改变 Agent 任务或应用内部 ORM。

## 可重复验证

`src/cron/cron-security.test.ts` 将原审计 R3 的 `executeJob` 隔离探针改为安全行为断言，并覆盖 SQL 分类、能力和内容绑定、目标删除与审计失败。

MySQL/API 集成测试仅读取显式 `CRON_TEST_MYSQL_PORT`，连接 localhost 的空密码专用测试容器，不读取应用 `.env`。它创建并清理自己命名的测试库，使用实际 Fastify 路由、RBAC 中间件、CronManager 和数据库服务；认证上下文由测试注入，未声称验证登录/JWT。

```sh
docker run --name slide-cron-test -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -p 127.0.0.1:33307:3306 -d mysql:8.4
# 等待该专用 MySQL 就绪后：
CRON_TEST_MYSQL_PORT=33307 pnpm --filter slide-api exec vitest run src/cron
# 完成后仅清理本次测试容器：
docker rm -f slide-cron-test
```

覆盖新建/更新/手动运行/定时触发、跨实例与全局共享脚本拒绝、迁移只读保留与旧写拒绝、绑定不随内容变更、固定维护写成功/失败、结果审计失败回滚、锁等待超时。未连接或操作生产数据库。
