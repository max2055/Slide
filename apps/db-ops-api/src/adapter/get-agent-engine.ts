/**
 * getAgentEngine() — IAgentEngine factory, DirectAdapter-only.
 *
 * The factory does NOT call .start() — that is the caller's responsibility
 * (server.ts calls engine.start() after the factory returns).
 */

import { ToolRegistry } from '@slide/agent-core';
import type { Tool } from '@slide/agent-core';
type CoreToolExecutionContext = {
  sessionKey?: string;
  signal?: AbortSignal;
  idempotencyKey?: string;
  progressCallback?: ((event: Record<string, unknown>) => Promise<void> | void) | null;
};
import type { IAgentEngine } from './types.js';
import { DirectAdapter } from './direct-adapter.js';
import type { ActorContext } from '../auth/actor-context.js';
import { normalizeToolResult, type AnyAgentTool } from '../tools/types.js';
import { canActorDiscoverTool, decideToolPolicy, executeToolWithPolicy } from '../tools/policy.js';
import {
  assertToolSecurityCatalogCoverage,
  getToolSecurityDefinition,
  isActorFacingTool,
  isDeclarativelyReadOnlyTool,
} from '../tools/security-catalog.js';
import { skillRegistry } from '../skills/loader.js';
import { filterRuntimeSkills } from '../skills/runtime-policy.js';
import { TrustedSkillsLoader } from '../skills/trusted-skills-loader.js';
import { DEFAULT_AGENT_ID, agentSecurityPolicyService } from '../security/agent-security-policy-service.js';

let directEngine: IAgentEngine | null = null;

// ── Platform tool loading (lazy, once) ──

let toolsLoaded = false;
let platformToolRegistry: ToolRegistry | null = null;
let platformTools: AnyAgentTool[] = [];

/**
 * Load Slide platform tools from catalog.ts into a ToolRegistry.
 *
 * Generated tool modules (slide-self-mgmt, etc.) register themselves into
 * the global toolCatalog singleton via module-side effects. We import
 * the generated modules first to trigger registration, then pull all
 * tools from toolCatalog.getAll() and convert them to @slide/agent-core
 * Tool[] format.
 *
 * This is called lazily on first getAgentEngine() invocation so that all
 * service imports in generated tool modules are guaranteed to be resolved.
 */
