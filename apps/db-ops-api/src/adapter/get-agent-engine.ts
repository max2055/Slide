/**
 * getAgentEngine() — IAgentEngine factory, DirectAdapter-only.
 *
 * The factory does NOT call .start() — that is the caller's responsibility
 * (server.ts calls engine.start() after the factory returns).
 */

import { ToolRegistry } from '@slide/agent-core';
import type { Tool } from '@slide/agent-core';
import type { IAgentEngine } from './types.js';
import { DirectAdapter } from './direct-adapter.js';
import type { ActorContext } from '../auth/actor-context.js';
import type { AnyAgentTool } from '../tools/types.js';
import { canActorDiscoverTool, executeToolWithPolicy } from '../tools/policy.js';
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
    console.warn(
      '[getAgentEngine] Could not load platform tools from catalog:',
      err instanceof Error ? err.message : String(err),
    );
  }

  platformToolRegistry = registry;
  toolsLoaded = true;
  return registry;
}

const cronActor: ActorContext = Object.freeze({
  userId: 0,
  username: 'slide-cron',
  roles: Object.freeze(['system']),
  permissions: Object.freeze(['instance:*', 'instance:view', 'servers:view', 'alert:view', 'metric:view']),
  sessionVersion: 0,
  instanceScopes: Object.freeze({}),
  requestId: 'cron-runtime',
});

const noPersistentSystemAudit = { record: async () => undefined };

/** Build the non-interactive Cron Agent registry from an explicit read-only posture. */
export async function createCronToolRegistry(): Promise<ToolRegistry> {
  await loadPlatformTools();
  const registry = new ToolRegistry();
  for (const anyTool of platformTools) {
    const security = getToolSecurityDefinition(anyTool.name);
    const isCompletion = anyTool.name === 'slide_complete_cron';
    if (!isCompletion && !(security?.audience === 'actor' && security.effect === 'read')) continue;
    registry.register({
      name: anyTool.name,
      description: anyTool.description,
      parameters: anyTool.parameters as Tool['parameters'],
      readOnly: !isCompletion,
      concurrencySafe: !anyTool.ownerOnly,
      exclusive: false,
      scope: anyTool.scope,
      ownerOnly: anyTool.ownerOnly,
      group: anyTool.group,
      pluginId: anyTool.pluginId,
      requiresApproval: anyTool.requiresApproval,
      dangerLevel: anyTool.dangerLevel,
      execute: async (params: Record<string, unknown>, context?: { sessionKey?: string }) => {
        if (isCompletion) return anyTool.handler(params, { actor: cronActor, userId: cronActor.userId });
        const { decision, result } = await executeToolWithPolicy(
          cronActor,
          anyTool,
          params,
          undefined,
          undefined,
          noPersistentSystemAudit,
        );
        if (!decision.allow) return { ...result, policyDecision: decision };
        return result && typeof result === 'object' && 'data' in result
          ? (result as { data?: unknown }).data ?? result
          : result;
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
      execute: async (params: Record<string, unknown>, context?: { sessionKey?: string }) => {
        const { decision, result } = await executeToolWithPolicy(actor, anyTool, params, undefined, undefined, undefined, agentId, {
          sessionKey: context?.sessionKey,
        });
        if (!decision.allow) return { ...result, policyDecision: decision };
        const value = result && typeof result === 'object' && 'data' in result
          ? (result as { data?: unknown }).data ?? result
          : result;
        return value && typeof value === 'object'
          ? { ...(value as Record<string, unknown>), policyDecision: decision }
          : { value, policyDecision: decision };
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

/**
 * Create an LLMProvider from the database-configured enabled provider.
 * Falls back to AnthropicProvider (env var) if no DB provider is enabled.
 */
export async function createLLMProvider(): Promise<import('@slide/agent-core').LLMProvider> {
  try {
    const { llmDatabaseService } = await import('../llm-database-service.js');
    const providers = await llmDatabaseService.getEnabledProviders();
    for (const p of providers) {
      const apiKey = await llmDatabaseService.getProviderApiKey(p.name);
      if (apiKey) {
        const model = p.default_model || undefined;
        const baseURL = p.api_base_url || undefined;
        const apiFormat = p.api_format || null;

        if (apiFormat === 'anthropic-messages') {
          process.env.ANTHROPIC_API_KEY = apiKey;
          if (model) process.env.ANTHROPIC_MODEL = model;
          const { AnthropicProvider } = await import('./llm-provider.js');
          console.log(`[getAgentEngine] Using AnthropicProvider (DB: ${p.display_name}, model: ${model})`);
          return new AnthropicProvider();
        }

        // OpenAI 兼容（openai-completions / null / 未知）
        const { OpenAIProvider } = await import('@slide/agent-core');
        console.log(`[getAgentEngine] Using OpenAIProvider (DB: ${p.display_name}, model: ${model}, baseURL: ${baseURL || 'default'})`);
        return new OpenAIProvider({ apiKey, baseURL, model });
      }
    }
  } catch (err) {
    console.warn('[getAgentEngine] Could not load DB provider:', err instanceof Error ? err.message : String(err));
  }

  // Fallback: env-var AnthropicProvider（DB 无可用 provider 时紧急兜底）
  console.error('[getAgentEngine] WARNING: No DB provider configured, falling back to ANTHROPIC_API_KEY env var. Please configure a provider in LLM settings.');
  const { AnthropicProvider } = await import('./llm-provider.js');
  return new AnthropicProvider();
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
