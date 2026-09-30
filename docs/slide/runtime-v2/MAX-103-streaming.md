# MAX-103：有界有序 Streaming 消费

## 执行契约与基线

范围版本 v1：按 MAX-103 正文实现模型 reader/消费者解耦、events/bytes 双上限、事件顺序与 drain、消费者错误/取消、每客户端 WS 高水位及回归测量。排除 durable anchor/recovery epoch（MAX-104）、Message Parts、provider decoder 重写、逐 token MySQL 持久化和无关架构优化。停止条件为局部及受影响模块门禁通过、提交独立 PR；CI 尚未完成时登记条件唤醒，合并前核验当前 head 的全部门禁。

复核基线为 `6c22d2a51d7bf17ec3cd36526032671b104849dd`；实际实施 main 为 `6b6116f`，MAX-100/98/99/101/102 已合并。复用这些阶段的 canonical history、权限与预算行为。实现前核对了当前 OpenAIProvider、ModelStep、DirectAdapter 及完成事务；当前 `ws.send` 不等待浏览器消费，没有慢 UI 阻塞 SSE 的证据。

硬预算未设定。未使用子代理：数量 0、最大深度 0、代理并发峰值 1（主线程）。模型 raw input/cached input/output 与费用遥测不可用；不以内部上下文/估算替代实际计量。

## 消费契约

Provider 必须顺序 await delta callback；它返回表示事件已被有界接纳，不表示 UI 消费完成。`ModelStep` 在 provider EOF 后 drain，完成后才允许 reasoning end、tool start、候选撤回、工具执行和终态。EOF 后清除 reader idle timer，request deadline 与 consumer deadline 继续覆盖 drain。请求失败/Stop/超时会停止队列、通知等待 admission 的 reader、撤销 writer signal；reader 原始 Promise 继续由既有 `onProviderRequest` 生命周期观察器追踪。

`AgentHook.onStream`/`emitReasoning` 和 `ChatEventConsumer` 可以同步或返回 Promise，新增可选 AbortSignal。异步实现必须响应 signal，以结束自己的网络/文件等外部工作。内部 pump、等待者与 timer 在失败后退出，迟到的 reader callback 不再启动消费者；对忽略 signal 的任意第三方 Promise，JS 无法物理终止它，race 会继续观察其 rejection，但不保证其外部副作用已停止。

默认上限和计数口径：

| 层 | events | bytes | deadline / 策略 |
| --- | ---: | ---: | --- |
| 模型 coordinator | 64 | 262144 | 每次 writer 30000ms；高水位暂停 reader |
| ChatEvent 消费 | 64 | 1048576 | 每回调 30000ms；超量并发/单个超大快照明确失败 |
| 每个 WS 客户端 | 128 | 1048576 | 高水位关闭 4009；1000ms 内未关闭则 terminate |

可通过 `AgentRunSpec.streamingLimits`、`DirectAdapterOptions.streamingLimits` 与 `socketWriteLimits` 配置。模型 bytes = 解码 delta 的 UTF-8 bytes + 每事件 32 bytes 的记账开销；ChatEvent bytes = JSON 快照 UTF-8 bytes；WS bytes = `max(in-flight send bytes, bufferedAmount) + 新帧 bytes`，帧头保守计入 14 bytes。这些是逻辑 payload 上限，包含正在写的事件；不是 JS heap 或内核 TCP 缓冲的精确上限。

只合并相邻、尚未开始消费的原始 text delta，语义为顺序拼接。活跃事件不可修改；reasoning、tool argument marker 阻止跨边界合并；控制和 terminal 不合并。OpenAI SDK 的解码/think/tool arguments 累积实现保留，只补齐 tool delta 的 await 通知。DirectAdapter 的 `text_delta.delta` 继续是累计替换文本，候选撤回的空字符串仍是明确替换，不作追加。并行工具 progress 的 callback 消费也按调用顺序串行完成，不生成无界 Promise 链。

`sequence` 为这次 chat delivery 的递增序号，`attempt` 为普通模型请求次序。均为可选增量字段，不替代 `messageSequence`，不宣称可作为 durable cursor 或跨进程 epoch；旧客户端仍读原字段。真实候选回归确认顺序与重试 attempt 为 `[1, 1, 2]`。

## 失败、WS 恢复与持久化

消费者失败在 Runtime 中保留 `STREAM_CONSUMER_FAILED`，超时为 `STREAM_CONSUMER_TIMEOUT`；事件超限、非法配置、并发违反 producer 契约分别有明确错误码。失败、blocked admission 和晚到 rejection 都被观察，不出现 unhandled rejection。terminal callback 失败向调用者传播，只尝试一次 terminal。

