# MAX237-T2B-DDL-ERROR-GUARD 有界补修交付

本文件只记录 `t2b/drill.ts` 的 root DDL 子进程错误边界补修，依据
`44063e91f:docs/slide/development/MAX-237/reviews/fk-guard/t2b-ddl-error-guard-instruction-20261027.md`
与同提交的 `chief-fk-guard-review-20261027.md`、`synthetic-secret-probe.json`、`chief-secret-probe.py`。
已接受的 T1、T2A+TX-CLEANUP、T2B 存储表示、R1 事务处置与 F1/F2 外键预检结论不重做；`migrate.ts`、产品
adapter 及其两测试、冻结 DDL、公共契约、应用 migration、共享 pool、runtime/frontend 全部只读。

## 1. 精确对象

| 项 | 值 |
|---|---|
| base | `99b9eb0ba392effed2c3df3e149656d7dc276990`（F1/F2 接受点） |
| code commit | `c38c68485`（`drill.ts`、`ddl-error-guard.test.ts`） |
| docs commit | 本文件、README 与 `evidence/ddl-error-guard/**` 所在提交 |
| 分支 | `agent/15coder1/max-237`（仅追加，保留起点与 PR #390，未合并、未改历史） |
| 修改 | `t2b/drill.ts`：仅 `mysqlRootDdl` 的子进程失败处置（并导出该函数供专属测试调用） |
| 新增 | `t2b/ddl-error-guard.test.ts`、`t2b/evidence/ddl-error-guard/**` |
| 未改 | `t2b/migrate.ts`、`env-start.sh`、`env-clean.sh`、候选 DDL、原 140、产品源码/测试 |

`git diff 99b9eb0ba..HEAD -- apps packages frontend` 与工作树产品 diff 均为空
（[evidence/ddl-error-guard/scope.txt](evidence/ddl-error-guard/scope.txt)），`migrate.ts` 与两具 DDL 在
base/HEAD 逐字节相同，因此 83 focused / 503 passed-143 skipped metrics / API typecheck 0 的已接受证据继续有效，
未机械重跑；F1/F2、R1、safe 27/27 与 FK 六入口 DML 0 / 三 manifest 不变亦复用（见 §5）。

## 2. E1：root DDL 子进程失败回显私有 argv

原 `mysqlRootDdl` 直接 `execFileSync('docker', ['exec','-e','MYSQL_PWD=<root>', ...])`，失败时未捕获；
顶层 catch 把原始 `error.message` 写进 stderr 与 `--out` JSON，而 Node 的子进程错误 message 含完整 argv，
因此真实 root 口令会回显。补修只在这一边界：

- `execFileSync` 包在 `try/catch` 中；捕获后**不读** `error.message/stack/stderr/stdout/argv`，只取安全的
  `status` 数字。
- 抛出受控 `DrillError('root-ddl-failed', …)`：`message` 为
  `the root DDL subprocess failed with exit code 1 in this fixture`（或无法启动时的固定文案），
  `detail = { exit_code: 1 }`（无法启动时为 `null`）。
- 不打日志、不写文件、不含 `cause`；正常 SQL/FK/事务语义与成功路径 argv 未变。

## 3. 专属最小回归（`ddl-error-guard.test.ts`）

用放在 PATH 首位的假 `docker` 驱动真实 `mysqlRootDdl`，不连接任何数据库/容器，4/4 PASS
（[evidence/ddl-error-guard/focused-test.txt](evidence/ddl-error-guard/focused-test.txt)）：

| 检查 | 断言 |
|---|---|
| 成功子进程不变 | docker argv 逐项等于 `exec -e MYSQL_PWD=<pw> -i <cid> mysql -uroot -N -e <sql>`，无输出、不抛错 |
| 认证失败 | 抛出受控 `DrillError`（`root-ddl-failed`、`exit code 1`、`{exit_code:1}`）；哨兵不出现在 message/stack/自有属性/`cause`/序列化 error/CLI 会写的两类记录中；调用期间 stdout/stderr 零写入 |
| 子进程无法启动 | 受控 reason 与固定文案，`exit_code:null`，无哨兵 |
| 独立进程 | 真实子进程 exit=1，stdout/stderr 均无哨兵，记录 reason 仍为 `root-ddl-failed` |

## 4. 真实 CLI 失败回归（fresh 独占 fixture）

