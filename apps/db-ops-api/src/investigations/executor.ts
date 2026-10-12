import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import {
  AgentRunner,
  NoopHook,
  ToolRegistry,
  checkpointFacts,
  type LLMProvider,
  type LLMResponse,
  type Message,
  type SessionEntry,
} from '@slide/agent-core';
import { ActorAuthenticationError, type ActorContext } from '../auth/actor-context.js';
import {
  CanonicalStore,
  type InvestigationConnection,
  type InvestigationExecutionBinding,
} from '../adapter/canonical-store.js';
import { persistedMessageParts } from '../adapter/message-parts.js';
import { AgentRunService, type AgentRun, type AgentRunState } from '../adapter/agent-run-service.js';
import type { ClaimedJob, JobExecutionContext } from '../workflows/worker-runtime.js';
import { InvestigationAuthorization, type InvestigationAuthoritySnapshot } from './authorization.js';
import { InvestigationSessionBridge } from './session-bridge.js';
import { INVESTIGATION_PROMPTS, resolveInvestigationProfile } from './profiles.js';
import {
  MysqlInvestigationBudgetLedger,
  budgetUsage,
  type BudgetPolicy,
  type BudgetPrices,
  type BudgetUsage,
} from './budget-ledger.js';
import { getToolSecurityDefinition } from '../tools/security-catalog.js';
import { resolveToolResourceFromArgs } from '../tools/resource-resolver.js';
import { redactSensitiveText } from '../security/log-redaction.js';
import { redactSensitiveData } from '../security/sensitive-data.js';

const decode = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
// Only these reviewed handlers require no browser, approval, credential read or
// interactive session. Profile membership alone never grants background safety.
const BACKGROUND_SAFE = new Set([
  'get_instance_summary',
  'query_metrics',
  'list_active_alerts',
  'get_server_metrics',
  'get_server_alerts',
  'get_resource_observations',
  'get_resource_relations',
  'get_platform_observations',
]);
export interface InvestigationExecuteCommand {
  investigationId: string;
  requestId: string;
  job: ClaimedJob;
  context: JobExecutionContext;
}
export interface InvestigationRuntimeDependencies {
  providerForPurpose: (purpose: string) => Promise<LLMProvider>;
  toolsForActor: (actor: ActorContext) => ToolRegistry;
}
export interface InvestigationExecutorOptions extends InvestigationRuntimeDependencies {
  pool: () => Pool | null;
  authorization?: InvestigationAuthorization;
  budget: { policy: BudgetPolicy; domain: string; reserveCostMicros: number; prices?: BudgetPrices };
}
interface ExecutionState {
  schemaVersion: 1;
  requestId: string;
  jobId: string;
  fencingToken: number;
  deadlineAt: number;
  reservationId: string;
  usage: BudgetUsage;
  usageUnknown: boolean;
  provider: { id: string; inputHash: string; messageId: string | null; status: 'sent' | 'received' } | null;
  tools: Record<string, { name: string; inputHash: string; status: 'running' | 'returned'; result?: unknown }>;
}
const usageOf = (response: LLMResponse): BudgetUsage | null => {
  try {
    return budgetUsage({
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
      cachedInputTokens: response.usage.cached_tokens ?? 0,
    });
  } catch {
    return null;
  }
};
function callerFrom(snapshot: InvestigationAuthoritySnapshot): ActorContext {
  return {
    userId: snapshot.actor.id,
    username: `investigation-actor-${snapshot.actor.id}`,
    roles: [],
    requestId: `investigation:${snapshot.investigationId}`,
    principalKind: snapshot.actor.kind,
    sessionVersion: snapshot.sessionVersion,
    permissions: snapshot.globalInstanceAccess ? [...snapshot.permissions, 'instance:*'] : snapshot.permissions,
    instanceScopes: snapshot.instanceScopes,
    resourceBoundary: snapshot.globalInstanceAccess ? undefined : snapshot.resourceBoundary,
  };
}

/** Model parameters are untrusted. Targets are parsed against the security
 * catalog, with conflicting aliases rejected rather than silently preferred. */
