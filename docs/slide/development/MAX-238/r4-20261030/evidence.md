# MAX238-NATIVE-CONFIGURATION-FLOW-R4：可靠主体、真实草稿身份与普通入口兼容回归

2026-10-30。**一句话结论**：R3 复审的两条组件反例已先红后绿修正——恢复键改由**签名会话主体**派生（缓存 `user` 损坏不再改变键，无可靠主体时拒绝写），旧 committed 只按**原意图内容**结算（不再用可重置的本地计数器）；同时把 PR567 CI 分片 6 的 `flow.mysql.test.ts` 两项失败诊断为**真实夹具漂移**（该隔离 Fastify 应用未注册普通入口现在读取的绑定来源路由）并真实 MySQL 回归转绿。R3 已被接受的探测刷新、证据收尾授权与既有真实采集展示证据全部复用，未重造成功采集证明。整单仍 `in_progress`，`done` 留成员。

## 1. 分支与范围

| 项 | 值 |
|---|---|
| 任务分支 | `agent/15coder1/max-238`（基点 `5bb64673c`，只在其上追加） |
| 未改写 | 未 amend/rebase/reset，未切换任务分支，未推送任务历史到 PR |
| 迁移 | 无新增/修改迁移 |
| 未触碰 | MAX240 query/storage/formal-store、activate 谓词/必要项名单、strict codec、共享 3306 |
| 产品模型调用 | 0；无子代理 |

## 2. 两条反例：先失败 → 修正 → 回归

### 2.1 可靠主体是写前条件（R3 反例一）

R3 的恢复键是 `slide.metric.native.apply.<user-id>.instance:N`，`user` 无法解析时退化为**每个组件实例随机**的 `unreadable-<random>`：`/apply` 仍会发出，但组件重建后新实例用新键寻址，旧未知请求再也查不到（apply=1、query=0、unresolved=0）。

修正（`native-template-configuration.ts`）：

- 新增 `sessionPrincipal()`：从服务端签发的访问令牌（`localStorage.token`）负载里的 `userId` 派生 `user-<id>`。缓存的 `user` 只是资料副本，损坏/缺失不再影响恢复键；令牌缺失/无法解析即视为**没有可靠主体**。
- `intentStorageKey()` 返回 `null` 即拒绝：`storedIntents`/`rememberIntent`/`persistIntents` 都 fail-closed，`/apply` 不发送、草稿保留、显示可读原因“无法确认当前登录主体…”。
- 同一 `sessionStorage` 键在组件重建、同标签页重载和**真实整页刷新**后都不变，因此正常可靠会话的 unknown 一定可查询恢复。

先失败证据（R3 源码 + 新测试，3 项全红）：`applies=1`（损坏 `user` 仍发送）、`applies=1`（无会话仍发送）、旧 committed 清掉 70000 草稿。修正后 25/25 通过。

回归：`R4: a corrupt cached profile does not change the signed principal…`、`R4: without a signed session no apply is sent…`。

### 2.2 草稿身份不能是可重置的本地计数器（R3 反例二）

R3 记录 `intent.draft = draftVersion`（组件实例内单调计数），重建后从 0 重新计。原 60000 编辑存下的 `draft=2` 与新实例编辑 70000 后的 `draft=2` 相同，于是旧 committed 被当成“当前草稿”，把 `settings` 清空、`dirty` 置 false。

修正：

- `IntentRecord` 去掉 `draft`；`lookup()` 不再接受草稿计数器参数。
- 新增 `intentStillCurrent(key)`：取该 key 的持久记录，把其中的 **intent 字符串**（资源 + 完整请求体：固定 pin、设置、指标启停、参数、策略组、base revision）与当前 `intentIdentity()` 比较；键序经规范化，跨重建稳定。只有当前草稿**就是**原意图时才清 `dirty`/重载并投影旧 revision。
- 恢复查询是后台工作：`load()` 在 `restorePending` 之前释放 `busy`，用户可以在查询进行中编辑（否则“查询中编辑”在真实 UI 上无法发生）。

回归：`R4: a remount collision in the local edit counter cannot let an old committed row clear a new draft`（重建后新实例计数器与旧记录碰撞，查询中编辑 70000，旧 committed 到达 → 70000/`dirty` 保留、`applyResult=null`）。

## 3. 真实浏览器证据（Chromium → Vite → Fastify → 一次性 MySQL 8.4）

