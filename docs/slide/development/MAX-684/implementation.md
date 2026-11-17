# MAX-684 实现与集成交付

政策依据：Max 在任务线程确认整套推荐政策；方案候选 `58abcdbb4683532430f447c32a47e87b3b603dd4`。本文件记录实现和验证，不代表独立审查、合并或部署放行。

## 候选与归属

- 集成目标 base/main：`451ab8c9969f18d94f17392a74301294de82b5e1`（包含 #1008）；从任务起点通过 merge 纳入，没有重写起点历史。
- 后端实现：`38765b0dc`；集成前端 merge：`07bcad19d2950e173bf862bf8c530fe0a4722cde`；真实客户端集成验证提交：`cb8f212e9019471c96dee1ba65494b312b070027`。最终产品代码候选 `963b079c28ec60ac88c9b6d94fffab7422a7f1fa`，本提交之后仅补交付证据文档；完整候选见 [草稿 PR #1010](https://github.com/max2055/Slide/pull/1010)。
- 前端浏览器证据：[作者 REPORT](https://multica.ai/api/attachments/01a1e99c-b7c5-7544-b5ae-8b6006255b1b/download)、[原证据包](https://multica.ai/api/attachments/01a1e99c-ce62-75d1-8340-4a3844cb052c/download)。
- 前端原候选：[草稿 PR #1009](https://github.com/max2055/Slide/pull/1009)，head `0f4919bf76a224912409102ce9f93f85b419560b`；准确核对六个前端文件后以 merge 纳入，原 PR 保持 OPEN/DRAFT，不改写或关闭。
- 后端、运行、迁移、测试及六个已释放前端文件构成本完整候选；没有纳入工作树既有运行时 `AGENTS.md`。本代理完成集成后释放这些文件给 Chief/Reviewer，未再启动其他成员。

## 入口与错误契约

成功响应保持原结构。HTTP 聊天权拒绝 403 `{error:'权限不足',code:'CHAT_FORBIDDEN'}`；不可见会话 404 `{error:'Session not found',code:'CHAT_SESSION_NOT_FOUND'}`；失效身份、起始凭证到期或缺乏可信期限的交互聊天请求 401；授权依赖不可用 503。问候语纳入同一注册和出站复核。

WS 使用已有 error 帧及稳定 code `CHAT_FORBIDDEN` / `CHAT_SESSION_NOT_FOUND`，沿用 sessionKey/messageId/runId 关联。身份失效/原 token 到期关闭 4001，授权不可用关闭 1013；不会将授权基础设施错误当作 404。失 chat 后保留有效身份的本人取消、退订和 memory.stop，不新增历史读/删/导出例外。内部凭证绑定不会进入 run.snapshot 的公开载荷。

`chat:view` 是聊天使用门禁：HTTP 七个入口（含 greeting）、WS 聊天和记忆入口、存储服务及最终正文输出都覆盖。分享必须同时满足接收者自身聊天权、明确 read 分享和 owner 当前 active/chat；owner 失权时暂停并保留记录，恢复后重新准入。分享不授写，不扩大工具、记忆或调查权限。

## 执行、持久化与恢复

- JWT 验签后以 WeakMap 保存可信 exp 和 SHA256 引用，不序列化原 token。非聊天认证继续保留既有兼容行为；普通交互聊天必须有可信期限，不能用客户端字段补齐。
- 每个普通执行在排队前绑定初始 actor/version/credential/exp。Provider 请求（含 runtime 重试、压缩）、工具实际 handler 及输出前复核；5 秒监测为兜底，不承诺撤权事务提交时召回已发出的动作或已交给网络栈的字节。
- 子任务只能从可信聊天父上下文派生，保留原工具权限上限和实际父会话，独立持有绑定引用。父正常结束不释放活动子任务的监测；父取消、身份失效、失权、起始凭证到期级联。无 lineage 的旧记录不能被当作普通任务继续或读出结果。
- 新 token 只恢复观察，不改旧运行期限；A 到期不取消独立 B。撤 version 只影响旧版本；禁用和撤 chat 由每个绑定的实时检查共同覆盖。
- 迁移 `160_chat_execution_authority.sql` 新增三列：chat_session_version / chat_credential_ref / chat_credential_expires_ms，全部 NULL 兼容旧行并附 comment。无角色补权、无聊天或分享删除。缺绑定的旧 running/staged completion 失败关闭；取消的 staged 答案保留在 SQL 中对账，不再成为响应正文。恢复事务用 READ COMMITTED 重验，不能由新 token 接管原执行。
- 普通 checkpoint 带原始授权绑定；无绑定或换绑定的未结 checkpoint 要求对账，不自动重放。已经准入的 scope 可以继续写已观察到的工具事实，但此窄端口不授予新的调用或正文读取。
- 用户分析完整权限快照哈希、Cron 实时 owner/业务授权、系统分析开关、调查 service 授权算法不改。可信后台执行入口显式退出普通聊天 ALS 上下文，保留自己的授权复核，不把所有异步工作都套为聊天子任务。

回滚保留新增列、历史、分享、审计和未知事实；回滚至旧代码会恢复此前较宽松的聊天政策，必须作为发布决定明确处理，不能把代码回滚描述为自动安全恢复。

## 验证入口与证据边界

真实验收固定入口：`MAX684_ACCEPTANCE=1 MAX684_MYSQL_PORT=3308 pnpm --filter slide-api exec vitest run src/auth/chat-authorization.mysql.test.ts`。host/user/password 由受控执行环境通过 MAX684_MYSQL_HOST / MAX684_MYSQL_USER / MAX684_MYSQL_PASSWORD 注入，证据路径可由 MAX684_EVIDENCE 指定；不得在命令或日志中展开真实密码。默认测试收集不读私人凭据，不连接共享默认库；显式启用缺端口会报错。

本机使用 Node 24.22.1、packageManager 指定 pnpm 11.19.0、锁定依赖；AGENTS §2.1 的 mysql3308 服务上使用每次随机独占 schema。真实 JWT、MySQL、正式 ChatDatabaseService/HTTP routes/handleChatSend、Fastify 监听套接字、DirectAdapter/AgentRunner 和真实 WS 均参与；没有启动整套 server.ts 调度器或更改平台 3306 配置。

模型边界是本地真实 HTTP OpenAI 兼容端点的受控输出，工具为进程内可计数的受控 handler；不是 DeepSeek/其他真实模型能力或目标数据库/SSH 业务工具兼容性验收。累计付费模型请求为零，没有发送预算账本请求。

前端新增集成验收使用 #1009 的实际 DirectGatewayClient、控制器和状态接收器，在 JSDOM 环境连接上述真实 HTTP/WS/SQL 授权服务。验证 403 清理历史/流/工具正文、迟到消息丢弃、503 保留可恢复观察、1013 自动恢复观察、丢失准入回执后仅一次 chat.send/模型准入，以及 A 到期后新 token B 建新连接。迟到帧通过绕过服务端 writer 的显式传输故障注入模拟，不能据此声称服务端发送了未授权正文。

浏览器的三个桌面尺寸、控件名称和键盘证据沿用前端阶段的契约替身证据，未扩大为完整真实浏览器后端验收。刷新期间焦点回到 body 是原作者已复现的既有问题，本候选未触及控件，不宣称焦点保持通过；不恢复人工听读门禁。

## 批准方案的 18 场景

下表每行在固定真实验收入口有同 ID 用例，并写入无正文/无凭据的 JSON 观察记录。

| 场景 | 本地结果 |
|---|---|
| MF1-parent-completed | 通过 |
| MF1-second-model | 通过 |
| MF1-next-tool | 通过 |
| MF1-child-exp | 通过 |
| MF1-access | 通过 |
| MF2-A-B | 通过 |
| MF2-version | 通过 |
| MF2-http-send | 通过 |
| MF2-http-history | 通过 |
| MF2-observer | 通过 |
| MF2-reconnect | 通过 |
| MF3-analysis-chat | 通过 |
| MF3-analysis-business | 通过 |
| MF3-cron | 通过 |
| MF3-system | 通过 |
| MF3-service | 通过 |
| D3-owner | 通过 |
| D3-token | 通过 |

另有 HTTP/WS 拒绝矩阵、父取消/无 lineage、staged completion 原绑定恢复、实际前端真实授权集成及单会话分享撤回观察隔离五项，共 23 项。负例比较本地 Provider 请求数和受控工具 handler 次数；没有把健康探针、静态哈希、方案 PASS 或纯 mock 当作本次真实授权验收。

迁移验收覆盖空库全量、截至 159 的旧库升级、重复执行和新增列 comment；每次验收清理客户端、在途受控请求、服务、连接池和本任务 schema。

## 必要 gate 与已知限制

已验证前端全量 226 文件/2352 项通过，安全回归 35 文件/613 项通过，真实授权与集成 23 项通过；前后端 typecheck、contracts:check、ci:source-policy、前端 build/CSP 通过。API 全量 `pnpm --filter slide-api test --maxWorkers=1` 为 690 文件通过、190 文件跳过，8464 项通过、1928 项跳过，Vitest 退出 0。全量运行开始于 cb8f212；期间仅完成分享撤回观察隔离的窄修改，之后在 963b079 产品代码上补跑安全 613 项与真实授权 23 项，覆盖该变化。无需重跑未变化模块；所有 gate 都使用完整入口，测试、观测和清理分别记录。前后端 typecheck、公开契约、source-policy、前端 build/CSP、安全测试及适用模块回归均须在完整候选检查。独立权限实现复核仍由 Chief 交原 Reviewer 执行，本文件不代替其结论。

历史诊断：首次扩大 API 全量时，旧夹具缺少新凭证/聊天权，已更新并分别验证。随后共享 mysql3308 发生 OOM（Docker State.ExitCode=137/OOMKilled=true），出现连接丢失、ECONNREFUSED 和跨 schema 的全局迁移锁等待；核对容器身份后仅重启该测试服务，未停止其他任务容器。另有未修改的 prompt-manager 文件监听断言在并行全量中超时，隔离 20 项通过。不能把这些失败记为 gate 通过；最终用单 worker、明确注入 T08_TEST_MYSQL_PORT / TRIGGER_TEST_MYSQL_PORT 及对应密码环境配置，通过全量 gate；各夹具仍使用随机独占 schema。历史失败保留在证据包，不改无关提示词代码。

仍有范围限制：真实外部模型能力/费用测试未执行；未做新增授权查询的容量基准；网络栈已接受的数据和已发出的未知外部动作不能瞬间撤回，须保全事实并对账，不自动补权或重放。没有合并至 main、部署或自行签署实现 PASS。

最终本地检查入口：

```bash
pnpm --filter slide-api typecheck
pnpm --filter slide-frontend typecheck
pnpm --filter slide-api test --maxWorkers=1
pnpm --filter slide-frontend test
pnpm --filter slide-frontend build
pnpm security:test
pnpm security:scan
pnpm contracts:check
pnpm ci:source-policy origin/main HEAD
```

API 全量通过仍不覆盖按环境跳过的全部外部场景；23 项 MAX-684 验收通过独立显式入口执行。模型受控端点请求总数和工具计数见 scenario-evidence.json；拒绝矩阵中准入增量为零、子任务撤权后第二次模型/下一工具增量为零。取消 staged answer 的 SQL 事实保留、未写 assistant 消息、未重发模型；前端未知回执恢复仅一次 chat.send/模型准入均有断言。

CI 是推送后外部系统，未等待或宣称通过。完整候选继续保持草稿；MAX-684 实施阶段交付给 Chief 后等待原 Reviewer 独立实现审查及最终验收，未宣称整单完成。