export async function loadPlatformTools(): Promise<ToolRegistry> {
  if (toolsLoaded && platformToolRegistry) {
    return platformToolRegistry;
  }

  const registry = new ToolRegistry();

  try {
    const { toolCatalog, registerPredefinedToolGroups, discoverToolsFromDirectory } = await import('../tools/catalog.js');
    // Discover tool modules at runtime. The generated indexes remain a
    // compatibility path for bundled builds, while directory discovery makes
    // newly added tool modules available without editing a central index.
    const generatedDir = new URL('../tools/generated/slide-self-mgmt/', import.meta.url).pathname;
    const opsDir = new URL('../tools/ops/', import.meta.url).pathname;
    const discovered = [
      ...(await discoverToolsFromDirectory(generatedDir, '*.js')),
      ...(await discoverToolsFromDirectory(generatedDir, '*.ts')),
      ...(await discoverToolsFromDirectory(opsDir, '*.js')),
      ...(await discoverToolsFromDirectory(opsDir, '*.ts')),
    ];
    // Bundled indexes retain side-effect registration for environments where
    // module enumeration is unavailable; directory discovery then adds any
    // newly introduced modules without requiring index edits.
    await import('../tools/generated/slide-self-mgmt/index.js');
    await import('../tools/ops/index.js');
    const generatedIndex = await import('../tools/generated/slide-self-mgmt/index.js');
    const opsModules = await Promise.all([
      import('../tools/ops/get_instance_summary.js'),
      import('../tools/ops/list_active_alerts.js'),
      import('../tools/ops/query_metrics.js'),
    ]);
    if (Array.isArray((generatedIndex as any).slideSelfMgmtTools)) {
      toolCatalog.registerAll((generatedIndex as any).slideSelfMgmtTools);
    }
    for (const module of opsModules) {
      for (const value of Object.values(module)) {
        if (value && typeof value === 'object' && 'name' in value && 'handler' in value) {
          toolCatalog.register(value as AnyAgentTool);
        }
      }
    }
    toolCatalog.registerAll(discovered);
    // Register the cron completion tool (agent calls slide_complete_cron to save results)
    await import('../cron/cron-completion-tool.js');

    const { executeCodeTool } = await import('../tools/code-execution-tool.js');
    toolCatalog.register(executeCodeTool);
    registerPredefinedToolGroups();

    // Collect all AnyAgentTool-formatted tools: catalog + subagent tools
    const { getSubagentTools } = await import('../agents/subagent-spawn-tool.js');
    const allTools = [...toolCatalog.getAll(), ...getSubagentTools()];
    assertToolSecurityCatalogCoverage(allTools);
    platformTools = allTools;
    let registeredCount = 0;

    for (const anyTool of allTools) {
      if (!isActorFacingTool(anyTool.name)) continue;
      const agentTool: Tool = {
        name: anyTool.name,
        description: anyTool.description,
        parameters: anyTool.parameters as Tool['parameters'],
        readOnly: isDeclarativelyReadOnlyTool(anyTool.name),
        concurrencySafe: !anyTool.ownerOnly,
        exclusive: false,
        scope: anyTool.scope, // Pass through scope for subagent filtering
        ownerOnly: anyTool.ownerOnly,
        group: anyTool.group,
        pluginId: anyTool.pluginId,
        requiresApproval: anyTool.requiresApproval,
        dangerLevel: anyTool.dangerLevel,
      execute: async () => {
          throw new Error('ACTOR_CONTEXT_REQUIRED');
        },
      };
      registry.register(agentTool);
      registeredCount++;
    }

    console.log(`[getAgentEngine] Loaded ${registeredCount} platform tools (catalog + subagent)`);
  } catch (err) {
    // Do not cache a partially discovered or empty registry. A transient
    // filesystem/import failure must be retriable on the next request.
    console.error(
      '[getAgentEngine] Could not load platform tools from catalog:',
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }

  platformToolRegistry = registry;
  toolsLoaded = true;
  return registry;
}

export interface CronToolAuthority {
  readonly actor: ActorContext;
  refreshActor(): Promise<ActorContext>;
}

/** A fresh registry per run, carrying an owner and a live authorization loader. */
export async function createCronToolRegistry(authority: CronToolAuthority): Promise<ToolRegistry> {
  if (!authority?.actor || authority.actor.userId <= 0) throw new Error('CRON_OWNER_REQUIRED');
  await loadPlatformTools();
  const registry = new ToolRegistry();
  let auditFailed = false;
  const { agentToolAuditService } = await import('../security/agent-tool-audit-service.js');
  const audit = { record: async (...args: Parameters<typeof agentToolAuditService.record>) => {
    try { await agentToolAuditService.record(...args); } catch (error) { auditFailed = true; throw error; }
  } };
  for (const anyTool of platformTools) {
    const security = getToolSecurityDefinition(anyTool.name);
    const isCompletion = anyTool.name === 'slide_complete_cron';
    // User Cron currently delegates database reads only. Server/network and
    // platform-wide evidence/source tools require a separate explicit capability.
    if (!isCompletion && !(security?.audience === 'actor' && security.effect === 'read'
      && security.resource === 'instance' && canActorDiscoverTool(authority.actor, anyTool))) continue;
    registry.register({
      name: anyTool.name, description: anyTool.description,
      parameters: anyTool.parameters as Tool['parameters'], readOnly: !isCompletion,
      concurrencySafe: !anyTool.ownerOnly, exclusive: false, scope: anyTool.scope,
      ownerOnly: anyTool.ownerOnly, group: anyTool.group, pluginId: anyTool.pluginId,
      requiresApproval: anyTool.requiresApproval, dangerLevel: anyTool.dangerLevel,
      execute: async (params: Record<string, unknown>, context?: CoreToolExecutionContext) => {
        if (auditFailed) throw new Error('AUDIT_UNAVAILABLE');
        const actor = await authority.refreshActor();
        if (context?.signal?.aborted) throw new Error('TOOL_EXECUTION_CANCELLED');
        if (isCompletion) {
          const decision = { allow: true, reasonCode: 'ALLOW' as const, actor: { userId: actor.userId, username: actor.username, roles: actor.roles },
            tool: anyTool.name, resource: { type: 'cron' as const }, requestId: actor.requestId };
          await audit.record({ phase: 'decision', actor, decision, args: params });
          const result = normalizeToolResult(await anyTool.handler(params, { actor, userId: actor.userId }), anyTool.name);
          await audit.record({ phase: 'result', actor, decision, args: params, result });
          return result;
        }
        const { resolveToolResource } = await import('../tools/resource-resolver.js');
        const resolveResource = async (name: string, args: Record<string, unknown>) => {
          const resource = await resolveToolResource(name, args);
          // query_metrics can name non-database resources despite its catalog type.
          return resource.serverId !== undefined || resource.networkDeviceId !== undefined
            ? { ...resource, error: 'RESOURCE_INVALID' as const } : resource;
        };
        let authorityError: Error | undefined;
        const guardedTool: AnyAgentTool = { ...anyTool, handler: async (args, toolContext) => {
          // Audit I/O may take time. Recheck current authority after that I/O,
          // immediately before the sensitive handler, as well as at call entry.
          const current = await authority.refreshActor().catch(error => {
            authorityError = error instanceof Error ? error : new Error(String(error));
            throw authorityError;
          });
          const decision = decideToolPolicy(current, anyTool, args, await resolveResource(anyTool.name, args), true, false);
          if (!decision.allow) {
            authorityError = new Error(decision.reasonCode);
            await audit.record({ phase: 'decision', actor: current, decision, args });
            return { success: false, errorCode: decision.reasonCode, error: 'Tool access denied' };
          }
          if (context?.signal?.aborted) throw new Error('TOOL_EXECUTION_CANCELLED');
          return anyTool.handler(args, { ...toolContext, actor: current, userId: current.userId, policyDecision: decision });
        } };
        const { decision, result } = await executeToolWithPolicy(actor, guardedTool, params,
          resolveResource, undefined, audit, undefined,
          { sessionKey: context?.sessionKey, signal: context?.signal, idempotencyKey: context?.idempotencyKey, progressCallback: context?.progressCallback });
        if (auditFailed) throw new Error('AUDIT_UNAVAILABLE');
        if (authorityError) throw authorityError;
        return { ...result, policyDecision: decision };
      },
    });
  }
  return registry;
}

/** Build the per-actor registry used by the production DirectAdapter. */
export function createActorBoundToolRegistry(actor: ActorContext, agentId = DEFAULT_AGENT_ID): ToolRegistry {
  const registry = new ToolRegistry();
  for (const anyTool of platformTools) {
    const security = getToolSecurityDefinition(anyTool.name);
    if (!security || !isActorFacingTool(anyTool.name) || !canActorDiscoverTool(actor, anyTool)
      || !agentSecurityPolicyService.evaluateTool(agentId, anyTool.name, security.effect).allowed) continue;
    registry.register({
      name: anyTool.name,
      description: anyTool.description,
      parameters: anyTool.parameters as Tool['parameters'],
      readOnly: isDeclarativelyReadOnlyTool(anyTool.name),
      concurrencySafe: !anyTool.ownerOnly,
      exclusive: false,
      scope: anyTool.scope,
      ownerOnly: anyTool.ownerOnly,
      group: anyTool.group,
      pluginId: anyTool.pluginId,
      requiresApproval: anyTool.requiresApproval,
      dangerLevel: anyTool.dangerLevel,
      execute: async (params: Record<string, unknown>, context?: CoreToolExecutionContext) => {
        const { decision, result } = await executeToolWithPolicy(actor, anyTool, params, undefined, undefined, undefined, agentId, {
          sessionKey: context?.sessionKey,
          signal: context?.signal,
          idempotencyKey: context?.idempotencyKey,
          progressCallback: context?.progressCallback,
        });
        return { ...result, policyDecision: decision };
      },
    });
  }
  return registry;
}

export async function getPlatformTool(toolName: string): Promise<AnyAgentTool | undefined> {
  await loadPlatformTools();
  return platformTools.find((tool) => tool.name === toolName);
}

// ── Adapter instance factories ──

/** Select the configured provider without changing process-wide environment. */
export async function createLLMProvider(purpose?: string): Promise<import('@slide/agent-core').LLMProvider> {
  const { llmDatabaseService } = await import('../llm-database-service.js');
  const { createConfiguredAgentProvider } = await import('./llm-provider-factory.js');
  return createConfiguredAgentProvider(llmDatabaseService, purpose ?? 'chat', true, purpose === undefined);
}

async function createDirectAdapter(): Promise<DirectAdapter> {
  console.log('[getAgentEngine] Creating DirectAdapter...');

  const provider = await createLLMProvider();
  const tools = await loadPlatformTools();
  const skillsLoader = new TrustedSkillsLoader(() =>
    filterRuntimeSkills(DEFAULT_AGENT_ID, skillRegistry.getAll()),
  );

  const adapter = new DirectAdapter({
    tools,
    toolsForActor: createActorBoundToolRegistry,
    llmProvider: provider,
    providerForPurpose: createLLMProvider,
    skillsLoader,
    workspace: process.env.AGENT_WORKSPACE || process.cwd(),
  });

  console.log('[getAgentEngine] DirectAdapter created');
  return adapter;
}

// ── Public API ──

/**
 * Get the active adapter type.
 */
export function getAdapterType(): 'direct' {
  return 'direct';
}

/**
 * Get or create the DirectAdapter singleton.
 *
 * @returns IAgentEngine instance (DirectAdapter)
 */
export async function getAgentEngine(): Promise<IAgentEngine> {
  if (!directEngine) {
    directEngine = await createDirectAdapter();
  }
  return directEngine;
}
