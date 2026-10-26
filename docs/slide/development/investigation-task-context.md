# 调查任务的上下文分配

隔离 API/Worker 可通过 `INVESTIGATION_CONTEXT_WINDOW_TOKENS` 和
`INVESTIGATION_OUTPUT_TOKENS` 设置调查上下文窗口及单次输出上限。
`INVESTIGATION_SUMMARY_OUTPUT_TOKENS` 独立设置压缩摘要输出上限，新执行默认
10,240，不受普通回答的 4,096/8,192 上限截断；显式较小摘要配置仍生效。
这些服务端环境配置不接受客户端或模型参数，不修改 Provider 全局配置。
未配置时保留 16,000 窗口和现有 Provider 输出限制；显式配置必须在当前模型的
已知 capability 范围内，并为输出之外保留 1,024 token 余量，否则发送前拒绝。

例如，经核实支持该容量的模型可在任务专用 API/Worker 使用窗口 32,768、
输出 4,096。`INVESTIGATION_MAX_TOKENS` 是独立的累计调用预算，必须足以
承担每次窗口预留及此前消耗，不能用窗口配置代替累计预算。

执行器在首次发送前把实际分配存入 `investigationExecution.runtimeContext`。
恢复时使用原分配，并按当前 Provider 能力重新校验；改变环境默认值不会扩大
在途调查的窗口。canonical、工具配对、实时权限、压缩状态、unknown 保留和
最终请求准入均继续生效。能力声明和本地回归不替代真实业务验收。

摘要分配也在发送前持久化。旧持久记录缺少摘要字段时恢复原有
`min(2048, 普通输出)` 分配；已有 2,048 截断的 partial 不重放或回填。
压缩时分别验证摘要请求的模型能力、输入 + 完整摘要输出 + 1,024 余量、
累计窗口预留及实际完整摘要回填后的普通请求。大于 4,096 的摘要需要可信
Provider capability 明确给出最大输出；未知能力或窗口不足时发前拒绝，
不静默调低分配。10,240 是上限，不能保证任何摘要均完成，也不增加累计预算。
未显式配置摘要额度的其他 Runtime（聊天等）不继承该调查额度，保留
`min(2048, 普通输出, 已核实最大输出)` 的兼容默认；显式额度超过已核实
模型最大输出时在 Runtime 启动、发出任何普通或摘要请求之前以明确错误拒绝，
即使本次运行不会触发压缩；压缩边界保留同一校验，冻结额度不静默改写。

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

## 部署映射与版本管理

`INVESTIGATION_*` 只写进 `.env` 不会进入容器：`compose.production.yaml` 默认不转发这些变量。
需要调整时，使用版本库中的 `deploy/compose.investigation.example.yaml` 叠加部署：

```bash
docker compose -p <project> --env-file <protected-env> \
  -f compose.production.yaml -f deploy/compose.investigation.yaml up -d api
```

- 未配置相应变量时就删掉整行；空字符串会被拒绝（`INVESTIGATION_CONTEXT_CONFIGURATION`）。
- 示例值来自一次验收样本，不是已证明的最小值；窗口/输出必须落在 Provider 已声明能力内，
  并保证窗口预留不超过累计预算（`INVESTIGATION_MAX_TOKENS`），否则会以 `TOKEN_BUDGET` 失败。
- 压缩摘要的输出上限不得超过 Provider 的最大输出；过小会导致摘要被 `finishReason=length` 截断。
- 密钥、TLS 私钥、数据库口令保存在受保护的持久位置，不进入仓库或示例文件。
- 验收应从空容器重建：核实际生效的配置、Provider 可用性，并跑一次代表性调查。
