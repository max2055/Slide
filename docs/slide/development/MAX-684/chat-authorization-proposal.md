# MAX-684 普通聊天授权调查与待决方案

日期：2026-11-17。阶段：调查交付；以下建议尚未实施，不能当作现有能力。整单继续 `in_progress`，由 Chief 汇总政策决定后再安排实现和独立审查。本阶段不改产品代码、角色授权、数据或运行服务，不合并、部署或派发前端。

修订说明：本版回应线程 `01a1e93f-4f1f-78af-9b2b-626194b85ced` 的 MF1–MF3 及分享存续项。修订起点为 `33e76544049930703f4f21853753fbb58a85a95c`；新增静态证据见 `source-evidence.json` 的 `revisionEvidence`。第 5.1–5.4 节把现有行为、唯一推荐组合与待选备选分开；这些建议未获政策批准，也未经实现验收。

## 1. 基线与证据适用性

| 对象 | 完整版本与结论 |
|---|---|
| 本任务分支 | `agent/15-backenddev-01/max-684` |
| 本任务 base / 调查产品 head | `c22f7eef6d871cec40aad4d26c24cededb89562f`；空基线提交，树与父提交 `92aa557b887729e19ce2aa4a9e8a957d4e2935ac` 相同 |
| MAX-683 原 main 基线 | `92aa557b887729e19ce2aa4a9e8a957d4e2935ac` |
| 旧审计材料声明的产品候选 | `337d93cfb533a96481894086f71780200f5f4883` |
| MAX-684 正文引用候选 | `eed274e29f1ae03d74bc0e903648915cb480597f` |
| PR #1008 最终 head | `9a4cac3d3f732c24cc87b7a25ba3e2bac67c79b8`；base `main` / `92aa557b887729e19ce2aa4a9e8a957d4e2935ac` |
| PR #1008 merge / 本轮抓取 origin/main | `451ab8c9969f18d94f17392a74301294de82b5e1`，2026-11-17 05:03:56 UTC 已合并；不代表已部署 |

本分支起点不包含 #1008；不切换、重置或合入 main。分别用 `git show` / `git diff` 核对这几个版本。后续实现应由集成 owner 在保留本分支起点的前提下对齐届时 main，不能直接把旧起点当作最新产品候选。

旧材料在 #1008 最终 head 的 `docs/slide/development/MAX-683/ordinary-chat-permission-audit.md`，复现文件为 `apps/db-ops-api/src/auth/chat-permission-contract.mysql.test.ts`。MAX-683 评论 `01a1e26b-2ed7-7b70-9e84-22be4b3f7766` 留有 `chat-permission-report.md` / `chat-permission-evidence.zip` 附件（报告附件 ID `01a1e26b-282a-7a6d-af83-fa4430f7a307`，压缩包 ID `01a1e26b-2a5f-701d-8f74-f9bde91cb609`）。本轮读取入库审计材料，未重新下载核验这些原始附件。

旧材料报告：独占 MySQL、正式迁移、真实 JWT/SQL 身份，基线/候选各 5 项、14 条观察一致；引擎边界为受控替身，另两个 DirectAdapter 敏感目录用例通过。只能复用为“普通聊天历史允许行为及归属隔离的历史证据”，不是新政策验收、真实模型生成、全部 WS 入口或运行中撤权证明。

本轮字节对比见同目录 `source-evidence.json`：聊天路由、handler、存储、DirectAdapter、引擎工厂、认证及工具策略等文件从旧基线到 #1008 merge 相同；相关目录差异只有新增旧复现测试。调查授权文件确有 #1008 增量：新增 `action-scope` 以行动权限核对成员及资源，不授予 `chat:view` 或调查工具。普通聊天关联调查仍调用 `read`，不能把该增量解释为调查正文放行。

验证类型：静态调用链核对与 git 对比，未进行本阶段真实 HTTP/WS/SQL/模型测试。未读取私有凭据、共享数据库或 token 账本；模型调用为零。本机当前 shell 未发现 node/corepack/pnpm，工作树无 API node_modules。已执行 `pnpm ci:source-policy`，退出 127（command not found），未声称 gate 通过；`git diff --check` 退出 0。文档阶段不因此安装依赖或启动共享环境。

## 2. HTTP 入口清单与现状

以下文件位置均相对于调查产品 head；HTTP 注册见 `apps/db-ops-api/server.ts:1063`。没有父级 `chat:view` hook 替这些接口补门禁，`registerChatRoutes` 的 preHandler 只有 `verifyToken`。

| 入口 | 当前服务端条件与输出 | 建议（待决定） |
|---|---|---|
| `POST /api/chat/send` | `chat-routes.ts:59` → `chat-handler.ts:53`；指定会话 `append`，空 key 创建本人会话；保存用户消息后调用引擎，无 chat 权限判断 | 先认证 + `chat:view`，再创建/追加；无权不得创建会话、消息、run 或调用模型 |
| `GET /api/chat/history` | `chat-routes.ts:84`；分页/非分页均走 `history`，metadata 走 `read`；本人或 read 分享，关联调查额外授权 | 权限门禁 + 当前归属/分享；响应写出前再核验，防慢查询期间撤权 |
| `GET /api/sessions` | `chat-routes.ts:123`；本人与 read 分享列表，关联调查不可见项被过滤；无 chat 权限仍能列普通会话 | 无权 403，不以空成功代替拒绝；过滤机制仍保留 |
| `PATCH /api/sessions/:key` | `chat-routes.ts:173`；更新模型/思考级别，存储使用本人、非关联调查约束 | 同一普通聊天门禁 + 本人；不把 read 分享提升为写 |
| `DELETE /api/sessions/:key` | `chat-routes.ts:190`；事务内 `delete`，本人且非关联调查 | 默认同门禁；是否允许无权用户仅清理旧数据属于 D1 备选，不能顺手增加例外 |
| `POST /api/sessions/:key/cap` | `chat-routes.ts:203`；事务内 `cap`，本人且非关联调查 | 同门禁 + 本人；保留上限及事务约束 |
| `GET /api/chat/greeting` | `server.ts:4071`；有效 JWT，返回配置问候语，不读取会话、不发模型请求 | 建议随聊天门禁 403，避免失权后仍呈现可用入口 |

