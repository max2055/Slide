# MAX238-NATIVE-CONFIGURATION-FLOW-R1：完整资源配置生命周期修正

2026-10-30。**一句话结论**：旧版单包资源现在有一个显式、受控的原生模板入口，首次绑定按 base revision 0 走同一条 host/policy 锁/CAS/receipt/journal/audit 路径；编辑契约无损（状态返回存储的 overrides/group，放弃与重载不再清空），未知结果不再是可放弃的草稿（编辑、放弃、重载、切资源都不清键，只由原生 journal 结算），异步 re-pin/详情/preview 结果按资源 generation 隔离。真实 Lit → 真实 Fastify → 一次性 MySQL 8.4 上的 API 与浏览器证据见下。**仍有一处未闭环：完全未绑定的资源在库中没有任何 capability 证据，既有“capability_unknown ⇒ 不可执行”激活谓词禁止其首次应用**（详见 §7，需要决策，不在本包授权内放宽）。

机器证据：[api-evidence.json](api-evidence.json)、[browser-evidence.json](browser-evidence.json)；复现脚本：[seed.ts](seed.ts)（一次性环境）、[flow.mjs](flow.mjs)（真实 API 七场景）、[browser-evidence.mjs](browser-evidence.mjs)（真实浏览器四场景）。

## 1. 代码与分支

| 项 | 值 |
|---|---|
| 任务分支 | `agent/15coder1/max-238` |
| 基点 | `9aea87a17f04013a1212e5550ff91e785b2c9fa5`（R1 未接受交付） |
| 实现提交 | 见本文件所在提交（`feat(max238): complete the native configuration lifecycle`） |
| 证据提交 | 本文件所在提交（docs/evidence 追加） |
| 未推送 | 按本轮指令，发布沿 Chief 安全头 `9cba6934a` 追加独立提交，不由本包改写任务分支或推送风险祖先 |

### 本包改动（逐条对应复审四点）

1. **入口与首次绑定。** `metric-configuration` 对 `package` 资源默认保留旧版编辑器，并提供显式的“改用固定版本模板配置/返回旧版单包配置”控件（切换前走 `confirmDiscard`）。首次绑定契约：请求体 `expected_revision` 允许 0（`TemplateBindingBodySchema`），请求候选使用新的 `ResourceBindingCandidateInputSchema`（base 0 = 首个绑定，存储行仍要求正数），guard 在无行时只接受 base 0 → target 1，宿主新增一条 `INSERT ... VALUES (?, ?, ?, '[]')`（主键即 CAS，并发首绑只有一个成功，重复键映射为 `REVISION_CONFLICT`），`applicationContext` 对无行资源返回 `application: null` 而不是伪造 pending。前端不再以 `baseRevision<=0` 阻止“检查配置”。
2. **无损编辑契约。** `GET /api/metrics/template-bindings/:type/:id` 新增 `configuration: { overrides, group_id } | null`，即存储的原始绑定选择；前端从它种子化 settings / metricToggles / parameters / groupId（不再从 pending plan 猜测），`discardChanges`/`reloadAll` 回到该存储值而不是清空。
3. **未知操作。** 前端把“未确认的应用意图”改为按精确意图跟踪的记录列表（`{key, intent, pending}`，会话存储按用户+资源隔离），意图身份不含 trial receipt（同一配置重新试采仍是同一意图、同一 caller key），`invalidate`/`discardChanges`/`reloadAll`/权限事件都不清除，只有 journal 的 committed/absent 结算。新用户意图与未决原请求分开跟踪，CAS/锁/去重不变。
4. **异步隔离。** `runRepin` 捕获 generation + 资源键 + 目标模板，完成、异常、`finally` 都重新校验；资源切换会关闭对话框、清空详情缓存；`ensureDetail` 也带 generation 校验。
5. **服务端解析修订**：B2C 计划对 base 0 使用记录修订 `max(revision, 1)`（`config_revision`/`policy_revision` 必须为正），其余语义不变。

## 2. 环境（一次性、非 3306）

| 项 | 值 |
|---|---|
| 一次性平台库 | 容器 `max238life-6235a3c3`，ID `f5e49eefdb33d795c0079528f983c5610d9af93d24581e3d9383f7172ed42dfa`，`127.0.0.1:13361` → 3306，`mysql:8.4`（8.4.10） |
| 平台库 | `slide_max238_life`，由空库执行仓库自带 `MigrationRunner` 全量 migration（跑两次，第二次无变更） |
| 目标库 | 同一服务器的独立 schema `slide_target`，只读用户 `target_ro`（仅 SELECT + PROCESS）；真实采集只执行只读查询 |
| 模板 | 通过产品自带 `MetricTemplateService` 创建并发布：`mysql-representative@1.0.0` / `builtin:database.mysql.connections.v1` / `mysql.processlist.count`，发布后按运营动作置为 `active` |
| 身份 | 一次性库内 `life-admin`（admin，真实 JWT/session_version）与 `life-operator`（dba 角色 + 显式权限，无隐式 `*`，用于撤销场景） |
| 运行 | 真实 `apps/db-ops-api`（127.0.0.1:3001）+ 真实 Vite（127.0.0.1:5173，代理到 3001） |
| 目标写入 | 0 |

## 3. API 七场景（真实 Fastify → 真实 DB → 真实只读目标）

