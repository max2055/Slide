# MAX-237 / T2B：未挂载存储兼容候选与独占升级/回退演练

本目录是 Issue #261（Multica MAX-237）**MAX237-T2B 内部候选包**的交付说明。准入依据是 Issue 描述所附
`t2b-owned-candidate-admission-20261027.md`（附件 `01a17bba-2a42-78a0-8490-85ffb37bfbc2`），其前置为
`chief-tx-cleanup-review-20261027.md` 在 HEAD `32dd311af5ea4e3b2e7424f945f7b4a667f7e068` 对 T2A 的有限接受。
T1 与 T2A 已接受结论不重做。

**一句话结论**：在 T2A 五表 140 之上，新增一个**未挂载**的 T2B 存储兼容候选 DDL（BIGINT UNSIGNED actor、
LONGTEXT ascii canonical 身份、24 字符 canonical UTC `CHAR(24)` 时间），适配器只改这三类表示/映射/校验，
保留已接受的事务清理、锁序、CAS 与未知提交语义；并在一次性独占 MySQL 8.4 容器上用三个 schema
（原样 140 源 / 候选 / 原样 140 回退副本）完成**仅演练**的 up/down 与失败注入验证。**83/83** focused 测试、
**reject 14/14 + safe 27/27** 演练步骤、`tsc` 0、`oxlint` 0/0 通过。T2B-DRILL-TX-GUARD 有界补修（未知事务
终态 discard、commit 结果重查分类、三 schema 冻结结构预检）见 [tx-guard-20261027.md](tx-guard-20261027.md)；
T2B-FK-GUARD 有界补修（外键引用 schema 与 ON UPDATE/ON DELETE 规则、拒绝场景与安全 roundtrip 分属两具
fresh fixture）见 [fk-guard-20261027.md](fk-guard-20261027.md)；T2B-DDL-ERROR-GUARD 有界补修（root DDL
子进程失败只暴露受控 exit code，不回显 `MYSQL_PWD`/argv/子进程 stderr）见
[ddl-error-guard-20261027.md](ddl-error-guard-20261027.md)；**没有**接应用库、没有公共契约变更、
没有应用 migration、没有真实采集闭环，整单保持 `in_progress`。

## 1. base / 提交 / 允许面

| 项 | 值 |
|---|---|
| 任务分支 | `agent/15coder1/max-237`（未切分支、未 rebase/squash） |
| 交付 base（T2A 接受点） | `32dd311af5ea4e3b2e7424f945f7b4a667f7e068` |
| 产品提交 | `bc1c66d74` |
| 新增 | `t2b/sql/t2b_metric_template_aggregate.sql`、`t2b/env-start.sh`、`t2b/env-clean.sh`、`t2b/migrate.ts`、`t2b/drill.ts`、本 README、`t2b/evidence/**`、`t2b/fk-guard-20261027.md`、`t2b/evidence/fk-guard/**` |
| 修改 | `apps/db-ops-api/src/metrics/templates/mysql-repository.ts` 及其两个测试 |
| 只读未改 | `service.ts`、`model.ts`、`errors.ts`、`repository.ts`、`index.ts`、公共契约、共享 pool/db-connection、应用 migration、236 文件、runtime/scheduler/resolver/collector、consumer/routes/前端 |
| 允许清单 patch | [evidence/t2b-allowlist.patch](evidence/t2b-allowlist.patch)（53 290 bytes，sha256 `5d01bbbd642aba69f07df3611fa857950f4bafa578f81493ed86875fe23f81ba`） |

| 文件 | 行数 | sha256 |
|---|---|---|
| `mysql-repository.ts` | 878 | `a660c1db890ef593280fd7258a50d94a21a8ad575bad56c26fb41ceeb2ecb1c7` |
| `mysql-repository.test.ts` | 280 | `45468356ead0554d8030cdc27e31c0d4d7209f13b3707737c031e8be492bb0a5` |
| `mysql-repository.mysql.test.ts` | 873 | `14354a4eaa9efe7cd0b27a38451daeda8cf7d32ec72adec435042b80dbd42356` |
| `t2b/sql/t2b_metric_template_aggregate.sql` | 81 | `c599f6b6505cf900c1b1b924dc3789d0a945a77c97c8722bae017029f7814323` |

`repository.ts`（`d722c5e8…`）、`model.ts`（`d3207eb1…`）、`errors.ts`（`4f047fc3…`）、`index.ts`（`b63c556b…`）
与 T2A 接受时逐字节一致；原 140（`3fab3958…`）未改，继续作为迁移来源与回退目标。

## 2. 冻结逐列候选（仅五张同名表）

以 T2A 的 140 为起点，表名、PK/FK、`uk_content` 唯一 hash、JSON 列语义不变，只改：

