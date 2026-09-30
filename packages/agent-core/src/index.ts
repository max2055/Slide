/**
 * @slide/agent-core
 *
 * Production-grade TypeScript agent engine rewritten for Slide from the
 * original Python nanobot design; no original Python runtime or external
 * agent platform is required by this package.
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

export { ToolRegistry } from "./tool-registry.js";
export { migrateMessageParts, readMessageParts, restoreLegacyMessage, acknowledgeMessageParts, compatibleMessageParts, projectProviderMessages, hasMessageAttachments, statusForStopReason, AttachmentProjectionError } from './message-parts.js';
export type { MessageParts, MessagePart, PartStatus, PartBoundary, AttachmentSource, AttachmentBudget, ProviderPartPolicy } from './message-parts.js';
export { AgentRunner, NoopHook } from "./runner.js";
export { AgentRuntime } from './runtime/agent-runtime.js';
export { conservativePromptEstimate, conservativeTextTokens, estimateWithProvider, FamilyTokenCounter, tokenPayload } from './token-estimation.js';
export type { PromptTokenEstimate, TokenMethod } from './token-estimation.js';
export { resolveContextConfig, UNKNOWN_CONTEXT_WINDOW, openAIModelCapabilities, isNativeOpenAIEndpoint } from './model-context.js';
export type { ModelCapabilities } from './model-context.js';
export { StreamingCoordinator } from './runtime/streaming-coordinator.js';
export type { StreamingLimits, StreamingMetrics } from './runtime/streaming-coordinator.js';
export { createTurnState, transition, snapshotTurnState, restoreTurnState } from './runtime/turn-state.js';
export type { TurnState } from './runtime/turn-state.js';
export type { TurnPhase, RunControl, RuntimeStateSnapshot } from './runtime/contracts.js';
export { Session, SessionManager, AutoCompact } from "./session.js";
export { checkpointFacts } from './runtime/checkpoint.js';
export type { SessionEntry, SessionMetadata, SessionData, SessionManagerOptions, AutoCompactOptions } from "./session.js";
export { SkillsLoader } from "./skills.js";
export type { Skill, SkillMeta } from "./skills.js";
export { MemoryStore } from "./memory.js";
export { ContextBuilder } from "./context.js";
export { OpenAIProvider, normalizeProviderError } from "./openai-provider.js";
export type { NormalizedProviderError } from "./openai-provider.js";
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
  RuntimeResolution,
  // Checkpoint types
  RuntimeCheckpoint,
} from "./types.js";

export { RuntimeError, RecoveryPolicy, runtimeError, cancellationError } from "./runtime/recovery-policy.js";
export type { RecoverySnapshot, RecoveryLimits, RecoveryKind } from "./runtime/recovery-policy.js";

export type { RuntimeBudgetLimits } from './runtime/contracts.js';
export { reserveChildBudget } from './runtime/budget.js';

export type { RuntimeEvent } from './runtime/events.js';

export { projectContextBlocks, runtimeBlock, currentTime } from './context-block.js';
export type { ContextBlock } from './context-block.js';

export { StructuredMemoryStore, memoryHash } from './memory-record.js';
export type { MemoryKind, MemoryScope, MemorySource, MemoryRecord, MemoryCandidate, MemoryInput, MemoryJob, MemoryLimits } from './memory-record.js';
export { MemoryPipeline, ProviderMemoryExtractor, DEFAULT_MEMORY_LIMITS } from './memory-pipeline.js';
export type { MemoryExtractor, CommittedMemorySnapshot, MemorySourceReader } from './memory-pipeline.js';
export { MemoryRetriever, DEFAULT_RETRIEVAL_LIMITS, memoryReferenceTokens, emptyRetrieval } from './memory-retrieval.js';
export type { MemoryQuery, MemoryReference, MemoryRetrievalResult, MemoryRetrievalLimits } from './memory-retrieval.js';
export type { ContextRequest } from './context.js';

export type { StreamAnchor, StreamSnapshot, StreamReset } from './runtime/stream-boundary.js';
