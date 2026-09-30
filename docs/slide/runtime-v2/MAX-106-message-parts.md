MAX-106 在既有 canonical ledger 上增加 Message Parts v1。旧字段仍是兼容投影，原始内容、角色、工具关联和 opaque reasoning 块都保留；没有新增数据库表、事件总线、附件入口或 PDF/video 产品。

## 执行契约与基线

- 原复核基线：`6c22d2a51d7bf17ec3cd36526032671b104849dd`；实施基线：main `3bb924b2d08fd2cb16c9cdfdd52052e063f3a9c2`。
- 直接依赖 MAX-98 / MAX-99 / MAX-104 的 PR #103 / #104 / #108 均通过 Multica 链接表核验 merged。前序 MAX-105 的 PR #109 已合并；沿用其模型窗口、token 会计与媒体安全准入。
- 独立分支 `agent/15astra/max-106-parts` 从最新 main 开始；原工作树的用户修改未动。
- 验收：角色/文本/调用/结果/推理/ID 可逆往返，durable acknowledgement 和 attempt 一致，DB/JSONL/checkpoint/WS/UI 一致，附件 capability/预算/失效负例，迁移失败保留原内容且不重放工具。
- 验证分层：focused checks → 受影响模块 test/typecheck/build → 隔离 MySQL/WS/Chromium 验收。父任务仍负责整链 gate 和真实供应商验证。
- 停止条件：本地必要检查通过后交付独立 PR；CI 交给平台 checks 条件唤醒，满足仓库门禁且无冲突后按已有授权合并。未验证项不得计为通过。
- 硬预算未设定。子代理数 0、深度 0、代理并发峰值 1。raw input、cached input、output、费用实测遥测不可用；没有用内部预算计数冒充实际吞吐。

## 契约与持久化

`messageParts` 是可选增量字段：version=1、稳定 message/run/turn IDs、source、status、durable evidence、attempt/sourceRequestId 和有序 parts。part ID 由 C1 message ID 与原始 part 顺序生成，不重新分配消息 ID。类型为 text、reasoning、tool_call、tool_result、attachment、runtime_notice；system/user/assistant/tool 均保留。

v1 迁移保留完整 `legacy` 回退投影，包括 null/空 content、未知旧字段、旧 `<think>`、`reasoning_content`、`thinking_blocks`、`tool_call_id` 和附件引用。parts 是从旧事实派生的不可变增量表示；此阶段没有引入独立编辑 parts 的写入入口。重复迁移、重复 checkpoint 和冷加载不重复 part；严格读函数对未知 version/非法 boundary 返回明确错误，兼容 UI/存储保留原旧字段和未知 document，provider dispatch 拒绝无法验证的版本。

- 新 candidate/checkpoint facts 默认 partial，`completed` 必须携带存储层的 durable evidence。JSONL 先构造待写 document，rename/fsync 成功后才更新内存状态；失败时旧文件和 partial candidate 保留。旧文件读取确认已经持久化的事实，原子回写 parts，保留 C1 的容量和 repair 规则。
- DB 新消息在现有 metadata JSON 中保存 parts，tool facts 仍在 `entry_json` 中；读取旧行时生成可重复的 projection，不进行全库破坏性迁移。最终 assistant 的 parts 与原消息/terminal transaction 同时提交，completion pending 不成为 canonical final。
- checkpoint 的 partial part 携带 S2 attempt/sourceRequestId；仅 durable 工具 intent 时保持 partial，工具结果事务成功后推进到 completed，重复写入只更新确认状态且不重复 fact/part。未知 settlement 沿用原禁止重放机制。失败/取消前缀不被标为 completed，discarded/failed 状态不因保存升级为 completed。
- canonical/source hash 继续覆盖旧事实字段；派生的 parts 快照和 acknowledgement 不改变事实 hash。provider token 估算排除不会发送的 rollback document；附件仍受原模型准入限制。
- REST history 和 WS chat.history 增加可选 messageParts，旧内容字段和取消接口继续保留。UI 保留现有 REST thinking/text projection，读取附件 parts；同一 legacy image 和 attachment part 只渲染一次。

## Provider 与附件

