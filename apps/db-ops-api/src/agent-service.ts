/**
 * DB-Ops AI Agent Service
 *
 * Trimmed for Phase 108: only getAgentGreeting() and AGENT_GREETING remain.
 * All tool definitions, intent classification, and agent request handling
 * have been removed (migrated to adapter layer and tools/catalog.ts).
 */

export const AGENT_GREETING = `你好，我是数据库运维助理，可以帮你完成以下操作：

- 查看数据库实例的运行状态和健康评分
- 查看当前活跃告警及详细信息
- 分析慢查询 SQL 并提供优化建议
- 诊断数据库故障并分析根因
- 分析数据库性能瓶颈
- 预测容量使用趋势

请描述你需要帮助的问题，我会调用相应的工具来协助你。`;

/**
 * getAgentGreeting — 获取问候语
 */
export function getAgentGreeting(): string {
  return AGENT_GREETING;
}
