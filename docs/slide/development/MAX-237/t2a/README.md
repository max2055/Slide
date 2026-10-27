# MAX-237 / T2A：未挂载 MySQL 模板仓库适配器与真实事务验证

本目录是 Issue #261（Multica MAX-237）**MAX237-T2A 内部实现包**的交付说明。准入依据是 Issue 描述所附
`max237-t2a-admission-20261027.md`（附件 `01a17b8f-15e4-763e-a4de-e263d14f0503`，落实成员评论
`01a17b67-f991-761c-ab00-5fb0f883ad32` 的接续授权）；T1 已在
`1d7f9e1f9c5a1649a7791b995691b72f5b21f887` 接受，本包不重做 R1/R2/R3 或设计审查。

**一句话结论**：新增了一个**未挂载**的 `MySqlTemplateRepository`（显式注入 `mysql2` pool、五张既有表、
父行优先锁序、CAS、真实回滚与未知提交结果），并在一次性独占 MySQL 8.4 容器上由两个独立连接验证了并发与事务行为。
73/73 模板 focused 测试、`tsc` 0、`oxlint` 0/0 通过；**没有**注册路由/进程、没有迁移、没有共享连接池、
没有真实采集闭环。整单保持 `in_progress`，T2A 不等于持久化完成或生产兼容。

## 1. base / 提交 / 允许面

| 项 | 值 |
|---|---|
| 任务分支 | `agent/15coder1/max-237`（未切分支、未 rebase/squash） |
| 交付 base（T1 接受点） | `1d7f9e1f9c5a1649a7791b995691b72f5b21f887` |
| 产品提交 | `0b60d1f429276f9ffb4ad9e318c9c4bf3a15470f` |
| 新增 | `apps/db-ops-api/src/metrics/templates/mysql-repository.ts`、`mysql-repository.test.ts`、`mysql-repository.mysql.test.ts` |
| 修改 | `repository.ts` 仅把已有 `itemContent` / `identityConflict` 导出（算法、接口、行为不变） |
| 只读未改 | `service.ts`、`model.ts`、`errors.ts`、契约原样副本、`index.ts`、共享连接池、`db-connection`、migrations、resolver/store/scheduler、路由、前端 |
| 允许清单 | [evidence/t2a-allowlist.patch](evidence/t2a-allowlist.patch)（81 775 bytes，sha256 `ffca5dbddaaae1262b5afceb37983d79841f45394f36785654aad74561db5716`） |

| 文件 | 行数 | sha256 |
|---|---|---|
| `mysql-repository.ts` | 829 | `a66f9f1c0cea755e51805a8e5c0ff3dc5d6f340a43c834d1f1ae38e7918736f3` |
| `mysql-repository.test.ts` | 204 | `24105e24ccc26b4551af28ad56ca4c5044d276bb318ab3374a57bff00c76e316` |
| `mysql-repository.mysql.test.ts` | 572 | `4a64ce12425ff9d478b32674fdbaf0ae56200fe373dded56cb9e6afc1b6364a7` |
| `repository.ts` | 363 | `d722c5e864eeba194a8ca653beb207e23ee8ea28f33a9cdca9081fd235e24153` |

机器可读证据：[evidence/t2a-fixture.json](evidence/t2a-fixture.json)（真实 fixture 事实）、
[evidence/t2a-verification.json](evidence/t2a-verification.json)（验证与允许面）、
[evidence/t2a-cleanup.json](evidence/t2a-cleanup.json)（清理证明）。

## 2. 五表映射（D1 候选 DDL 140，原样）

DDL 逐字节复制自
`b5377142497282afa364a53b7aeab38088d095fb:docs/slide/development/MAX-236/real-a/sql/140_metric_template_aggregate.sql`
（git blob `f958ba73b719a0cf84b3546675a9701544f55a27`，sha256
`3fab395880891966565dea989dc475b3dff404404d0bb085a6875aff2f5ec13d`），仅在一次性容器的新空库
`max237_t2a` 内执行；**不安装到应用库、不修改原文件、不加第六张影子表**。

