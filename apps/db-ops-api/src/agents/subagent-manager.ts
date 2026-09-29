import { recordRuntimeEvent } from '../platform/runtime-events.js';
import { resolveRuntimePolicy, runtimeSpec, type RuntimePolicy } from '../adapter/runtime-policy.js';
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

import type { AgentRunner, RuntimeResolution } from '@slide/agent-core';
import { ToolRegistry, reserveChildBudget } from '@slide/agent-core';
import { subagentRegistry, type SubagentRunRecord } from './subagent-registry.js';
import type { ActorContext } from '../auth/actor-context.js';
import { loadAgentRuntimeLimits } from '../security/agent-runtime-limits.js';
import { redactSensitiveText } from '../security/log-redaction.js';

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
  private readonly toolsForActor?: (actor: ActorContext) => ToolRegistry;
  private readonly unsettled = new Set<string>();
  private readonly owners = new Map<string, number>();
  private readonly limits = loadAgentRuntimeLimits();

  constructor(
    agentRunner: AgentRunner,
    parentTools?: ToolRegistry,
    toolsForActor?: (actor: ActorContext) => ToolRegistry,
  ) {
    this.agentRunner = agentRunner;
    this.parentTools = parentTools || null;
    this.toolsForActor = toolsForActor;
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
    actor?: ActorContext,
    parentRemaining?: RuntimePolicy,
  ): Promise<string> {
    if (!actor) throw new Error('SUBAGENT_ACTOR_REQUIRED');
    if (!task.trim() || task.length > this.limits.maxMessageChars) throw new Error('SUBAGENT_TASK_INVALID');
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(agentId)) throw new Error('SUBAGENT_AGENT_ID_INVALID');
    const activeForActor = [...this.owners.entries()].filter(([runId, ownerId]) => {
      const status = subagentRegistry.getRun(runId)?.status;
      return ownerId === actor.userId && (status === 'running' || this.unsettled.has(runId));
    }).length;
    if (activeForActor >= this.limits.maxConcurrentRunsPerActor) {
      throw new Error('SUBAGENT_CONCURRENCY_LIMIT');
    }
    const requested = resolveRuntimePolicy('subagent', { parentRemaining });
    const allocation = await reserveChildBudget(requested);
    const policy = allocation ? Object.freeze({ ...requested, ...allocation }) : requested;
    // Reserving a child budget can await persistence; recheck admission afterward.
    if ([...this.owners].filter(([id, owner]) => owner === actor.userId && (subagentRegistry.getRun(id)?.status === 'running' || this.unsettled.has(id))).length >= this.limits.maxConcurrentRunsPerActor) throw new Error('SUBAGENT_CONCURRENCY_LIMIT');
    const run = subagentRegistry.register({
      sessionKey: `subagent:${agentId}:${Date.now()}`,
      task,
      parentSessionKey,
    });
    this.owners.set(run.runId, actor.userId);

    // Fire-and-forget: execute in background without awaiting
    this._executeSubagent(run, actor, policy, allocation?.signal).catch((err) => {
      console.error(`[SubagentManager] Subagent ${run.runId} failed:`, err);
      subagentRegistry.updateRunStatus(run.runId, 'failed', undefined, err instanceof Error ? err.message : String(err));
    });

    return run.runId;
  }

  /**
   * Access a subagent's status and result.
   */
  async access(runId: string, actor?: ActorContext): Promise<{ status: SubagentStatus; result?: unknown; error?: string; resolution?: RuntimeResolution; cancellationPending?: boolean }> {
    if (!actor || this.owners.get(runId) !== actor.userId) {
      return { status: 'failed', error: 'Subagent run not found' };
    }
    const run = subagentRegistry.getRun(runId);
    if (!run) {
      return { status: 'failed', error: `Subagent run not found: ${runId}` };
    }
    return { status: run.status, result: run.result, error: run.error, ...(run.resolution ? { resolution: run.resolution } : {}), ...(this.unsettled.has(runId) && run.status !== 'running' ? { cancellationPending: true } : {}) };
  }

  /**
   * Build the subagent tool registry by copying parent tools minus recursive ones.
   * Mirrors nanobot's ToolLoader.load(ctx, registry, scope="subagent").
   */
  private _buildSubagentTools(actor: ActorContext): ToolRegistry {
    const subTools = new ToolRegistry();
    const parentTools = this.toolsForActor?.(actor) ?? this.parentTools;
    if (!parentTools) {
      return subTools; // empty — subagent can only chat
    }
    for (const name of parentTools.toolNames) {
      const tool = parentTools.get(name);
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
  private async _executeSubagent(run: SubagentRunRecord, actor: ActorContext, policy: RuntimePolicy, parentSignal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const cancel = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort', cancel, { once: true });
    if (parentSignal?.aborted) cancel();
    const timeout = setTimeout(() => controller.abort(new Error('RUN_DEADLINE')), policy.runTimeoutMs);
    let pending = 0;
    let finished = false;
    this.unsettled.add(run.runId);
    const release = () => { if (finished && pending === 0) this.unsettled.delete(run.runId); };
    const observe = (operation: Promise<unknown>) => {
      pending++;
      const done = () => { pending--; release(); };
      operation.then(done, done);
    };
    try {
      subagentRegistry.updateRunStatus(run.runId, 'running');

      const result = await this.agentRunner.run({
        initialMessages: [
          { role: 'system', content: 'You are a subagent executing a specific task. Focus only on the assigned task.' },
          { role: 'user', content: run.task },
        ],
        tools: this._buildSubagentTools(actor),
        model: this.agentRunner.getDefaultModel(),
        ...runtimeSpec(policy),
        onRuntimeEvent: recordRuntimeEvent,
        onProviderRequest: observe,
        onToolExecution: observe,
        maxToolResultChars: Math.min(this.limits.maxToolResultChars, 10_000),
        contextWindowTokens: 200_000,
        maxTokens: 4096,
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
        signal: controller.signal,
      });

      const completed = !controller.signal.aborted && result.stopReason === 'completed'
        && (!result.resolution || result.resolution.kind === 'response_ready');
      const reason = controller.signal.aborted ? (controller.signal.reason?.code ?? (/DEADLINE/.test(controller.signal.reason?.message ?? '') ? 'RUN_DEADLINE' : 'USER_CANCELLED'))
        : result.resolution?.reasonCode ?? result.stopReason ?? 'MISSING_STOP_REASON';
      subagentRegistry.updateRunStatus(run.runId, completed ? 'completed' : 'failed',
        completed ? result.finalContent || undefined : result.resolution?.safePartialContent,
        completed ? undefined : redactSensitiveText(reason),
        controller.signal.aborted ? { kind: reason === 'RUN_DEADLINE' ? 'timed_out' : 'cancelled', reasonCode: reason, retryable: false }
          : result.resolution ?? { kind: completed ? 'response_ready' : result.stopReason === 'timed_out' ? 'timed_out' : result.stopReason === 'cancelled' ? 'cancelled' : result.stopReason === 'max_iterations' ? 'partial' : 'failed', reasonCode: completed ? 'COMPLETED' : reason, retryable: false });
    } catch (err) {
      const errorMessage = redactSensitiveText(err instanceof Error ? err.message : String(err));
      subagentRegistry.updateRunStatus(run.runId, 'failed', undefined, errorMessage);
      throw err;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', cancel);
      finished = true; release();
    }
  }
}
