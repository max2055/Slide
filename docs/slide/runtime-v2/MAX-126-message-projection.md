# MAX-126：实时、历史与恢复的 Message Parts

## 范围与版本

S2 复用 S1 的 MessageParts 与工具 intent/settlement 契约，以一个 browser-safe reducer 解释实时帧、持久事实 hydrate 和恢复快照。业务事实、checkpoint/anchor 和完成事务仍是持久状态的权威。

- 基线：`2096fe320528537d16d193d86c70784819cd016a`，S1 PR #129 已合并。
- 最终实现候选：`43e5e228ceb136ed99d9cceb77573a739b345d44`。后续文档提交不改变执行代码。
- 分支：`codex/max-126-message-parts`；目标：`main`；MAX-124 负责验收与合并。
- 保留 DirectAdapter 自管理 WS、JWT/权限、provider 抽象、工具事务与 completion pending。
- S3 协商、增量传输、续传缓存/预算不在范围；不改页面样式、不逐 token 写 MySQL、不调用付费业务模型或操作生产库。
- 硬预算未设定；无子代理。任务范围仍为 v1/v2 的 S2，没有新增阶段。

## 契约与兼容

`@slide/agent-core/message-projection` 为纯函数出口，不引入 Node 运行时。帧包含 version/runId/attempt/sequence 与 operations。非法帧原子拒绝，不推进水位；旧 attempt、重复帧、终态后的事件不改变投影。

`generation=open/ended` 只表达模型生成。`part.end` 不设置 completed/durable。工具 settled 与 persisted 分开表达，completed 需要持久化证据；MySQL 完成事务提交后才追加 `parts.persisted` 与 `run.terminal`。本地 JSONL 路径也在原子保存成功后确认投影。partial/cancelled/timed_out/failed 均不能伪装成 completed。

生成前由 StreamBoundary 分配 `model_<sourceRequestId>`，并用于模型消息与 part 的身份。OpenAI provider 用已有协议 index 映射取回真实 toolCallId，后续参数片段沿用此 ID；浏览器不按工具名、数组位置或本地时间猜测身份。完成记录保留既有 `run_<runId>_assistant` 存储键，通过 projectionMessageId/sourceMessageId 保留生成来源。重复请求沿用 checkpoint 的 run/turn，显式 admission ID 优先，其他 run 的投影不能被移植。

未闭合工具参数 JSON 仅展示生成进度，完整后使用 S1 有界脱敏展示。参数片段不参与工具执行，也不进入 canonical facts/anchor；完整 tool_call 会替代对应输入展示。跨片段拆开的敏感字段不会从新帧泄漏。投影持久确认帧不携带 legacy 原文；工具参数/结果继续有界脱敏。

reset 是单次 reducer 操作，同时撤回未确认 text/reasoning/tool_input。保留确认事实与实际 settled 工具，并保持原顺序。checkpoint 分别保存当前投影及已确认 anchor；重启只恢复 anchor 加 canonical facts，不复活 provisional 尾部。已有 chat.watch 内存快照附带完整 Parts 投影，没有增加缓存系统或传输机制。

前端只从 reducer 派生既有 stream/thinking/tool 渲染输入。历史按稳定 part ID 映射到已有组件，避免正文统一排在工具之前；同 run、同 toolCallId 的已展示结果不重复生成工具卡片。历史窗口、请求版本与会话切换 guards 保留。旧事件和旧/未知版本历史保留原读法；DOMPurify、链接边界和共享组件不变。

## 验收矩阵

| 验收 | 证据 | 结果 |
|---|---|---|
| 1. start/append/replace/end、非法/重复/晚到事件、正文/思考/工具顺序 | Core `message-projection.test.ts`；前端 `message-projection.test.ts`；Chromium `tool-stream.spec.ts` 的 DOM 顺序断言 | 通过 |
| 2. 生成结束、工具 settled、持久 completed 独立；保存失败准确 | Adapter `message-projection.test.ts`、`candidate-final.test.ts`、`runtime-lifecycle.test.ts`；完成事务模块回归 | 通过；真实 MySQL 见下述限制 |
| 3. 空 reset/重复 reset 原子撤回，工具保留且不重执行 | Core 表驱动 reset；Adapter 未完整参数中断与超时结算 guards；真实认证 WS 两个订阅者、两个工具只启动各一次 | 通过 |
| 4. live/hydrate/snapshot 等价、历史切换与 legacy 兼容、稳定来源身份 | Adapter 交错投影往返；真实 JSONL 保存后冷加载等价；真实 WS chat.watch → Gateway → UI consumer；OpenAI 同名工具交错 ID 回归；冻结 legacy 快照 | 通过 |
| 5. 思考先于正文/无思考、text/tool 交错、终态晚到、历史显示顺序与模块门禁 | Core/Adapter/前端 focused checks、完整模块测试、Chromium native Parts 用例 | 通过 |