环境：一次性 MySQL 8.4.10 容器（精确 ID `6967e9708c19…`，nonce 标签 `r4bb34e849a06ee6b90465d06ad5d45b2d`，host-port **50014**，非 3306），真实迁移 + 真实只读目标 schema + 真实模板版本；API/Vite 进程按 PID + cwd 记录后停止；容器 rm 前复核 ID+nonce，删除后确认不存在。共享 3306 未写。

`docs/slide/development/MAX-238/r4-browser/flow.mjs`，视口 1440×900，机器证据 `browser-evidence.json`：

| 用例 | 注入 | 结果 |
|---|---|---|
| A 损坏资料缓存 + 丢响应 + 整页刷新 + 查询中编辑 | 有效签名令牌，`localStorage.user='{corrupt-profile'`；`/apply` 先 `route.fetch()` 让真实服务器执行再丢弃响应；恢复查询真实发出但被延迟 15s | 键为 `slide.metric.native.apply.user-3.instance:1`（签名主体，不是缓存）；apply=1；刷新后查询在 620ms 发出、15.6s 才应答，**应答前**编辑间隔为 70000（`unresolved=1`），committed 应答后 `settings.interval_ms=70000`、`dirty=true`、`applyResult=null`、intent `pending=false`；DB：bindings 2→3、operations=1、audits=1（无重复） |
| B 持久化异常 | `sessionStorage.setItem` 对本组件键抛 `QuotaExceededError` | apply=0、页面显示“拒绝本次发布”、`intentStorageLimited=true`、`dirty=true`、计数不变 |
| C 主体不可用 | 试采后在点击发布前移除签名令牌（受控会话丢失） | apply=0、显示“无法确认当前登录主体”、65000 草稿保留、`dirty=true`、计数不变 |

限制：C 是**受控会话丢失**，不是生产身份库自然撤权；A 的“丢响应”是转发真实请求后丢弃响应，不是伪造业务成功。

## 4. 普通入口兼容回归（PR567 CI 分片 6）

**诊断**：`flow.mysql.test.ts` 自建隔离 Fastify 应用，只注册历史路由、策略路由与配置路由。`7beba8852` 起，普通配置入口 `metric-configuration` 先读 `GET /api/metrics/template-bindings/:type/:id` 决定 legacy/native 编辑器；该应用没有这个路由（404 → 入口进入错误态），所以 142 行旧“检查并启用”与 253 行“采集包 / 模板版本”必然超时。这是**真实夹具漂移**，不是 legacy 契约变化。

**修正**：在同一测试应用里用**真实** `TemplateBindingService`（同一一次性库、同一 registry、真实关系存储与真实路由）注册 `registerMetricTemplateRoutes`，不删断言、不 skip、不宽松谓词、不强迫新配置走 legacy。

**先红后绿**（同一一次性库，同一环境）：

| 状态 | 结果 |
|---|---|
| 旧测试应用（HEAD 版本） | 2 failed / 3 passed：`desktop and mobile…` 30s 超时在“检查并启用”；`shows full success…` 5s 超时在“采集包 / 模板版本” |
| 修正后 | **5 passed / 5**（功能：真实 HTTP preview/trial/publish、只读拒绝、设置页、全绿/部分失败试采门禁） |

## 5. 门禁

- 前端 `tsc --noEmit`：通过；受影响组件 + 包装组件：**29/29**；全量 vitest：**1355 passed / 150 files**（0 失败）。
- 前端 build + CSP：通过。
- `contracts:check`：通过。
- 后端 `tsc --noEmit`：通过；受影响 `src/metrics/{config,templates}` 单元/组件：**208 passed / 11 skipped**（真实库测试按既有跳过条件未自动运行）。
- 真实 MySQL：`flow.mysql.test.ts` **5/5**（上述先红后绿）。
- 复用（不重跑）：R3 的 61 focused、3 项真实 MySQL（过期 probe 刷新、凭据隔离、读回后撤权回滚）、R2 首绑/并发无损、R4 receipt、78602 s 真实固定模板采集展示、旧 R3/R5/REG/c14b。

## 6. 剩余

整单 `in_progress`：解绑预览/历史保留、正式采集 SLO、容量与迁移演练、触发恢复等原范围项未在本包内；部分真实采集展示阶段维持 `in_review`，`done` 留成员。
