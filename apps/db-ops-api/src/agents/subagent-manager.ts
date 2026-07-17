/**
 * SubagentManager — wraps AgentRunner for subagent execution.
 *
 * Slides over the existing Slide subagent infrastructure (registry, capabilities)
 * and provides spawn/access lifecycle via AgentRunner.
 *
 * Pattern from nanobot subagent.py: creates fire-and-forget AgentRunner tasks
 * that update SubagentRun records on completion.
 *
 * Tool scoping (from nanobot tools/loader.py + tools/spawn.py):
 * - Parent tools are copied to the subagent, minus recursive tools
 *   (spawn_subagent, access_subagent) to prevent infinite spawn chains.
 * - This mirrors nanobot's _scopes = {"core"} default — subagents get a subset.
 */

import type { AgentRunner, Tool } from '@slide/agent-core';
import { ToolRegistry } from '@slide/agent-core';
import { subagentRegistry, type SubagentRunRecord } from './subagent-registry.js';

export type SubagentStatus = SubagentRunRecord['status'];

export interface SubagentResult {
  runId: string;
  status: SubagentStatus;
  result?: unknown;
  error?: string;
}

// Scope-based tool filtering mirrors nanobot's ToolLoader.load(ctx, registry, scope="subagent").
// Tools default to scope=['core'] (main agent only).
// Tools with scope=['core','subagent'] are available to both.
const SUBAGENT_SCOPE = 'subagent';

export class SubagentManager {
  private agentRunner: AgentRunner;
  private parentTools: ToolRegistry | null;

  constructor(agentRunner: AgentRunner, parentTools?: ToolRegistry) {
    this.agentRunner = agentRunner;
    this.parentTools = parentTools || null;
  }

  /**
   * Update the parent tool registry (call when tools are reloaded).
   */
  setParentTools(tools: ToolRegistry): void {
    this.parentTools = tools;
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
   * Build the subagent tool registry by copying parent tools minus recursive ones.
   * Mirrors nanobot's ToolLoader.load(ctx, registry, scope="subagent").
   */
  private _buildSubagentTools(): ToolRegistry {
    const subTools = new ToolRegistry();
    if (!this.parentTools) {
      return subTools; // empty — subagent can only chat
    }
    for (const name of this.parentTools.toolNames) {
      const tool = this.parentTools.get(name);
      if (!tool) continue;
      const scopes = tool.scope;
      if (!scopes) {
        // No scope set: default to core+subagent (most tools)
        subTools.register(tool);
      } else if (scopes.includes(SUBAGENT_SCOPE)) {
        // Explicitly includes subagent scope
        subTools.register(tool);
      }
      // scope set but doesn't include 'subagent' → core-only, skip
    }
    return subTools;
  }

  /**
   * Internal: Execute the subagent with AgentRunner.
   * Creates a minimal run spec and updates the registry on completion.
   * This is fire-and-forget — no awaited call from spawn().
   */
  private async _executeSubagent(run: SubagentRunRecord): Promise<void> {
    try {
      subagentRegistry.updateRunStatus(run.runId, 'running');

      const result = await this.agentRunner.run({
        initialMessages: [
          { role: 'system', content: 'You are a subagent executing a specific task. Focus only on the assigned task.' },
          { role: 'user', content: run.task },
        ],
        tools: this._buildSubagentTools(),
        model: this.agentRunner.getDefaultModel(),
        maxIterations: 200,
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
