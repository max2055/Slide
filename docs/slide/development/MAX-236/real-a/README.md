# MAX-236 / P0-REAL-A：独占真实 schema 的迁移 / 回退执行包

本目录是 Max 于 2026-10-27 授权（评论 `01a17ab8-7a68-782d-b23a-984fd802f74b`，决定
`44bf126e4:docs/slide/development/MAX-235/real-a-dispatch-20261027.md`）后的执行交付：
在本批**自建、独占、非生产**的 MySQL 库中，用仓库真实迁移账本建库，运行可执行的
迁移 / 回退入口，并保留脱敏证据。

`P0-REAL-A-correctness-remediation` 随后按 Chief 复审的 **A1–A3** 做有限补修：归属前置校验、
完整结果重放/回退与提交前原子校验、全列内容级保留证明。它仍不是生产迁移、不是 P1 接线、
不是三类采集闭环。

## 1. 结论先行

| 项 | 结果 |
|---|---|
| 真实 schema 建库 | 134 条真实 migration 全部 completed（`app_schema_migrations` 无未完成行），MySQL 8.4.10，179 张表（含候选 140–142 新建的 12 张） |
| 归属前置（A1） | 创建时记录容器全 ID/镜像 ID/专属网络 ID/卷/动态回环端口/写允许清单；连接、start、drop、seed、stop、remove 前 fresh 核对；同名但 ID/标签/挂载/网络/端口不符一律拒绝 |
| instance 迁移 / 回退 | **已执行**：revision 0→1→2→3→4；2 pin 迁移、单 pin 变更、回退到 2 pin revision、回退到基线单包 |
| server 迁移 / 回退 | **已执行**：0→1；同 revision overrides 漂移后重放被拒；完整回退到 0（overrides/group 恢复）；回退重放 = `noop`；失败注入整段回滚；再迁移到 revision 3 |
| network_device | **未映射**：真实 schema 没有设备指标目录，计划被阻断；写允许清单也不含 device，写入被拒绝，资源状态未变 |
| 精确重放（A2） | 同一计划重放 = `noop`，不新增 revision / 审计；完整结果（pins/package/group/overrides/resolved/application）不符 = `REAL_REPLAY_CONFLICT`，不写；计划后基线漂移 = `REAL_BASELINE_DRIFT`，不写 |
| 保留断言（A3） | 每次 apply/rollback 前的写入事务内完成 7 项内容级断言：历史全列、凭据库内哈希、ACL 全列（含 `access_level`/`grant_expiry`）、revision、审计全行前缀、单执行者、事件；任何失败在 COMMIT 前 ROLLBACK |
| 事务回滚 | `after-binding` 注入失败 → payload 不变、审计不增、revision 不前进；同连接内历史被改 → `REAL_PRESERVATION_VIOLATION` 且未提交 |
| 目标守卫 | 非记录内数据库/容器 ID/owner/phase/镜像/卷/网络/端口、非白名单资源、错误确认串均拒绝；拒绝发生在连接之前 |
| 默认 plan 一致性（B1） | 同一连接显式 `REPEATABLE READ` + `START TRANSACTION READ ONLY`，从 `performance_schema.events_transactions_current` 验证 ACTIVE 事务的隔离级别与访问模式；失败 `ROLLBACK` 并关闭。连接用**已验证**的 `127.0.0.1:<记录端口>` 与有界 connect/statement/lock 超时；`localhost` 拒绝 |
| 连接后身份（B1） | plan 与 apply 都在任何状态读取之前核对实时 `DATABASE()`/`@@hostname`/版本/owner/phase；不符即关闭连接 |
| 旧 plan 调用绑定（B2） | `--plan` 提交时必须与**当前 manifest** 的 resource/identities/pins/object_blockers 一致，新增 blocker 不再被忽略 → `REAL_PLAN_INVOCATION_MISMATCH` |
| 回退基线绑定（B2） | 回退计划携带完整 live baseline（含 payload digest）；锁内重读并比对，同 revision 的 overrides/payload 漂移 → `REAL_ROLLBACK_BASELINE_DRIFT`，零写。原 baseline 记入回退审计行，合法重放仍产出**同一 digest** 并 `noop` |
| 截断段（B3） | `acl`/`events`/`schedules` 任一侧 `truncated=true` 即判 `fail`（自比也不通过）；`unknown/unsupported` 继续独立、不计 PASS |