export function boundedInvestigationArguments(
  name: string,
  value: Record<string, unknown>,
  budget: {
    maxBytes: number;
    maxRows: number;
    maxWindowMs: number;
  },
  now: number,
): { args: Record<string, unknown>; targets: { type: 'instance' | 'server' | 'network_device'; id: number }[] } {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Buffer.byteLength(JSON.stringify(value)) > budget.maxBytes
  )
    throw new Error('INVESTIGATION_TOOL_INPUT_LIMIT');
  const args = structuredClone(value);
  for (const aliases of [
    ['instance_id', 'instanceId'],
    ['server_id', 'serverId'],
    ['network_device_id', 'networkDeviceId'],
  ]) {
    if (aliases.every((k) => args[k] !== undefined) && args[aliases[0]] !== args[aliases[1]])
      throw new Error('INVESTIGATION_TARGET_AMBIGUOUS');
  }
  if (
    args.instance_name !== undefined ||
    args.host !== undefined ||
    args.command !== undefined ||
    args.sql !== undefined ||
    (args.resourceType !== undefined &&
      (args.instance_id !== undefined ||
        args.instanceId !== undefined ||
        args.serverId !== undefined ||
        args.server_id !== undefined ||
        args.networkDeviceId !== undefined ||
        args.network_device_id !== undefined))
  )
    throw new Error('INVESTIGATION_TARGET_AMBIGUOUS');
  const resource = resolveToolResourceFromArgs(name, args);
  if (resource.error) throw new Error('INVESTIGATION_TARGET_INVALID');
  const targets: { type: 'instance' | 'server' | 'network_device'; id: number }[] = [];
  if (resource.instanceId !== undefined) targets.push({ type: 'instance', id: resource.instanceId });
  if (resource.serverId !== undefined) targets.push({ type: 'server', id: resource.serverId });
  if (resource.networkDeviceId !== undefined) targets.push({ type: 'network_device', id: resource.networkDeviceId });
  for (const key of ['limit', 'maxRows', 'rows'])
    if (
      args[key] !== undefined &&
      (!Number.isSafeInteger(args[key]) || Number(args[key]) < 1 || Number(args[key]) > budget.maxRows)
    )
      throw new Error('INVESTIGATION_TOOL_ROW_LIMIT');
  const from = args.from ?? args.since,
    to = args.to ?? new Date(now).toISOString();
  if (
    (args.to !== undefined && from === undefined) ||
    (args.from !== undefined && args.since !== undefined) ||
    (args.range !== undefined && args.range !== '1h')
  )
    throw new Error('INVESTIGATION_TOOL_WINDOW_LIMIT');
  if (
    from !== undefined &&
    (typeof from !== 'string' ||
      typeof to !== 'string' ||
      !Number.isFinite(Date.parse(from)) ||
      !Number.isFinite(Date.parse(to)) ||
      Date.parse(to) > now ||
      Date.parse(to) < Date.parse(from) ||
      Date.parse(to) - Date.parse(from) > budget.maxWindowMs)
  )
    throw new Error('INVESTIGATION_TOOL_WINDOW_LIMIT');
  if (args.period !== undefined && args.period !== '1h') throw new Error('INVESTIGATION_TOOL_WINDOW_LIMIT');
  // Bound the handlers' implicit history defaults as well as explicit windows.
  if (name === 'query_metrics' && args.mode === 'history' && args.from === undefined) {
    args.from = new Date(now - budget.maxWindowMs).toISOString();
    args.to = new Date(now).toISOString();
  }
  if (name === 'list_active_alerts') {
    args.limit ??= Math.min(100, budget.maxRows);
    args.since ??= new Date(now - budget.maxWindowMs).toISOString();
  }
  return { args, targets };
}
function boundedResult(value: unknown, maxRows: number, maxBytes: number): unknown {
  const copy = (v: any, depth = 0): any => {
    if (depth > 20) return '[depth limit]';
    if (typeof v === 'string') return redactSensitiveText(v);
    if (Array.isArray(v)) return v.slice(0, maxRows).map((x) => copy(x, depth + 1));
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x, depth + 1)]));
    return v;
  };
  const result = copy(redactSensitiveData(value)),
    json = JSON.stringify(result);
  if (json === undefined || Buffer.byteLength(json) > maxBytes)
    return { success: false, errorCode: 'INVESTIGATION_TOOL_OUTPUT_LIMIT', error: '工具结果超过调查输出限额' };
  return result;
}

