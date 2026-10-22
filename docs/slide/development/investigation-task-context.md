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