## 2. 文件

| 文件 | 作用 |
|---|---|
| `../../../../apps/db-ops-api/src/metrics/dry-run/real-migration.ts` | 真实 schema 快照、计划、apply / rollback、保留断言、句柄/端点守卫（无路由、无启动接线） |
| `../../../../apps/db-ops-api/scripts/max236-migrate.ts` | S9 迁移入口；默认只读计划，`--apply` 需句柄 + 精确 digest + 确认串 + 资源白名单 |
| `../../../../apps/db-ops-api/scripts/max236-rollback.ts` | S9 回退入口；追加 revision，不压平多模板，支持同一回退命令的合法重放 |
| `sql/140_metric_template_aggregate.sql` | 候选 DDL（模板聚合/草稿/不可变版本），从 `08` §1.1 逐字提取 |
| `sql/141_metric_trigger_snapshots.sql` | 候选 DDL（规则/触发快照），从 `08` §1.3 逐字提取 |
| `sql/142_metric_problem_episode_evidence.sql` | 候选 DDL（水位/评估/episode/证据），从 `08` §1.4 提取；**表顺序修正**见文件头 |
| `env-start.sh` | 独占网络/卷/容器初始化：记录精确句柄 → 核对 → 真实迁移 + 候选 DDL + 自有种子 |
| `env-clean.sh` | 读取句柄，逐对象核对 ID/标签后优雅停止/删除；错误可见，三条复查为空 |
| `bootstrap-library.sql` | 本批自有资源/历史/ACL（含授权级别与有效期）/凭据占位/绑定/审计种子（可重复执行） |
| `run-evidence.sh` | 一键复现 plan/apply/replay/漂移/回退/回退重放/注入/内容负例；每个 docker 动作前重新核对精确 ID/标签/挂载/网络/端口，`docker exec` 只用容器 ID，SQL 入口另核资源白名单。输出目录由 `MAX236_REALA_EVIDENCE_DIR` 指定（默认 `evidence/correction-20261027/`，本轮 B1–B3 在 `evidence/boundary-20261027/`） |
| `manifests/*.json` | 脱敏的盘点导出（身份、目标、pin）；不含凭据或业务数据 |
| `evidence/` | 历史 REAL-A 证据保留；A1–A3 补修在 `evidence/correction-20261027/`，B1–B3 边界补修在 `evidence/boundary-20261027/` |

候选 SQL **不在** `apps/db-ops-api/sql/migrations/`，不会随应用部署；143（binding 增量列）与
144（物理审计表）仍明确否决，未创建。

## 3. 句柄与归属边界（A1）

`env-start.sh` 首次创建时写入 `<repo>/.max236-reala/handle.json`（未跟踪、权限 600），记录：

- `container_id`（64 位）、`image`（`sha256:` 镜像 ID）、`network` + `network_id`、
  `volume` + 卷标签、`volume_destination=/var/lib/mysql`、动态回环 `port`、
  `database`/`user`、`password: empty`、写允许 `resources`（`instance:9101`、`server:9201`）。

任何后续动作都先 `docker inspect` 精确 ID 并核对上述事实，**然后才建立连接或执行
start/drop/seed/stop/remove**。同名容器/卷/网络若没有句柄记录，脚本拒绝复用或删除；
`openRealSession` 在 `createConnection` 之前完成 DSN 与本机回环端口/数据库/用户的核对。
DSN 中的非空密码、远程主机或未记录端口直接拒绝；owner 不再由调用方前缀“自证”。

