# MAX-111 / W04：Cron 触发 ID 与启动指标质量

## 执行契约

MAX-107 v2 严格串行第 5/16 项。基线 `origin/main@263c22aa05f1abce2c3518469c487e4d6a35e4a0`，分支 `codex/max-111-cron-metric-quality`。已核对 W01 / PR #112、W03 / PR #113 已合并；前项 MAX-109 / PR #115 合并到该基线，父任务评论确认验收通过。原工作区 AGENTS.md、.multica 和旧分支未改动。

范围仅包含手动触发 jobId、启动质量重标、直接回归和只读历史候选预览。验收：确认触发 POST/日志请求均使用原 ID、没有 null；失败可重试；首次和第二次 worker 启动不改新准确数据及旧标记；候选导出带来源/行数且不修改数据。Cron 历史日志误判、并发轮询完整整改留给 W05。本任务不启动后项、不自行合并 PR；交付至 in_review，由父任务审查当前 head 八项 CI 并串行合并。

硬预算未设定；实际 raw input / cached input / output / 费用遥测不可用，平台 usage 当前没有已计量任务，不将返回的零值当成本轮真实用量。子代理 0、最大深度 0、代理并发峰值 1。停止条件是代码、验证、证据文档及 PR 完成交付，或者真实权限/外部审批阻塞。

## 变更与兼容决定

- `confirmTrigger` 在异步 POST 前保存本地 jobId，POST 和后续轮询共用该 ID。关闭弹窗仍清空 UI 状态；不会把 null 传给轮询。失败仍保留重试入口；POST 等待期间关闭弹窗也不丢失已提交的 ID。
- 删除 `startWorkers` 中近 30 天 `is_estimated=0 → TRUE` 的 UPDATE。启动不再改写历史质量；旧估算、NULL 和准确值原样保留，不改变 API、写入默认值、legacy 读取或公式。
- 未分配新迁移编号，也没有历史自动重标或恢复迁移。`metrics_history` 只有质量标记和采集时间，没有可证明的历史公式版本；`database-service.ts` 的 MySQL/PG 路径本来就会合法写入 true。Git 中出现公式代码的时间不是部署时间，也不能推断每行来源。故无法划定可信旧批次，不能对全部 true 改回 false。
- “合法旧批次最多一次迁移”在本包为不适用：没有可证明批次，自动迁移次数为零。如后续取得备份/公式部署证据，须另行交付具体 ID、原标记、证据摘要、受影响行数及 dry-run，再确认批量范围；届时使用迁移账本/事务检查，不能复用滚动 30 天谓词。

## RED → GREEN

| 检查点 | 实际结果 |
| --- | --- |
| `fe550d8c` 前端 RED | 4 个用例实际执行，3 失败/1 通过；成功/关闭中途/重试路径均实际请求 `/api/cron/jobs/null/logs?limit=1` |
| `b9ab4717` 后端 RED | 启动函数实际执行两次，捕获两次重标 SQL；隔离 MySQL 中 id=1 的准确数据从 0 变 1，断言失败 |
| `47b85f9a` 前端 GREEN | 同一 4 项通过，包含 DOM 点击确认、弹窗消失、原 ID 请求、无选择不发送、失败重试 |
| `ee83117c` 后端 GREEN | 同一启动回归通过；真实 MySQL 首次/二次启动快照相等；新增候选导出回归，3/3 通过 |

后端测试用 TypeScript AST 提取并执行当前 `server.ts` 的整个 startWorkers 函数，替身只隔离 Agent、采集器、定时器和其他服务，不启动 HTTP/WS/用户服务；直接启动 SQL交给真实 MySQL。表结构取自实际 baseline。首次启动前写入准确/估算/NULL/60 天前准确四种记录，第二次前再写准确记录，对比全部列；保留 Cron reaper SQL调用断言，防止测试未执行启动路径。此层不是完整服务器进程 E2E。