| 表 | 列 | T2B 候选 |
|---|---|---|
| `metric_templates_v2` | `created_by` | `BIGINT UNSIGNED NULL`，0..9007199254740991 或 NULL |
| `metric_template_drafts` | `updated_by` | 同上 |
| `metric_template_item_versions` | `canonical_metric_id` | `LONGTEXT ascii ascii_bin NOT NULL`（无人工长度上限） |
| `metric_template_item_versions` | `canonical_semantic_version` | 同上 |
| `metric_template_item_versions` | `idx_canonical` | **非唯一**前缀索引 `(canonical_metric_id(128), canonical_semantic_version(16))`，仅查询加速，**不是身份判据** |
| `metric_templates_v2` | `created_at` / `updated_at` | `CHAR(24) ascii ascii_bin NOT NULL` |
| `metric_template_drafts` | `updated_at` | 同上 |
| `metric_template_versions` | `published_at` / `retired_at` | 同上；`retired_at` 允许 NULL |
| `metric_template_items` | `created_at` | 同上 |

版本、revision 及所有 version/pointer 列保持 `INT`：`VersionNumberSchema`/`RevisionSchema` 明确上限
2147483647，不扩 BIGINT。其余字段与 collation（表 `utf8mb4_bin`）不动。没有第六张业务表/影子 registry，
也没有用 hash 代替 canonical 完整身份。

## 3. 适配器改动（`bc1c66d74`）

- **actor**：`sqlActorId` 写前拒绝非整数、负数与 `>9007199254740991`；`fromSqlActorId` 对 `mysql2` 的字符串
  与数值两种返回形态都显式 `Number.isSafeInteger` + 范围校验，不靠位运算或截断。测试 pool 启用
  `supportBigNumbers`/`bigNumberStrings`，另有 number-form pool 验证同一行两种形态都能读。
- **canonical 身份**：删除 T2A 的 `VARCHAR(128)/VARCHAR(16)` 人工拒绝；沿用已接受 `MetricRefSchema` 的 ASCII
  正则（`MetricIdSchema`/`VersionSchema`）作为唯一文本规则，完整值参与身份比较。前缀索引只用于查询。
- **时间**：`toSqlTimestamp` 用 `TimestampSchema` 校验后写精确 24 字符 canonical UTC 串（年份 0000..9999，
  0–3 位小数统一为 3 位）；`fromSqlTimestamp` 只接受该精确形态。移除 `DATE_FORMAT`，不再依赖 pool 的
  `timezone`/`dateStrings`。JSON 快照原值不重写（`source_chain.created_at` 的 `…T00:00:00.1Z` 保持一位小数）。
- **保留**：T2A-TX-CLEANUP 的“仅确认 commit/rollback 后才 release，否则 destroy”、父行优先锁序、
  revision/version CAS、`TEMPLATE_STORAGE_UNKNOWN_COMMIT` 与脱敏身份全部不变。
- **边界**：`INT` 版本/revision 上限仍在写前检查；LONGTEXT/packet/驱动容量属于真实存储边界，显式拒绝，
  不声称无限容量，也不改公共 schema 加长度上限。

## 4. 独占 fixture（三个 schema，一个容器）

| 项 | 值 |
|---|---|
| 容器 | `max237-t2b-15coder1-20261027`，本次 `e5e762eaf458…838fa9` |
| 镜像 | `mysql:8.4`，`sha256:c592c15aaf4a1961e15d82eb31ea5987dda862d1c4b1e93424438c0e91dc1f8d`，服务端 8.4.10 |
| labels / 卷 | `max237.owner=15coder1-t2b`、`max237.phase=T2B-20261027`；专属卷 `max237-t2b-15coder1-20261027-data` |
| schema | `max237_t2b_d1`（原样 140 + 合成旧数据）、`max237_t2b`（候选五表）、`max237_t2b_restore`（原样 140） |
| 账号 | `max237_t2b_app` 仅三个 schema 的 `SELECT/INSERT/UPDATE/DELETE`，无 DDL/GRANT；随机密码只在未跟踪 0600 文件 |
| 网络/挂载 | 仅 loopback 动态端口；只挂自有卷，无宿主目录/共享卷/网络对象；未加载平台 `.env` |

三个 schema 是同一 fixture 的迁移源/候选/恢复副本，不是三个运行时 registry 或业务单写者，均无外部消费者。
运行结束按准确 ID 优雅清理容器/卷/私有状态，见 [evidence/t2b-cleanup.json](evidence/t2b-cleanup.json)。
机器可读 fixture 事实见 [evidence/t2b-fixture.json](evidence/t2b-fixture.json)。

## 5. 仅演练迁移与回退