相邻发现接口：`GET /api/agents`（1172）、`/api/agent/skills`（1188）、`/api/agent/tools`（1286）、`/api/agent/status`（1296），当前只有 JWT；agents/status 会取得引擎但本接口不生成回答。它们还承担平台管理发现用途，不在本阶段把整个 `/api/agent/*` 全局套上 `chat:view`。实现时核对消费者，聊天正文及模型准入不能依赖隐藏这些接口。扩展管理已有 `ai:view` / `admin:*` 等权限，保留原政策。

分享现状：`chat-database-service.ts:468` 的 `grantSessionShare` 是内部方法，允许普通会话 owner 授予 `read`；全仓调用搜索未发现生产调用方，也未发现专用聊天分享授予/撤销 HTTP 或 WS 命令。数据表支持明确接收人，不是匿名链接。不得把 `memory.share` 当作聊天分享，也不在本项顺便新增分享 UI/API。

## 3. WebSocket 与内部入口清单

传输由 DirectAdapter 自管理（`adapter/direct-adapter.ts:355`），默认地址以运行配置为准。认证是连接后的 `auth` 帧；`/ws/auth` 在代码中是设备签名验证路径，不能据此断言它是 HTTP 认证路由。有效 JWT 初次认证后，业务帧逐条 `revalidateActor`（653），默认 30 秒心跳再次读取身份（474）。

| 入口 / 分支 | 当前条件 | 建议（待决定） |
|---|---|---|
| `auth` | JWT 验签/到期检查、当前用户状态/sessionVersion，可选设备认证；不要求 chat 权限 | 连接仍可服务调查等消息；普通聊天按消息类型门禁，不把混用 socket 全局视为 chat |
| `chat.history`（974） | 读本人/read 分享普通历史，关联调查额外 read 授权；无 chat 门禁 | 同 HTTP 历史；错误帧不得带正文 |
| `chat.watch`（1003） | 入订阅前 `watch` 归属/分享；可回放 legacy snapshot、parts snapshot、pending completion | 权限 + ACL，在实际快照/回放/正文发送边界重验接收人 |
| `chat.send`（721） | 支持新建、指定会话及幂等重放；`append`；建 run/保存消息/加入订阅后运行；无 chat 门禁 | 所有分支先门禁，包括已完成 run 重放，不能用幂等快照绕过读权限 |
| `chat.steer`（690） | `append`、同 actor/session 的唯一活动 run；消费队列时再次重读 actor/归属（1313） | 新增聊天门禁；撤权清队列，不把历史 steer 延迟送入后续模型 |
| `chat.cancel`（944） | 当前身份有效、run actorId/session 匹配；没有 `authorizeSession`/chat 门禁 | 建议保留本人已有 run 的最小取消能力，属于 D4；不能返回 run 正文或让共享接收者取消 |
| `chat.unwatch`（995） | 当前身份有效后移除订阅，无正文 | 允许清理自身订阅，即使失去 chat 权限；认证失效直接服务端清理 |
| `memory.list/export/delete/share/import/stop/retry`（960） | 功能开启时均要求 `append`，read 分享不能使用；`retry` 可发起提取模型 | 读写/重试增加同聊天门禁，保持独立 memory scope；stop 建议允许本人最小清理；完成后自动提取也须重验 |
| `investigation.watch` / `investigation.unwatch`（636/669） | 独立调查授权、连接初始权限上限、成员/资源检查 | 不替换为普通聊天 ACL；保留独立授权与撤权机制 |

内部调用边界：