| 端口对象 | 表与列 |
|---|---|
| `TemplateRecord` | `metric_templates_v2` 同名列；`current_published_version`/`created_by` 的 SQL NULL 原样；新模板 `revision=0` |
| `TemplateDraft` | `metric_template_drafts` 同名列；`aggregate` JSON 保持引用型草稿；`published_version`/`updated_by` NULL 原样 |
| 首次 item 身份 | `metric_template_items`：只在第一次创建时写 `status='active'`、`created_at=首个 item 的 source_chain.created_at`；后续 append/reuse 不改这两列（本阶段没有归档 API，也不由模板 status 推断 item status） |
| `TemplateItemVersion` | `metric_template_item_versions`：`canonical_metric.id`/`semantic_version` 分别落到 `canonical_metric_id`/`canonical_semantic_version`，其余同名；JSON 保留空键、逗号键、Unicode 与 null 语义 |
| `TemplateVersion` | `metric_template_versions` 同名列；`aggregate`/`items`/`package_composition`/`source_chain` 原值 JSON；hash 仍只覆盖 aggregate；`published_at`/`retired_at` 与 source_chain 语义一致 |

日期在会话内以字符串读写：写入 `DATETIME(3)` 为 UTC 墙钟，读取用
`DATE_FORMAT(col, '%Y-%m-%dT%H:%i:%s.%fZ')` 再截到 3 位小数，输出 `YYYY-MM-DDTHH:mm:ss.SSSZ`；
不依赖 pool 的 `dateStrings`/`timezone` 配置。`source_chain` 内的 JSON 时间戳**不重写**，保留原值快照。

## 3. 原子性、锁序与错误语义

- 每个写事务在**同一条连接**上：`template` 父行 → `draft` → 按 `item_id` ASCII 升序的 item 身份 → item/version 行。
  首次 item 竞争由**已存在的 template 父行** `SELECT … FOR UPDATE` 串行化，绝不以锁不存在的 item 行冒充。
- 全进程无内存锁；不同连接/进程的互斥由 InnoDB 行锁提供（两连接与并发 publish 测试已证）。
- `create`：父行、draft、复制 item 同事务；跨 template / 重复 item / 非 0 revision 失败零残留；
  重复 template 映射 `TEMPLATE_EXISTS`。
- `updateTemplate`/`updateDraft`：父行锁后各自核 `revision` 再 CAS 递增，冲突分别为
  `TEMPLATE_REVISION_CONFLICT` / `TEMPLATE_DRAFT_CONFLICT`。
- `putItemVersion`：父行锁内取 latest，复用 `repository.ts` 同一套 canonical/unit/无歧义维度键集合与
  `itemContent`（无第二套身份判定）；相同内容复用、不覆盖 source_chain；否则 append `MAX+1`。
- `publish`：父行 + draft 同一事务；**先核两个 revision，再按 hash 幂等**（旧 revision + 已有 hash 仍是冲突）；
  新版本 `MAX+1` 与双 revision 递增均在任何写之前检查上限；插快照后更新 pointer/CAS 失败整体回滚；
  已有 hash 且 CAS 新鲜则 noop 且不移动 pointer、不改快照。
- 任何错误 `rollback`，连接在 `finally` release；死锁/断连**不自动重试**。
- commit 回执未知用适配器本地 `TemplateStorageUnknownCommitError`（`TEMPLATE_STORAGE_UNKNOWN_COMMIT`，
  未扩公共 `errors.ts`）报告，携带脱敏操作身份（template_id / content_hash / expected_revision），
  调用方只读重查；“commit 已落库但确认丢失”与“commit 前断开确实回滚”分别用真实服务器行为验证。

## 4. 存储兼容边界（T2A 明确缺口，不是公共契约问题）

适配器在执行任何写入前检查 SQL 列可表示性，超出即以 `TEMPLATE_INVALID_INPUT` 拒绝并注明
**internal T2A storage boundary**，不截断、不猜值：