导出回归对真实 MySQL 执行诊断文件：当前和 60 天前两个 estimated 候选都被导出、count=2、来源状态正确，前后全行快照相等。测试环境最初的简化 fixture 缺少导出所需字段，已改用真实 baseline，未修改业务范围。

## 最终本地验证

环境：2026-10-03，macOS arm64，Node 24.18.0，pnpm 11.19.0，Vitest frontend 3.2.6 / API 4.1.8。依赖 frozen lockfile 离线安装，依赖文件无变更。使用本任务独占的 MySQL 8.4 容器 `slide-max111-metric-quality`、127.0.0.1:33321 和临时数据库；不读取实际 .env，不使用生产凭证/数据，不调用付费模型。

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter slide-frontend exec vitest run src/app/ui/views/cron-jobs-settings.test.ts` | 4/4 |
| `METRIC_QUALITY_TEST_MYSQL_PORT=33321 pnpm --filter slide-api exec vitest run src/lifecycle/metric-quality-startup.test.ts` | 3/3，包含实际 MySQL 两项 |
| `METRIC_QUALITY_TEST_MYSQL_PORT=33321 CRON_TEST_MYSQL_PORT=33321 pnpm -r test` | API 2955 通过 / 123 环境跳过；frontend 558；agent-core 654；sandbox 22 / 4 环境跳过；总 4189 通过 / 127 跳过 |
| `pnpm -r typecheck` | 四个包通过 |
| `pnpm contracts:check` | 通过，无 API 契约变更 |
| `pnpm qualification:matrix` | 37/37 映射通过 |
| `pnpm lint` | 0 errors / 261 warnings |
| `pnpm security:scan` | 通过 |
| `pnpm --filter slide-frontend build` | 通过，CSP 通过；既有 chunk 大小警告 |
| `bash scripts/qualification/run-agent-runtime.sh --mode deterministic` | 通过，假 provider |
| `pnpm --filter slide-frontend test:browser` | Chromium 47/47 |
| `git diff --check` | 通过 |

环境 skipped 不算通过。未测覆盖率百分比；没有执行生产历史导出/恢复、真实模型、跨主机实验。未在本地重复运行未触达的完整恢复/发布 qualification；完整进程/发布资格以 PR 当前 head 的八项 CI 为门禁，由父任务核对，不用此前 head 的结果替代。

## 历史候选导出与回滚

只读文件：`apps/db-ops-api/sql/diagnostics/metric-quality-candidates.sql`。优先从备份/只读副本使用 SELECT-only 账号执行；输出首个结果集为候选总数和时间范围，第二个为候选行 ID、instance_id、时间、质量/主要值、source_table、provenance、review_status。所有 estimated 行都纳入候选，因为过去启动时的滚动 30 天误标可能发生在任意历史时间，不能仅查今天的 30 天。候选不等于确认误标；没有证据的行明确为 source-quality-unverified，不自动改写。

示例在已获授权的诊断环境交互输入密码，连接参数由操作者填写，输出保存在其受控目录：

```sh
mysql --host=<read-replica> --user=<readonly-user> --password --batch <database> \
  < apps/db-ops-api/sql/diagnostics/metric-quality-candidates.sql > metric-quality-candidates.tsv
```

不将真实候选数据提交 Git 或公共 PR。只有逐行备份/原公式版本证明且用户确认具体批量范围后，才能恢复；未证明数据保持原标记。这份文件没有 UPDATE/DELETE，不需要数据回滚。

两项功能修改独立提交，RED 测试检查点另行保留。前端可独立 revert `47b85f9a`（保留回归，回退版本会重新暴露 ID 问题）。后端禁止直接 revert `ee83117c` 或恢复旧启动 SQL；若回退发布版本，须先将该 SQL 移除/禁用，再验证重复启动，保留所有质量标记和数据。启动修复没有 Schema/数据迁移，故无需反向迁移。