## 本地验证证据

环境：macOS darwin arm64，Apple M5，Node `v24.18.0`，pnpm `11.19.0`，Chromium/Playwright。所有 provider/auth/SQL fixtures 是受控测试，不计作生产或真实数据库验证。

| 命令 | 结果与代码版本 |
|---|---|
| `pnpm -r test` | 首轮识别新增 ID 引起的 legacy 快照差异，修正兼容比较后按受影响模块重跑；未更新历史快照文件 |
| `pnpm --filter agent-core test` | 32 文件、671 项通过，`4cc8db0d`；此后 Core 未变 |
| `pnpm --filter slide-api test` | 320 文件通过、28 文件跳过；3025 项通过、251 项跳过，`4cc8db0d` |
| `pnpm --filter slide-api exec vitest run src/adapter/__tests__/message-projection.test.ts src/adapter/__tests__/tool-stream-integration.test.ts src/adapter/__tests__/candidate-final.test.ts src/adapter/__tests__/runtime-lifecycle.test.ts` | 最终 Adapter 修复后 34 项通过，`8b2b6384`；此后 API 未变 |
| `pnpm --filter slide-frontend test` | 85 文件、582 项通过，`43e5e228` |
| sandbox-controller 的 workspace tests | 22 项通过、4 项跳过；该模块未修改 |
| `pnpm -r typecheck` 与受影响 API/前端复验 | 四模块通过；首轮新测试 union 收窄错误已修复 |
| `pnpm contracts:check` / `pnpm qualification:matrix` | 通过，37/37 findings 映射；契约未变 |
| `pnpm lint` / 前端 build 与 CSP | 通过；仓库已有 lint/bundle-size warnings 保留 |
| `pnpm --filter slide-frontend test:browser` | 完整 Chromium audit gate，58 项通过；最终历史顺序断言在本次门禁内 |
| `bash scripts/qualification/run-agent-runtime.sh --mode deterministic` | 通过：210 正常样本，falseRejects=0、misses=0；100,000 字符 detector p95=3.677ms，`8b2b6384`；此后 Core/API 未变 |
| `pnpm security:audit` / `pnpm security:scan` | 无已知漏洞；secret scan 通过 |
| `git diff --check` | 通过 |

真实认证 WS 集成使用实际 Adapter、socket、Gateway、UI consumer 与 ToolRegistry 执行，只有认证结果、provider 和 SQL 持久边界 mock。没有在本地运行真实 MySQL qualification、真实业务 provider、30 分钟 soak 或生产 rollout；环境型数据库测试跳过如实保留。这些不能用健康检查或上述 fixtures 替代，PR 当前 head CI 的八项 job 仍须全部 SUCCESS，由 MAX-124 核验后合并。

## 交付与回滚

提交 PR 后保持 in_review，子任务不 merge/done/启动后继。复用 CI 条件规则 `01a10a15-a5ab-79c5-a948-2e29601c924d`（continuous、max-fires=1000，至 `2026-10-12T03:22:33.257353Z`）；pending 由该规则续修，退出前核对实际 PR head 与 checks。

没有新增数据库 schema。回滚可 revert 本 PR 的代码提交，旧 WS 帧和 legacy 内容继续可读；不删除工具事实、用户消息、completion ledger 或 checkpoint。新增投影字段为 additive；旧版忽略它们，升级版也不得把它们当作可执行命令或未经持久化的事实。