| 边界 | 范围 |
|---|---|
| `created_by` / `updated_by` | `INT` 0..2147483647 或 NULL（schema 允许更大的非负整数） |
| `canonical_metric_id` | `VARCHAR(128)`（schema 的 MetricId 无长度上限） |
| `canonical_semantic_version` | `VARCHAR(16)`（schema 的版本号无长度上限） |
| SQL 日期 | `DATETIME` 年份 1000..9999（schema 允许 4 位更早年份） |
| 版本 / revision | 1..2147483647 / 0..2147483647，递增前检查上限 |

这些是 140 候选 DDL 相对已接受 schema 的**已知限制**，T2A 不改列、不加列、不改 schema。T2B 需先定最小
存储兼容候选，再讨论应用 migration/集成；共享/生产 DDL 仍需对象授权与评审。

## 5. 真实 fixture 与验证

独占选择器：container `max237-t2a-15coder1-20261027`、labels `max237.owner=15coder1-t2a` /
`max237.phase=T2A-20261027`、schema `max237_t2a`；镜像 `mysql:8.4`
（实际 image ID `sha256:c592c15aaf4a1961e15d82eb31ea5987dda862d1c4b1e93424438c0e91dc1f8d`），
容器 ID `b232577f0f27…ba664`，仅回环动态端口 `127.0.0.1:58416`、仅自有数据卷
`max237-t2a-15coder1-20261027-data:/var/lib/mysql`，不挂宿主目录/共享卷、不建网络对象、不碰平台 compose
或平台数据库。库默认 `utf8mb4` / `utf8mb4_bin`，五表及所有文本列 collation 均为 `utf8mb4_bin`。

root 只初始化本库、执行一次 DDL 并创建一次性测试用户 `max237_t2a_app`；该用户仅有本 schema 的
`SELECT/INSERT/UPDATE/DELETE`（`CREATE`/`DROP` 探针返回 `ERROR 1142`）。root 与测试用户密码均为随机生成，
只存在于未跟踪的 0600 私有文件/进程环境，未写入仓库或证据。

| 命令（cwd `apps/db-ops-api`，除注明外） | 结果 |
|---|---|
| `npx vitest run src/metrics/templates`（注入 `MAX237_T2A_MYSQL_*`） | **5 文件 / 73 passed**（catalog 6、repository 13、service 27、adapter 单元 11、真实 MySQL 16），exit 0 |
| `npx vitest run src/metrics`（不带 MySQL 变量） | **48 文件通过 / 25 跳过；499 passed / 137 skipped**，exit 0 |
| `npx tsc --noEmit` | exit 0，无诊断 |
| `npx oxlint apps/db-ops-api/src/metrics/templates`（仓库根） | 0 warning / 0 error，12 files |

真实 MySQL 覆盖：create 原子失败/重名；两类 CAS；首 item 兼容/不兼容竞争；同 revision 并发 publish 恰好一胜一拒；
同 hash 的陈旧/新鲜 revision 两种结果；插快照后 pointer 更新失败回滚；commit 前断开回滚；commit 后丢确认只读重查；
大小写不同 ID 独立与有序游标；空键/逗号键/Unicode/键序 JSON；SQL NULL；0/1/2/3 位 UTC；actor/长度/年份/版本/
revision 边界拒绝；断开重建连接后持久读取；旧快照不变。mock 仅覆盖错误分支，不替代真实事务证据。

## 6. 本包没有做（不得当成完成）

- 未挂载：无路由、无进程注册、无共享连接池、无 db-connection 接入、无应用 migration、无 scheduler/collector/通知/模型调用。
- 无公共契约/导出变更，`contracts:check` 未重跑（无此影响）。
- 无真实业务采集闭环：Linux SSH / MySQL / PostgreSQL / Oracle / 达梦 / 华为 SNMP 原生模板、速率与未知边界、
  共享读取与凭据隔离等原六项验收全部仍待办；本 fixture 的合成模板数据不算真实数据库业务闭环。
- 无 T2B 存储兼容决定、无部署/合并；PR #390 保持未合并，CI 现状只记录、不轮询。
- 整单保持 `in_progress`；T1 接受保留。
