# MAX-127 增量展示流与恢复

S3 基于 S2 merge `a70de824199e9d2e013e47e5d7dc815f741230e4`。新端正文 true append，旧端仍按 `text_delta.delta` 累计替换。展示恢复不发起模型请求、重执行工具或逐 token 写 MySQL。父 MAX-124 负责验收和合并。

## 协议与顺序

- auth 请求/响应协商 `capabilities: ["parts-stream-v1"]`。未协商客户端保持 legacy，同一端不同时应用两条投影。
- `chat.watch` 带 `sessionKey`、`subscriptionId`，可选 `cursor: {streamEpoch, runId, turnId, toSeq}`；`chat.unwatch` 释放该连接的订阅。
- `stream.snapshot` 带完整 `snapshot`，`stream.delta` 带 `projection`。二者都有 `stream: {version:1, streamEpoch, runId, turnId, subscriptionId, fromSeq, toSeq}`。
- streamEpoch 是展示缓存身份，独立于 attempt 与 durable。每批占一个展示序号，projection sequence 保留批末的原序号。相同 epoch 窗内游标重播 >W suffix；窗外/淘汰/刷新走完整 snapshot(W)。捕获 W、安装订阅和排队后续事件在同一同步 authority，不跨 await。
- 重复区间忽略，缺口或非法操作冻结并重新 watch；恢复只 watch，不 chat.send。Gateway 过滤旧订阅和过期 epoch；UI reducer 同步替换 parts、工具、phase、runState、attempt、anchor、durable 与水位。
- 首个正文/状态立即发送；正文后续 40ms/8KiB、progress 200ms；attempt/part 改变及 reset/tool/terminal 先 flush。终态由现有事务 owner 持久确认后发布。
- 历史读取可能晚于实时快照返回。活跃 parts stream 的投影和游标保留，不以 durable 历史抹去实时后缀；终态清理 run 与 `chatSending`，不依赖 rAF。

## 容量与配置

所有数值由 `SLIDE_STREAM_` 加下表字段的大写蛇形命名覆盖，例如 `SLIDE_STREAM_MAX_RUN_BYTES=1048576`。要求正安全整数；snapshot 至少 8192 bytes，run bytes 至少为 snapshot 两倍，全局不小于单 run，text batch 不大于 snapshot 的一半；非法配置启动时报错。

| 字段 | 默认值 | 计量 |
|---|---:|---|
| maxRunOps | 2000 | 投影 parts + 缓存 operations + pending operations |
| maxRunBytes | 1048576 | snapshot + replay log + pending batch 的 JSON bytes |
| maxRuns | 64 | 展示缓存/活跃 source 数 |
| maxGlobalOps | 16000 | 所有 run operations |
| maxGlobalBytes | 16777216 | 所有 run JSON bytes |
| maxSnapshotParts | 256 | 单快照有序 parts |
| maxSnapshotBytes | 262144 | 快照含预留 4096 bytes 的身份、恢复引用 envelope |
| maxSubscriptionsPerPeer | 8 | 单 WS 连接订阅 |
| terminalTtlMs | 600000 | 终态保留时间 |
| textWindowMs | 40 | 正文合并窗口 |
| textBatchBytes | 8192 | 正文批阈值 |
| progressWindowMs | 200 | 进度合并窗口 |

pending batch 和 capture 重入队列计入边界；重入 overflow 退最新快照。慢 peer 继续使用既有 bounded writer 并以 4009 断开，不阻塞正常 peer 的 terminal。浏览器 Gateway 水位最多 64 项、订阅最多 8 项，UI 投影最多 64 个 run。此预算约束展示缓存，不替代现有 actor/持久事实/连接准入的预算。

单快照超限保留尾部；正文按 UTF-8 边界裁剪，工具沿用 S1 的有界结果预览/状态/计时。无空间的 part 可省略，`recovery.truncated/omittedParts` 明示，并提供 `detailRef: {kind:"authorized-history", sessionKey, runId}`。这是经原权限边界读取分页历史的引用，不是绕过授权的 URL。现代 `run.snapshot` 仅携带 durable 状态元数据，不以完整存储答案绕过快照预算。

缓存淘汰后活跃 actor 可重新捕获，生成新 epoch。进程冷恢复只有 durable 历史/anchor，未持久尾部允许丢失，`recovery.cold` 及 UI 提示明确说明；unknown 副作用不自动重放。

## 实测与验收

原始字节数据见 [MAX-127-ws-metrics.json](MAX-127-ws-metrics.json)，取自 `442b777a` 真实 authenticated WS fixture，同 run 同时两端，每 provider 片段 `setImmediate`，1000 片段/100000 bytes。正文计量为 JSON 的 delta/partText/finalContent/thinkingContent/text/content 字段编码字节，包含快照、持久确认及工具预览；WS 总量加每帧保守 14 bytes，元数据为差值。帧数因 timer 调度在 37–40 间变化。

