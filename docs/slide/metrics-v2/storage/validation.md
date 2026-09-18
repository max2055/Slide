# MAX-65 验收记录

执行日期：2026-09-18。任务分支 `agent/15astra/max65-storage`，基线 `main@7cba40c`，包含 MAX-64 `980d236`。测试对应本目录随同提交的实现；精确交付 commit 和 PR 链接记录于 MAX-65 最终评论。

环境：独立 Docker `mysql:8.0`（实测 8.0.46），仅绑定 localhost:13365；测试自己创建并删除 `max65_<PID>` 和升级库，未访问业务数据库。测试结束停止该容器。

| 验收命令（仓库根目录） | 结果 |
|---|---|
| `METRICS_V2_TEST_MYSQL_PORT=13365 pnpm --filter slide-api exec vitest run src/metrics-v2/storage.mysql.test.ts` | 12/12 通过，4.97 秒 |
| `METRICS_V2_TEST_MYSQL_PORT=13365 pnpm --filter slide-api test` | 完整后端：264 文件通过、4 文件跳过；2344 测试通过、55 跳过；12.20 秒，包含本项 12 项实库测试 |
| `pnpm --filter slide-api exec vitest run tests/phase-94-docs-structure.test.ts src/contracts/metrics-v2/contracts.test.ts tests/migration-runner.test.ts src/resources/resource-service.test.ts src/resources/resource-routes.test.ts` | 5 文件、109 测试通过 |
| `pnpm --filter slide-api typecheck` | 通过 |
| `pnpm exec oxlint apps/db-ops-api/src/metrics-v2/storage.ts apps/db-ops-api/src/metrics-v2/compatibility.ts apps/db-ops-api/src/metrics-v2/storage.mysql.test.ts` | 0 警告、0 错误 |
| `pnpm --filter slide-api exec tsx src/contracts/metrics-v2/export.ts` 后 `git diff --exit-code -- docs/slide/metrics-v2/contracts` | schema/fixture 重生无差异 |
| `git diff --check` | 通过 |

实库测试证据位置：`apps/db-ops-api/src/metrics-v2/storage.mysql.test.ts`。全新库执行完整 migration 链，升级库先执行 main 的 000–097 链再填入旧数据并执行 098。成功项重跑、部分 DDL 提交后显式恢复、旧 Store/Service 查询与 legacy/v2/shadow 切换均有断言。int64 最小值与 uint64 最大值、MAX-64 三类资源/Extension fixture、版本/维度隔离、并发幂等与冲突、失败尝试保值、证据清理及查询 EXPLAIN 均已验证。没有用 mock 数据库替代这些验收。

## 非阻塞既有问题和边界

额外执行 `python3 docs/slide/metrics-v2/v1/verify.py` 报 source snapshot drift。对比定位到 `apps/db-ops-api/server.ts` 的 source_sha256 和引用行号；该文件 main 的最后修改来自 `e8c1605`（MAX-81），本分支没有改动。未通过刷新盘点快照掩盖问题，也未扩展范围修复。绕开快照一致性断言、单独调用原脚本 `verify(inventory.json)` 的 fixture/映射内容检查通过：64 registry identities、65 provider cases、70 realtime fields、55 referenced files、三类资源 fixture。该结果不表示旧快照一致性校验通过。

完整后端的跳过项是其他测试的运行条件未启用，不计作通过；本项 12 项实库测试无跳过。未执行生产发布、真实采集源联调或生产规模压测。容量估算、原始证据脱敏边界及数据保留/切换回退详见 README。

CI 由 PR 推送触发，结果与本地测试分别记录在交付评论，不将本地通过等同 CI 通过。

资源：硬预算未设定。实际 raw input/cached input/output token 与费用遥测不可用；不填估计值冒充实测。子代理 0，最大代理深度 0，并发峰值 1。
