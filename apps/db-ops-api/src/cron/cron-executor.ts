/**
 * CronExecutor — AI Agent 驱动定时任务执行引擎
 *
 * 封装 @slide/agent-core 的 AgentRunner.run()，提供 cron 专用执行模式：
 * - 使用 DirectAdapter 的 AgentRunner（非 Gateway），满足 D-07
 * - 每次执行创建唯一 sessionKey (cron:{jobId}:{timestamp})，满足 D-04
 * - 超时取消并返回 partial trace；executionSettled 标记底层请求与工具实际收敛
 * - CronHook 在 afterIteration 中收集 ToolEvent[]，满足 D-02 多轮执行追踪
 */
import { AgentRunner, NoopHook, ToolRegistry } from '@slide/agent-core';
import type {
  AgentHookContext,
  ToolEvent,
  Message,
  LLMProvider,
  AgentRunResult,
} from '@slide/agent-core';
import { loadAgentRuntimeLimits } from '../security/agent-runtime-limits.js';

// ── CronHook — 收集 ToolEvent 的自定义 Hook ──

export class CronHook extends NoopHook {
  public events: ToolEvent[] = [];

  override async afterIteration(ctx: AgentHookContext): Promise<void> {
    this.events.push(...ctx.toolEvents);
  }
}

// ── CronExecutor — Agent 驱动的 cron 执行器 ──

export type CronExecutionResult = AgentRunResult & {
  structuredResult?: Record<string, unknown> | null;
  /** Always resolves, only after the runner AND actual provider requests settle. */
  executionSettled: Promise<void>;
  cancellationPending: boolean;
};

export class CronExecutor {
  private readonly runtimeLimits = loadAgentRuntimeLimits();
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
  ): Promise<CronExecutionResult> {
    const sessionKey = `cron:${jobId}:${Date.now()}`;
    const hook = new CronHook();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let pendingOperations = 0;
    let runSettled = false;
    let resolveSettled!: () => void;
    const executionSettled = new Promise<void>(resolve => { resolveSettled = resolve; });
    const maybeSettled = () => {
      if (runSettled && pendingOperations === 0) resolveSettled();
    };
    const timeoutError = new Error(`Cron 任务执行超时（${timeoutSeconds}s）；已请求取消，未收敛操作结果不确定`);

    try {
      // Start the deadline before the runner, including its internal provider deadline.
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(timeoutError);
          controller.abort(timeoutError);
        }, timeoutSeconds * 1000);
      });
      const runPromise = Promise.resolve().then(() => this.runner.run({
        initialMessages: [
          { role: 'system', content: this.buildSystemPrompt(taskDescription, outputSchema) },
          { role: 'user', content: taskDescription },
        ] as Message[],
        tools: this.registry,
        model: this.provider.getDefaultModel(),
        maxIterations: Math.min(this.runtimeLimits.maxIterations, 40),
        maxToolResultChars: this.runtimeLimits.maxToolResultChars,
        temperature: 0.0,
        reasoningEffort: 'medium',
        hook,
        contextWindowTokens: 200_000,
        maxTokens: 4096,
        llmTimeoutS: timeoutSeconds,
        failOnToolError: false,
        sessionKey,
        signal: controller.signal,
        onProviderRequest: request => {
          pendingOperations++;
          const finish = () => { pendingOperations--; maybeSettled(); };
          request.then(finish, finish);
        },
      }));
      const finishRun = () => { runSettled = true; maybeSettled(); };
      runPromise.then(finishRun, finishRun);

      const result = await Promise.race([runPromise, timeoutPromise]);
      if (timedOut) throw timeoutError;

      // Extract structured result from agent output
      const structuredResult = this.extractStructuredResult(result.finalContent, hook.events);

      return {
        finalContent: result.finalContent,
        messages: result.messages,
        toolsUsed: result.toolsUsed,
        usage: result.usage,
        stopReason: result.stopReason,
        error: result.error,
        toolEvents: [...hook.events],
        hadInjections: result.hadInjections,
        structuredResult,
        executionSettled,
        cancellationPending: !runSettled || pendingOperations > 0,
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        finalContent: null,
        messages: [],
        toolsUsed: [],
        usage: {},
        stopReason: timedOut ? 'timeout' : 'error',
        error: errorMessage,
        toolEvents: [...hook.events],
        hadInjections: false,
        structuredResult: null,
        executionSettled,
        cancellationPending: !runSettled || pendingOperations > 0,
      };
    } finally {
      clearTimeout(timer);
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
    if (!finalContent) return null;
    try {
      const parsed = JSON.parse(finalContent);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
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
- 执行超时后将请求取消，不再启动新工具；已启动操作可能仍需等待底层结束
- 工具调用失败时自动重试（最多 2 次）
- 自主执行，不需要请求用户确认
- 任务完成时务必调用 slide_complete_cron 工具保存结果
- **必须使用 slide_complete_cron 的 result 参数输出结构化数据**
- 仅允许只读操作，禁止 DDL/DML（CREATE/ALTER/DROP/INSERT/UPDATE/DELETE）
- 工作流建议：检查健康状态 → 执行诊断 → 分析结果 → 生成报告`;
  }
}