| 模式 | WS 总 bytes | 正文 bytes | 元数据/帧 bytes | 帧 |
|---|---:|---:|---:|---:|
| legacy | 101614752 | 101163618 | 451134 | 1019 |
| parts | 560546 | 528824 | 31722 | 40 |

正文下降 **99.48%**（要求 ≥80%）；authority 独立 500/1000/2000 片段正文为 50000/100000/200000 bytes，精确线性。样本缓存 659008 bytes/45 ops，pending 0，3 subscriptions。

| 验收 | 证据 | 结果 |
|---|---|---|
| 旧新兼容、首发和 flush 屏障、线性载荷 | display-stream.test.ts、display-stream-ws.test.ts | 通过 |
| 真 WS 断开/刷新、重复/缺口、旧订阅/epoch、缓存淘汰、capture 竞态 | 同上；真实 Gateway 故障注入；工具 counter 不增加 | 通过 |
| 完整有序 parts/工具状态与计时/phase/attempt/anchor/durable | Core/API 快照断言、tool-stream.spec.ts | 通过 |
| 多订阅、慢端隔离、长结果、各容量、rAF 停滞 reset/terminal | 真实 socket 阻塞 send callback、2MB stored result、浏览器 fixture | 通过 |
| crash durable 恢复及 unknown 副作用不重放 | mysql qualification 真实子进程崩溃；工具执行 1 次、重启后 provider 请求 0 次 | 通过 |
| Stop、历史读取/快照竞态、刷新后唯一安全 final | chat-history.test.ts、direct-gateway.test.ts；真实 managed MySQL+WS+Chromium | 通过 |

## 验证命令与环境

环境 macOS、仓库 `.nvmrc` 对应 Node、pnpm 11.19.0，离线 frozen-lockfile 安装。MySQL 8.4 使用唯一命名临时 Docker 容器/独立测试库及端口，fixture provider 不调用付费业务模型；容器和服务验收后清理。后续只改前端的修复复用未变化 Core/API/sandbox 证据。

| 命令/门禁 | 实际结果 |
|---|---|
| `pnpm --filter agent-core test` | 33 文件 / 674 项通过 |
| `pnpm --filter slide-api test` | 322 文件通过、28 跳过；3037 项通过、251 跳过 |
| `pnpm --filter slide-frontend test` | 最终 85 文件 / 589 项通过 |
| `pnpm --filter slide-sandbox-controller test` | 22 项通过、4 跳过 |
| 四模块 `typecheck` | 通过；前端最终重新验证 |
| `pnpm --filter slide-frontend exec playwright test --config playwright.audit.config.ts` | 集成候选 59 项通过；前端终态修复后受影响 tool-stream 3 项再次通过 |
| managed `playwright test agent-runtime.spec.ts agent-cancellation.spec.ts --workers=1` | 最终真实 MySQL/WS/Chromium 5 项通过（含 Stop） |
| `bash scripts/qualification/run-agent-runtime.sh --mode mysql` | durable 完成/length/reject/deadline/cancel、completion pending、崩溃事务回滚/恢复、unknown 不重放通过；approval 14 项通过 |
| `bash scripts/qualification/run-agent-runtime.sh --mode deterministic` | 210 normal、0 falseRejects、0 misses；并行负载 detector p95 约30.48ms，此指标不是 S4 渲染延迟 |
| build/CSP、lint、contracts:check、qualification:matrix、security:scan、security:audit | 通过；lint 0 errors/262 既有 warnings；matrix 37/37；已有 bundle warnings |
| `git diff --check` | 通过 |

初次 workspace gate 发现 malformed delta 测试期望与冻结策略不一致，已修正并重跑 Core/API 完整门禁。真实取消最初暴露历史竞态与 sending 标志遗漏，已修复且保持原端到端断言，未 skip 或放宽。完整集成结果与最终受影响重验分开记录；CI 必须核验 PR 当前精确 head 的全部八项 SUCCESS，不能以本地证据代替。

## 回滚与交接

设置 `SLIDE_PARTS_STREAM_ENABLED=false` 后重启 API，新连接协商回 legacy；可用旧客户端不请求 capability。现有 durable 事务、事实、intent/settlement、权限与 provider 抽象保留，未新增逐 token 数据库写入或执行重播。

硬预算未设定。实际 raw input/cached input/output、费用遥测不可用，不把平台 active 的零值解释为零消耗，也不以内部计数冒充实测。子代理 0、最大代理深度 0、代理并发 1。CI continuous rule `01a10a15-d46b-7527-92e9-78ce5ecc623f`，有效至 2026-10-12T03:22:45.224187Z。交付后 in_review，由父任务合并，不自行 done/启动后继。