- `chat-handler.ts` 导出的 `handleChatSend` / `handleChatHistory`、`DirectAdapter.chat/runChat`、`ChatDatabaseService.createSession/authorizeSession/getSessions` 是入口之外也应复用授权的边界。仅给 HTTP preHandler 加门禁不足以统一 WS 和内部调用。
- 普通聊天存储 ACL 见 `chat-database-service.ts:109–156`：read/history/watch 为 owner OR 明确 read 分享；其他动作必须 owner 且不能关联调查。管理员的通配权限也不能替代会话归属。
- `adapter/canonical-store.ts:86/93/301`、`agent-run-service.ts:209/232` 控制 checkpoint、工具事实和 completion 恢复；恢复以 run actor/session 与 owner 约束为主，不能当作现有实时 chat 撤权检查。
- `DirectAdapter.invoke/runInvoke`（1455）是后台通道，未绑定浏览器 actor，不走普通 `chat`。普通 invoke 无工具，分析 invoke 仅有绑定记录的 completion 工具，并可使用 `guardedAnalysisProvider`；不得给后台虚构用户 actor 或把它改为维护方法写用户聊天。
- 聊天派生 `spawn_subagent/access_subagent`：`agents/subagent-spawn-tool.ts:79/126` 传入 actor；`agents/subagent-manager.ts:71–115/157–217` 异步执行、本人结果访问、独立 controller 与共享 runner。`direct-adapter.ts:339` 初始化，`get-agent-engine.ts:114/236` 纳入 actor 工具目录，`tools/security-catalog.ts:66` 要求 `config:manage`，还受 Agent 策略限制。仅改普通 chat Provider 不覆盖共享 runner 子任务。`packages/agent-core/src/runtime/budget.ts:54–78` 在有预算上下文时返回父 spec.signal，manager 接入此信号；这是条件性预算取消传播，不是可信父 run/凭证绑定，也没有持续 chat 门禁。MF1 推荐见第 5.1 节。
- 用户分析、用户 Cron、系统自动分析已存在不同绑定，不能概括成无 actor 后台；见第 5.3 节逐项现状和兼容影响。
- `principalKind=service` 的调查身份经专用端口加载、有限权限及资源边界，不允许签发交互 JWT/refresh token（`auth/actor-context.ts:288/394/452`）。它与无 actor 的 invoke 不同，也不是所有后台任务的统一身份。

## 4. 现状 / 推荐拒绝矩阵

符号：允许始终还需合法输入及对应 ACL；“静态”是本轮代码推导，不是新实测。下列推荐按 D1–D5 建议组合，均待 Max 确认。

| 场景 | 当前行为 / 证据强度 | 推荐 HTTP / WS 结果 |
|---|---|---|
| 无 JWT、无效或已过期 JWT 新请求/新连接 | HTTP 401；WS 认证失败关闭；旧 HTTP 矩阵覆盖无 JWT、版本撤销 | HTTP 401 / WS 4001；未 auth 发业务帧仍沿用 4002；零模型/工具准入 |
| 有 chat 权限、本人普通历史/发送 | 按 owner 可用，静态 | 允许；工具仍需自身权限/范围/审批 |
| 无 chat 权限、本人普通历史/列表 | 历史 200 且有正文（旧测试），列表允许（静态） | HTTP 403 / `CHAT_FORBIDDEN` 帧，无正文/列表/快照 |
| 无 chat 权限、本人或新普通会话发送 | 旧测试 200、到受控引擎 | 403 / `CHAT_FORBIDDEN`，创建/持久化/模型/工具调用均为零 |
| 无 chat 权限、设置/删除/cap/steer/memory | 依本人 ACL 可进入（静态；memory 须开启） | 拒绝；取消/退订/stop 仅按 D4 最小清理例外 |
| 跨用户、无分享（包括管理员） | 历史/发送 404；旧测试覆盖跨用户；管理员归属结论为静态 | 有全局 chat 权限时仍 HTTP 404 / `CHAT_SESSION_NOT_FOUND`；无权先 403，避免探测资源 |
| 有 read 分享且无 chat 权限 | 历史 200（旧测试）；watch 静态允许 | 建议两条件相交，403 / `CHAT_FORBIDDEN`；保留分享记录但不赋予 chat 权限 |
| 有 read 分享且有 chat 权限 | 读/历史/watch 可用；写拒绝（旧测试覆盖追加 404） | owner 当前 active 且有 chat 才允许读（第 5.4 节）；发送、steer、设置、删除、cap、memory 均拒绝；不向分享者重放含 owner 专有字段的 run 快照 |
| owner 失 chat/禁用、接收者自身有 chat 且有 read 分享 | 现有读谓词未核 owner 状态/权限，静态仍可读 | 暂停读取，404 / CHAT_SESSION_NOT_FOUND；保留分享记录，恢复 owner 权限后重新准入（第 5.4 节） |
| 有 chat 权限但无 owner/分享/调查成员范围 | 不可读；调查本人也须资源权限等 | 404 / 不可见，不以普通 chat 权限替代调查授权 |
| 关联调查无 chat 权限 | 旧 HTTP 测试 404，无调查正文 | 全局门禁 403；有 chat 权限仍须原调查 read 授权；普通 send 不能继续调查 |
| 权限被移除或角色授权到期，用户仍 active 且版本相同 | 重读得到新权限，但普通聊天不检查 chat，仍可进入（静态） | 后续请求/消息 403/错误帧；现有订阅、运行按 D4 处理 |
| 用户禁用/sessionVersion 改变 | HTTP 下次认证拒绝；WS 下次帧/心跳关闭；不等同已停止 run | 按第 5.2 节区分禁用全部普通 run 与仅旧 sessionVersion 的 run；有效新版本运行不连坐，未知副作用保留待核对 |
| JWT 在已认证 WS 存活期间到期 | `revalidateActor` 不保存/重验原 token 的 exp，只查用户/sessionVersion；静态未见到期断开机制 | 建议 exp 到期关闭该连接 4001；仅取消绑定该到期凭证的普通 run 及派生子任务，其他连接/HTTP 不受影响（第 5.2 节） |
| read 分享撤销后仍保持旧 watch | 新 watch/history 走实时分享 SQL；已订阅广播未逐接收人重验（静态） | 下一次正文/快照写入前拒绝接收人，移除订阅；不取消 owner 自己的 run |
| 旧幂等 key / completionPending / reconnect | 先归属检查，再 recover/快照；无 chat 检查（静态） | 权限/ACL 通过后才能恢复、返回正文或自动 memory；未知调用不重放模型/工具 |

