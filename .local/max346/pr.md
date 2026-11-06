带资源边界的全局实例权限原先被 hasInstanceAccess 错误拒绝，实例列表也因仅枚举 scope 而为空。现在先验证边界，再接受全局授权；列表返回有效边界 ID 的去重排序集合。普通 scope 的 minLevel 与不受限操作门禁保留。

Closes #497

验证：定向 87 项通过，包含三类全局授权、非法 ID、空边界、普通 scope 最小等级、真实 Fastify HTTP 监听器及 get_instance_summary 实际 handler（数据库读取使用 spy）。API typecheck、security:scan 通过；完整 API 回归结果见 MAX-346 最终附件。无需数据库或模型调用验证本次纯授权判断；HTTP 测试使用构造 actor，不声明完整 JWT/MySQL 业务端到端。

Chief 负责独立复核与合并。目标 main，起点 134208f35 保留，并正常合并当前 main e39663f08；修复提交 824f8a899。PR 净变更仅访问帮助函数及直接测试两个文件。未部署。

最终本地安全回归：35文件478项通过；采集器复跑6/6通过。两轮广泛API回归因自动MySQL容器/长时间未收束而中止，不计通过，完整gate尚未完成。证据见MAX-346附件。