## 4. 计划与写入边界（A2）

- 计划绑定：执行器**源码指纹**、schema 指纹（列 + 索引/约束 + `app_schema_migrations`
  id/checksum/status）、完整 binding payload 基线、调用内容（identities/pins/blockers）。
- apply：同一连接 `metric_policy_lock FOR UPDATE` 内重读基线并**重算计划**，任一漂移拒绝；
  写入后在同一事务内重读快照并做保留/结果/审计断言，全部通过才 COMMIT。
- 精确重放要求 revision、pins、package、group、overrides、`resolved`、`application` 全部等于
  该计划的目标状态，且存在本计划 `request_id` 的审计行；否则 `REAL_REPLAY_CONFLICT`。
- 回退恢复 target revision 的**完整配置**（pins/package/group/overrides），同时写 payload
  与真实 `group_id` 列并保持一致；审计记录实际写入值。同一回退命令重放为合法 `noop`。

## 5. 内容级保留（A3）

- 历史/事件/审计按 information_schema 的**实际列**读取并对整行做摘要；`DATETIME`
  显式编码，不再被 `digestOf({})` 吞掉。`metrics_history` 的 `buffer_pool_hit_rate` 等
  此前遗漏的列现在参与比较。
- ACL 使用 `instance_permissions` 全列（`id/user_id/instance_id/access_level/grant_expiry/created_at`）；
  server/device 无资源级 ACL 表时状态为 `unsupported`、`complete=false`，不计 PASS。
- 凭据只比较库内 `SHA2(ciphertext)` 与 presence，从不取回密文；平台审计按全行摘要比较前缀。
- 任何 block 超过有界行数即 `truncated=true` 并判 **fail**；读取错误直接使写入拒绝。
- 模板 pin 的 version 必须 `published`、hash 匹配、`aggregate.items/triggers` 与 `items`
  内容有效；`retired`/`draft` 不能成为新 apply 目标，历史 revision 仍可读。

## 6. 复现

```bash
# 1) 依赖（若 worktree 未安装）
pnpm install --frozen-lockfile

# 2) 独占环境：自动分配 127.0.0.1 动态端口；句柄写入 <repo>/.max236-reala/handle.json
bash docs/slide/development/MAX-236/real-a/env-start.sh

# 3) 聚焦测试（无 DSN 时 MySQL 套件 skip）
cd apps/db-ops-api
npx vitest run src/metrics/dry-run/real-migration.test.ts
MAX236_REALA_HANDLE=../../.max236-reala/handle.json \
MAX236_REALA_MYSQL_DSN="mysql://root@127.0.0.1:$(python3 -I -c "import json;print(json.load(open('../../.max236-reala/handle.json'))['port'])")" \
  npx vitest run src/metrics/dry-run/real-migration-mysql.test.ts
npx tsc --noEmit
cd ../.. && pnpm contracts:check

# 4) 端到端证据（重置种子 → plan/apply/replay/漂移/回退/回退重放/注入/内容负例）
bash docs/slide/development/MAX-236/real-a/env-start.sh
bash docs/slide/development/MAX-236/real-a/run-evidence.sh

# 5) 清理（三对象 fresh 核对后按精确 ID 删除；任一 inspect 非零即拒绝，三条复查必须为空）
bash docs/slide/development/MAX-236/real-a/env-clean.sh
```

CLI 的写操作要求同时给出：

```bash
export MAX236_REALA_HANDLE="$PWD/.max236-reala/handle.json"
export MAX236_REALA_DSN="mysql://root@127.0.0.1:<handle port>/max236_reala"
npx tsx scripts/max236-migrate.ts --manifest <manifest.json>                 # 只读计划
npx tsx scripts/max236-migrate.ts --manifest <manifest.json> --apply \
  --confirm max236_reala@<container_id12>:<resource> --expect-digest <digest>    # 显式写
```

