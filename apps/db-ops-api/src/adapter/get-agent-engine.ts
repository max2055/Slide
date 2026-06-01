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

let directEngine: IAgentEngine | null = null;

// ── Platform tool loading (lazy, once) ──

let toolsLoaded = false;
let platformToolRegistry: ToolRegistry | null = null;

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
    // Trigger module-side registration of generated tools into toolCatalog
    await import('../tools/generated/slide-self-mgmt/index.js');
    // Register db-ops tools (get_instance_summary, list_active_alerts, query_metrics)
    await import('../tools/ops/index.js');
    // Register the cron completion tool (agent calls slide_complete_cron to save results)
    await import('../cron/cron-completion-tool.js');

    const { toolCatalog, registerPredefinedToolGroups } = await import('../tools/catalog.js');
    registerPredefinedToolGroups();

    // Collect all AnyAgentTool-formatted tools: catalog + subagent tools
    const { getSubagentTools } = await import('../agents/subagent-spawn-tool.js');
    const allTools = [...toolCatalog.getAll(), ...getSubagentTools()];
    let registeredCount = 0;

    for (const anyTool of allTools) {
      const agentTool: Tool = {
        name: anyTool.name,
        description: anyTool.description,
        parameters: anyTool.parameters as Tool['parameters'],
        readOnly: true,
        concurrencySafe: !anyTool.ownerOnly,
        exclusive: false,
        execute: async (params: Record<string, unknown>) => {
          const result = await anyTool.handler(params);
          // Extract meaningful data from ToolResult wrapper
          if (result && typeof result === 'object' && 'data' in result) {
            return (result as { data?: unknown }).data ?? result;
          }
          return result;
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

// ── Adapter instance factories ──

/**
 * Create an LLMProvider from the database-configured enabled provider.
 * Falls back to AnthropicProvider (env var) if no DB provider is enabled.
 */
export async function createLLMProvider(): Promise<import('@slide/agent-core').LLMProvider> {
  try {
    const { llmDatabaseService } = await import('../llm-database-service.js');
    const providers = await llmDatabaseService.getEnabledProviders();
    if (providers.length > 0) {
      const p = providers[0];
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

  const adapter = new DirectAdapter({
    tools,
    llmProvider: provider,
  });

  console.log('[getAgentEngine] DirectAdapter created');
  return adapter;
}

// ── Public API ──

/**
 * Always returns 'direct' — OpenClawAdapter has been removed.
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
