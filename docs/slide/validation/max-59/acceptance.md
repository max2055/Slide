# MAX-59 验收记录

实施基线：`origin/main@711f5cb`（2026-09-17 拉取）。原工作树含其他任务提交及用户修改，未改动；本分支从最新 main 独立建立。最新 main 的 repair 漏洞与复核基线一致，仓库内未找到生产调用者。

范围：外部修复确认契约、checksum/状态/校验/锁、原失败证据与操作者记录、相关测试和运维说明。排除自动重放 DDL、公开 API、历史 SQL 改写及无关重构。硬预算未设定；未使用子代理，实际 token/费用遥测不可用。

## 证据

- RED：`pnpm --filter slide-api exec vitest run tests/migration-runner.test.ts`：7 通过、8 失败。旧 `repair()` 在没有专属验证时实际把 failed 改成 completed；其余失败覆盖新增明确契约。
- GREEN：同一命令 15/15 通过；随后补充兼容别名成功路径、审计容量和条件 UPDATE 竞争测试，全部纳入最终回归。
- 模块边界：runner、src/migrations 和三份 migration parity 测试，9 文件、33 项通过（新增上述三项前）。
- 最终后端回归：`pnpm --filter slide-api test`，259 文件通过、4 文件跳过；2182 项通过、55 项现有配置跳过，0 失败。未用跳过测试代替真实 MySQL 验收。
- `pnpm --filter slide-api typecheck`：通过。
- 对五份修改/新增 TypeScript 文件执行 `pnpm exec oxlint ...`：0 告警、0 错误；`git diff --check` 通过。
- 真实 MySQL：独立临时 MySQL 8.4 容器、随机数据库；执行 `MIGRATION_TEST_MYSQL_PORT=<port> pnpm --filter slide-api exec tsx tests/migration-repair.mysql.ts` 全部通过。脚本清理自身随机数据库，验收后停止并自动删除临时容器，未使用业务数据库。

## 验收对应

1. 全局 schema 校验失败、专属数据效果缺失及未注册校验器均保持 failed。实际 MySQL 已验证全局检查不能发现的数据效果仍被专属校验阻止。
2. 人工补齐缺失效果后可确认。单测覆盖未知 ID、不存在及 running/completed/baselined 状态、空 actor/reason、锁失败；实际 MySQL processlist 证明并发 run 和第二次 repair 等待同一锁，随后 run 成功、重复确认拒绝。
3. MySQL 首次执行两个 DDL 已提交、第三条 DML 失败；确认前后 checksum、started_at、statement_index 不变，原错误嵌入审计 JSON。后续两次 run 不重放 DDL/DML。原 checksum 白名单及历史 SQL 均未修改。
4. 现有迁移测试和隔离 MySQL 部分失败/人工修复/并发验收均通过；完整应用 migration bootstrap 在真实 MySQL 上通过。

## 适用边界

默认专属校验注册表为空，任意 migration 均不会仅依靠 actor/reason 变成 completed。实际运维需提交并审阅对应 ID/历史 checksum 的只读校验器，完整覆盖该 migration 的 schema 与数据效果；注册入口仅为内部 TypeScript 构造参数，无网络入口。

全局校验是当前完整 schema 契约，早期失败需先外部补齐必要 schema。外部人工 SQL 不遵守 advisory lock，因此验证期间仍需维护窗口防止外部写入。详见 `docs/slide/operations/migration-repair.md`。