WS 建议新增 `error` 帧的稳定 `code`（`CHAT_FORBIDDEN`、`CHAT_SESSION_NOT_FOUND`），请求关联字段沿用现有协议，不加正文、工具参数或可探测资源信息。HTTP 保留既有成功结构，403 `{error: '权限不足'}`；基础设施错误沿用 503 / WS 1013，不伪装成资源不存在。具体协议须经前后端契约对齐，不能把建议字段说成当前已支持。

## 5. 需要 Max 决定的政策差异

| 决策 | 推荐方案 | 备选及实际影响 |
|---|---|---|
| D1 读历史与存量 | `chat:view` 为普通聊天整体使用门禁；读、发、设置、删/cap、记忆统一检查；无权不可读旧历史，数据保留，重新授权后恢复 | 无权仅可读/导出或删除本人旧数据：保留便利，但需明确独立例外及入口；若允许旧历史读，不能再宣称“无 chat:view 禁止所有正文” |
| D2 发送权限语义 | 当前阶段继续一个 `chat:view` 控制读和发送，并更新权限说明为“使用 AI 聊天”；不增加新 permission code | 拆 `chat:send`：可做只读角色，但新增角色迁移、前端契约及兼容成本；现有 code 文案是“查看聊天历史”，不能未经确认扩义 |
| D3 分享 | 接收者自身 `chat:view` AND 明确 read 分享 AND owner 当前 active 且有 chat 权限；owner 失权暂停旧分享可读，保留记录（第 5.4 节） | 接收者门禁例外、或 owner 失权后分享继续、或永久撤销分享均须 Max 明选；不推荐隐式赋全局 chat 权限 |
| D4 运行中撤权 / JWT 到期 | chat 撤权级联所有该用户普通 run 与聊天派生子任务；禁用、version 撤销、单凭证到期分别按第 5.2 节限定范围。本人有效身份 cancel/unwatch/memory.stop 保留最小清理；推送前重验，运行含子任务/空闲 WS 建议 5 秒兜底，exp 定时处理 | 只拦新请求、让旧 run 完成：成本低但继续消费模型/工具且可能推送正文，不满足建议的撤权语义；若保留 30 秒心跳，只能承诺相应窗口，不能称立即生效 |
| D5 后台身份 | 按第 5.3 节保留已有分类：用户分析完整权限快照失效算法不变；用户 Cron 实时业务授权不变；系统自动分析和调查 service 保留自身授权；聊天派生子任务属于 D4 | 使用户分析不受单独撤 chat 影响需更改版本算法，属于额外政策变化，本轮不推荐、不实施；不能笼统承诺“聊天权不影响后台” |

这里的 D4 区分三个时间：撤权事务提交、服务端读取并发现撤权、外部请求实际发出。对 D4 作用域内的普通 run 及派生子任务，目标承诺为“发现后零新增调用、后续写出前校验；下一轮调用前实时校验、运行期有界检测”，不能声称撤权提交的同一瞬间能召回已经发出的 HTTP/SQL/SSH 请求。读权限与外部动作的竞态需要证据记录，不用单一心跳成功作为线性一致证明。

遇到已提交工具但未知结果、取消不合作的 Provider、completionPending，不自动重试。保留事实、checkpoint、审计与 usage 以便对账；不把未确认调用伪装成“未执行”。停止对客户端展示与后端保存必要恢复事实应分开：不得通过关闭写入丢掉已发生副作用证据，不再让失权用户读取这些内容。撤回分享只影响对应接收者观察；owner 撤 chat 按 D4 处置其运行，并按 D3 暂停旧分享可读。单个 owner JWT 到期不等于 owner 失权，不暂停分享。

## 5.1 MF1：聊天派生子任务（唯一推荐组合，待 Max 选择）

现状是用户 actor 快照、ownerId 和 parentSessionKey，尚无可信 parentRunId/凭证期限绑定。access 仅核对 ownerId；共享 runner 的子任务不会自动获得只加在普通聊天 Provider 上的门禁。现有预算上下文可能传播父取消信号并分配剩余期限，不能据此证明撤权已生效；本轮未运行该链。推荐将聊天派生子任务归入 D4，而非 D5 后台例外。