`migrate.ts` 只在 `t2b/`，没有产品导出或运行接线；**默认 `plan` 零连接零写**（drill 在
`MAX237_T2B_FORBID_CONNECT=1` 的独立进程中证明 `connects=false`，而 `execute` 在同标志下被拒）。

- **handle/schema/冻结结构校验**：静态校验 owner/phase/container/image/volume/三 schema allowlist；所有写入口
  （seed/up/down）在第一条 DML 前证明连接的是记录容器（hostname 前缀）、允许账号，`max237_t2b%` 恰好三个
  schema、每库恰好五张表，并显式比对三 schema 的冻结列集合/类型/nullability/字符集 collation、engine、
  PK/唯一 `uk_content`/`idx_canonical`（候选 128/16 前缀）/其余索引与四个外键（引用 schema、引用表、列序、
  `ON UPDATE`/`ON DELETE` 规则）。漂移 → `structure-drift` 拒绝且零写；`plan` 仍零连接。
- **事务连接**：只在服务端确认 commit/rollback 后 release；begin 失败、rollback 未确认、commit 抛错一律
  destroy 且 destroy 失败不回退 release。commit 结果不明时以新连接只读重查 source/target manifest，区分
  `commit-not-applied` / `commit-unconfirmed` / `commit-unknown`，不盲目重放。
- **up**：源只读，目标必须为空；预检后才在**目标同一连接事务**按 父 → draft/items → item versions →
  template versions 复制。父行后/版本快照后注入失败都会回滚，由两个独立连接确认目标为空、源 manifest 不变。
  目标非空且与期望 manifest 相同 → 明确 `no-op`；漂移 → 拒绝且不覆盖。
- **down**：先全量检查是否可无损回 140（actor ≤ 2147483647、canonical ≤ 128、semver ≤ 16、UTC 年 ≥ 1000）；
  任一不满足即**拒绝且不写**，candidate/source/restore 三库不变，restore 仍为空；不做截断/DROP/TRUNCATE 或
  删除新增合法数据。超界拒绝现场与安全旧数据 round-trip 现在是**两个独立场景、两具 fresh fixture**：
  拒绝场景保留超界行并整体销毁 fixture，安全场景只含旧数据完成 down（见 6.2）。
- 没有应用 migration 注册、共享池、负载切换、平台重启或部署；本演练**不能**声称是已上线迁移。

## 6. 验证（存储候选绑定 `bc1c66d74`；TX-GUARD 绑定 `24ad7ec82`；FK-GUARD 绑定 `219a7e3dc`）

| 命令（cwd `apps/db-ops-api`，除注明外） | 结果 |
|---|---|
| `npx vitest run src/metrics/templates`（注入 `MAX237_T2B_MYSQL_*`） | **5 文件 / 83 passed**，exit 0（日志 [evidence/t2b-test-log.txt](evidence/t2b-test-log.txt)） |
| `npx vitest run src/metrics`（不带 MySQL 变量） | **48 文件通过 / 25 跳过；503 passed / 143 skipped**，exit 0 |
| `npx tsc --noEmit` | exit 0，无诊断 |
| `npx oxlint apps/db-ops-api/src/metrics/templates`（仓库根） | 0 warning / 0 error，12 files |
| `npx oxlint docs/slide/development/MAX-237/t2b`（仓库根，FK-GUARD） | 0 warning / 0 error，2 files（[evidence/fk-guard/fk-guard-oxlint.txt](evidence/fk-guard/fk-guard-oxlint.txt)） |
| `tsc --noEmit`（仅 `t2b/migrate.ts`、`t2b/drill.ts`，严格模式，FK-GUARD） | exit 0（[evidence/fk-guard/fk-guard-typecheck.txt](evidence/fk-guard/fk-guard-typecheck.txt)） |
| `tsx t2b/drill.ts --scenario reject --out t2b/evidence/fk-guard/fk-guard-reject.json` | **14/14 PASS**，exit 0（[evidence/fk-guard/fk-guard-reject.json](evidence/fk-guard/fk-guard-reject.json)） |
| `tsx t2b/drill.ts --scenario safe --out t2b/evidence/fk-guard/fk-guard-safe.json` | **27/27 PASS**，exit 0（[evidence/fk-guard/fk-guard-safe.json](evidence/fk-guard/fk-guard-safe.json)） |
| `tsx t2b/ddl-error-guard.test.ts`（假 `docker`，无数据库；DDL-ERROR-GUARD） | **4/4 PASS**，exit 0（[evidence/ddl-error-guard/focused-test.txt](evidence/ddl-error-guard/focused-test.txt)） |
| `python3 -I chief-secret-probe.py <repo> <out>`（fresh 独占 fixture，DDL-ERROR-GUARD） | exit 1、stdout/stderr/`--out` 均无哨兵（[evidence/ddl-error-guard/secret-probe.json](evidence/ddl-error-guard/secret-probe.json)） |