先 fresh 核旧对象：同 name 容器/卷不存在、无 `max237.owner=15coder1-t2b` 容器或卷、无创建记录
（[fresh-absence.json](evidence/ddl-error-guard/fresh-absence.json)）。随后自建唯一 fixture
`max237-t2b-15coder1-20261027`（container `1bd969bef470…`，缓存 MySQL8.4.10 镜像
`sha256:c592c15a…1f8d`，专属卷 `max237-t2b-15coder1-20261027-data`，loopback `55467`，三 schema
`max237_t2b_d1/max237_t2b/max237_t2b_restore`，state `0700`/handle/credentials `0600`；
[fixture.json](evidence/ddl-error-guard/fixture.json)）。

直接复用 Chief 的 `chief-secret-probe.py`（`44063e91f` 版本，sha256 `eff8bb2e…dca7`，不传 `--expect-leak`）：
只把该 fixture 的 root 口令临时换为已知非秘密哨兵 `CHIEF_SYNTHETIC_NON_SECRET_ROOT_SENTINEL`，app 口令保持有效，
首个 root DDL 真实认证失败：

- `exit=1`，`marker_in_stdout=false`，`marker_in_stderr=false`，`marker_in_out_file=false`，`output_exists=true`
  （[secret-probe.json](evidence/ddl-error-guard/secret-probe.json)）。
- 同一操作保留的 CLI 记录显示外部可见的只有受控失败
  `root-ddl-failed / the root DDL subprocess failed with exit code 1 in this fixture / {"exit_code":1}`，
  前 7 步已完成的受控步骤与（修改前会泄漏的）argv/stderr 无关
  （[cli-failure-record.json](evidence/ddl-error-guard/cli-failure-record.json)）。
- `finally` 恢复原私有文件；恢复后 root 认证成功，fixture 仍为空。

恢复原凭据后，在同一仍 fresh 的 fixture 执行真实 reject 场景：**14/14 PASS**，exit 0，stderr 为空；
第 14 步仍为“合法超界行被 down 拒绝、三 schema 不变且行保留”，超界数据与三库 manifest 留在证据中
（[reject.json](evidence/ddl-error-guard/reject.json)）。safe 27/27 的相关逻辑（`up`/`down`/manifest/回退校验）
本次未改，未重建第二具 fixture。

## 5. 复用与未重做

| 已接受证据 | 复用依据 |
|---|---|
| F1 外键引用 schema/规则预检、F2 reject/safe 独立场景 | `99b9eb0ba` 接受；本轮未改 `migrate.ts`/场景 |
| R1 事务清理真实反例、只读重查 | `6dcb16651` 接受；`drill.ts` 仅改 root DDL 错误处置 |
| safe 27/27、FK 六入口业务 DML 0、三 manifest 不变 | 相关实现与场景未改 |
| 83 focused（含 22 真实 DB）、503 metrics/143 skipped、API typecheck 0 | `apps`/`packages`/`frontend` diff 为空 |

严格 TypeScript（`migrate.ts`、`drill.ts`、`ddl-error-guard.test.ts`）exit 0
（[typecheck.txt](evidence/ddl-error-guard/typecheck.txt)），oxlint 3 files 0/0
（[oxlint.txt](evidence/ddl-error-guard/oxlint.txt)）。

## 6. 清理

`env-clean.sh` 按 handle 的精确 ID 停止并删除容器、删除专属卷，随后 fresh 核验：按 ID 无容器、按名无卷、
owner label 下无容器/卷，`.max237-t2b` 目录与 handle/credentials 均已删除
（[cleanup.json](evidence/ddl-error-guard/cleanup.json)）。未读平台 `.env`，未使用 236 旧句柄、共享库、
未知或生产资源，未做部署/权限/负载，未派发子代理或产品模型调用，未创建回调。

## 7. 边界

这是受控独占 fixture 上的错误边界补修，不等于真实业务/容量/SLO 或生产存储兼容；MySQL DDL 非事务，
不声称 ALTER 可事务回滚。T2B 仍只是未挂载存储候选；共享应用接线、目标对象与权限、逐列兼容、停写/切换/回退、
pool 生命周期与 route 决定仍由 Chief 协调存储/运维。MAX237 整项保持 `in_progress`，原六项/五项、A01–A22、
四标准/D05/O02/O03 与人工读屏排除均未改变。
