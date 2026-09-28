/** Legacy public API; execution is composed by AgentRuntime. */
import type { AgentRunSpec, AgentRunResult, LLMProvider, AgentHook, AgentHookContext } from "./types.js";
import { AgentRuntime } from "./runtime/agent-runtime.js";
import { ToolExecutor } from "./runtime/tool-executor.js";
import { LegacyCheckpoint } from "./runtime/checkpoint.js";

export class AgentRunner extends LegacyCheckpoint {
  private readonly executor = new ToolExecutor();
  private readonly runtime = new AgentRuntime(() => this.provider, this.executor);

  constructor(private provider: LLMProvider) { super(); }
  setProvider(provider: LLMProvider): void { this.provider = provider; }
  getDefaultModel(): string { return this.provider.getDefaultModel(); }
  run(spec: AgentRunSpec): Promise<AgentRunResult> { return this.runtime.run(spec); }
  runTool(...args: Parameters<ToolExecutor["runTool"]>): ReturnType<ToolExecutor["runTool"]> {
    return this.executor.runTool(...args);
  }
}

export class NoopHook implements AgentHook {
  wantsStreaming(): boolean {
    return false;
  }
  async beforeIteration(_ctx: AgentHookContext): Promise<void> {}
  async onStream(_ctx: AgentHookContext, _delta: string): Promise<void> {}
  async onStreamEnd(_ctx: AgentHookContext, _resuming: boolean): Promise<void> {}
  async beforeExecuteTools(_ctx: AgentHookContext): Promise<void> {}
  async emitReasoning(_text: string | null): Promise<void> {}
  async emitReasoningEnd(): Promise<void> {}
  async afterIteration(_ctx: AgentHookContext): Promise<void> {}
  finalizeContent(_ctx: AgentHookContext, content: string | null): string | null {
    return content;
  }
}