Runtime 在实际 provider boundary 前完成投影和窗口检查。OpenAI-compatible 的 DeepSeek/Kimi/GLM 工具轮次保留必要 reasoning；新 user turn 后不回放旧推理。Anthropic 活跃工具轮次保留原始 signed/redacted thinking 块及顺序，parser/checkpoint 保留 opaque 内容，不裁剪签名。普通历史与摘要请求排除历史 reasoning 和 rollback 快照。旧直接调用且没有 parts/media 的 OpenAI API 保留原兼容字段。

图像与可读文本文件按 capability、累计 bytes/tokens budget 投影。默认媒体投影上限为 8 MiB / 8192 tokens，调用方可提供更严格预算；base64 实际 decoded bytes 不能被较小 metadata 绕过。缺少远端 bytes 边界、超预算、已失效引用、不支持的 role/capability、无可读文本的文件返回 `ATTACHMENT_*` 固定错误，不静默删除 canonical 引用。此层不主动下载远端媒体；来源解析方必须提供有效性与大小信息。SDK 可发送符合 capability 的 OpenAI image_url / Anthropic image source；unknown image token calibration 仍由 MAX-105 的 `MEDIA_UNCALIBRATED` 准入保护拒绝，不凭固定 allowance 放宽模型窗口。媒体错误保留 status/code，但不把供应商回显的私有 URL/data 写入日志。

## 回退

不需要 schema downgrade。旧二进制继续读取旧 content/tool/reasoning 字段；DB 可只移除 metadata.messageParts，保留 content、canonical IDs、运行 checkpoint、预算和完成事务。JSONL 可用 `restoreLegacyMessage(document)` 导出旧条目后，按现有原子保存方式替换文件；回退先停对应写入实例并备份文件。未知版本/迁移失败时保留原数据，不猜测解析，不清空 checkpoint，不自动重放工具副作用。

## 验证证据

| 层级 | 命令/样本 | 结果 |
| --- | --- | --- |
| core | `pnpm --filter @slide/agent-core test`、typecheck | 最终 635 项通过；parts/边界/summary/token/context focused checks 通过 |
| backend | `pnpm --filter slide-api test`、typecheck | 2784 项通过，129 项环境可选测试跳过，未计为通过 |
| frontend | `pnpm --filter slide-frontend test`、typecheck、build | 549 项通过；生产 build/CSP 检查通过 |
| API | `pnpm contracts:check` | 通过 |
| provider SDK | `src/adapter/runtime-provider.test.ts`，本地真实 HTTP SDK 请求 | 图像支持/拒绝、opaque thinking 工具轮次/新轮次、媒体错误脱敏通过，无付费调用 |
| MySQL/JSONL | `tests/qualification/canonical-history-mysql.ts`，随机隔离 schema | 505 facts 的 ID/角色/parts/原文往返、回退、COMMIT ack 丢失、唯一 final、并发 pending 恢复、缓存失败重建、完整工具组保留通过 |
| MySQL/WS/crash | `tests/qualification/agent-runtime-mysql.ts`，动态端口/受控 provider | history parts/旧字符串一致，取消、deadline、思考/partial args 撤回、有效重连快照、真实子进程退出恢复通过；工具执行一次，未知 settlement 后 provider 请求 0 |
| Chromium | `pnpm --filter slide-frontend exec playwright test --config playwright.parts.config.ts` | 从真实 DB 导出的 history 样本，新旧投影显示一致、reload final 唯一、图片只显示一次、Stop 回调通过 |

真实 DB 检查开始时，旧 controlled fixture 使用未知模型默认窗口，无法容纳该测试的保护历史。在独立、未修改的 main `3bb924b` 上运行原脚本也在相同行失败；测试 fixture 现明确配置 131072 window，没有放宽生产 fallback 或安全准入。数据库测试只使用随机 schema 和临时 JSONL，结束关闭实例/删除 schema，没有修改生产会话。

Chromium 是实际浏览器渲染，但采用受控 UI fixture 和真实 DB 导出样本；没有验证部署站点上的完整登录/发送链路。真实付费供应商及其图像 token 校准尚未验证，不计为通过。父任务先前的余额不足限制仍有效。截图和更细运行证据通过 issue 附件交付；PR/CI 状态由平台条件唤醒记录。
