# Slide、ZCode、OpenClaw 流式对比：S1–S5 实施后更新

2026-10-05。本报告更新父 MAX-124 附件 `agent-streaming-comparison.md` 的 Slide 结论。原报告是源码分析和设计目标，基线为 Slide `c3195b46c81f6855bab32ee4e5b622575d7ce031`、ZCode `29628c9acdb81b703bbd4080c207a0e7ce5e276e`、OpenClaw `000cc6619c112e4c4cf0d52e456f32aacee65288`。外部两项目未重新测量或更新版本，因此不产生同模型/同硬件性能排名。HTML附件仍是交互示意，不能充当实现或性能证据。

Slide 已按推荐的渐进方案实施：工具稳定身份 → 单一 Parts 投影 → 有界增量和续传 → 局部渲染 → 真实资格验证。最终代码、PR/head/merge链、逐项验收和原始证据见 [MAX-129资格报告](MAX-129-qualification.md)。前四阶段已进入main，S5合并由父任务完成，不能将未合并候选写成已发布版本。

## 旧问题与当前行为

| 原报告结论 | 实施后行为及证据 |
| --- | --- |
| Adapter工具字段与UI消费错位，原始start最小探针0条 | S1保留执行器真实toolCallId、规范化生命周期；S5真实MySQL/WS/Gateway/reducer/renderChat得到100次执行/100卡，快/慢/并行与正文顺序各有测试。 |
| start批次预发，result等整个批次 | 在真实调度/执行/settlement点发布；scheduled/started/settled/persisted分开。未知结算显示待确认，Stop发出与确认停止分开。 |
| 累积前缀重复发送，理论1000片段50.05MB | legacy语义保持，能力协商的新端true append；同条件真实运行暂停边界：legacy正文102,075,034bytes，对parts534,563bytes，减少99.4763%。数字含思考/确认/工具预览，与原理论计算口径不同。 |
| live/history/recovery投影分散 | browser-safe shared contract + reducer；stable message/part/tool身份贯穿快照和历史。S5修复确认后的正文/工具未进入最终REST历史及结果重复卡片。 |
| chat.watch只恢复text/thinking，无完整工具 | epoch/seq/subscription完整有界snapshot(W)+suffix；工具状态/预览/计时、phase、attempt、anchor/durable一起恢复。两次浏览器导航不增加SQL计数。冷恢复只到持久边界。 |
| 长Markdown全文解析，40k后降级纯文本 | 局部缓存与稳定DOM、DOMPurify；15组20k/40k/100k样本当前parse/apply P95最大7.2/10.3ms、paint35.4ms，路径long task 0；保留140k截断边界。 |
| provider形态需要补验证 | 本地HTTP SSE+真实Anthropic/OpenAI SDK；项目Ollama的OpenAI-compatible协议；JSON片段真实ID、无reasoning、thinking先行、EOF drain、空heartbeat覆盖。未运行真实Ollama或付费模型。 |

原报告建议借鉴的稳定身份、有序parts、快照水位、语义合并和真实状态已映射到现有Slide架构。原本较强的模型events/bytes双界、WS bounded writer、anchor/intent/settlement和完成事务保留；不移植ZCode runtime，不引入OpenClaw Gateway或渠道humanDelay，不改WS为SSE，不提前执行未闭合工具JSON。

## 拟定目标与实测

| 目标 | 当前实测 | 口径 |
| --- | --- | --- |
| accepted→实际反馈≤100ms | 26.3ms | 真实live同浏览器时钟，waiting_model；不承诺模型首token。 |
| receipt→paint P95≤100ms | live32.4ms；独立100工具UI34.2ms | 两rAF保守上界，真实链路与UI输入fixture分列。 |
| 正文传输减少≥80% | 99.4763% | 同run同暂停边界的全部原连接WS帧；JSON字段bytes，非TCP/TLS抓包。 |
| parse/apply P95≤16ms，路径无>50ms long task | 15组最大7.2/10.3ms，0相关long task | Apple M5/24GiB/Chromium148；固定片段/文档语料。 |
| 100工具、重连不重复副作用 | 执行100、UI100、两次刷新后仍100 | 10×10并行批次、真实SELECT1和隔离计数表。 |

正文窗口最终40ms/8KiB，progress200ms，首个有效输出立即发，控制边界flush。缓存默认每run2000ops/1MiB、终态TTL10分钟，加全局16MiB/16000ops、64runs，均有实际SLIDE_STREAM_*配置和校验。建议值已转为代码默认值，但不代表所有部署/业务参数组合的性能承诺。

## 保留边界

单批100工具突发曾触发现有128帧writer的4009保护；最终100工具真实样本采用十批十并行，没有扩大硬界。该断开不是事务取消或业务回滚；新订阅通过快照恢复，不重执行工具。超限快照明确截断并引用授权历史；进程重启不恢复未持久token，也不自动重放unknown副作用。

故障资格包含真实MySQL完成事务失败、completion pending、子进程crash、权限审批、取消、epoch/订阅过期、gap/重复/capture竞态、缓存淘汰和慢peer；各项具体测试与门禁日志见资格报告和附件，既有skip不计通过。原报告仅设计的性能目标现在已有上述固定环境证据，不能扩展为跨机器、生产rollout、任意文档或三个产品的比较成绩。