## 7. 证据分级

| 类 | 计划 | 写入 | 能证明 | 不能证明 |
|---|---|---|---|---|
| instance:9101 | 2 mapped+1 keep-legacy，cutover 允许 | apply/replay/漂移拒绝/rollback/回退重放 | 真实表上的 revision、payload 唯一权威、全列保留断言、提交前事务回滚 | 真实采集、通知、并发 |
| server:9201 | 1 mapped+1 keep-legacy | apply/overrides 漂移/回退/注入/再 apply | 同上；server 历史表与凭据库内哈希；ACL 如实 unsupported | 真实 SSH 采集；server 无资源级 ACL 表 |
| network_device:9301 | blocked（无设备指标目录） | 拒绝（写白名单亦不含 device），未写 | 计划/守卫在真实 schema 上的阻断行为 | 设备映射、真实 SNMP |

## 8. 归属与清理

| 项 | 值 |
|---|---|
| 容器 | `max236-reala-15coder1`，`max236.owner=15coder1-reala`、`max236.phase=P0-REAL-A` |
| 卷 | `max236-reala-15coder1-data`（同标签，无共享） |
| 网络 | `max236-reala-15coder1-net`（同标签，专属） |
| 端口 | `127.0.0.1:<动态端口>`（仅回环，记录在句柄） |
| 数据库 | `max236_reala`（测试套件另建 `max236_reala_test` 并自删） |
| 镜像 | `mysql:8.4`（句柄记录精确镜像 ID） |
| 清理 | `env-clean.sh`：读取句柄，逐对象核对 ID/标签后优雅停止/删除；任一 `inspect` 非零即拒绝并保留句柄；不 prune、不按端口/进程名清理 |

秘密只出现在任务本地的未跟踪环境变量中；容器内为 `MYSQL_ALLOW_EMPTY_PASSWORD` 与占位值，
资源凭据列为 `ENC[not-a-secret]`，执行器只读取库内哈希与“是否非空”，从不读取值。

## 9. B1–B3 边界关闭（2026-10-27，review `c23d59169`）

Chief `chief-real-a-correction-review-20261027.md` 确认的 5 项独立检查（3 项截断 + 2 项真实 SQL/CLI）
现已全部成为回归测试；执行器协议版本升为 `max236-real-a/3`（digest 因此变化，旧计划需重新生成）。

### B1 — 目标验证覆盖所有动作

- `openRealSession`：先 `docker inspect` 精确 ID 并核对，再按**已验证的回环发布端点**建连；
  `localhost` 视为不同 socket 拒绝；connect / statement / lock wait 均有界。
- `openVerifiedSession`：连接后先读实时 `DATABASE()`/`@@hostname`/版本/owner/phase，不符即关闭，
  任何状态 SELECT 都不会执行。
- 默认 plan：`beginReadOnlySnapshot` 显式 `SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ`
  → `START TRANSACTION READ ONLY` → 从 `performance_schema.events_transactions_current`（ACTIVE 行）
  验证 `ISOLATION_LEVEL='REPEATABLE READ'`、`ACCESS_MODE='READ ONLY'`；读失败/验证失败一律 `ROLLBACK`，
  永不 COMMIT，连接由 CLI `finally` 关闭。
- `run-evidence.sh`：所有 SQL 与 docker 动作前重新核对容器 ID/镜像/owner/phase/挂载/网络/发布端口、
  网络 ID/标签、卷/标签与运行态；`docker exec` 只用 `<container_id>`，不再有按名旁路；
  `sql_for` 另核资源写允许清单。`env-clean.sh` 先核对容器/网络/卷三者，之后才 stop/remove
  （原先先删容器再核网络/卷的顺序已修正）。MySQL 套件 `afterAll` 在 DROP 前重新 inspect + 校验。
  清理脚本的 inspect 失败语义见 §10。

