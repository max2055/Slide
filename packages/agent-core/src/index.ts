/**
 * @slide/agent-core
 *
 * Production-grade TypeScript agent engine ported from nanobot (HKUDS/nanobot).
 *
 * Core architecture:
 *   AgentRunner — LLM ↔ Tool execution loop with 6 key mechanisms
 *   ToolRegistry — dynamic tool registration, validation, and execution
 *   Session — per-conversation state container
 *   SessionManager — JSONL-persisted session store
 *   SkillsLoader — workspace skills discovery and loading
 *   MemoryStore — persistent memory context
 *   ContextBuilder — system prompt assembly from bootstrap files + memory + skills
 *
 * Key mechanisms:
 *   1. Parallel tool execution (concurrency_safe tools batched)
 *   2. Mid-turn message injection (pending queue)
 *   3. Interrupt recovery (checkpoint callbacks + restore)
 *   4. Context budget management (microcompact + snip)
 *   5. Structured tracing (tool events + usage)
 *   6. JSON Schema parameter validation
 *   7. Bidirectional checkpoint (send during execution, restore before turn)
 *   8. Tool auto-discovery (directory scan + dynamic import)
 *
 * Usage:
 *   const registry = new ToolRegistry();
 *   registry.register(myTool);
 *   const runner = new AgentRunner(llmProvider);
 *   const result = await runner.run({
 *     initialMessages: [...],
 *     tools: registry,
 *     model: "claude-sonnet-4-20250929",
 *     maxIterations: 10,
 *     maxToolResultChars: 20000,
 *     hook: new MyHook(),
 *   });
 */

export { ToolRegistry, validateJsonSchema, castToolParams, scanToolDir, importToolsFromDir } from "./tool-registry.js";
export { AgentRunner, NoopHook } from "./runner.js";
export { Session, SessionManager } from "./session.js";
export type { SessionEntry, SessionMetadata, SessionData } from "./session.js";
export { SkillsLoader } from "./skills.js";
export type { Skill, SkillMeta } from "./skills.js";
export { MemoryStore, Consolidator } from "./memory.js";
export { ContextBuilder } from "./context.js";
export { OpenAIProvider } from "./openai-provider.js";
export type {
  // Core types
  LLMProvider,
  LLMResponse,
  LLMCallOptions,
  StreamCallbacks,
  ToolCallRequest,
  Message,
  // Tool types
  Tool,
  ToolRegistry as IToolRegistry,
  ToolSchema,
  JsonSchemaProperty,
  // Hook types
  AgentHook,
  AgentHookContext,
  ToolEvent,
  // Run types
  AgentRunSpec,
  AgentRunResult,
  // Checkpoint types
  RuntimeCheckpoint,
} from "./types.js";
