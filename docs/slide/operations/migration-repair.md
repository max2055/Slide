# Migration 外部修复确认

`MigrationRunner.acknowledgeExternallyRepairedMigration(id, actor, reason)` 仅确认已在外部完成的修复；不执行原 migration、不补跑失败语句，也不提供自动 DDL 回滚。`repair()` 是弃用兼容别名，执行完全相同的校验。没有新增 HTTP 路由或 CLI。

## 确认前提

- 停止部署与其他 schema 写入，检查 ledger 的 `statement_index`、`error` 和真实 schema/数据。MySQL DDL 可能已经提交；不要重跑整个文件。
- 外部人工完成缺失的 schema **及数据**效果，不修改历史 SQL、checksum 或 ledger 状态。
- 在受审阅的内部运维代码中，为该 migration ID 注册 `MigrationRepairVerification`（构造函数第三个参数）。`checksum` 必须是精确的 ledger checksum；`verify(connection)` 必须只读、异步等待全部检查，不满足任何后置条件时抛出异常。核对列类型、默认值、索引/约束以及数据回填等该 migration 的全部语义，不能只检查表存在。
- 注册表默认空：未提供专属校验器即拒绝确认。不会把全局 invariant 当作任意 migration 的完整证明，也不会从 HTTP 参数加载可执行校验器。当前没有生产 repair 调用者；首次运维使用需要随具体 migration 提交并审阅校验器，禁止用空函数绕过。
- 校验器是可信代码，不是沙箱；数据库凭据本身已有直接写库能力。本接口防止意外跳过声明的校验，不能防御持有写库凭据的人主动篡改 ledger。

确认在与 `run()` 相同的 MySQL advisory lock 中完成，等待最多 30 秒。读取 failed 状态、检查 checksum、全局 invariant、专属校验和条件 UPDATE 均使用同一持锁连接。未知 ID、缺失/非 failed 记录、锁不可用、checksum 不匹配或任一校验失败时不更新 ledger。历史兼容 checksum 白名单保持不变，但专属校验器必须绑定实际记录的旧 checksum。

全局 invariant 是当前应用的完整契约，早期 migration 失败且后续 schema 尚不满足该契约时也会拒绝确认；须先在维护窗口完成必要的外部修复再确认，不能仅修改 ledger 来继续。

成功后保留 checksum、started_at、失败 statement_index；finished_at 记录确认时间。error 保存 JSON，包括 action、actor、reason、checksum、previousError。超出 TEXT 字节上限会拒绝，不截断审计证据。操作者身份由可信运维调用方负责核实，不能直接采用未经认证的用户输入。后续 `run()` 会跳过已确认的 migration。

advisory lock 只协调遵守相同锁的 runner；外部人工 SQL 不自动参与，验证期间必须禁止外部并发 schema/数据修改。

## 验证

```bash
pnpm --filter slide-api exec vitest run tests/migration-runner.test.ts src/migrations
# 指向专用测试 MySQL；脚本创建随机数据库，结束后只清理自身数据库。
MIGRATION_TEST_MYSQL_PORT=<port> pnpm --filter slide-api exec tsx tests/migration-repair.mysql.ts
```

集成脚本默认 127.0.0.1、root、空密码；可通过 `MIGRATION_TEST_MYSQL_HOST/PORT/USER/PASSWORD` 覆盖。不要指向业务实例：MySQL advisory lock 名称在同一 server 上共享。建议使用临时独立 MySQL 8.4 容器。