### B2 — 调用与回退完整基线

- `assertPlanInvocation`：`--plan` 提交时比较当前 manifest 与计划 invocation（resource/identities/
  pins/object_blockers），新增 blocker 直接拒绝；真实反例见 MySQL 套件（exit 2、revision 0）。
- `RealRollbackPlan.baseline`：完整 live baseline（payload digest + 配置）；apply 在事务前与锁内
  各比对一次，同 revision 漂移零写；回退审计行记录该 baseline，使同一命令重放的 digest 与
  `noop` 仍可达（`REAL_ROLLBACK_BASELINE_MISSING` 用于缺少该行的旧记录）。

### B3 — 截断段不得伪完整

`verifyPreservation` 的 `acl`、`events-unchanged`、`single-executor` 现在都会因任一侧
`truncated=true` 判 `fail`；`unsupported`（如 server/device 无资源级 ACL 表）仍为独立状态，
不升格为 PASS，`complete=false`。

证据：`evidence/boundary-20261027/`（`verification-boundary-20261027.md`、`pure-tests.txt`、
`mysql-tests.txt`、`boundary-evidence-sha256.txt`、`boundary-cleanup-20261027.txt`）。

## 10. CLEAN-UNKNOWN：inspect 失败不等于不存在（2026-10-27，review `2cd78a59c`）

Chief 复审在准确 HEAD `0e27c8f1c` 上用无网络假 `docker` 复现：其余对象完全匹配、只让
`docker network inspect` 返回非零时，旧 `env-clean.sh` 的
`if docker … inspect …; then … fi` 把任何非零退出都当成“对象不存在”，于是仍然
`stop`/`rm` 已识别容器并删除卷，最后返回成功并删除句柄。这属于 B1 fail-closed 清理的确认缺陷。

本修订（`P0-REAL-A-cleanup-inspection-correction`）：

- `env-clean.sh` 不再用 `if inspect` 表示存在。新增 `probe <kind> <exact id>`：**只有
  `docker container|network|volume inspect <精确记录 ID>` 退出 0 才继续**；任何非零退出
  （daemon 不可用、权限、暂态错误、ID 不符）在第一次 mutation 之前 `REFUSED`，
  **保留创建记录句柄**。
- 三个对象全部先核对（容器 ID/镜像/owner/phase/挂载/网络/发布端口，网络精确 ID/标签，
  卷精确名称/标签），任一不符或探测失败即拒绝；通过后才 stop → rm → network rm → volume rm。
- 本修订**有意不保留**“对象已不存在”的幂等捷径：非零 inspect 无法区分“确实已被删除”和
  “读不到”，而用失败的查询冒充 absence 正是被复现的缺陷。部分清理后由操作者依据保留句柄
  自行核对；如后续要恢复该能力，必须用**成功的精确 ID/名称查询**证明不存在，并另加
  absence 正例。
- 原反例（仅网络 inspect 非零）与同一根因的容器/卷 inspect 非零三个反例均已成为回归测试，
  断言 `refused=true`、`stop/rm/volume rm` 为 0、句柄仍在；原有正常顺序/归属 spy 测试保留。

聚焦结果：`real-migration.test.ts -t "shell verify-before-act"` 8 passed（含 3 个新反例），
`npx tsc --noEmit` exit 0；已接受的 82 纯模型 / 24 真实 MySQL / B2、B3 与旧 49/66 未重跑。
真实生命周期只用本批新建独占环境做一次 start → fresh inspect → 按精确 ID 清理 → 成功查询
absence；证据见 `evidence/cleanup-inspection-20261027/`。

B2/B3 与连接/只读 plan 已在 `2cd78a59c` 接受；**CLEAN-UNKNOWN 关闭后 B1 才可宣称收口**，
但整单五项、A01–A22、D1–D8/S1–S11/P1/生产仍未放行。
