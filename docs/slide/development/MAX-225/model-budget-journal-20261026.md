# MAX-225 模型预算逐次审计 journal（2026-10-26）

本文件把第三轮真实模型验收的累计预算记录按现有产物恢复为可审计证据。**本轮没有新增任何模型发送，也没有改写父单账本**；所有数字来自父单 `model_test_budget_ledger` revision 53、该轮运行 `01a17588-67d4-77f0-aa5b-e5a69ae5c892` 的执行消息，以及仍保留的最终成功证据文件。机器可读版本见同目录 `model-budget-journal-20261026.json`。

## 结论

- 父账本累计 `settled`：input **40,976**（其中 cached **24,320**，只计一次）+ output **16,502** = **57,478 / 10,000,000**；无未结算预留；1 条 `MODEL_TRANSPORT_UNKNOWN` 保留 **15,367**，未重放。
- 这 57,478 由 **19 次有响应的发送**（16 次此前尝试 + 最终成功 3 次）加 **1 次未知发送**构成。
- **最终 3 次发送有完整逐次记录**（reservation id、请求哈希、请求字节、输入上界、输出上限、预留、回读、Provider requestID、实测 usage、结算）。
- **此前 16 次响应只有部分可恢复**：账本压缩后只留总量；现有产物中还能恢复 5 个 reservation id、2 个 Provider requestID 和若干“每次尝试”的用量聚合，其余逐次字段已不可恢复。本文件逐项标明 missing，不猜测、不补造。
- 因此此前 `verification.md` 中“全部模型请求均可追溯 requestID”的说法不准确；只有最终 3 次可追溯 Provider requestID，已更正。

## 来源与恢复方式

| 项 | 值 |
|---|---|
| 发送所在运行 | `01a17588-67d4-77f0-aa5b-e5a69ae5c892` |
| 恢复命令 | `multica issue run-messages 01a17588-67d4-77f0-aa5b-e5a69ae5c892 --output json` |
| 账本 | 父单 `01a173c9-449e-72ed-8301-9b7a6c19647b` / `model_test_budget_ledger` revision 53（只读） |
| 最终成功证据 | `docs/slide/development/MAX-225/vm-acceptance-model-20261026.json` |
| 本轮发送/账本写入 | 0 / 0 |

## 对账

| 检查 | 结果 |
|---|---|
| input 40,976 = 此前 33,775 + 最终 7,201 | ✓ |
| output 16,502 = 此前 12,412 + 最终 4,090 | ✓ |
| cached 24,320 = 此前 19,584 + 最终 4,736 | ✓ |
| total 57,478 = 46,187 + 11,291 | ✓ |
| 八次尝试聚合 4,632 + 7,138 + 1,847 + 4,848 + 5,173 + 1,923 + 4,500 + 16,126 = 46,187 | ✓ |
| 最终三次 1,831 + 3,079 + 6,381 = 11,291 | ✓ |
| 未知发送 | 15,367 保留，未计入 settled，未重放 |

## 最终成功运行（N，00:32:36–00:34:11）

告警/调查请求 `d61aaef6-3ef2-47b8-a6eb-9adefebdb35d`，investigation `d554fd8c-afbc-497f-bc28-2a6df97c98c3`，agent run `074ae36f-9b6d-4a3a-8be3-315314d965d4`；运行参数 `contextWindowTokens=60000`、`summaryMaxTokens=2048`、`maxTokens=4096`。

| # | reservation | 请求哈希 | 字节 | 输入上界 | 输出上限 | 预留 | 回读 | HTTP | Provider requestID | input/cached/output | 结算 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `6941da82-0b58-4e8b-b887-aa59d4f98e6f` | `bf5a2cf9…f37c2` | 6912 | 7936 | 4096 | 12032 | 是 | 200 | `adf36a41-df6b-4335-874b-3d4207123f3f` | 1604 / 1152 / 227 | settled |
| 2 | `7045a0c0-4cc1-4dd8-820d-c0a7f96534ab` | `ab734828…73a32` | 10207 | 11231 | 4096 | 15327 | 是 | 200 | `1048f419-21a0-42b8-a4f4-e670d0e49c94` | 2395 / 1280 / 684 | settled |
| 3 | `6ab1962a-fd6a-4d69-9fcd-1412197de763` | `d5a19afa…c10a` | 13587 | 14611 | 4096 | 18707 | 是 | 200 | `ab993020-3fcc-4417-a89c-0e8f25928876` | 3202 / 2304 / 3179 | settled |

合计 7,201 + 4,090 = 11,291；产品侧 `investigation_budget_ledger` 同为 settled / 11,291。

## 此前 16 次响应（按尝试）

