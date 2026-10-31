# MAX238-NATIVE-CONFIGURATION-FLOW-R2：完整首次配置与恢复修正

2026-10-30。**一句话结论**：完全未绑定的普通资源现在可以走完真实首次配置——真实只读能力探测 → 严格可信能力证据 → preview/trial 解析 → 原激活门禁 → host 同事务首次绑定 revision 1；同时修正了会话存储失败、迟到 preview 授权新草稿、指标显式停用导致的 receipt 身份漂移以及首绑 capability 列为空的问题。真实 Lit → 真实 Fastify → 一次性 MySQL 8.4（非 3306）→ 真实只读目标已跑通，证据见下。

## 1. 分支与提交

| 项 | 值 |
|---|---|
| 任务分支 | `agent/15coder1/max-238`（基点 `61c8c0822`，只追加） |
| 实现提交 | `88ba9a61b` |
| 新增迁移 | `apps/db-ops-api/sql/migrations/136_metric_capability_evidence.sql`（单表、additive、无 ALTER/DROP） |
| 未改写 | 未 amend/rebase/reset `61c8c0822` 之前的任何提交，未切换任务分支 |

## 2. 首次配置的生产者/消费者衔接

R1 的真实缺口是“没有任何机制为未绑定资源产生能力证据”。本期按成员决定实现**真实只读探测 → 严格证据 → 原门禁应用**，不放松任何激活谓词、必要名单或 codec：

1. **探测（producer）**：`POST /api/metrics/template-bindings/:type/:id/probe`，仅对未绑定资源开放（已绑定返回 409，已发布能力仍是唯一权威）。只对固定 pin 中已注册实现、可信适用目标执行有界只读读取；请求体不能自报 `supported`。已绑定的资源不会读取或写入这份 bootstrap 证据。
2. **证据（store）**：新表 `metric_capability_evidence` 一行只对应一个精确实例：资源、base revision、固定 pin（含 content hash）、credential reference、候选意图 digest（resource/pins/revision/group/overrides）。主键是这些字段的 sha256，所以跨资源、凭据、pin、revision、过期或编辑后的草稿都不能复用；同一意图的并发探测只落一行（upsert）。损坏、过期或身份不一致的行是稳定拒绝，**不是**“没有探测过”。
3. **消费（context）**：未绑定资源的 preview/trial/apply 从上述精确证据解析 capabilities；已绑定资源仍只读 `metric_policy_bindings.capabilities`。`capability_unknown` 仍然阻塞，`unknown` 不会变成 `supported`。
4. **首次提交（host）**：仍由现有 host 事务写 binding/operation/audit，未新增第二 binding/policy/audit writer。首绑 INSERT 现在写入本次启用决策实际使用的可信能力事实，而不是空 `[]`；下次 preview/status/replay 才能从同一事实解析。
5. **授权边界**：取得资源锁后、每次真实远程请求前、每次远程读取返回后、证据持久化（admission/连接/INSERT 行锁/commit）前后都重新读取 live actor 与资源授权；拒绝、连接/数据库错误或全 `unknown` 的探测不落任何证据/绑定/审计/最终结果。
6. **并发**：并发首次探测 upsert 只留一行；并发首次 apply 仍由 `INSERT` 主键 CAS 判定，只有一个 revision/operation/audit。

### 本轮同时修正的真实缺陷

- **显式停用指标无法应用**：receipt 的 optional exclusion 与 host 的 mandatory 名单冲突。现在 mandatory 集合由**可信 resolution**（同 pin/group/capabilities）推导，显式停用项不是必要项；未停用项仍必须完整试采。
- **trial/apply 身份漂移**：停用项由解析器合成的 capability 带 `evaluated_at = at`，同一配置两次解析会因时钟不同而 identity 不同。现在 identity 只排除 `decision = disabled` 的惰性 capability 字段；可采集/阻塞项仍保留完整 capability 身份。
- **trial 的 `config_revision` 为 0**：base 0 的首次试采现在使用记录修订 `max(revision, 1)`，与计划一致。

## 3. 恢复与新意图完整性

| 反例 | 修正 | 回归 |
|---|---|---|
| `sessionStorage.setItem` 抛 `QuotaExceededError` 后 `commit_unknown`，普通 reload 把未决意图清成 0 | 按“主体 + 资源”维护同标签页内存副本；存储写入失败时内存仍保留精确 key，`load/reloadAll/discard` 合并读取而不是被空存储覆盖；界面明确提示“只能在当前标签页查询，刷新浏览器页面后无法恢复”，不宣称跨页面恢复。存储结构损坏是显式错误（并阻止无跟踪的写请求），不当作真实 absent | `R2: an unavailable session storage keeps the unknown intent for this tab` |
| preview 在途时把 interval 改为 70000，旧 60000 响应仍令 `previewStale=false/trialReady=true` | 新增草稿版本号：每次编辑/放弃/资源加载/权限事件递增；preview/trial/apply 的响应只在“原 generation + 原草稿版本”仍成立时投影。旧响应不能清掉失效状态或授权新草稿；旧 intent 的 journal 结算与当前编辑分离，committed 不会吞掉之后的新草稿 | `R2: a late preview for an edited draft can never enable the trial` |

会话换人时意图按当前主体重新读取，不会把旧主体请求投影到新人。

## 4. 真实证据

### 4.1 一次性环境（本 run 独占）