export class InvestigationExecutor {
  private readonly inFlight = new Map<string, Promise<AgentRun>>();
  private readonly canonical: CanonicalStore;
  private readonly runs: AgentRunService;
  private readonly authorization: InvestigationAuthorization;
  private readonly bridge: InvestigationSessionBridge;
  private readonly ledger: MysqlInvestigationBudgetLedger;
  constructor(private readonly options: InvestigationExecutorOptions) {
    this.authorization = options.authorization ?? new InvestigationAuthorization();
    this.canonical = new CanonicalStore(options.pool as never, this.authorization);
    this.runs = new AgentRunService(options.pool as never);
    this.bridge = new InvestigationSessionBridge(options.pool, this.authorization);
    this.ledger = new MysqlInvestigationBudgetLedger(options.pool, options.budget.policy);
  }
  private async transaction<T>(work: (c: InvestigationConnection) => Promise<T>): Promise<T> {
    const pool = this.options.pool();
    if (!pool) throw new Error('INVESTIGATION_STORE_UNAVAILABLE');
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const value = await work(c as unknown as InvestigationConnection);
      await c.commit();
      return value;
    } catch (error) {
      try {
        await c.rollback();
      } catch {
        /* retain original */
      }
      throw error;
    } finally {
      c.release();
    }
  }
  execute(
    command: InvestigationExecuteCommand,
    runtime: InvestigationRuntimeDependencies = this.options,
  ): Promise<AgentRun> {
    const key = `${command.requestId}:${command.job.id}:${command.context.workerId}:${command.context.fencingToken}`;
    const previous = this.inFlight.get(key);
    if (previous) return previous;
    const promise = this.executeOwned(command, runtime);
    this.inFlight.set(key, promise);
    void promise
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      })
      .catch(() => {});
    return promise;
  }
  private async executeOwned(
    command: InvestigationExecuteCommand,
    runtime: InvestigationRuntimeDependencies,
  ): Promise<AgentRun> {
    const { investigationId, requestId, job, context } = command;
    if (
      !uuid.test(investigationId) ||
      !uuid.test(requestId) ||
      job.type !== 'investigation.execute' ||
      job.payload.investigationId !== investigationId ||
      job.payload.requestId !== requestId ||
      job.fencingToken !== context.fencingToken
    )
      throw new Error('INVESTIGATION_JOB_INVALID');
    context.signal.throwIfAborted();
    const pool = this.options.pool();
    if (!pool) throw new Error('INVESTIGATION_STORE_UNAVAILABLE');
    const [requests] = await pool.query<any[]>(
      'SELECT request_snapshot, actor_id, actor_kind, message_id, job_id FROM investigation_requests WHERE id = ? AND investigation_id = ?',
      [requestId, investigationId],
    );
    const request = requests[0],
      snapshot = request && decode(request.request_snapshot),
      frozen = snapshot?.authority as InvestigationAuthoritySnapshot;
    if (
      !request ||
      request.job_id !== job.id ||
      !frozen ||
      frozen.actor.id !== Number(request.actor_id) ||
      frozen.actor.kind !== request.actor_kind
    )
      throw new Error('INVESTIGATION_REQUEST_INVALID');
    const actor = callerFrom(frozen),
      profile = resolveInvestigationProfile(snapshot.profileId, snapshot.profileVersion);
    const base = {
      investigationId,
      requestId,
      jobId: job.id,
      workerId: context.workerId,
      fencingToken: context.fencingToken,
    };
    // A completed/cancelled replay settles its persisted receipt, never dispatches.
    const prior = await this.runs.findByIdempotencyKey(actor.userId, `investigation:${requestId}`);
    if (prior && prior.state !== 'running') {
      await this.transaction((c) => this.canonical.assertInvestigationLease(c, base));
      await this.settle(prior);
      return prior;
    }
    let run: AgentRun;
    try {
      await this.bridge.requestAuthority(actor, investigationId, requestId);
      run = await this.transaction((c) => this.runs.claimInvestigation(c, this.canonical, actor, base));
    } catch (error) {
      // Withdrawal before Run creation does not fabricate a competing queued
      // Run state. Keep a failed job for the admission owner to inspect.
      if (!prior) {
        const reason = this.reason(error);
        if (
          !['INVESTIGATION_NOT_FOUND', 'INVESTIGATION_OPERATION_FORBIDDEN', 'INVESTIGATION_CANCELLED'].includes(reason)
        )
          throw error;
        return this.transaction((c) => this.runs.rejectInvestigationRequest(c, actor, base, reason));
      }
      const terminal = await this.transaction((c) =>
        this.runs.terminateInvestigation(c, actor, { ...base, runId: prior.id }, 'failed', this.reason(error)),
      );
      await this.settle(terminal);
      return terminal;
    }
    const existingState = (run.result as { investigationExecution?: ExecutionState } | undefined)
      ?.investigationExecution;
    // Only a NEW fenced lease may recover another invocation. The same
    // owner/fence in a different service instance cannot reset state or close it.
    if (existingState?.fencingToken === context.fencingToken)
      throw new Error('INVESTIGATION_EXECUTION_ALREADY_RUNNING');
    const binding = { ...base, runId: run.id };
    const control = new AbortController();
    const abort = () => control.abort(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    let checking = false;
    let pendingCheck: Promise<unknown> | undefined;
    // Browser lifecycle never owns this controller. Persisted cancel/live ACL
    // are checked during I/O as well as at every dispatch/checkpoint boundary.
    const timer = setInterval(() => {
      if (checking || control.signal.aborted) return;
      checking = true;
      pendingCheck = this.transaction((c) => this.canonical.lockInvestigationExecution(c, actor, binding))
        .catch((error) => control.abort(error))
        .finally(() => {
          checking = false;
        });
    }, 250);
    const operations = new Set<Promise<unknown>>();
    const observe = (p: Promise<unknown>) => {
      operations.add(p);
      void p.catch(() => {}).finally(() => operations.delete(p));
    };
    try {
      let access = await this.transaction((c) => this.canonical.lockInvestigationExecution(c, actor, binding));
      let state: ExecutionState = decode(access.run.result_json)?.investigationExecution;
      if (decode(access.run.result_json)?.completionPending) {
        const completed = await this.transaction((c) =>
          this.runs.recoverInvestigationCompletion(c, this.canonical, actor, binding),
        );
        await this.settle(completed);
        return completed;
      }
      if (!state) {
        state = await this.transaction(async (c) => {
          const current = await this.canonical.lockInvestigationExecution(c, actor, binding);
          const persisted = decode(current.run.result_json)?.investigationExecution as ExecutionState | undefined;
          if (persisted) {
            if (persisted.fencingToken === context.fencingToken)
              throw new Error('INVESTIGATION_EXECUTION_ALREADY_RUNNING');
            return persisted;
          }
          const reservation = await this.ledger.reserveInTransaction(c, {
            requestId,
            operationId: `execution:${run.id}`,
            domain: this.options.budget.domain,
            mode: actor.principalKind === 'service' ? 'automatic' : 'manual',
            profile,
            reserveTokens: profile.budget.maxTokens,
            reserveCostMicros: this.options.budget.reserveCostMicros,
            prices: this.options.budget.prices,
          });
          if (reservation.accepted === false) throw new Error(`INVESTIGATION_BUDGET_${reservation.reason}`);
          const initial: ExecutionState = {
            schemaVersion: 1,
            requestId,
            jobId: job.id,
            fencingToken: context.fencingToken,
            deadlineAt: Date.now() + profile.budget.deadlineMs,
            reservationId: reservation.reservation.id,
            usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
            usageUnknown: false,
            provider: null,
            tools: {},
          };
          await c.query('UPDATE agent_runs SET result_json = ? WHERE id = ?', [
            JSON.stringify({ investigationExecution: initial }),
            run.id,
          ]);
          await this.canonical.assertInvestigationLease(c, binding);
          return initial;
        });
      }
      if (state.schemaVersion !== 1 || state.requestId !== requestId || state.jobId !== job.id)
        throw new Error('INVESTIGATION_CHECKPOINT_INVALID');
      const update = async (work: (s: ExecutionState) => void) =>
        this.transaction(async (c) => {
          const current = await this.canonical.lockInvestigationExecution(c, actor, binding);
          const result = decode(current.run.result_json),
            next: ExecutionState = result.investigationExecution;
          work(next);
          await c.query('UPDATE agent_runs SET result_json = ? WHERE id = ?', [
            JSON.stringify({ ...result, investigationExecution: next }),
            run.id,
          ]);
          await this.canonical.assertInvestigationLease(c, binding);
          state = next;
        });
      await update((s) => {
        s.fencingToken = context.fencingToken;
      });
      if (state.provider) throw new Error('INVESTIGATION_PROVIDER_UNKNOWN');
      let checkpoint = access.checkpoint?.canonical_run_id === run.id ? access.checkpoint : undefined;
      if (checkpoint && checkpoint.canonical_turn_id !== access.messageId)
        throw new Error('INVESTIGATION_CHECKPOINT_INVALID');
      // Runtime response_ready is durable evidence to stage the same answer.
      // An unaccepted candidate or any other terminal checkpoint must never
      // re-enter the model loop after an OS exit.
      if (checkpoint?.terminal_resolution || checkpoint?.phase === 'final_response') {
        const resolution = checkpoint.terminal_resolution as { kind?: string; reasonCode?: string } | undefined;
        const candidate = checkpoint.assistantMessage as Message | undefined;
        if (
          resolution?.kind === 'response_ready' &&
          checkpoint.phase === 'final_response' &&
          candidate?.role === 'assistant' &&
          typeof candidate.content === 'string' &&
          !candidate.tool_calls?.length
        ) {
          await this.transaction((c) =>
            this.runs.stageInvestigationCompletion(c, this.canonical, actor, binding, {
              type: 'complete',
              stopReason: 'completed',
              finalContent: redactSensitiveText(candidate.content as string),
              resolution: { kind: 'response_ready', reasonCode: 'RUNTIME_RESPONSE_READY', retryable: false },
            }),
          );
          const completed = await this.transaction((c) =>
            this.runs.recoverInvestigationCompletion(c, this.canonical, actor, binding),
          );
          await this.settle(completed);
          return completed;
        }
        if (!resolution) {
          await update((s) => {
            s.usageUnknown = true;
          });
          throw new Error('INVESTIGATION_FINAL_RESPONSE_UNKNOWN');
        }
        const terminalState =
          resolution.kind === 'cancelled' ? 'cancelled' : resolution.kind === 'timed_out' ? 'timed_out' : 'partial';
        const terminal = await this.transaction((c) =>
          this.runs.terminateInvestigation(
            c,
            actor,
            binding,
            terminalState,
            resolution.reasonCode ?? 'INVESTIGATION_RUNTIME_PARTIAL',
          ),
        );
        await this.settle(terminal);
        return terminal;
      }
      const pending = (checkpoint?.pendingToolCalls ?? checkpoint?.pending_tool_calls) as any[] | undefined;
      if (pending?.length) {
        if (pending.some((call) => state.tools[call.id]?.status !== 'returned'))
          throw new Error('INVESTIGATION_TOOL_UNKNOWN');
        checkpoint = {
          ...checkpoint,
          phase: 'tools_completed',
          pendingToolCalls: [],
          completedToolResults: pending.map((call) => ({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: JSON.stringify(state.tools[call.id].result, null, 2),
          })),
        };
        await this.persistCheckpoint(actor, binding, checkpoint);
      }
      if (Date.now() >= state.deadlineAt) throw new Error('INVESTIGATION_DEADLINE');
      const actual = await runtime.providerForPurpose(profile.modelScene);
      let modelMessageId: string | undefined;
      const dispatch = async (send: () => Promise<LLMResponse>, input: unknown): Promise<LLMResponse> => {
        control.signal.throwIfAborted();
        if (state.provider) throw new Error('INVESTIGATION_PROVIDER_UNKNOWN');
        const id = randomUUID();
        await update((s) => {
          if (s.provider) throw new Error('INVESTIGATION_PROVIDER_UNKNOWN');
          s.provider = { id, inputHash: hash(input), messageId: modelMessageId ?? null, status: 'sent' };
        });
        // The entire execution allocation stays sent through all subsequent
        // turns. Only the Run's durable terminal receipt may release it.
        await this.ledger.markSent(state.reservationId);
        await this.transaction((c) => this.canonical.lockInvestigationExecution(c, actor, binding));
        control.signal.throwIfAborted();
        const response = await send();
        control.signal.throwIfAborted();
        const usage = usageOf(response);
        await update((s) => {
          if (s.provider?.id !== id) throw new Error('INVESTIGATION_PROVIDER_UNKNOWN');
          s.provider.status = 'received';
          if (!usage) s.usageUnknown = true;
          else {
            s.usage.inputTokens += usage.inputTokens;
            s.usage.cachedInputTokens += usage.cachedInputTokens;
            s.usage.outputTokens += usage.outputTokens;
          }
        });
        return response;
      };
      const provider: LLMProvider = {
        getDefaultModel: () => actual.getDefaultModel(),
        getModelCapabilities: actual.getModelCapabilities?.bind(actual),
        countPromptTokens: actual.countPromptTokens?.bind(actual),
        projectMessages: actual.projectMessages?.bind(actual),
        chat: (messages, tools, options) => dispatch(() => actual.chat(messages, tools, options), [messages, tools]),
        chatStream: (messages, tools, callbacks, options) =>
          dispatch(() => actual.chatStream(messages, tools, callbacks, options), [messages, tools]),
      };
      let currentToolId: string | undefined;
      const effective = await this.transaction(async (c) =>
        this.authorization.authorize(
          c,
          actor,
          await this.authorization.load(c, investigationId),
          'continue',
          [],
          frozen,
        ),
      );
      const source = runtime.toolsForActor(effective.actor),
        tools = new ToolRegistry();
      for (const name of effective.tools) {
        const tool = source.get(name),
          security = getToolSecurityDefinition(name);
        if (
          !tool ||
          !BACKGROUND_SAFE.has(name) ||
          !tool.readOnly ||
          tool.requiresApproval ||
          tool.ownerOnly ||
          security?.effect !== 'read'
        )
          continue;
        tools.register({
          ...tool,
          concurrencySafe: false,
          exclusive: true,
          timeoutMs: Math.min(tool.timeoutMs ?? 10_000, 10_000),
          execute: async (value, toolContext) => {
            const toolId = currentToolId;
            if (!toolId) throw new Error('INVESTIGATION_TOOL_BINDING_INVALID');
            toolContext?.signal?.throwIfAborted();
            control.signal.throwIfAborted();
            const { args, targets } = boundedInvestigationArguments(name, value, profile.budget, Date.now());
            const live = await this.transaction(async (c) => {
              await this.canonical.lockInvestigationExecution(c, actor, binding);
              return this.authorization.authorizeTool(
                c,
                actor,
                await this.authorization.load(c, investigationId),
                frozen,
                name,
                targets.length
                  ? targets
                  : security.resource === 'instance'
                    ? snapshot.resources.filter((r: any) => r.type === 'instance')
                    : [],
              );
            });
            const existing = state.tools[toolId];
            if (existing) {
              if (existing.inputHash !== hash(args) || existing.name !== name || existing.status !== 'returned')
                throw new Error('INVESTIGATION_TOOL_UNKNOWN');
              return existing.result;
            }
            await update((s) => {
              s.tools[toolId] = { name, inputHash: hash(args), status: 'running' };
            });
            toolContext?.signal?.throwIfAborted();
            control.signal.throwIfAborted();
            const liveTool = runtime.toolsForActor(live.actor).get(name);
            if (!liveTool?.readOnly || liveTool.requiresApproval || liveTool.ownerOnly)
              throw new Error('INVESTIGATION_TOOL_FORBIDDEN');
            const result = boundedResult(
              await liveTool.execute(args, { ...toolContext, signal: toolContext?.signal ?? control.signal }),
              profile.budget.maxRows,
              profile.budget.maxBytes,
            );
            toolContext?.signal?.throwIfAborted();
            control.signal.throwIfAborted();
            await update((s) => {
              s.tools[toolId] = { name, inputHash: hash(args), status: 'returned', result };
            });
            return result;
          },
        });
      }
      const messages: SessionEntry[] = [];
      let before: string | undefined;
      do {
        const page = await this.transaction((c) =>
          this.canonical.getInvestigationPage(c, actor, binding, 1000, before),
        );
        messages.unshift(...page.messages);
        before = page.nextBefore ?? undefined;
        if (messages.length > 10_000) throw new Error('INVESTIGATION_HISTORY_LIMIT');
      } while (before);
      const initialMessages: Message[] = [
        {
          role: 'system',
          source: 'runtime',
          contextAuthority: 'policy',
          content: INVESTIGATION_PROMPTS[profile.id as 'ops' | 'system'],
        },
        ...messages,
      ];
      const hook = new NoopHook();
      hook.beforeIteration = async (ctx) => {
        modelMessageId = ctx.messageId;
      };
      const result = await new AgentRunner(provider).run({
        runtimeRunId: run.id,
        initialMessages,
        tools,
        model: provider.getDefaultModel(),
        contextWindowTokens: Math.min(actual.getModelCapabilities?.()?.contextWindowTokens ?? 16_000, 16_000),
        maxIterations: profile.budget.maxProviderAttempts,
        maxTokens: Math.min(4096, profile.budget.maxTokens),
        maxToolResultChars: profile.budget.maxBytes,
        budgetLimits: {
          maxToolCalls: profile.budget.maxToolCalls,
          maxProviderAttempts: profile.budget.maxProviderAttempts,
          maxTotalTokens: profile.budget.maxTokens,
          maxNoProgressSteps: profile.budget.maxProviderAttempts,
        },
        runTimeoutMs: Math.max(1, state.deadlineAt - Date.now()),
        toolTimeoutMs: 10_000,
        llmTimeoutS: Math.max(1, (state.deadlineAt - Date.now()) / 1000),
        concurrentTools: false,
        failOnToolError: true,
        hook,
        signal: control.signal,
        sessionKey: access.sessionId,
        idempotencyKey: `investigation:${requestId}`,
        resumeCheckpoint: checkpoint,
        recoveryLimits: { total: 0, empty: 0, continuation: 0, stream: 0, repetition: 0, context: 0 },
        onProviderRequest: observe,
        onToolExecution: observe,
        onToolEvent: async (e) => {
          if (e.phase === 'running' && !e.progress) currentToolId = e.toolCallId;
        },
        checkpointCallback: async (payload) => {
          await this.persistCheckpoint(actor, binding, payload);
          const current = await this.transaction((c) => this.canonical.lockInvestigationExecution(c, actor, binding));
          state = decode(current.run.result_json).investigationExecution;
          if (!state.provider) modelMessageId = undefined;
        },
      });
      access = await this.transaction((c) => this.canonical.lockInvestigationExecution(c, actor, binding));
      state = decode(access.run.result_json).investigationExecution;
      if (state.provider) throw new Error('INVESTIGATION_PROVIDER_UNKNOWN');
      if (Object.values(state.tools).some((t) => t.status === 'running')) throw new Error('INVESTIGATION_TOOL_UNKNOWN');
      let terminal: AgentRun;
      if (result.stopReason === 'completed' && (!result.resolution || result.resolution.kind === 'response_ready')) {
        await this.transaction((c) =>
          this.runs.stageInvestigationCompletion(c, this.canonical, actor, binding, {
            type: 'complete',
            stopReason: 'completed',
            finalContent: redactSensitiveText(result.finalContent ?? ''),
            resolution: result.resolution ?? {
              kind: 'response_ready',
              reasonCode: 'RUNTIME_RESPONSE_READY',
              retryable: false,
            },
          }),
        );
        terminal = await this.transaction((c) =>
          this.runs.recoverInvestigationCompletion(c, this.canonical, actor, binding),
        );
      } else {
        const state: Exclude<AgentRunState, 'running' | 'completed'> =
          result.resolution?.kind === 'timed_out'
            ? 'timed_out'
            : result.resolution?.kind === 'cancelled'
              ? 'cancelled'
              : 'partial';
        terminal = await this.transaction((c) =>
          this.runs.terminateInvestigation(
            c,
            actor,
            binding,
            state,
            result.resolution?.reasonCode ?? 'INVESTIGATION_RUNTIME_PARTIAL',
          ),
        );
      }
      await this.settle(terminal);
      return terminal;
    } catch (error) {
      const code = this.reason(control.signal.aborted ? control.signal.reason : error);
      if (
        code === 'INVESTIGATION_FENCE_LOST' ||
        code === 'INVESTIGATION_EXECUTION_ALREADY_RUNNING' ||
        context.signal.aborted
      )
        throw error; // new owner alone recovers
      const state =
        code === 'INVESTIGATION_CANCELLED'
          ? 'cancelled'
          : code === 'INVESTIGATION_DEADLINE'
            ? 'timed_out'
            : /UNKNOWN/.test(code)
              ? 'partial'
              : 'failed';
      const terminal = await this.transaction((c) => this.runs.terminateInvestigation(c, actor, binding, state, code));
      await this.settle(terminal);
      return terminal;
    } finally {
      clearInterval(timer);
      context.signal.removeEventListener('abort', abort);
      await pendingCheck;
      // Provider/tool I/O can outlive the Runtime boundary. Collect them before
      // handing off; late writes re-check signal and the current SQL fence.
      await Promise.allSettled(operations);
    }
  }
  private async persistCheckpoint(
    actor: ActorContext,
    binding: InvestigationExecutionBinding,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.transaction(async (c) => {
      const access = await this.canonical.lockInvestigationExecution(c, actor, binding);
      const checkpoint = { ...payload, canonical_run_id: binding.runId, canonical_turn_id: access.messageId };
      const facts = checkpointFacts(checkpoint, binding.runId)
        .filter((m) => m.role === 'tool' || m.tool_calls?.length)
        .map((m) => {
          // Core checkpoints default their turn to runtimeRunId before the caller
          // binds the admitted user fact. Preserve Parts and generating identity,
          // while assigning the same persisted turn on every replay.
          const doc = m.messageParts && structuredClone(m.messageParts);
          if (doc) {
            doc.runId = binding.runId;
            doc.turnId = access.messageId;
            doc.legacy.runId = binding.runId;
            doc.legacy.turnId = access.messageId;
          }
          return { ...m, runId: binding.runId, turnId: access.messageId, ...(doc ? { messageParts: doc } : {}) };
        });
      const acknowledged = facts.map((m) =>
        persistedMessageParts(
          m,
          'checkpoint',
          m.tool_calls?.some((call) => !facts.some((result) => result.tool_call_id === call.id))
            ? 'partial'
            : 'completed',
        ),
      );
      // Retain each fact's generating boundary in both the persisted and Core
      // checkpoint. A new model attempt must not re-stamp prior tool results.
      if (payload.assistantMessage && facts.some((m) => m.role === 'assistant'))
        payload.assistantMessage = acknowledged.find((m) => m.role === 'assistant');
      if (Array.isArray(payload.completedToolResults))
        payload.completedToolResults = acknowledged.filter((m) => m.role === 'tool');
      Object.assign(checkpoint, payload, { canonical_run_id: binding.runId, canonical_turn_id: access.messageId });
      await this.canonical.appendInvestigationToolFacts(
        c,
        actor,
        binding,
        facts,
        Number(payload.iteration ?? 0),
        checkpoint,
      );
      if (['awaiting_tools', 'tools_completed', 'final_response'].includes(String(payload.phase))) {
        const result = decode(access.run.result_json),
          state: ExecutionState = result?.investigationExecution;
        if (
          state?.provider?.status === 'received' &&
          state.provider.messageId &&
          (payload.assistantMessage as { id?: string } | undefined)?.id === state.provider.messageId
        ) {
          state.provider = null;
          await c.query('UPDATE agent_runs SET result_json = ? WHERE id = ?', [JSON.stringify(result), binding.runId]);
        }
      }
      await this.canonical.assertInvestigationLease(c, binding);
    });
  }
  private async settle(run: AgentRun): Promise<void> {
    const state = (run.result as { investigationExecution?: ExecutionState } | undefined)?.investigationExecution;
    if (!state) return;
    const reservation = await this.ledger.read(state.reservationId);
    if (reservation.state === 'reserved') {
      if (state.provider) {
        await this.ledger.markSent(reservation.id);
        await this.ledger.settle(reservation.id, null);
      } else await this.ledger.cancelUnsent(reservation.id);
      return;
    }
    const unknown =
      state.usageUnknown || !!state.provider || Object.values(state.tools).some((t) => t.status === 'running');
    await this.ledger.settle(reservation.id, unknown ? null : state.usage);
  }
  private reason(error: unknown): string {
    if (error instanceof ActorAuthenticationError) return 'INVESTIGATION_NOT_FOUND';
    const message = error instanceof Error ? error.message : String(error);
    return /^[A-Z][A-Z0-9_]{0,127}$/.test(message) ? message : 'INVESTIGATION_EXECUTION_FAILED';
  }
}
