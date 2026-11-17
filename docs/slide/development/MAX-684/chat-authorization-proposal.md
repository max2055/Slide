# MAX-684 普通聊天授权调查与待决方案

日期：2026-11-17。阶段：调查交付；以下建议尚未实施，不能当作现有能力。整单继续 `in_progress`，由 Chief 汇总政策决定后再安排实现和独立审查。本阶段不改产品代码、角色授权、数据或运行服务，不合并、部署或派发前端。

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
| `investigation.watch/unwatch`（636/669） | 独立调查授权、连接初始权限上限、成员/资源检查 | 不替换为普通聊天 ACL；保留独立授权与撤权机制 |

内部调用边界：

- `chat-handler.ts` 导出的 `handleChatSend` / `handleChatHistory`、`DirectAdapter.chat/runChat`、`ChatDatabaseService.createSession/authorizeSession/getSessions` 是入口之外也应复用授权的边界。仅给 HTTP preHandler 加门禁不足以统一 WS 和内部调用。
- 普通聊天存储 ACL 见 `chat-database-service.ts:109–156`：read/history/watch 为 owner OR 明确 read 分享；其他动作必须 owner 且不能关联调查。管理员的通配权限也不能替代会话归属。
- `adapter/canonical-store.ts:86/93/301`、`agent-run-service.ts:209/232` 控制 checkpoint、工具事实和 completion 恢复；恢复以 run actor/session 与 owner 约束为主，不能当作现有实时 chat 撤权检查。
- `DirectAdapter.invoke/runInvoke`（1455）是后台通道，未绑定浏览器 actor，不走普通 `chat`。普通 invoke 无工具，分析 invoke 仅有绑定记录的 completion 工具，并可使用 `guardedAnalysisProvider`；不得给后台虚构用户 actor 或把它改为维护方法写用户聊天。
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
| 有 read 分享且有 chat 权限 | 读/历史/watch 可用；写拒绝（旧测试覆盖追加 404） | 读允许；发送、steer、设置、删除、cap、memory 均拒绝；不向分享者重放含 owner 专有字段的 run 快照 |
| 有 chat 权限但无 owner/分享/调查成员范围 | 不可读；调查本人也须资源权限等 | 404 / 不可见，不以普通 chat 权限替代调查授权 |
| 关联调查无 chat 权限 | 旧 HTTP 测试 404，无调查正文 | 全局门禁 403；有 chat 权限仍须原调查 read 授权；普通 send 不能继续调查 |
| 权限被移除或角色授权到期，用户仍 active 且版本相同 | 重读得到新权限，但普通聊天不检查 chat，仍可进入（静态） | 后续请求/消息 403/错误帧；现有订阅、运行按 D4 处理 |
| 用户禁用/sessionVersion 改变 | HTTP 下次认证拒绝；WS 下次帧/心跳关闭；不等同已停止 run | 拒绝新调用、撤销订阅并取消用户 run，未知副作用保留待核对 |
| JWT 在已认证 WS 存活期间到期 | `revalidateActor` 不保存/重验原 token 的 exp，只查用户/sessionVersion；静态未见到期断开机制 | 建议 exp 到期关闭 4001，需重新认证；已有 run 按 D4 同处理 |
| read 分享撤销后仍保持旧 watch | 新 watch/history 走实时分享 SQL；已订阅广播未逐接收人重验（静态） | 下一次正文/快照写入前拒绝接收人，移除订阅；不取消 owner 自己的 run |
| 旧幂等 key / completionPending / reconnect | 先归属检查，再 recover/快照；无 chat 检查（静态） | 权限/ACL 通过后才能恢复、返回正文或自动 memory；未知调用不重放模型/工具 |

WS 建议新增 `error` 帧的稳定 `code`（`CHAT_FORBIDDEN`、`CHAT_SESSION_NOT_FOUND`），请求关联字段沿用现有协议，不加正文、工具参数或可探测资源信息。HTTP 保留既有成功结构，403 `{error: '权限不足'}`；基础设施错误沿用 503 / WS 1013，不伪装成资源不存在。具体协议须经前后端契约对齐，不能把建议字段说成当前已支持。

## 5. 需要 Max 决定的政策差异