真实 MySQL 正例：actor `2147483648`、`9007199254740991`、NULL 两种驱动形态读回；canonical 512 字符与
semver 100 字符；同 128/16 前缀不同后缀的完整值不混同（同 item 改后缀仍是
`TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE`）；UTC `0000/0999/1000/9999` 与 0–3 位小数；SQL NULL、JSON 原值、
新连接重读持久化。反例：schema 拒绝非安全整数输入、外部写入超安全范围读回显式拒绝、非 ASCII/非法 semver、
非法日期、stale CAS、INT 版本/revision 上限、未知 handle、错误 schema、目标漂移/非空、up 失败不部分写、
不可无损 down 明确拒绝不破坏任何库。

保留的 T2A 真实事务证据（TX-CLEANUP 两反例、commit 丢确认、新连接重查、双 CAS、首 item 竞争、
immutable publish、溢出零部分写）在本包同一套件内继续通过。

### 6.1 MAX237-T2B-DRILL-TX-GUARD 补修

- **R1 事务连接**：`up`/`down` 默认 discard，仅确认 commit/rollback 后 release；begin 失败、rollback 未确认、
  commit 抛错均 destroy，`destroy` 抛错不覆盖原失败且不回退 release。真实 commit 丢确认时以新连接只读重查
  source/target manifest，区分 `commit-not-applied` / `commit-unconfirmed` / `commit-unknown`，不重放写入。
  Chief 在 base 的两个真实 FAIL 反例已有记录；修复后同形状在真实 MySQL 上 `destroys=1/releases=0`，
  无关 `BEGIN/COMMIT` 前后目标均 0。
- **R2 冻结结构预检**：`verifyLiveFixture` 对 source/candidate/restore 显式比对列集合/类型/nullability/
  字符集、engine、PK/`uk_content`/`idx_canonical`（候选 128/16 前缀）/其余索引与四个外键；seed/up/down 的
  第一条 DML 前执行。真实 DDL 漂移分别对 source(type)、candidate(index)、restore(unique index) 拒绝并零写，
  恢复后结构快照逐字节相等。
- 详细对象、命令、mock/真实 DB 标注与限制见 [tx-guard-20261027.md](tx-guard-20261027.md)。

### 6.2 MAX237-T2B-FK-GUARD 补修

- **外键语义**：`readSchemaStructure` 现在读取 `REFERENCED_TABLE_SCHEMA` 与
  `REFERENTIAL_CONSTRAINTS.UPDATE_RULE/DELETE_RULE`；冻结结构用 `$self` 占位表示“本 schema”，
  跨库同名表不再被当作同一对象。
- **真实反例**：候选 FK 跨库指 source、同库 FK 改 `ON DELETE CASCADE` 两例，`seed`/`up`/`down` 均在第一条
  业务 DML 前 `structure-drift` 拒绝，业务 DML 计数 0，三库完整 manifest 不变（base 两例均为 acceptance
  并通过 up 写入 2/2/2/3/2 条）。
- **合成矩阵**：三个 schema × 四个 FK × 7 类变异（跨 schema、引用表、引用列、`ON UPDATE` 两种、
  `ON DELETE` 两种）共 84 例全部被比较器捕获。
- **场景分离**：`--scenario reject` 保存超界 actor/canonical/semver/year 原因、三库完整 manifest 与保留行后
  整体销毁 fixture；`--scenario safe` 另用 fresh fixture 只跑安全旧数据的 up/down roundtrip。旧“删除超界行再
  down”路径已移除；`evidence/t2b-drill.json` 仅作为 base `6dcb16651` 的历史记录。
- 详细对象、命令与两具 fixture 的清理证据见 [fk-guard-20261027.md](fk-guard-20261027.md)。

## 7. 本包没有做（不得当成完成）

- 未挂载：无路由、无进程注册、无共享连接池、无 db-connection 接入、无应用 migration、无 scheduler/collector/通知/模型调用。
- 无公共契约/导出变更，`contracts:check` 未重跑（无此影响）。
- 无可上线的存储兼容结论：共享应用 DDL/迁移授权、应用停写/切换/回退、pool 生命周期、模板资源级鉴权/审计/route
  契约、MAX-238 binding/compiler、MAX-239 事件、MAX-240 历史均未完成，由 Chief 协调存储/运维负责人。
- 无真实业务采集闭环：六项原验收与真实三类模板、速率/未知边界、共享读取与凭据隔离全部仍待办。
- PR #390 保持未合并；CI 只观察一次，不 watch/轮询。整单保持 `in_progress`。