| 场景 | 推荐唯一预期 | 后续实现边界 |
|---|---|---|
| 有 chat + config:manage、合法普通父运行发起 spawn | 实时 chat/父会话/工具策略均通过后才分配；子任务能力不超过初始 actor 与实时权限交集 | 服务端传入 parentRunId、parentSessionId、ownerId、初始 sessionVersion、凭证绑定 ID/exp、来源 ordinary-chat；不信任模型参数或 sessionKey 前缀 |
| 父正常完成但子任务仍活动 | 允许在原预算/期限及原凭证 exp 内完成；继续独立监测实时权限，不随父正常完成注销监测 | parent controller 回收不能删掉子任务授权记录；保留 lineage 到全部子任务与未决动作结算。父原 deadline/预算上限仍生效 |
| 父显式取消、失权/禁用终止或期限终止 | 取消该父运行所有聊天派生子任务，禁止后续模型与工具；正常完成不是此取消事件 | 可信 parentRunId → 子 controller 索引，兼容已有预算 signal；不修改所有共享 runner 的后台政策 |
| 父已结束后仅撤 chat / 禁用 / 撤销起始 version / 原 JWT 到期 | 按第 5.2 节作用域取消仍活动子任务；第二次模型及下一工具调用必须被拒绝，禁止结果正文输出 | 子任务每次实际 Provider chat/chatStream/重试/压缩及工具 execute 前准入，5 秒运行检测含无连接子任务；结果保存与结果读取分开 |
| access_subagent / 结果回流 | 必须有当前 chat、config:manage/工具策略和子任务 owner/父资源访问权；失权拒绝正文；有效重新授权可读已留存事实，不复活取消任务 | 访问点与父消息回流/自动后处理再次检查；不可仅保护 spawn；跨 owner 不可见 |
| 无可信 lineage 的存量活动子任务 | 切换前盘点并有控终止/结算，不认定其为 D5 例外或猜测归属；绑定未知时拒绝新增调用与正文 | 上线前排空或显式归属迁移，失败关闭；保留未决状态并对账，不重放未知动作 |

待 Max 选择：推荐上述级联；备选“派生后独立继续”会允许撤 chat 后仍新增模型/工具消费，必须撤回当前 D4 零新增承诺并定义独立委托准入、有效期及结果读取权限。未选备选前不得实现。后续最小文件范围：`agents/subagent-spawn-tool.ts`、`subagent-manager.ts`、`subagent-registry.ts`、`adapter/get-agent-engine.ts`、`direct-adapter.ts` 及普通运行授权上下文；仅当实际 runner 注入不足时才改 `packages/agent-core` 的窄接口，保留预算/取消/未知回执语义，不把公共 runner 全局套聊天权限。

## 5.2 MF2：身份、授权与凭证期限分域（唯一推荐组合，待 Max 选择）

现状：`auth/actor-context.ts:215–224` 验签后只返回 actor；`auth-middleware.ts:31` 将其存入 request.user；ActorContext、AgentRun 均无起始 exp/连接绑定。普通 HTTP 只在请求认证时验签，不能证明在途跨 exp 已终止；WS 重读 actor 也不重新验原 JWT。以下为拟建语义，不是已有功能。

| 事件/案例 | 推荐取消及观察范围 | 唯一 HTTP/WS 预期 |
|---|---|---|
| 用户禁用 | 该身份全部普通 run、聊天派生子任务及订阅，跨 HTTP/WS/连接 | 新请求 401、WS 4001；在途取消并抑制正文，重新启用需有效重新认证，不复活旧 run |
| sessionVersion 从 v 改为 v+1 | 仅绑定旧 version 的 run/子任务/连接/观察者（v 及其他失效旧版本） | 旧凭证 401/4001；已以 v+1 新认证的 B 及其新 HTTP/WS run 继续；不得按 userId 盲取消新版本 |
| 只撤 chat，身份 active、version 不变 | 全部该用户普通 run/子任务，跨连接和 HTTP；全部该用户聊天订阅 | 新请求 403/CHAT_FORBIDDEN；混用 socket 仅可继续仍具独立授权的消息；调查自身要求 chat 时也会拒绝，清聊天队列与正文；有效身份最小取消/退订/stop 可用 |
| A 的旧 JWT 到期，B 用新 JWT 独立启动另一运行（含 HTTP） | 仅取消起始绑定 A 凭证的 run 及其子任务，关闭所有使用该到期凭证的 WS；不触及 B 起始绑定的新 run | A 4001；B 继续。B 若也观察 A 运行，仅见安全取消状态，不接收取消后的正文；新 token 观察不能延长 A 执行期限 |
| HTTP send 在途跨 exp | 取消该 HTTP 请求起始凭证绑定的运行及派生子任务，不取消同用户其他 HTTP/WS run | 尚未响应时 401，无正文；已发送字节不可召回，流需终止且后续正文为零；保留已发生事实/usage |
| HTTP history 在查询期间跨 exp | 仅拒绝该响应，无运行级联 | 写出前 401；不得连坐 owner 或其他连接的 run |
| 仅观察者 JWT 到期（含有 read 分享者） | 清该观察者订阅及缓冲、关闭其 socket；它未发起的 owner run 不取消 | 4001；有权 owner/其他观察者继续；不能从 watcher.userId 猜测所有 run 都应取消 |
| 断线后在原 exp 前用新 token 重连 | 新 token 只绑定新连接/观察者；原运行仍绑定原起始凭证期限，不重新绑定、不延长 exp | 实时权限/ACL 通过可观察原 run；原 exp 到期仍取消原 run/子任务；在途幂等请求仅恢复观察，不重发模型 |
| 原运行已因到期/撤权取消后重新认证 | 历史/安全终态按当前门禁读取，原运行不可恢复执行 | 新发送须明确新请求；取消或未知外部动作不得借幂等 key 自动重放 |
| 同 socket 再发 auth 换 token | 推荐关闭并新建连接进行重新认证，不在原 socket 热替换授权 | 保留原 run 绑定；新 socket 按上一行重连规则，协议需与前端对齐 |

推荐运行绑定：由服务端验签一次后产生不可由客户端指定的 credentialBindingId、verifiedExp、actorId、initialSessionVersion；WS 另有 connectionId，HTTP 有 requestId；每个普通 run（含无幂等 key 路径）与子任务持有起始绑定，观察者另持有自己的绑定。不得用原始 JWT、解码但未验签的 exp 或客户端 connectionId 作事实，不记录 token 明文。相同 token 可安全映射同一不可逆引用，失效处理以 verifiedExp 为准；无需因复用同 token 误取消不同有效 token 的运行。

