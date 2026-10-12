# T02 outbox 有界基线修复验证

日期：2026-10-12。任务 MAX-143，范围仅 FINAL-0026/0300 和直接相关错误处理；后续调查模型/API不属于本修复PR。

独立 worktree 分支 `codex/MAX-143-outbox-repair`，起点为最新 main `ef9a09de1abf92bf789e6d59492a01b3e4b2ab70`。相对Review `fb0766d6`，前置增量为已合并R00/T01；outbox生产代码未变化。本机原工作区的用户基线、AGENTS.md和其他文件未带入此PR。

## 改动与兼容

- begin纳入try/finally，成功begin后才rollback，失败路径均release；rollback失败不覆盖原始错误。
- 幂等INSERT后在同一连接按唯一键SELECT FOR UPDATE，返回实际行ID。当前读避免REPEATABLE READ旧快照；重复输入不覆写既有payload。保持既有append参数、报表按幂等键定位和表结构。
- 新增outbox focused/真实MySQL回归；既有worker测试补持久ID查询响应；仓库现有report recovery隔离脚本同时执行新MySQL测试，进入recovery-qualification CI。
- 不新增迁移、不触及业务HTTP入口/权限/Profile/模型执行；未调用模型、未读写生产数据库、未改变运行中的其他服务。

## RED / GREEN

RED checkpoint `b8319924`：生产代码未修改时，unit 3失败/4通过；真实MySQL 3失败/1通过。重复append返回不同ID，100并发得到100个ID，begin故障release调用为0；rollback失败覆盖原错误也复现。

首次故障注入尝试中，prepared statement不支持SIGNAL，为测试设置问题；已改为业务表重复主键注入，真实SQL回滚断言通过，再记录有效RED。

GREEN checkpoint `7625bb65`：同一测试和现有worker/report回归 **4文件43项通过，0失败、0skip**。真实MySQL8.4.10运行在仅本任务创建的临时容器内，使用随机隔离数据库，结束删除测试schema。

```bash
REPORT_TEST_MYSQL_PORT=<隔离端口> REPORT_TEST_MYSQL_PASSWORD=<测试凭据> \
pnpm --filter slide-api exec vitest run \
  src/workflows/outbox-service.test.ts \
  src/workflows/outbox-service.mysql.test.ts \
  src/workflows/worker-runtime.test.ts \
  src/workflows/report-recovery.mysql.test.ts
pnpm --filter slide-api typecheck
pnpm exec oxlint apps/db-ops-api/src/workflows/outbox-service.ts \
  apps/db-ops-api/src/workflows/outbox-service.test.ts \
  apps/db-ops-api/src/workflows/outbox-service.mysql.test.ts \
  apps/db-ops-api/src/workflows/worker-runtime.test.ts
bash scripts/qualification/run-report-recovery.sh
```

typecheck与focused oxlint通过；lint 0警告/错误。真实验收包括：首次与重复ID匹配实际行、payload保持原值、100并发同键只一条outbox且100条业务关联无孤儿、SQL失败业务/outbox全部回滚后可重试、事务启动MySQL故障释放连接、现有报表恢复/通知兼容。

## 尚未解除的门禁

此证据只关闭0026/0300的具体触发条件，不授予Workflow整域clear。未验证调查request/job admission、授权先于limit/count、版本patch或HTTP路由。auth/actor/session blocked+pending、T04租约恢复、T07预算等继续保留。T02不能因修复合并而视为完整完成。

CI、Review、PR head和正常合并SHA须使用Issue交付中的实际结果；本文件不预填通过。实际token/费用遥测不可用，没有用估算冒充统计。
