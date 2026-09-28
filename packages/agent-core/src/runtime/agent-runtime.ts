import type { AgentRunResult, AgentRunSpec, LLMProvider } from '../types.js';
import { TurnLoop } from './turn-loop.js';
import type { ToolExecutor } from './tool-executor.js';

export class AgentRuntime {
  constructor(
    private readonly getProvider: () => LLMProvider,
    private readonly executor: Pick<ToolExecutor, 'runTool'>,
  ) {}

  run(spec: AgentRunSpec): Promise<AgentRunResult> {
    return new TurnLoop(this.getProvider, this.executor).run(spec);
  }
}