| 场景 | 结果 |
|---|---|
| A 首次绑定（库中无 binding） | 预览请求**被真实发送**：`POST /preview` 200，`revision=0`；`executable=false`，唯一排除项 `capability_unknown`（blocking）；试采 422 `TEMPLATE_BINDING_NOT_EXECUTABLE`；未创建任何行 |
| B 旧包 → 原生转换 | 预览 executable；真实试采读取目标成功（`mysql.processlist.count`，`observed_at` 真实时间）；应用 `committed` revision 4；绑定来源变为 `template`，`pending=4`、`applied=3`；journal `committed`；该 key 恰好 1 operation、1 audit |
| C 无损编辑 | 无改动重放：两个 override 原样保留（rev 5）；只改 `interval_ms` 45000→30000：`max_rows` 保持 50、`interval_ms` 变为 30000（rev 6） |
| D 取消 | 不发送任何 preview/trial/apply；revision 与 audit 计数不变 |
| E 并发 | 同一 base 6 的两个客户端：一个 `committed` rev 7，另一个 409 `TRANSACTION_REVISION_CONFLICT`；该 base 只写入 1 个 revision |
| F 未知响应 | 服务端收到并提交，客户端丢弃响应；journal 查得 `committed` target 8；同键重放返回 `replay`/8；该 key 1 operation、1 audit，最终 revision 8（无第二次写） |
| G 撤权 | 运营者试采 200 后把资源授权降为 read-only；应用 403 `TEMPLATE_BINDING_FORBIDDEN`；audit 5→5，revision 不变，该 key 0 operation |

## 4. 浏览器四场景（真实 Lit → 真实 API → 一次性库）

| 场景 | 结果 |
|---|---|
| A 显式入口 + 无损种子 + 真实试采/应用 | 旧版资源默认显示旧版编辑器，且出现“改用固定版本模板配置”；点击后原生编辑器载入，存储的 `interval_ms=45000`、`max_rows=50` 已种子化；检查请求体原样携带两者（`expected_revision=3`）；试采通过；应用 `committed` revision 4；转换后 `configuration` 仍是 45000/50 |
| B 取消 | 选择后取消选择：`config_writes=[]`（0 次模板/配置写请求），资源仍为 `unbound` |
| C 未知响应 + 刷新 | `route.fetch` 真实发出后 abort 响应：页面显示“上次发布结果尚未确认”，会话存储中意图 `pending: true`；刷新页面后同一意图被保留并两次查询同一 journal key，结算为 `pending: false`、`unresolved=[]`，revision 4→5 恰好一次 |
| D 迟到响应 + 切资源 | instance 3 的 preview 被延迟 6 秒；期间切到 instance 1；迟到响应到达后新资源 `preview=null`、`selected=[]`、无错误（未投影） |

视口：1440×900、1366×768、1920×1080 均正常渲染（`ui-*.png`）。

## 5. 验证

| 检查 | 结果 |
|---|---|
| 后端 `src/metrics/{bindings,templates,config}` | 505 passed / 89 skipped |
| 前端全量 | 1346 passed / 150 files |
| `pnpm --filter slide-api typecheck` / `slide-frontend typecheck` | 通过 |
| `pnpm contracts:check` | 通过（openapi.json 与生成客户端已更新：`TemplateBindingStatus.configuration`、`expected_revision` 允许 0） |
| 前端 build + CSP | 通过 |
| 预存在失败 | `src/metrics/policy/template-gateway.test.ts`「fences config trial/status…」在基点 `9aea87a17` 即失败（`POLICY_STORE_UNAVAILABLE`），本包未改动该路径，未修复 |

## 6. 清理

| 项 | 处置 |
|---|---|
| 一次性容器 | `docker rm -f f5e49eefdb33…`（按精确容器 ID，不按前缀扫描） |
| API / Vite | 按记录的 PID 停止（不使用按端口或按名称杀进程） |
| 临时凭据文件 | `.max238life.{pw,jwt,enckey,adminpw,targetpw,api.pid,vite.pid,nonce}` 已删除 |
| 共享 3306 | 未连接、未写；本包所有数据在 13361 的独立 schema |

## 7. 未闭环项（需要决策，非本包可自行放宽）

**完全未绑定资源的“启用式首次绑定”仍被既有激活谓词挡住。** 模板解析对每个 item 使用既有 `resolveItemCapability`：库中没有该资源的 capability 证据时状态为 `capability_unknown`，`excluded` 且 `blocking: true`，因此 `executable=false`，试采与应用都拒绝（实测见 §3-A）。而 capability 证据只有一条写入路径——`MysqlPolicyStore.reportCapabilities`，它要求**已存在**绑定行且 revision 匹配（`scheduler/store.ts` 的模板运行回写同样要求已发布绑定）。也就是说：没有任何机制的“首个 writer”会为未绑定资源产生能力证据，旧版单包激活虽然能发布（不要求能力证据），但它本身也要先有一行绑定。

两条可行路线，都需要产品决策，且都触碰本轮“不改 activate 必要谓词/名单/codec”的约束：

1. 允许模板试采在**仅** capability_unknown 阻塞时执行真实只读探测，把探测证据写入 receipt（v2 codec 变更）或写回绑定行，再由检查/应用使用；
2. 规定新资源必须先经既有旧版单包激活+调度跑一次产生 capability 证据，之后才允许原生模板接管（即把“首次绑定”定义为转换）。

本包已把该链路的其余全部环节实现并验证到真实数据库与真实浏览器；未把这一缺口伪装成成功，也没有通过预种 legacy/native 绑定或伪造 applied 绕过。

## 8. 边界

不涉及：MAX224 账本、共享 3306 业务写、生产 worker、部署、停写/复制/切换/回退/解绑；不改 activate 必要谓词、必要名单或持久化 codec；无模型调用、无子代理。整单仍 `in_progress`；已完成阶段保持 `in_review`（done 留成员）。