| 决策 | 推荐方案 | 备选及实际影响 |
|---|---|---|
| D1 读历史与存量 | `chat:view` 为普通聊天整体使用门禁；读、发、设置、删/cap、记忆统一检查；无权不可读旧历史，数据保留，重新授权后恢复 | 无权仅可读/导出或删除本人旧数据：保留便利，但需明确独立例外及入口；若允许旧历史读，不能再宣称“无 chat:view 禁止所有正文” |
| D2 发送权限语义 | 当前阶段继续一个 `chat:view` 控制读和发送，并更新权限说明为“使用 AI 聊天”；不增加新 permission code | 拆 `chat:send`：可做只读角色，但新增角色迁移、前端契约及兼容成本；现有 code 文案是“查看聊天历史”，不能未经确认扩义 |
| D3 分享 | 接收者需自身 `chat:view` AND 明确 read 分享；授予方须当前有权且为普通会话 owner；分享不传递工具、memory、调查权限 | 分享作为全局门禁例外：无 chat 权限仍可读指定共享内容，要在所有 HTTP/WS 输出统一例外；不推荐以分享隐式授予全局 chat 权限 |
| D4 运行中撤权 / JWT 到期 | 已检测撤权后禁止后续模型/工具启动及正文发布，取消该用户普通 run、清 steer 和订阅；本人 cancel/unwatch/memory.stop 保留最小清理。严格推送前重验；空闲 WS/运行监测建议 5 秒兜底，到期按 exp 定时关闭 | 只拦新请求、让旧 run 完成：成本低但继续消费模型/工具且可能推送正文，不满足建议的撤权语义；若保留 30 秒心跳，只能承诺相应窗口，不能称立即生效 |
| D5 后台身份 | 普通交互只接受 user；调查 service、分析 invoke、Cron 等保留各自绑定授权，不因取消某用户聊天权而全局停后台任务 | 若后台任务确代表某用户执行，则需要明确委托关系及撤权级联对象；不能仅凭 sessionKey 归因或给所有 service 加 chat:* |

这里的 D4 区分三个时间：撤权事务提交、服务端读取并发现撤权、外部请求实际发出。可承诺“发现后零新增调用、后续写出前校验；下一轮调用前实时校验、运行期有界检测”，不能声称撤权提交的同一瞬间能召回已经发出的 HTTP/SQL/SSH 请求。读权限与外部动作的竞态需要证据记录，不用单一心跳成功作为线性一致证明。

遇到已提交工具但未知结果、取消不合作的 Provider、completionPending，不自动重试。保留事实、checkpoint、审计与 usage 以便对账；不把未确认调用伪装成“未执行”。停止对客户端展示与后端保存必要恢复事实应分开：不得通过关闭写入丢掉已发生副作用证据，不再让失权用户读取这些内容。撤回分享只影响接收者观察，owner 撤权才按其 run 权限处置。

## 6. 存量兼容与实现边界

建议上线前只读盘点并交给管理员确认（本阶段未读实际数据）：有效用户/角色的精确与通配权限、到期 grant、拥有普通会话但无 chat 权限的人数、read 分享接收者、关联调查、service 身份及活动/未决 run。不能只按 `permissions.code = 'chat:view'` 计数；复用 `hasPermission` 的 `*`、`chat:*`、`*:view` 和现有管理员有效身份规则。会话 owner、分享接收人与 service 分开统计，不记录正文或凭据。

不通过迁移向全部历史用户/分享接收者自动补权，不删除/改 owner/复制会话，不新增匿名分享，也不根据消息内容把 JSONL 缓存升级成授权事实。新策略生效后 old JWT 仍取实时权限；旧 socket、display snapshot、run 幂等/恢复及自动记忆路径须一起生效，不能靠刷新页面。若管理员决定补权，需明确具体角色/用户清单和回滚清单，由 Chief 纳入批准范围。

默认无需 schema 迁移；若选 D2 拆权限，再设计新迁移及旧角色映射，不修改已执行迁移。回滚代码不删除聊天、分享、审计或未知调用记录，回滚导致旧宽松授权恢复必须在发布决定中注明。

