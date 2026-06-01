/**
 * SubagentManager — wraps AgentRunner for subagent execution.
 *
 * Slides over the existing Slide subagent infrastructure (registry, capabilities)
 * and provides spawn/access lifecycle via AgentRunner.
 *
 * Pattern from nanobot subagent.py: creates fire-and-forget AgentRunner tasks
 * that update SubagentRun records on completion.
 */

import type { AgentRunner } from '@slide/agent-core';
import { subagentRegistry, type SubagentRunRecord } from './subagent-registry.js';

export type SubagentStatus = SubagentRunRecord['status'];

export interface SubagentResult {
  runId: string;
  status: SubagentStatus;
  result?: unknown;
  error?: string;
}

export class SubagentManager {
  private agentRunner: AgentRunner;

  constructor(agentRunner: AgentRunner) {
    this.agentRunner = agentRunner;
  }

  /**
   * Spawn a subagent execution.
   * Creates a SubagentRun record and returns immediately with the runId.
   * The actual execution happens fire-and-forget.
   */
  async spawn(
    agentId: string,
    task: string,
    parentSessionKey: string,
  ): Promise<string> {
    const run = subagentRegistry.register({
      sessionKey: `subagent:${agentId}:${Date.now()}`,
      task,
      parentSessionKey,
    });

    // Fire-and-forget: execute in background without awaiting
    this._executeSubagent(run).catch((err) => {
      console.error(`[SubagentManager] Subagent ${run.runId} failed:`, err);
      subagentRegistry.updateRunStatus(run.runId, 'failed', undefined, err instanceof Error ? err.message : String(err));
    });

    return run.runId;
  }

  /**
   * Access a subagent's status and result.
   */
  async access(runId: string): Promise<{ status: SubagentStatus; result?: unknown; error?: string }> {
    const run = subagentRegistry.getRun(runId);
    if (!run) {
      return { status: 'failed', error: `Subagent run not found: ${runId}` };
    }
    return { status: run.status, result: run.result, error: run.error };
  }

  /**
   * Internal: Execute the subagent with AgentRunner.
   * Creates a minimal run spec and updates the registry on completion.
   * This is fire-and-forget — no awaited call from spawn().
   */
  private async _executeSubagent(run: SubagentRunRecord): Promise<void> {
    try {
      subagentRegistry.updateRunStatus(run.runId, 'running');

      // Update status to running
      const result = await this.agentRunner.run({
        initialMessages: [
          { role: 'system', content: 'You are a subagent executing a specific task. Focus only on the assigned task.' },
          { role: 'user', content: run.task },
        ],
        tools: undefined as any, // Will use the runner's default tools
        // model omitted — uses provider's getDefaultModel()
        maxIterations: 10,
        maxToolResultChars: 20000,
        temperature: 0.0,
        hook: {
          wantsStreaming: () => false,
          beforeIteration: async () => {},
          onStream: async () => {},
          onStreamEnd: async () => {},
          beforeExecuteTools: async () => {},
          emitReasoning: async () => {},
          emitReasoningEnd: async () => {},
          afterIteration: async () => {},
          finalizeContent: (_ctx: any, content: string | null) => content,
        },
        sessionKey: run.sessionKey,
      });

      subagentRegistry.updateRunStatus(run.runId, 'completed', result.finalContent || undefined);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      subagentRegistry.updateRunStatus(run.runId, 'failed', undefined, errorMessage);
      throw err;
    }
  }
}