控制回调内部触发 Stop 时保留 checkpoint 的累计预算/usage 和 terminal marker；同步撤回后 Stop 仍正常返回 cancelled。存储故障与 Stop 同时发生时，存储故障继续传播，不能被转换成成功取消。required drain 结束后仍复用既有 completion pending/唯一完成事务，未改变 MySQL 写入粒度；WS complete 仅在完成事务确认后广播。

WS send callback 表示本地发送完成，**不是浏览器消费 ACK**。没有把一个慢客户端的 drain 引入共享 provider reader。每个客户端独立计数，正常客户端继续发送；超限客户端记录脱敏 `WS_SLOW_CONSUMER` 并关闭，send 错误记录 `WS_WRITE_FAILED` 并终止该连接。重连使用已有授权 `chat.watch`/`run.snapshot`/幂等 replay 和 REST `/api/chat/history`，不自动重跑工具。超过单帧上限的 history/snapshot 也不会进入发送缓冲；较大历史可走现有 REST 历史分页。关闭时不取消服务器正在完成的 durable run；精确恢复锚点由 MAX-104 继续实现。

## 实测

复现：`pnpm --filter slide-api exec tsx ../../tests/qualification/streaming.ts`。完整原始指标见 `MAX-103-streaming-metrics.json`（含实现 source SHA256）。Node v24.18.0 / Apple M5，1000 个固定 delta，约 1ms 的受控 hook，每 10 个事件插入 reasoning 边界；队列设 32 events / 4096 bytes。单次样本，无生产吞吐或显著性承诺。

| 方式 | reader ms | 全部完成 ms | events/s | first token ms | drain ms | peak events / bytes | heap 增量 bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 直接 await | 1269.10 | 1269.11 | 787.96 | 1.35 | 0.00 | 1 / 100 | 704784 |
| 队列、不合并 | 1267.53 | 1308.96 | 763.97 | 3.97 | 41.42 | 32 / 3200 | 918344 |
| 队列、text 合并 | 245.98 | 259.26 | 3857.17 | 1.30 | 13.27 | 12 / 4092 | 270816 |

不合并时没有整体吞吐增益；队列给 reader 提供有界前进空间。合并样本将消费调用从 1000 降为 200，完整输出字节顺序相同。heap 是同一进程的采样峰值减起点，受 GC/既有分配影响，不是隔离 retained-heap 证明。真实 loopback WS 1000 帧：旧 send reader 14.16ms，新 send 11.02ms，两者 bufferedAmount 峰值均为 0；差异仅作开销/噪声观测，不据此宣称 SSE 加速。

## 验收证据

- `streaming-coordinator.test.ts`：独立达到 events/UTF-8 bytes 高水位，active write 计入上限；相邻 text 合并及 reasoning/tool/control/terminal 边界；reader 在慢 hook 结束前前进；正常终点 drain；oversized event、writer rejection、Stop、idle/request/consumer timeout，合作式 writer 数量归零。
- 同文件的真实 HTTP SSE + OpenAI SDK 测试：原始 provider request 在慢 writer 放行前完成，模型边界仍等待 drain；reasoning/text/tool arguments 的内容与顺序正确。
- `bounded-socket-writer.test.ts`：真实 paused TCP peer flood 到高水位并被断开；第二个 peer 收到连续 sequence 和 terminal；任意时刻观测 bufferedAmount 不越界。另有 events、UTF-8/frame bytes、异步 send rejection 注入。
- `chat-event-consumer.test.ts`、`candidate-final.test.ts`、`direct-adapter.test.ts`：异步回调排序、progress 并发上限、唯一 terminal、撤回/Stop/持久化失败互相竞争及精确错误回归。
- Core 全量 593 项；后端最终全量 2769 项、129 项环境条件跳过；core/backend typecheck 通过。前端 direct-gateway/init 71 项通过。contracts check、qualification matrix 37/37、lint（0 errors，263 个仓库 warning）通过。
- `run-agent-runtime.sh --mode deterministic`：候选恢复、限长、provider reset、认证错误及 210 个正常样本通过；0 个误撤回，正常样本未新增请求。沿用已有 gate，不扩大上线范围。
- 独立临时 MySQL 8.4 + 真实 WS：recovery/length/reject/deadline/cancel、storage pending + restart/concurrent replay、OS process exit-before-COMMIT、unique final 全通过；审批事务 14 项通过。额外 `canonical-history-mysql.ts` 验证 505 facts、stable IDs、COMMIT ACK 丢失、JSONL 写入失败后的 DB 重建和隔离/retention 回归。

本次没有运行真实付费 LLM 或生产浏览器慢渲染验收；provider 证据来自本地真实 SDK/SSE 和受控 provider，slow client 证据来自真实 TCP pause。CI 的浏览器/发布门禁由 PR 运行并在合并前核验，不能把本地上述结果当作 CI 已通过。