后续实现：在认证边界新增内部可信凭证 envelope，不破坏现有 service ActorContext；HTTP handler 与 WS start 显式传入普通执行上下文；按 userId + version/凭证/runId 索引分别取消，接入 Provider/工具/响应/队列边界。使用服务端时钟和 exp 定时器，执行及推送前再比较期限；重启后禁止凭旧 checkpoint 或缺失绑定恢复外部执行。当前默认“无需 schema 迁移”仅指角色/会话数据；若实现需跨进程持久 run 绑定，必须新增迁移及恢复验证，不能假定旧 AgentRun 已支持。本阶段不改 schema。

待 Max 选择：推荐上述“单 JWT 到期只终止该起始凭证绑定运行、重连不续期”。备选可只关闭观察连接并让执行完成，或允许显式新凭证接管原运行；两者需重写执行授权期限及竞态/迁移验收，不能默认为现有能力。用户禁用、sessionVersion 撤销和 chat 撤权不受单凭证备选偷换。5 秒为检测兜底建议而非数据库变更至取消的无条件 SLA；授权服务不可用时停止新增准入/正文，返回 503/1013，不能放行或伪装成无权。

## 5.3 MF3：真实后台身份与兼容影响

下表“现状”均为本分支静态源码核对；“推荐”保留现有业务授权，只有聊天派生执行按 D4 新增聊天边界。没有本轮修改分析版本算法的授权。

| 类别 | 现有身份绑定与复核点 | 推荐本次边界 |
|---|---|---|
| 聊天派生子任务 | actor 快照、ownerId/parentSessionKey；独立 runner，access 核 owner；预算可带父 signal | 新增第 5.1/5.2 节可信 lineage/实时门禁；属于 D4 |
| 用户分析（包括用户触发 invoke） | `analysis-dispatch-store.ts:11–22` 保存 actor + authorizationVersion；`analysis-identity.ts:11–12/27–46` 哈希完整 roles/permissions/sessionVersion/scopes/resourceBoundary；重读身份、业务权限 ai:manage/sql:audit 和资源；`analysis-dispatch-handler.ts:21–45` 准入、每次 Provider 前、completeAnalysis 前复核 | 原样保留完整快照失效；单撤 chat 也会使原快照含该权限的请求失效，权限扩张也失效。失效拒绝后续请求/完成写入，保留 unknown/恢复事实；不称即时召回在途请求 |
| 用户 Cron | `cron/cron-authority.ts:37–80` 持久 owner、任务 resource_scope，上线身份 bound；启动与 refreshActor 重读 owner、cron:manage、实例权限、任务归属/配置；`adapter/get-agent-engine.ts:188–223` 工具执行复核，脚本也 refresh | 不加普通 chat 门禁、不绑定浏览器 JWT exp；保留任务、工具和资源复核。并非“所有 Provider 请求前都有 chat 检查”；不借本项扩展 Cron 运行取消算法 |
| 系统自动分析 | 同 analysis 调度链，但无正数用户 actor/可信 system 身份；`analysis-identity.ts:39–46` 核 auto_analysis_config、资源存在；handler 另核 ANALYSIS_DISPATCH_ENABLED 与配置版本 | 不跟随某用户 chat/JWT；保留独立开关/配置/资源复核及完成写入复核；不能把用户请求改成 system 以绕快照 |
| 调查 service | 专用加载口、service 身份与资源边界；`investigations/authorization.ts:172–242` 重读同 kind/version，核 profile、owner/成员、chat:view（系统 profile 另需 config:view）及资源/工具交集 | 保留原独立调查授权；service 自己失去所需 chat 权限仍拒绝。某人失权不等于另一 service 失权；不得为普通聊天创建 service 例外 |

| 变化场景（其他条件不变） | 聊天子任务推荐 | 用户分析：现状=推荐 | 用户 Cron：现状=推荐 | 系统自动分析：现状=推荐 | 调查 service：现状=推荐 |
|---|---|---|---|---|---|
| 仅撤某用户有效 chat 权限；其分析快照原含 chat | 取消该用户子任务，后续模型/工具拒绝 | 完整哈希变化，后续 Provider/completeAnalysis 检查拒绝旧请求；新分析若有业务权限可用新快照准入 | owner 仍有 cron:manage/资源权则继续；不因仅删 chat 拒绝 | 继续，不绑定该用户 | 独立 service 不变则继续；若撤的是 service 自身所需 chat 则下次调查授权拒绝 |
| 撤实际所需业务权限/资源权 | 下一工具/资源检查拒绝；不把单个工具拒绝扩大为全用户 chat 撤销 | 快照变化或业务/资源复核失败，拒绝旧请求 | 撤 cron:manage/目标实例权限在启动/refresh/工具或脚本检查拒绝；已发出动作保留事实 | 某用户业务撤权无影响；资源删除/自身开关关闭才按原检查拒绝 | 撤 service 自身所需 config/profile/资源权限在调查检查拒绝；无关用户业务撤权无影响 |
| 用户禁用 / 起始 sessionVersion 失效 | 按第 5.2 节取消相应作用域 | revalidate 失败拒绝旧请求，不通过换 actor 延续 | owner 禁用在 load 拒绝；仅 version 更新不自动停任务，loadActiveActor 未绑定旧 version，业务权仍在则继续 | 无绑定用户，不受此事件影响 | 无关用户禁用无影响；service 自身禁用或绑定 version 不匹配则拒绝 |
| 浏览器 JWT 到期 | 取消起始凭证绑定子任务 | 现有持久委托未绑定浏览器 exp，保持按 actor 快照/实时复核，不按浏览器 exp 额外取消 | 不绑定浏览器 exp，继续按业务授权 | 不受影响 | service 没有交互 JWT，不受浏览器 exp 影响 |