| 项 | 值 |
|---|---|
| 容器 | `mysql:8.4`，容器 ID `4f3f4c42a14b2f1369a68eca33a4cf7774facf31c10ad2c9f6f198fb4b99226c`，名称 `max238r2-97ab3159ac67`，标签 `max238.r2.run=97ab3159ac67`，`127.0.0.1:13421 → 3306` |
| 平台库 | `max238_flow` / `max238_first_<pid>`（隔离容器内，全量 migration 跑两次） |
| 目标 | 同容器独立 schema，只读用户仅 `SELECT + PROCESS`；真实采集只执行固定只读查询 |
| API / 前端 | 真实 `apps/db-ops-api` `127.0.0.1:3001` + 真实 Vite `127.0.0.1:5173`（代理到 3001） |
| 共享 3306 / 既有 mysql3306 | 未连接、未写入 |

### 4.2 真实 API + 真实 DB + 真实只读目标（集成验收）

`apps/db-ops-api/src/metrics/templates/first-binding.real.test.ts`，`3 passed`：

| 场景 | 结果 |
|---|---|
| 空 binding/空 capability 起步 | 初始 `source=unbound`、证据 0、operation/audit 0；旧路线 preview `executable=false` |
| 真实只读探测 | `probe` 200；能力 `mysql.processlist.count = supported`；证据 1 行；**binding 仍 0 行** |
| 检查 | preview 200、`executable=true`、`revision=0`；启用项 `collect`，显式停用项 `disabled` 且非阻塞 |
| 试采 | 真实 SQL 读取目标，`decision=attempted` |
| 首次应用 | `committed` revision 1；operation +1、audit +1、binding 1 行 |
| 无损读回 | 固定 pin/content hash、`group_id=prod-max238`、显式 `enabled=enable`、`interval_ms/max_rows` 覆盖、指标停用、模板参数 `sample_batch=25` 全部原样保留 |
| 重放 | 同 caller key 返回 `replay`/revision 1，operation 数量不变 |
| 并发首绑 | 两个独立 trial + 两个并发 apply：恰好 1 个 committed、1 个 409；operation/audit 各 +1 |
| 失败探测 | 错误凭据的 probe 422；证据 0 行、binding 0 行 |

### 4.3 真实浏览器（Lit → Fastify → 一次性库）

`docs/slide/development/MAX-238/first-binding-20261030/browser-evidence.mjs`，1440×900，真实 Chromium：

| 步骤 | 结果 |
|---|---|
| 打开未绑定资源 | `source=unbound`、binding 2（既有资源）、证据 0、operation/audit 0 |
| 选择固定版本 → 检查配置 | 浏览器真实发出 `/probe` 200、`/preview` 200；preview `executable=true`、`revision=0`、`mysql.processlist.count` 为 `collect/supported`；证据 1 行，binding 仍 2 行（探测不写绑定） |
| 试采 | 页面出现“试采通过” |
| 首次绑定并启用 | 页面出现“配置已提交”，`applyResult.revision=1`；operation/audit 各 1；binding 3 行 |
| 读回 | `source=template`、`revision=1`、pin/version/content hash 与发布版本一致；`configuration` 返回存储值 |

截图：[first-binding-1440.png](first-binding-1440.png)；机器证据：[browser-evidence.json](browser-evidence.json)。

## 5. 必要门禁

| 检查 | 结果 |
|---|---|
| 后端 `src/metrics`（全量） | **907 passed / 210 skipped**（R1 基线 887；新增 20 项） |
| 后端 `src/metrics/{bindings,templates,config}` | **525 passed / 92 skipped** |
| 前端全量 | **1348 passed / 150 files** |
| `slide-api typecheck` / `slide-frontend typecheck` | 通过 |
| `pnpm contracts:check` | 通过（新增 `TemplateProbeResponse`、probe 路径，生成客户端已同步） |
| 前端 build + CSP | 通过 |
| 浏览器 `resource-metrics.spec.ts`（audit config，真实 Chromium） | **23 passed**；原先 :302 等待旧“检查并启用”超时已按真实 binding-source 契约修正夹具，未删断言/skip |
| 共享围栏回归 | `policy/template-gateway.test.ts` 仍通过（`e380275fd` 的修正保留） |

## 6. 测试资源与清理（本 run 严格生命周期）

- 启动前记录唯一容器名/标签/nonce 与精确容器 ID；未按端口或名称扫描、未批量 kill。
- API/Vite 以真实 PID 记录（`api.pid`/`vite.pid`），结束时只 `kill` 这两个精确 PID；未按 `vite --port 5173` 匹配杀进程。
- 清理前先用精确容器 ID + 标签核对所有权，再 `docker rm -f <exact-id>`；删除后 `docker inspect` 返回明确的 `no such object`（视为 absent），未把其它 inspect 错误当 absent。
- 临时凭据/日志/附件目录（`.run-lifecycle`、`.run-attachments`）已删除；一次性库只存在于已销毁的隔离容器。
- `seed.ts` 增加隔离约束：拒绝 3306 端口、拒绝非 `max238_` 前缀 schema（它会对传入 schema 执行 DROP）。

## 7. 保留与未变

- 旧 78602s 真实采集/正式历史/API/页面链未重跑、未改；旧 R2/R3/R4 安全证据保留。
- 未改激活必要谓词/名单、receipt v2 codec、MAX240 query/storage/formal-store 文件；未启动生产 worker、未部署、未写共享 3306。
- 浏览器首绑场景覆盖 pin/默认配置；group/显式启用/指标停用/模板参数的完整无损 roundtrip 由 4.2 的真实 API+DB 集成测试覆盖。
- 正式采集调度、24h 历史、容量与迁移演练不在本包；整单仍 `in_progress`，`done` 留成员。
