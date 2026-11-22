# Migration 中断对账与外部修复确认

`MigrationRunner.inspectMigrationForRepair(id)` 和 `MigrationRunner.acknowledgeExternallyRepairedMigration(id, actor, reason)` 供受审阅的内部维护代码调用。前者只读检查 `running` 或 `failed` 账本记录，后者仅确认已在外部完成的修复。两个入口均不执行原 migration、补跑语句或自动回滚 DDL。`repair()` 是确认入口的弃用兼容别名。

## 确认前提

- 停止部署与其他 schema/数据写入，调用 `inspectMigrationForRepair(id)` 核对 ledger 的 `statement_index`、`error`，再检查真实 schema/数据。检查会等待与 `run()` 相同的 MySQL advisory lock，最多 30 秒。锁不可用时退出。拿到锁后若仍为 `running`，返回 `executionOutcome: 'unknown'`，即此前执行回执未知。MySQL DDL 可能已经提交，不能根据空错误或空语句序号推断未执行或已回滚。若 ledger 缺少错误或序号，从原运行日志取证，在确认理由中引用证据。
- 外部人工完成缺失的 schema **及数据**效果，不修改历史 SQL、checksum 或 ledger 状态。
- 在受审阅的内部运维代码中，为该 migration ID 注册 `MigrationRepairVerification`（构造函数第三个参数）。`checksum` 必须是精确的 ledger checksum；`verify(connection)` 必须只读、异步等待全部检查，不满足任何后置条件时抛出异常。核对列类型、默认值、索引/约束以及数据回填等该 migration 的全部语义，不能只检查表存在。
- 注册表默认空：未提供专属校验器即拒绝确认。不会把全局 invariant 当作任意 migration 的完整证明，也不会从 HTTP 参数加载可执行校验器。当前没有生产 repair 调用者；首次运维使用需要随具体 migration 提交并审阅校验器，禁止用空函数绕过。
- 校验器是可信代码，不是沙箱；数据库凭据本身已有直接写库能力。本接口防止意外跳过声明的校验，不能防御持有写库凭据的人主动篡改 ledger。

确认重新取得同一把锁并读取当前状态，等待最多 30 秒。检查 checksum、全局 invariant、专属校验和条件 UPDATE 均使用同一持锁连接。状态限于 `failed` 或 `running`，并在 UPDATE 时再次匹配所读状态和 checksum。未知 ID、缺失记录、其他状态、锁不可用、checksum 不匹配或任一校验失败时不更新 ledger。历史兼容 checksum 白名单继续适用，专属校验器必须绑定实际记录的 checksum。

全局 invariant 是当前应用的完整契约，早期 migration 失败且后续 schema 尚不满足该契约时也会拒绝确认；须先在维护窗口完成必要的外部修复再确认，不能仅修改 ledger 来继续。

成功后状态为 `completed`，保留 checksum、started_at 和原 statement_index（含空值），finished_at 记录确认时间。error 保存 JSON，包括 action、actor、reason、checksum、previousError。原状态为 `running` 时，另外记录 `previousStatus: 'running'` 与 `previousExecutionOutcome: 'unknown'`。超出 TEXT 字节上限会拒绝，不截断审计证据。操作者身份由可信运维调用方负责核实。后续 `run()` 会跳过已确认的 migration。若确认命令断线或回执不明，先读取账本状态和审计，核对是否已完成写入。

advisory lock 只协调遵守相同锁的 runner；外部人工 SQL 不自动参与，验证期间必须禁止外部并发 schema/数据修改。

## 验证

```bash
pnpm --filter slide-api exec vitest run tests/migration-runner.test.ts src/migrations
# 指向专用测试 MySQL；脚本创建随机数据库，结束后只清理自身数据库。
MIGRATION_TEST_MYSQL_HOST=127.0.0.1 MIGRATION_TEST_MYSQL_PORT="$TEST_MYSQL_PORT" \
  pnpm --filter slide-api exec tsx tests/migration-repair.mysql.ts
```

集成脚本默认 127.0.0.1、root、空密码；可通过 `MIGRATION_TEST_MYSQL_HOST/PORT/USER/PASSWORD` 覆盖。不要指向业务实例：MySQL advisory lock 名称在同一 server 上共享。建议使用临时独立 MySQL 8.4 容器。
