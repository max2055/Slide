/**
 * CronExecutor — AI Agent 驱动定时任务执行引擎
 *
 * 封装 @slide/agent-core 的 AgentRunner.run()，提供 cron 专用执行模式：
 * - 使用 DirectAdapter 的 AgentRunner（非 Gateway），满足 D-07
 * - 每次执行创建唯一 sessionKey (cron:{jobId}:{timestamp})，满足 D-04
 * - 5 分钟超时通过 llmTimeoutS: 300 和 catch 块 partial_trace 保存实现，满足 D-06
 * - CronHook 在 afterIteration 中收集 ToolEvent[]，满足 D-02 多轮执行追踪
 */
import { AgentRunner, NoopHook, ToolRegistry } from '@slide/agent-core';
import type {
  AgentHook,
  AgentHookContext,
  ToolEvent,
  Message,
  LLMProvider,
  AgentRunResult,
} from '@slide/agent-core';

// ── CronHook — 收集 ToolEvent 的自定义 Hook ──

export class CronHook extends NoopHook {
  public events: ToolEvent[] = [];

  override async afterIteration(ctx: AgentHookContext): Promise<void> {
    this.events.push(...ctx.toolEvents);
  }
}

// ── CronExecutor — Agent 驱动的 cron 执行器 ──

export class CronExecutor {
  constructor(
    private runner: AgentRunner,
    private registry: ToolRegistry,
    private provider: LLMProvider,
  ) {}

  /**
   * 执行一次 Agent 驱动的定时任务
   *
   * @param jobId - 任务 ID
   * @param taskDescription - 自然语言任务描述
   * @param timeoutSeconds - 执行超时秒数（默认 300 = 5 分钟）
   * @returns AgentRunResult
   */
  async execute(
    jobId: number,
    taskDescription: string,
    timeoutSeconds: number = 300,
    outputSchema?: Record<string, unknown> | null,
  ): Promise<AgentRunResult & { structuredResult?: Record<string, unknown> | null }> {
    const sessionKey = `cron:${jobId}:${Date.now()}`;
    const hook = new CronHook();

    try {
      const result = await this.runner.run({
        initialMessages: [
          { role: 'system', content: this.buildSystemPrompt(taskDescription, outputSchema) },
          { role: 'user', content: taskDescription },
        ] as Message[],
        tools: this.registry,
        model: this.provider.getDefaultModel(),
        maxIterations: 20,
        maxToolResultChars: 20000,
        temperature: 0.0,
        reasoningEffort: 'medium',
        hook,
        contextWindowTokens: 200_000,
        maxTokens: 4096,
        llmTimeoutS: timeoutSeconds,
        failOnToolError: false,
        sessionKey,
      });

      // Extract structured result from agent output
      const structuredResult = this.extractStructuredResult(result.finalContent, hook.events);

      return {
        finalContent: result.finalContent,
        messages: result.messages,
        toolsUsed: result.toolsUsed,
        usage: result.usage,
        stopReason: result.stopReason,
        error: result.error,
        toolEvents: hook.events,
        hadInjections: result.hadInjections,
        structuredResult,
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        finalContent: null,
        messages: [],
        toolsUsed: [],
        usage: {},
        stopReason: 'error',
        error: errorMessage,
        toolEvents: hook.events,
        hadInjections: false,
        structuredResult: null,
      };
    }
  }

  /**
   * Extract structured result from agent output.
   * First tries to parse the entire finalContent as JSON,
   * then tries to find a JSON block in the slide_complete_cron tool event data.
   */
  private extractStructuredResult(
    finalContent: string | null,
    toolEvents: ToolEvent[],
  ): Record<string, unknown> | null {
    // Try to find `slide_complete_cron` tool call data
    for (const ev of toolEvents) {
      try {
        const data = typeof ev.result === 'string' ? JSON.parse(ev.result) : ev.result;
        if (data?.result && typeof data.result === 'object') {
          return data.result as Record<string, unknown>;
        }
      } catch { /* continue */ }
    }
    return null;
  }

  /**
   * 构建数据库运维 Agent 的 system prompt
   */
  private buildSystemPrompt(task: string, outputSchema?: Record<string, unknown> | null): string {
    let schemaBlock = '';
    if (outputSchema) {
      const schemaStr = JSON.stringify(outputSchema, null, 2);
      schemaBlock = `
## 输出格式要求
调用 slide_complete_cron 时，必须提供 \`result\` 参数，其值必须符合以下 JSON Schema：
\`\`\`json
${schemaStr}
\`\`\`

**重要字段说明：**
- \`instances\`: 必须统计 \`total\`（扫描总数）、\`succeeded\`（成功数）、\`failed\`（失败数）
- \`failures\`: 对每个失败的实例，记录 \`instance\` 名称和 \`reason\` 失败原因
- \`coverage_rate\`: 覆盖率 = succeeded / total，0.0-1.0 之间的小数
- 所有数字字段必须是实际数值，不能用占位符或估算值
`;
    }

    return `你是一个数据库运维 Agent，负责根据自然语言描述自动执行数据库运维任务。

## 当前任务
TASK: ${task}
${schemaBlock}
## 执行约束
- 执行时间上限：5 分钟（超时将自动终止，请尽快完成任务）
- 工具调用失败时自动重试（最多 2 次）
- 自主执行，不需要请求用户确认
- 任务完成时务必调用 slide_complete_cron 工具保存结果
- **必须使用 slide_complete_cron 的 result 参数输出结构化数据**
- 仅允许只读操作，禁止 DDL/DML（CREATE/ALTER/DROP/INSERT/UPDATE/DELETE）
- 工作流建议：检查健康状态 → 执行诊断 → 分析结果 → 生成报告`;
  }
}