以上“继续”只表示该行事件不使其失效，不豁免其他已有权限、开关、租约或 deadline。后台输出的观察者仍须自身实时授权，运行继续不等于可读正文。分析已发出但未回执的请求继续按未知结果保全，不承诺取消已在途 Provider。

待 Max 选择：推荐保留完整分析快照失效规则，接受仅撤 chat 对已有用户分析的上述兼容影响；若选择“分析不受单撤 chat 影响”，需另明确授权版本字段、存量请求/证据失效规则与新验收，不能在本次修订或后续普通 chat 门禁中顺手修改。Cron、系统分析、调查 service 的现有规则本项不改；用户分析不作为 D4 全用户取消索引的普通 run。

## 5.4 分享 owner 失权后的存续

现状：`chat-database-service.ts:120–156/468` 读分享按 recipient 和 read 记录判断，没有联查 owner 当前 chat 权限/active，也没有 owner JWT 到期绑定。因而“仅 owner 失 chat/禁用，记录与会话仍在、接收者身份有效”的读授权静态推导仍可通过；当前已订阅输出还缺逐接收者检查。不是本轮实测。

唯一推荐 D3：接收者有效身份 + 自身 chat + 明确 read 分享 + owner 当前 active 且有有效 chat 权限，四者相交。owner 失 chat 或禁用时暂停读取（接收者自身有效且有 chat 时 HTTP 404/CHAT_SESSION_NOT_FOUND，不泄露 owner 状态）；接收者自身无权仍优先 403。清受影响观察订阅/缓冲，所有 history/list/watch/replay/parts/legacy 输出一致检查；不删除分享记录。owner 恢复 active 和有效权限后，原分享可再次按实时准入读取；订阅需重新建立，不自动重发或恢复取消 run。owner 单 JWT 到期、sessionVersion 更新但仍 active 且有 chat 均不暂停既有分享；它们仅按第 5.2 节处理绑定执行/连接，不等同 owner 失权。单撤接收者分享只停该接收者观察，不取消 owner run。分享始终只读，不传递工具/memory/调查写权。

待 Max 在以下互斥 owner 政策中选一：推荐“暂停并保留记录、恢复权限后可重新读”；备选“owner 失权不影响既有分享，接收者仍凭自身 chat+read 可读”；备选“owner 失权即永久撤销分享，恢复后需重新授予”。本节推荐矩阵只采用第一项，未混入备选。后两者分别意味着失权 owner 历史仍可传播或破坏存量分享恢复，均需明确批准。

实现边界为 ChatDatabaseService actor 可读谓词/列表过滤与实际输出前的 owner 当前有效授权核验，复用现有通配/admin/grant 到期语义；不能用 owner 的过期 JWT 来判断当前权限，不能给 owner 伪造交互凭证。授权库不可用时 503/1013，不能误判 404。grant 内部方法亦需授予方当前权限与 owner 校验；仍不新建公开分享 API/UI。存量盘点增加“有效分享但 owner 已失权/禁用”的数量，未来验收覆盖暂停、恢复、只撤接收者、owner token/version 变化及慢写队列，禁止扫描正文或自动补权。

## 6. 存量兼容与实现边界

建议上线前只读盘点并交给管理员确认（本阶段未读实际数据）：有效用户/角色的精确与通配权限、到期 grant、拥有普通会话但无 chat 权限的人数、read 分享接收者、关联调查、service 身份及活动/未决 run。不能只按 `permissions.code = 'chat:view'` 计数；复用 `hasPermission` 的 `*`、`chat:*`、`*:view` 和现有管理员有效身份规则。会话 owner、分享接收人与 service 分开统计，不记录正文或凭据。

不通过迁移向全部历史用户/分享接收者自动补权，不删除/改 owner/复制会话，不新增匿名分享，也不根据消息内容把 JSONL 缓存升级成授权事实。新策略生效后 old JWT 仍取实时权限；旧 socket、display snapshot、run 幂等/恢复及自动记忆路径须一起生效，不能靠刷新页面。若管理员决定补权，需明确具体角色/用户清单和回滚清单，由 Chief 纳入批准范围。

角色/会话权限默认无需 schema 迁移；运行可信绑定若需持久化按第 5.2 节新增迁移与恢复验收；若选 D2 拆权限，再设计新迁移及旧角色映射，不修改已执行迁移。回滚代码不删除聊天、分享、审计或未知调用记录，回滚导致旧宽松授权恢复必须在发布决定中注明。

