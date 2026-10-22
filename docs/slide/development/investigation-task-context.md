# 调查任务的上下文分配

隔离 API/Worker 可通过 `INVESTIGATION_CONTEXT_WINDOW_TOKENS` 和
`INVESTIGATION_OUTPUT_TOKENS` 设置调查上下文窗口及单次输出上限。
这两个服务端环境配置不接受客户端或模型参数，不修改 Provider 全局配置。
未配置时保留 16,000 窗口和现有 Provider 输出限制；显式配置必须在当前模型的
已知 capability 范围内，并为输出之外保留 1,024 token 余量，否则发送前拒绝。

例如，经核实支持该容量的模型可在任务专用 API/Worker 使用窗口 32,768、
输出 4,096。`INVESTIGATION_MAX_TOKENS` 是独立的累计调用预算，必须足以
承担每次窗口预留及此前消耗，不能用窗口配置代替累计预算。

执行器在首次发送前把实际分配存入 `investigationExecution.runtimeContext`。
恢复时使用原分配，并按当前 Provider 能力重新校验；改变环境默认值不会扩大
在途调查的窗口。canonical、工具配对、实时权限、压缩状态、unknown 保留和
最终请求准入均继续生效。能力声明和本地回归不替代真实业务验收。

Ops 完整回答使用受限 JSON 分析格式，服务端只将当前执行的有效工具证据
引用转换为 evidence ID。模型判断始终标为 inference，假设始终标为 unknown；
模型不能设置根因、人类确认或恢复状态。partial、格式不合规或引用无法绑定时，
只保存检查回执，不生成结构化判断。历史 partial 不会因此重新生成或重放。
当前完整输出提示比历史提示更长；16k 对完整 r4 历史可能提前触发
`CONTEXT_UNRECOVERABLE`，32k 的本地连续读取回归包含当前完整提示。

工具预算拒绝整个已返回批次时，Runtime 持久化 rejected_tool_batch，明确
该批次未执行。执行器据此确认收到响应并结算已知用量；真正 sent 未知、
未返回工具和缺失用量继续保留 unknown，不允许自动重放。

普通发送附带当前剩余工具/Provider 额度的临时运行提示。工具额度为零时，
仅本次请求不提供工具定义，让模型依据已有证据回答；原执行、用量、工具及
最终上下文门禁保持有效。若 Provider 仍请求工具，原工具预算拒绝执行。
