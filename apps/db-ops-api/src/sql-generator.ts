/**
 * AI SQL 生成服务 (D-10)
 * 调用系统配置的 LLM 根据自然语言描述生成采集 SQL
 *
 * Phase 106: 指标采集可配置化
 */
import { llmService, ChatMessage } from './llm-service.js';

/**
 * 生成采集 SQL
 * @param dbType 数据库类型: mysql | postgresql | oracle | dameng
 * @param description 自然语言描述，如"获取当前活跃连接数"
 * @param instanceId 可选的实例 ID（预留，当前未使用）
 * @returns 生成的 SQL 字符串或错误信息
 */
export async function generateCollectionSql(
  dbType: string,
  description: string,
  instanceId?: number
): Promise<{ sql?: string; error?: string }> {
  if (!description || !description.trim()) {
    return { error: '请提供指标描述' };
  }

  try {
    const dbTypeName = (
      { mysql: 'MySQL', postgresql: 'PostgreSQL', oracle: 'Oracle', dameng: '达梦' } as Record<string, string>
    )[dbType] || dbType;

    const systemPrompt = `你是一个数据库运维专家。请根据用户描述，生成一条 ${dbTypeName} 的监控指标采集 SQL。

要求：
1. 仅 SELECT 查询
2. 返回单行单列的标量值（数字）
3. 不要包含 DDL/DML
4. 如果是 deltas/rates，优先使用秒级计算
5. 查询性能优先，避免全表扫描
6. 用中文回复，但 SQL 本身用标准语法

SQL 示例：
- MySQL: SELECT COUNT(*) as val FROM information_schema.PROCESSLIST
- PostgreSQL: SELECT count(*) as val FROM pg_stat_activity WHERE state = 'active'
- Oracle: SELECT COUNT(*) as val FROM V$SESSION WHERE STATUS = 'ACTIVE'
- Dameng: SELECT COUNT(*) as val FROM V$SESSIONS WHERE STATE = 'ACTIVE'

只返回 SQL，不要加解释。`;

    const userPrompt = `数据库类型: ${dbTypeName}\n描述: ${description}\n\n生成采集 SQL:`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const response = await llmService.chat(messages);

    if (!response.success || !response.content) {
      return { error: response.error || 'AI SQL 生成失败' };
    }

    const rawSql = extractSqlFromResponse(response.content);
    if (!rawSql) {
      return { error: 'AI 未能生成有效的 SQL，请重试或手动编写' };
    }

    // 验证 AI 生成的 SQL 是否为安全的 SELECT-only 查询
    const { validateSqlIsSelectOnly } = await import('./sql-validator.js');
    const validation = validateSqlIsSelectOnly(rawSql);
    if (!validation.valid) {
      return { error: `AI 生成的 SQL 无效: ${validation.error}，请手动编写` };
    }

    return { sql: rawSql };
  } catch (e: any) {
    return { error: `AI SQL 生成失败: ${e.message}` };
  }
}

/**
 * 从 LLM 响应中提取 SQL 语句
 * 处理 markdown 代码块等情况
 */
export function extractSqlFromResponse(response: string): string | null {
  if (!response || !response.trim()) return null;

  // Strip markdown code blocks if present
  const codeBlockMatch = response.match(/```(?:sql)?\s*([\s\S]*?)```/);
  const sql = codeBlockMatch ? codeBlockMatch[1].trim() : response.trim();
  return sql || null;
}