| 后续文件边界 | 最小职责 |
|---|---|
| 拟新增 `src/auth/chat-authorization.ts` | 可注入 actorContexts 的普通 chat 准入、有效权限和资源判定；复用现有权限匹配，无新通用 RBAC 框架 |
| `src/chat-routes.ts`、`src/chat-handler.ts`、`server.ts` greeting | HTTP 拒绝与最终响应检查；异常分类，禁止 chat 拒绝被现有 catch 转成 500 |
| `src/chat-database-service.ts` | actor 入口统一门禁、owner/share/调查分流；不要在 maintenance/调查专用写入路径无差别加交互权限 |
| `src/adapter/direct-adapter.ts`、`display-stream.ts`、`bounded-socket-writer.ts` | 所有普通消息及 legacy/parts/replay/invoke 推送收件人授权；撤权清理、token 到期、跨连接用户 run 取消；缓冲队列失权后不得继续排正文 |
| `src/adapter/get-agent-engine.ts` | 普通 chat Provider 实际 chat/chatStream/重试/压缩边界及工具 execute 前实时 chat 授权，保持请求初始上限与实时权限交集；不只在 beforeIteration 检查 |
| `src/adapter/agent-run-service.ts`、`canonical-store.ts`、`memory-service.ts` | completion/checkpoint/工具事实保全与对用户可见性分离；恢复、自动 memory、新提取请求不能绕门禁；清理必须覆盖无幂等 key 的旧发送和 HTTP run |
| `src/auth/actor-context.ts`（按需） | 传输记录 token exp 的可信来源；避免把可伪造客户端 exp 加到 actor 或破坏调查服务身份 |
| 契约生成/WS 协议与测试 | 只在公开拒绝契约变化处更新，补 HTTP/WS/Provider/工具/回放/队列负例；不要改全局工具策略来替代 chat 门禁 |
| 前端（后续另协调） | 稳定错误帧、失权清空当前正文/停止重连重发、保留取消/退订反馈；不在本阶段修改 UI |

当前普通工具注册在 `get-agent-engine.ts` 中捕获初始 actor；`executeToolWithPolicy` 对这个 actor 做工具权限判断，本身不等于实时 chat 检查。后续只围绕本任务普通聊天执行边界补实时授权，保留已有工具资源、审批及审计检查；不把公共工具一律声称不可用，也不将本调查扩大成全仓工具整改。

## 7. 实施后的验证与停止条件

本阶段可验收：版本差异明确；入口列全；现状/建议分开；五个政策决策、兼容及实现边界可审阅。以上文档与静态 manifest 为阶段产物，不声称整单业务验收通过。

实施后需要：

1. 单元/契约：权限匹配（含通配、admin、失效 grant）、稳定拒绝、身份伪造、owner/share/调查及服务身份；拒绝发生在创建 session/run/写用户消息之前。
2. 独占真实 MySQL + 真实 JWT 的 HTTP 与真实 WS：覆盖本矩阵，含同 socket 撤权、只删角色而不改 version、分享撤销、exp 跨越、同用户多连接、无幂等 key、HTTP 运行、队列中和已开始的请求。模型/工具用可观测受控端点验证拒绝后零新调用，不能仅断言一个 mock 返回 403。
3. 流与恢复：legacy/parts snapshot、慢写缓冲、幂等 run.snapshot、pending completion、重连、memory retry/自动提取；撤权后零未授权正文，保留事实与未知副作用，重新授权可恢复且不重发未知模型/工具请求。
4. 真实业务链：隔离角色、正式服务与受控模型/工具端点，并记录真实 Provider 能力要求是否另需验证。若需真实付费模型，沿用共享累计账本；本轮未调用，不能引用旧 45 token 当作当前余额。
5. 按最终改动运行 API typecheck、相关测试、公开契约检查及 source-policy；权限改动由 15-Reviewer 独立复核，证据记录完整 base/head、配置、命令、测试/观测/清理状态及无凭据的审计计数。前端受影响再验证键盘、焦点、控件名称和自动化可访问性，不加人工听读门禁。

本阶段到方案交付即停止；后续实现依赖 Chief 协调 D1–D5，当前“启动”不解释为已批准其中一种全局政策。后续验收若仍观察到失权后的新模型/工具调用、未授权正文、未知结果被重放或事实丢失，不得判通过。