平台 usage 查询当前原始累计字段为 0、metered_task_count=0；当前活跃 run 尚无可用实测 token/费用遥测，不能将其解释成零消耗。标准化吞吐/费用不可用；无硬预算、子代理数=0、深度=0、主线程并发=1。父 MAX-124 巡检可同时运行，家族并发上限未突破。

## PR/CI 续修证据 v2（2026-10-05）

本轮不扩展 S2 范围。原 head `1e810a0fcb76b47817a3cab88e05b85ce347c90b` 的 [browser-qualification](https://github.com/max2055/Slide/actions/runs/37265057968/job/111620339214) 在 `agent-runtime.spec.ts:35` 失败；其余六项 job SUCCESS，release-artifact 因依赖失败 SKIPPED。分类为本次引入的最终展示回归，不按环境问题重跑。

在隔离 MySQL 8.4 容器、受控本地 OpenAI provider、真实 DirectAdapter/WS 与 Chromium 上复现原失败：DB 只有一条 `第一段。第二段。`，完成后 DOM 却有两个独立段落 `第一段。`、`第二段。`，刷新断言未执行。根因是历史按每个 text part 建独立渲染行，文本提取还在续写片段间增加了换行；这同样会断开跨模型请求的 Markdown/SQL。

修复仅调整前端展示：相邻有效 text parts 按原字节拼接成一个 Markdown 行，首个真实 part ID 作为稳定行 key；原 parts、sourceMessageId、durable、usage 与持久事实均保留，不合并跨工具/思考边界。没有放宽、skip 或改写既有资格断言。

RED checkpoint `54351f6a`：新增中文/跨片段 SQL 围栏/思考边界回归实际执行，3 项失败（额外换行或行拆分）；既有真实浏览器资格测试 length 失败、recovery/reject 通过。GREEN 代码 `3119be08`：上述回归和真实资格场景全部通过，后续仅文档变动。

| 当前代码验证 | 实际结果 |
|---|---|
| `pnpm --filter slide-frontend exec vitest run src/app/ui/chat/message-parts.test.ts src/app/ui/chat/message-projection.test.ts src/app/ui/chat/grouped-render.test.ts` | 3 文件、17 项通过 |
| `pnpm --filter slide-frontend test` | 85 文件、585 项通过 |
| `pnpm --filter slide-frontend typecheck` | 通过 |
| `pnpm --filter slide-frontend test:browser` | 58 项通过，含真实 DOM 工具交错/reset/history guards |
| `pnpm --filter slide-frontend build` / `pnpm lint` / `git diff --check` | build/CSP 通过；lint 0 errors、262 既有 warnings；diff 通过 |
| `pnpm --filter slide-frontend exec playwright test agent-runtime.spec.ts --workers=1`，`QUALIFICATION_CANCELLATION_E2E=1 PLAYWRIGHT_MANAGED_ENV=1` | 3 项通过、0 skipped；recovery（含保存失败 completion pending 恢复与唯一写入）/length（完成态与刷新完整正文）/reject（无候选残留） |

隔离环境使用 `mysql:8.4`、`127.0.0.1:13316`，API/WS/Vite/provider 分别为 13003/38890/15175/38900，避开既有运行实例；容器与测试服务在每次前台运行结束清理。平台和生产库未使用，本地 provider 为受控 fixture，不计真实付费模型质量验收。前一轮 Core/API/sandbox 验证的代码与配置未改变，复用其证据；本轮首次补充的真实 MySQL 浏览器证据替代前文“本地未运行真实 MySQL”的限制，仅覆盖上述三场景，未宣称完整 MySQL qualification、soak 或生产 rollout 已通过。

仍复用 continuous CI 规则 `01a10a15-a5ab-79c5-a948-2e29601c924d`（有效至 `2026-10-12T03:22:33.257353Z`），修复推送前确认 enabled、未暂停、未过期。当前 head 全部八项 CI 必须由平台续跑/父任务重新核验；本地通过不代替 CI SUCCESS，不自行合并。

资源延续原累计。当前查询的既有 terminal 原始累计：input=657,963、output=105,549、cache_read=16,119,424、metered_task_count=1；本轮 active 用量尚未报告，cache/input 包含口径未确认，标准化吞吐/实际费用不可用，0 cost 字段不解释为免费。未设硬预算，无新增子代理。