| 尝试 | 时间（UTC） | 结果 | 有响应发送 | settled | 可恢复程度 |
|---|---|---|---|---|---|
| E | 00:18:05–00:18:42 | MODEL_RUN_NOT_COMPLETED | 2（算术推导） | 4,632（算术） | 无逐次字段 |
| F | 00:18:53–00:19:51 | 本次准入/恢复通过，run completed | 2 | input 3,999 / cached 2,432 / output 3,139 = 7,138 | **2 次发送的 requestID、字节、上界、预留、HTTP、finishReason 可恢复**；逐次 usage 只剩尝试聚合 |
| G | 00:20:54–00:21:38 | partial / INVESTIGATION_PROVIDER_UNKNOWN | 1 结算 + 1 未知 | 1,847（算术） | 无逐次字段；未知记录完整 |
| H | 00:24:02–00:24:22 | 工具预检无真实观测 | 0 | 0 | — |
| I | 00:24:39–00:25:21 | partial / CONTEXT_UNRECOVERABLE | 2 | 4,043 / 2,432 / 805 = 4,848 | 仅尝试聚合 |
| J | 00:26:21–00:27:04 | partial / CONTEXT_UNRECOVERABLE | 2 | 4,108 / 2,432 / 1,065 = 5,173 | 仅尝试聚合 |
| K | 00:27:23–00:27:56 | partial / PROVIDER_TRANSIENT | 1 | 1,604 / 1,152 / 319 = 1,923 | 仅尝试聚合 |
| L | 00:29:12–00:29:55 | partial / CONTEXT_GOVERNANCE_ERROR | 2 | 3,904 / 2,432 / 596 = 4,500 | 仅尝试聚合 |
| M | 00:30:17–00:31:51 | partial / transport Connection error | 4（算术推导） | 16,126（算术） | 无逐次字段 |

（A–D 四次尝试在采集/鉴权/预检阶段结束，发送数为 0，未计入 16。）

### F 的两次发送（可恢复的逐次片段）

| # | Provider requestID | 字节 | 输入上界 | 输出上限 | 预留 | HTTP | finishReason | 逐次 usage |
|---|---|---|---|---|---|---|---|---|
| 1 | `e411a2c0-40a3-4570-b1bc-8a5c8328e56a` | 6912 | 7936 | 4096 | 12032 | 200 | tool_calls | 不可恢复 |
| 2 | `e0500b4e-f5dd-416e-a3ac-eff8c1c68b2e` | 10167 | 11191 | 4096 | 15287 | 200 | stop | 不可恢复 |

尝试聚合 3,999 / 2,432 / 3,139 = 7,138，与产品账本 `charged_tokens=7138` 一致。

### 仅存 reservation id 的 5 次发送

revision 20 的 5 条结算事件在压缩前被记录下来的 reservation id：

`be817ee2-2636-45d3-acfc-fd82f63c5f66`、`5fa9f1ea-a251-446c-826c-a93879526208`、`01381824-8733-4a6a-9156-42c2cee5d2d9`、`d12f3473-88a0-4b9f-b238-65577d46296d`、`1df4d5c9-062e-4fe2-bcdb-560cb12e506c`

它们对应尝试 E、F、G。其 scenario、输入/缓存/输出和 Provider requestID 在捕获时已被截断，revision 53 账本中也不再保留，无法映射，未做推断。

## 未知发送（1 条）

| 字段 | 值 |
|---|---|
| reservation id | `a37ad0e6-f9f4-485f-90d4-3dfbf9242571` |
| scenario | `investigation-send-2` |
| 预留时间 | 2026-10-26T00:21:24.501Z |
| 输入上界 / 输出上限 | 11,271 / 4,096 |
| 预留 | 15,367 |
| 传输状态 | 无 HTTP 状态、无 Provider requestID、无 usage；OpenAI SDK 报 `Connection error`，`maxRetries=0`、redirect=error |
| 关联运行 | `24769bf9-7a15-49d3-9c77-c6b52583581d`（partial / INVESTIGATION_PROVIDER_UNKNOWN） |
| 结算 | unknown，保留全额预留，未释放 |

**未重放依据**：发送包装器在传输错误时置 `stop=true`、结算为 unknown 后抛出，进程内不再发送；该 reservation 在 revision 17 起只出现一次，之后一直留在 `unknown_requests`；后续尝试 I–N 均为新的告警/调查请求与新的预留，最终成功作业使用 `d61aaef6-…` 并只结算自己的 3 条预留；revision 53 的 `reservations` 为空。限制：没有 Provider 侧请求日志，因此不能独立证明 Provider 未执行；可证明的是账本和进程层面的“未重试、未重放、全额保留”。

## 明确缺失

- E、G、M 的逐次 reservation id、请求哈希、请求上界、Provider requestID 和 input/output 拆分不可恢复；E、G、M 只有精确的总量（4,632 / 1,847 / 16,126）。
- I、J、K、L 只有每次尝试的用量聚合，逐次哈希、reservation id、Provider requestID 已随被覆盖的尝试证据文件丢失。
- E–M 的告警/调查请求 ID 未保留。
- 5 个已恢复的 reservation id 无法映射到 usage 或 Provider requestID。
- 父账本 note 中“per-request detail in MAX-225 evidence”对 16 次此前响应不成立；本 journal 更正该说法。按本轮授权未改写父账本。

以上缺失不改变累计总量、预留和 unknown 记录；按策略继续暂停补发模型请求，不为了补齐明细重跑。