| 后续文件边界 | 最小职责 |
|---|---|
| 拟新增 `src/auth/chat-authorization.ts` | 可注入 actorContexts 的普通 chat 准入、有效权限和资源判定；复用现有权限匹配，无新通用 RBAC 框架 |
| `src/chat-routes.ts`、`src/chat-handler.ts`、`server.ts` greeting | HTTP 拒绝与最终响应检查；异常分类，禁止 chat 拒绝被现有 catch 转成 500 |
| `src/chat-database-service.ts` | actor 入口统一门禁、owner/share/调查分流；不要在 maintenance/调查专用写入路径无差别加交互权限 |
| `src/adapter/direct-adapter.ts`、`display-stream.ts`、`bounded-socket-writer.ts` | 所有普通消息及 legacy/parts/replay/invoke 推送收件人授权；撤权清理；按 user/version/起始凭证分别限定跨连接取消，不把 watcher 到期混为 owner 撤权；缓冲队列失权后不得继续排正文 |
| `src/adapter/get-agent-engine.ts` | 普通 chat Provider 实际 chat/chatStream/重试/压缩边界及工具 execute 前实时 chat 授权，保持请求初始上限与实时权限交集；不只在 beforeIteration 检查 |
| `src/adapter/agent-run-service.ts`、`canonical-store.ts`、`memory-service.ts` | completion/checkpoint/工具事实保全与对用户可见性分离；恢复、自动 memory、新提取请求不能绕门禁；清理必须覆盖无幂等 key 的旧发送和 HTTP run |
| `src/auth/actor-context.ts`、`src/auth-middleware.ts`（后续） | 验签后产生可信凭证 envelope，HTTP/WS 显式传递 run 起始绑定；保留既有 actor/service 契约 |
| `src/agents/subagent-spawn-tool.ts`、`subagent-manager.ts`、`subagent-registry.ts` | 第 5.1 节 lineage、子任务独立准入/监测与取消、access/回流检查；保留现有预算 signal 与事实结算 |
| `src/analysis/analysis-identity.ts`、`analysis-dispatch-handler.ts`、`src/cron/cron-authority.ts`、调查授权 | 本项保持产品实现不变；仅在后续集成验收覆盖第 5.3 节真实兼容影响，不改分析授权版本算法 |
| 契约生成/WS 协议与测试 | 只在公开拒绝契约变化处更新，补 HTTP/WS/Provider/工具/回放/队列负例；不要改全局工具策略来替代 chat 门禁 |
| 前端（后续另协调） | 稳定错误帧、失权清空当前正文/停止重连重发、保留取消/退订反馈；不在本阶段修改 UI |

当前普通工具注册在 `get-agent-engine.ts` 中捕获初始 actor；`executeToolWithPolicy` 对这个 actor 做工具权限判断，本身不等于实时 chat 检查。后续只围绕本任务普通聊天执行边界补实时授权，保留已有工具资源、审批及审计检查；不把公共工具一律声称不可用，也不将本调查扩大成全仓工具整改。

## 7. 实施后的验证与停止条件

本阶段可验收：版本差异明确；入口列全；现状/建议分开；五个政策决策、兼容及实现边界可审阅。以上文档与静态 manifest 为阶段产物，不声称整单业务验收通过。

实施后需要：

1. 单元/契约：权限匹配（含通配、admin、失效 grant）、稳定拒绝、身份伪造、owner/share/调查及服务身份；拒绝发生在创建 session/run/写用户消息之前。
2. 独占真实 MySQL + 真实 JWT 的 HTTP 与真实 WS：覆盖本矩阵，含同 socket 撤权、只删角色而不改 version、分享撤销、exp 跨越、同用户多连接、无幂等 key、HTTP 运行、队列中和已开始的请求。模型/工具用可观测受控端点验证拒绝后零新调用，不能仅断言一个 mock 返回 403。
3. MF1–MF3 负例与兼容：父正常完成后保持子任务活动，在第二次模型请求/下一工具前分别撤 chat、禁用、撤 version、跨 exp；观测子任务请求数不增加、无结果正文、未知事实完整。另覆盖父取消级联、跨 owner access、无 lineage 旧任务切换。A/B 新旧 token、新旧 version、HTTP send/history 跨 exp、仅观察者到期、新凭证重连但不续期逐行验证第 5.2 节；用户分析“仅撤 chat”必须旧快照失败，新业务请求按业务权限新准入；Cron/系统分析/调查 service 按第 5.3 节分别验证，不把 mock 当真实链。分享按第 5.4 节覆盖 owner 失权暂停/恢复以及 token/version 不连坐。
4. 流与恢复：legacy/parts snapshot、慢写缓冲、幂等 run.snapshot、pending completion、重连、memory retry/自动提取；撤权后零未授权正文，保留事实与未知副作用，重新授权可恢复历史观察，取消运行不复活且不重发未知模型/工具请求。
5. 真实业务链：隔离角色、正式服务与受控模型/工具端点，并记录真实 Provider 能力要求是否另需验证。若需真实付费模型，沿用共享累计账本；本轮未调用，不能引用旧 45 token 当作当前余额。
6. 按最终改动运行 API typecheck、相关测试、公开契约检查及 source-policy；权限改动由 15-Reviewer 独立复核，证据记录完整 base/head、配置、命令、测试/观测/清理状态及无凭据的审计计数。前端受影响再验证键盘、焦点、控件名称和自动化可访问性，不加人工听读门禁。

本阶段到方案交付即停止；后续实现依赖 Chief 协调 D1–D5，当前“启动”不解释为已批准其中一种全局政策。后续验收若仍观察到失权后的新模型/工具调用、未授权正文、未知结果被重放或事实丢失，不得判通过。
