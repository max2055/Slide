import { boundedToolValue, buildToolPreview } from '@slide/agent-core/tool-stream';
import { projectionDocuments, reduceMessageProjection, type ProjectionOperation } from '@slide/agent-core/message-projection';
import { PARTS_STREAM_CAPABILITY, type DisplayCursor } from '@slide/agent-core/display-stream';
import { DisplayStreamAuthority, type DisplayStreamLimits } from './display-stream.js';
import { AdapterMessageProjection } from './message-projection.js';
import { persistedMessageParts } from './message-parts.js';
import { redactSensitiveText } from '../security/log-redaction.js';
import { BoundedSocketWriter } from './bounded-socket-writer.js';
import { orderedChatConsumer } from './chat-event-consumer.js';
import { BusinessMemoryService } from './memory-service.js';
import { resolveRuntimePolicy, runtimeSpec } from './runtime-policy.js';
/**
 * DirectAdapter — Default IAgentEngine implementation.
 *
 * Wraps @slide/agent-core AgentRunner behind the IAgentEngine interface.
 * Includes a minimal WebSocket transport service for chat streaming
 * (D-25 Option B — ~100 line standalone WS server, no Gateway dependency).
 *
 * Architecture:
 *   DirectAdapter
 *     ├── AgentRunner (LLM ↔ Tool execution loop)
 *     ├── ToolRegistry (tool registration + validation)
 *     ├── LLMProvider (Anthropic/SDK wrapper)
 *     ├── SessionManager (JSONL-persisted session state)
 *     ├── ContextBuilder (dynamic system prompt assembly)
 *     ├── SkillsLoader (workspace skill discovery)
 *     ├── MemoryStore (persistent memory context)
 *     └── WebSocketServer (minimal WS transport on AGENT_WS_PORT)
 */

import { canonicalStore } from './canonical-store.js';
import { ChatResponse } from './chat-response.js';
import { WebSocketServer, WebSocket } from 'ws';
import { recordRuntimeEvent } from '../platform/runtime-events.js';
import { platformLogs } from '../platform/structured-log-evidence-adapter.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import {
  resolveContextConfig,
  AgentRunner,
  NoopHook,
  ToolRegistry,
  SessionManager,
  Session,
  checkpointFacts,
  ContextBuilder,
  SkillsLoader,
  MemoryStore,
  cancellationError,
  RuntimeError,
} from '@slide/agent-core';
import type { AgentHook, AgentHookContext, Message, ToolSchema, RuntimeCheckpoint } from '@slide/agent-core';
import type { IAgentEngine, ChatEvent, ChatEventConsumer, AgentCapabilities, ChatResult, InvokeResult, InvokeOptions } from './types.js';
import { guardedAnalysisProvider } from '../analysis/analysis-provider.js';
import { chatDatabaseService } from '../chat-database-service.js';
import { SubagentManager } from '../agents/subagent-manager.js';
import { setSubagentManager } from '../agents/subagent-spawn-tool.js';
import {
  actorContextService,
  type ActorContext,
  type ActorContextService,
} from '../auth/actor-context.js';
import { validateChatSendV2 } from './protocol-v2.js';
import { agentRunService, type AgentRun } from './agent-run-service.js';
import { getDeviceAuthService } from '../security/device-auth-service.js';
import { completeAnalysisTool } from '../tools/generated/slide-self-mgmt/complete_analysis.js';
import { normalizeToolResult } from '../tools/types.js';
import {
  ActorConcurrencyLimiter,
  FixedWindowRateLimiter,
  loadAgentRuntimeLimits,
} from '../security/agent-runtime-limits.js';

let _subagentManagerInitialized = false;

function analysisCompletionTools(analysisId?: number, completion?: InvokeOptions['completeAnalysis']): ToolRegistry {
  const tools = new ToolRegistry();
  if (!Number.isSafeInteger(analysisId) || Number(analysisId) <= 0) return tools;
  tools.register({
    name: completeAnalysisTool.name,
    description: completeAnalysisTool.description,
    parameters: completeAnalysisTool.parameters as ToolSchema['parameters'],
    readOnly: false,
    concurrencySafe: true,
    exclusive: false,
    scope: completeAnalysisTool.scope,
    execute: async (args: Record<string, unknown>) => {
      if (Number(args.analysisId) !== analysisId) {
        return normalizeToolResult({ success: false, errorCode: 'ANALYSIS_BINDING_MISMATCH', error: 'Analysis target denied' }, completeAnalysisTool.name);
      }
      const result = completion ? await completion(args.envelope) : await completeAnalysisTool.handler({ ...args, analysisId });
      return normalizeToolResult({ ...result, ...(!result.success ? { errorCode: result.error } : {}) }, completeAnalysisTool.name);
    },
  });
  return tools;
}

// ── Helper: maps Hook tool events to ChatEvent ──

function mapHookEventToChatEvent(
  hook: Partial<AgentHook>,
  onEvent: ChatEventConsumer,
  thinkingHolder?: { text: string },
  streamHolder?: { text: string; safeContent?: string; resetSnapshot?: import('@slide/agent-core').StreamReset },
  partPrefix = 'live',
  projection?: AdapterMessageProjection,
): AgentHook {
  let reasoningActive = false;
  let segment = 0;
  let segmentText = streamHolder?.text ?? '';
  let toolBoundary = false;
  let sourceMessageId: string | undefined;
  return {
    wantsStreaming: () => true,
    beforeIteration: async () => {},
    onStream: async (_ctx: AgentHookContext, delta: string, signal?: AbortSignal) => {
      if (_ctx.messageId !== sourceMessageId) { sourceMessageId = _ctx.messageId; segment++; segmentText = ''; toolBoundary = false; }
      if (reasoningActive) {
        reasoningActive = false;
        await onEvent({ type: 'thinking_end' }, signal);
      }
      // Accumulate full text and send as delta so the frontend's chatStream
      // replacement renders as progressively building text (not flickering chars).
      if (toolBoundary) { segment++; segmentText = ''; toolBoundary = false; }
      segmentText += delta;
      if (streamHolder) streamHolder.text += delta;
      signal?.throwIfAborted();
      await onEvent({ type: 'text_delta', delta: streamHolder ? streamHolder.text : delta, partId: `${sourceMessageId ?? partPrefix}:text:${segment}`, partText: segmentText }, signal);
    },
    onCandidateRejected: async (ctx, safeContent) => {
      reasoningActive = false;
      segment++; segmentText = ''; toolBoundary = false;
      if (thinkingHolder) thinkingHolder.text = ctx.streamReset?.anchor?.reasoning ?? '';
      if (streamHolder) { streamHolder.text = safeContent; streamHolder.safeContent = safeContent; streamHolder.resetSnapshot = ctx.streamReset; }
      if (ctx.streamReset?.reasonCode.startsWith('STREAM_CONSUMER_')) return;
      await onEvent({ type: 'text_delta', delta: safeContent, partId: `${sourceMessageId ?? partPrefix}:text:${segment}`, partText: safeContent, reset: true, thinkingContent: thinkingHolder?.text ?? '',
        anchorId: ctx.streamReset?.anchor?.checkpointId, sourceRequestId: ctx.sourceRequestId, discardedBytes: ctx.streamReset?.discardedBytes });
    },
    onStreamEnd: async (ctx, resuming) => {
      if (!projection) return;
      const operations: ProjectionOperation[] = [];
      if (!ctx.streamedContent && ctx.response?.content) {
        operations.push({ type: 'part.start', messageId: projection.currentMessageId,
          part: { id: `${projection.currentMessageId}/batch-text`, source: 'fact', status: 'partial', type: 'text', text: ctx.response.content } });
        operations.push({ type: 'part.end', partId: `${projection.currentMessageId}/batch-text` });
      }
      operations.push(...projection.end());
      if (resuming && ctx.toolCalls.length) for (const call of ctx.toolCalls) {
        operations.push({ type: 'tool.state', messageId: projection.currentMessageId, partId: `${projection.currentMessageId}/tool/${call.id}`,
          event: { toolCallId: call.id, name: call.name, phase: 'planned', occurredAt: Date.now(), args: boundedToolValue(call.arguments, redactSensitiveText) as Record<string, unknown> } });
      }
      if (operations.length) await onEvent({ type: 'message_parts', operations });
    },
    onToolInput: async (_ctx, delta, signal) => {
      if (!projection) return;
      const operations = projection.input(delta);
      if (operations.length) await onEvent({ type: 'message_parts', operations }, signal);
    },
    beforeExecuteTools: async () => { toolBoundary = true; },
    emitReasoning: async (text: string | null, signal?: AbortSignal) => {
      if (text) {
        reasoningActive = true;
        if (thinkingHolder) thinkingHolder.text += text;
        await onEvent({ type: 'thinking_delta', delta: text }, signal);
      }
    },
    emitReasoningEnd: async () => {
      // Only insert separator if reasoning text was accumulated (WR-08)
      if (!reasoningActive) return;
      reasoningActive = false;
      await onEvent({ type: 'thinking_end' });
    },
    afterIteration: async () => {},
    finalizeContent: (_ctx: AgentHookContext, content: string | null) => content,
    ...hook,
  };
}

// ── Helper: normalize frontend thinking level to LLM reasoningEffort ──

/**
 * Map frontend thinking level value to OpenAI/Anthropic reasoning_effort parameter.
 *   "" / "off" / "adaptive" → undefined (not passed → model default)
 *   "minimal" / "low" / "medium" / "high" → pass through
 */
function normalizeThinkingLevel(level?: string): string | undefined {
  if (!level || level === '' || level === 'off' || level === 'adaptive') return undefined;
  const valid = new Set(['minimal', 'low', 'medium', 'high']);
  return valid.has(level) ? level : undefined;
}

// ── DirectAdapter Options ──

export interface DirectAdapterOptions {
  /** Opt in to existing concurrencySafe batch scheduling; serial remains default. */
  concurrentTools?: boolean;
  tools: ToolRegistry;
  /** Builds an actor-bound registry so LLM calls cannot supply their own identity. */
  toolsForActor?: (actor: ActorContext) => ToolRegistry;
  llmProvider: import('@slide/agent-core').LLMProvider;
  providerForPurpose?: (purpose?: string) => Promise<import('@slide/agent-core').LLMProvider>;
  workspace?: string;              // workspace root path (defaults to process.cwd())
  sessionManager?: SessionManager; // optional, created from workspace if not provided
  contextBuilder?: ContextBuilder; // optional, created from workspace if not provided
  skillsLoader?: SkillsLoader;     // optional, created from workspace if not provided
  memoryStore?: MemoryStore;       // optional, created from workspace if not provided
  actorContextService?: Pick<ActorContextService, 'authenticateAccessToken' | 'revalidateActor'>;
  heartbeatIntervalMs?: number;
  streamingLimits?: import('@slide/agent-core').StreamingLimits;
  displayStreamLimits?: Partial<DisplayStreamLimits>;
  socketWriteLimits?: import('./bounded-socket-writer.js').SocketWriteLimits;
  memoryWorkspaceId?: string;
  memoryPipeline?: import('@slide/agent-core').MemoryPipeline;
  memoryRetrievalLimits?: Partial<import('@slide/agent-core').MemoryRetrievalLimits>;
}

// ── DirectAdapter ──

export class DirectAdapter implements IAgentEngine {
  private readonly concurrentTools: boolean;
  private runner: AgentRunner;
  private readonly socketWriter: BoundedSocketWriter;
  private readonly streamingLimits?: import('@slide/agent-core').StreamingLimits;
  private businessMemory: BusinessMemoryService;
  private providerForPurpose?: DirectAdapterOptions['providerForPurpose'];
  private registry: ToolRegistry;
  private toolsForActor?: (actor: ActorContext) => ToolRegistry;
  private provider: import('@slide/agent-core').LLMProvider;
  private sessionManager: SessionManager;
  private contextBuilder: ContextBuilder;
  private skillsLoader: SkillsLoader;
  private memoryStore: MemoryStore;
  private actorContexts: Pick<ActorContextService, 'authenticateAccessToken' | 'revalidateActor'>;
  private heartbeatIntervalMs: number;
  private readonly policies = { chat: resolveRuntimePolicy('chat'), invoke: resolveRuntimePolicy('invoke') };
  private readonly runtimeLimits = loadAgentRuntimeLimits();
  private readonly runLimiter = new ActorConcurrencyLimiter(this.runtimeLimits.maxConcurrentRunsPerActor);
  private wsServer: WebSocketServer | null = null;
  private readonly displayStreams: DisplayStreamAuthority<WebSocket>;
  private readonly partsPeers = new WeakSet<WebSocket>();
  private activeRuns = new Map<string, { actorId: number; sessionId: string; controller: AbortController }>();
  private sessionOperations = new Map<string, Set<Promise<void>>>();
  private sessionLocks = new Map<string, Promise<void>>();
  /** Track WebSocket clients subscribed to each session for invoke() broadcast. */
  private sessionSubscribers = new Map<string, Set<WebSocket>>();

  private sendSocketEvent(ws: WebSocket, payload: Record<string, unknown>): boolean {
    if (this.partsPeers.has(ws) && payload.type === 'run.snapshot') {
      const run = payload.run as AgentRun;
      // Durable status is separate from the bounded display snapshot. Large
      // stored answers are read through authorized paginated history.
      payload = { ...payload, run: { id: run.id, sessionId: run.sessionId, messageId: run.messageId,
        idempotencyKey: run.idempotencyKey, state: run.state,
        ...(run.result && (run.result as { completionPending?: boolean }).completionPending ? { result: { completionPending: true } } : {}) } };
    }
    return this.socketWriter.send(ws, JSON.stringify(payload));
  }

  constructor(opts: DirectAdapterOptions) {
    this.runner = new AgentRunner(opts.llmProvider);
    this.displayStreams = new DisplayStreamAuthority(opts.displayStreamLimits);
    this.streamingLimits = opts.streamingLimits;
    this.socketWriter = new BoundedSocketWriter(opts.socketWriteLimits, code => {
      platformLogs.record({ component: 'ws', eventType: 'stream.delivery_failed', status: 'failed', errorCode: code });
    });
    this.providerForPurpose = opts.providerForPurpose;
    this.registry = opts.tools;
    this.toolsForActor = opts.toolsForActor;
    this.provider = opts.llmProvider;
    this.concurrentTools = opts.concurrentTools === true;
    this.actorContexts = opts.actorContextService || actorContextService;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs || 30_000;

    const workspace = opts.workspace || process.cwd();
    this.memoryStore = opts.memoryStore || new MemoryStore(workspace);
    this.businessMemory = new BusinessMemoryService(workspace, opts.memoryWorkspaceId ?? process.env.SLIDE_MEMORY_WORKSPACE_ID,
      async () => this.providerForPurpose ? this.providerForPurpose('memory') : this.provider, opts.memoryPipeline, opts.memoryRetrievalLimits);
    this.skillsLoader = opts.skillsLoader || new SkillsLoader(workspace);
    this.sessionManager = opts.sessionManager || new SessionManager(workspace);
    this.contextBuilder = opts.contextBuilder || new ContextBuilder(workspace, {
      memoryStore: this.memoryStore,
      skillsLoader: this.skillsLoader,
      memoryRetrievalLimits: this.businessMemory.retriever.limits,
    });
  }

  /** Post-commit maintenance cannot change chat's durable terminal outcome. */
  async extractCompletedMemory(actor: ActorContext, sessionId: string, runId: string, signal?: AbortSignal): Promise<void> {
    try { await this.businessMemory.completed(actor, sessionId, runId, signal); }
    catch { platformLogs.record({ component: 'agent', eventType: 'memory.extraction_failed', status: 'failed', correlationId: runId }); }
  }

  // ── start() — minimal WS transport (D-25 Option B) ──

  async start(): Promise<void> {
    // Initialize SubagentManager so spawn_subagent tool can actually execute subagents
    if (!_subagentManagerInitialized) {
      const subagentManager = new SubagentManager(this.runner, undefined, this.toolsForActor);
      setSubagentManager(subagentManager);
      _subagentManagerInitialized = true;
      console.log(`[DirectAdapter] SubagentManager initialized with ${this.registry.toolNames.length} parent tools`);
    }

    // Idempotent guard
    if (this.wsServer) {
      console.log('[DirectAdapter] WS transport already running, skipping start()');
      return;
    }

    const port = parseInt(process.env.AGENT_WS_PORT || '28888', 10);

    // Bind explicitly for container-to-container connections. Relying on the
    // runtime default can bind the listener to an IPv6-only address, which
    // makes the frontend proxy see an abnormal 1006 close.
    this.wsServer = new WebSocketServer({
      host: process.env.AGENT_WS_HOST || '0.0.0.0',
      port,
      maxPayload: this.runtimeLimits.wsMaxPayloadBytes,
    });

    // Serve basic HTTP endpoints (the frontend fetches /__slide/control-ui-config.json
    // which is proxied to this port). Without this, the WS-only server returns 426.
    const httpServer = (this.wsServer as any)._server;
    if (httpServer) {
      const origListeners = httpServer.listeners('request').slice();
      httpServer.removeAllListeners('request');
      httpServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
        if (req.url === '/__slide/control-ui-config.json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            basePath: '/',
            assistantName: 'Slide',
            assistantAvatar: '',
            assistantAgentId: 'slide-db-ops',
            serverVersion: '1.0.0',
          }));
          return;
        }
        // Fall back to ws's internal handling for upgrade requests
        for (const fn of origListeners) {
          fn.call(httpServer, req, res);
        }
      });
    }

    this.wsServer.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const connectionId = randomUUID();
      const connectedAt = new Date().toISOString();
      platformLogs.record({ component: 'ws', eventType: 'connection.opened', status: 'ok', correlationId: connectionId, releaseId: process.env.SLIDE_RELEASE_ID });
      const pendingMessages = new Map<string, string>();
      const subscriptionRequests = new Map<string, string>();
      console.log('[DirectAdapter] WS client connected', JSON.stringify({
        connectionId,
        connectedAt,
        remoteAddress: req.socket.remoteAddress,
        remotePort: req.socket.remotePort,
        localAddress: req.socket.localAddress,
        localPort: req.socket.localPort,
      }));
      (ws as any)._isAlive = true;
      type ConnectionAuthState = 'unauthenticated' | 'authenticating' | 'authenticated' | 'closed';
      let authState: ConnectionAuthState = 'unauthenticated';
      let authGeneration = 0;
      let connectionActor: ActorContext | undefined;
      let authenticatedUserId: number | null = null;
      let revalidationInFlight = false;
      const frameLimiter = new FixedWindowRateLimiter(
        this.runtimeLimits.wsFramesPerWindow,
        this.runtimeLimits.wsRateWindowMs,
      );
      const authTimer = setTimeout(() => {
        if (authState === 'unauthenticated' || authState === 'authenticating') {
          closeAfterAuthFailure(4001, 'Authentication timeout');
        }
      }, this.runtimeLimits.authTimeoutMs);
      (ws as any)._authState = authState;
      (ws as any)._actorContext = undefined;

      const subscribeToSession = (sessionKey: string, subscriptionId?: string) => {
        if (!this.sessionSubscribers.has(sessionKey)) {
          this.sessionSubscribers.set(sessionKey, new Set());
        }
        this.sessionSubscribers.get(sessionKey)!.add(ws);
        if (this.partsPeers.has(ws)) this.displayStreams.watch(ws, sessionKey, subscriptionRequests.get(sessionKey) ?? subscriptionId ?? randomUUID(),
          event => this.socketWriter.send(ws, JSON.stringify(event)));
      };

      const sendToSession = (sessionKey: string, payload: Record<string, unknown>) => {
        const projection = payload.projection as import('@slide/agent-core/message-projection').ProjectionFrame | undefined;
        if (projection) this.displayStreams.publish(sessionKey, projection);
        const serialized = JSON.stringify(payload);
        for (const subscriber of this.sessionSubscribers.get(sessionKey) ?? []) {
          if (subscriber.readyState !== WebSocket.OPEN || projection && this.partsPeers.has(subscriber)) continue;
          try {
            if (this.partsPeers.has(subscriber)) this.sendSocketEvent(subscriber, payload);
            else this.socketWriter.send(subscriber, serialized);
          } catch { /* close logging captures the transport failure */ }
        }
      };

      const clearAuthentication = () => {
        authGeneration += 1;
        authState = 'closed';
        connectionActor = undefined;
        revalidationInFlight = false;
        (ws as any)._authState = authState;
        (ws as any)._actorContext = undefined;
        (ws as any)._revalidationInFlight = false;
      };

      const closeAfterAuthFailure = (code: number, reason: string) => {
        clearAuthentication();
        if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
      };

      // Heartbeat and authorization revalidation share the existing 30s cycle.
      const heartbeatTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if ((ws as any)._isAlive === false) {
          console.warn('[DirectAdapter] WS heartbeat timeout, terminating connection');
          clearAuthentication();
          ws.terminate();
          return;
        }

        if (authState === 'authenticated' && connectionActor && !revalidationInFlight) {
          const revalidationGeneration = authGeneration;
          const actorAtStart = connectionActor;
          revalidationInFlight = true;
          (ws as any)._revalidationInFlight = true;
          void this.actorContexts.revalidateActor(
            actorAtStart,
            randomUUID(),
          ).then((nextActor) => {
            if (ws.readyState === WebSocket.OPEN
              && authState === 'authenticated'
              && authGeneration === revalidationGeneration) {
              connectionActor = nextActor;
              (ws as any)._actorContext = nextActor;
            }
          }).catch(() => {
            if (authState === 'authenticated' && authGeneration === revalidationGeneration) {
              closeAfterAuthFailure(4001, 'Unauthorized');
            }
          }).finally(() => {
            if (authGeneration === revalidationGeneration) {
              revalidationInFlight = false;
              (ws as any)._revalidationInFlight = false;
            }
          });
        }

        (ws as any)._isAlive = false;
        ws.ping();
      }, this.heartbeatIntervalMs);

      ws.on('pong', () => {
        (ws as any)._isAlive = true;
      });

      ws.on('close', (code, reasonBuffer) => {
        platformLogs.record({ component: 'ws', eventType: 'connection.closed', status: code === 1000 || code === 1001 ? 'ok' : 'unknown',
          correlationId: connectionId, errorCode: `WS_${code}`, releaseId: process.env.SLIDE_RELEASE_ID });
        console.warn('[DirectAdapter] WebSocket closed', JSON.stringify({
          timestamp: new Date().toISOString(),
          connectionId,
          connectedAt,
          code,
          reasonBytes: reasonBuffer.length,
          wasClean: code !== 1006,
          userId: authenticatedUserId,
          pendingMessages: [...pendingMessages].map(([messageId, idempotencyKey]) => ({ messageId, idempotencyKey })),
        }));
        clearTimeout(authTimer);
        clearInterval(heartbeatTimer);
        clearAuthentication();
        this.displayStreams.unwatch(ws);
        // Unsubscribe from all session broadcasts
        for (const [key, subs] of this.sessionSubscribers) {
          subs.delete(ws);
          if (!subs.size) this.sessionSubscribers.delete(key);
        }
      });

      const handleMessage = async (raw: Buffer) => {
        if (authState === 'closed' || ws.readyState !== WebSocket.OPEN) return;
        if (!frameLimiter.allow()) {
          ws.close(4008, 'Rate limit exceeded');
          return;
        }
        let msg: { type?: string; sessionKey?: string; message?: string; [key: string]: unknown };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          this.sendSocketEvent(ws, { type: 'error', error: 'Invalid JSON' });
          return;
        }

        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
          this.sendSocketEvent(ws, { type: 'error', error: 'Invalid message envelope' });
          return;
        }

        // D-09/D-10: JWT auth frame -- must be first message after WS connect
        if (msg.type === 'auth') {
          if (authState !== 'unauthenticated') {
            closeAfterAuthFailure(4001, 'Authentication already attempted');
            return;
          }
          const token = msg.token as string;
          const JWT_SECRET = process.env.JWT_SECRET_KEY;
          if (!JWT_SECRET) {
            console.error('[DirectAdapter] JWT_SECRET_KEY not set, rejecting all auth');
            closeAfterAuthFailure(4001, 'Server misconfigured: JWT_SECRET_KEY not set');
            return;
          }
          authState = 'authenticating';
          authGeneration += 1;
          const authenticationGeneration = authGeneration;
          (ws as any)._authState = authState;
          try {
            const authenticatedActor = await this.actorContexts.authenticateAccessToken(
              token,
              JWT_SECRET,
              randomUUID(),
            );
            const deviceAuth = (msg as any).deviceAuth;
            if (deviceAuth && !(await getDeviceAuthService().verify(authenticatedActor, {
              ...deviceAuth,
              method: 'GET',
              path: '/ws/auth',
              body: '',
            }))) {
              closeAfterAuthFailure(4001, 'Device authentication failed');
              return;
            }
            if (ws.readyState === WebSocket.OPEN
              && authState === 'authenticating'
              && authGeneration === authenticationGeneration) {
              connectionActor = authenticatedActor;
              authenticatedUserId = authenticatedActor.userId;
              authState = 'authenticated';
              (ws as any)._actorContext = authenticatedActor;
              (ws as any)._authState = authState;
              clearTimeout(authTimer);
              const partsEnabled = process.env.SLIDE_PARTS_STREAM_ENABLED !== 'false' && Array.isArray(msg.capabilities) && msg.capabilities.includes(PARTS_STREAM_CAPABILITY);
              if (partsEnabled) this.partsPeers.add(ws);
              this.sendSocketEvent(ws, { type: 'auth_ok', ...(partsEnabled ? { capabilities: [PARTS_STREAM_CAPABILITY] } : {}) });
              console.log('[DirectAdapter] WS authenticated', JSON.stringify({ connectionId, userId: authenticatedUserId }));
            }
          } catch {
            if (authGeneration === authenticationGeneration) {
              closeAfterAuthFailure(4001, 'Unauthorized');
            }
          }
          return;
        }

        // D-11: Reject unauthenticated messages before auth
        if (authState !== 'authenticated' || !connectionActor) {
          closeAfterAuthFailure(4002, 'Authenticate first');
          return;
        }

        // Receipt order wins over asynchronous authorization/admission completion.
        if (this.partsPeers.has(ws) && ['chat.watch', 'chat.send'].includes(msg.type) && typeof msg.sessionKey === 'string'
          && typeof msg.subscriptionId === 'string' && msg.subscriptionId.length > 0 && msg.subscriptionId.length <= 512) {
          subscriptionRequests.set(msg.sessionKey, msg.subscriptionId);
          while (subscriptionRequests.size > this.displayStreams.limits.maxSubscriptionsPerPeer) subscriptionRequests.delete(subscriptionRequests.keys().next().value!);
        }

        // A connection may outlive a user disablement or role/session change.
        // Revalidate before every command so revocation takes effect without
        // waiting for the heartbeat interval.
        try {
          connectionActor = await this.actorContexts.revalidateActor(
            connectionActor,
            randomUUID(),
          );
          (ws as any)._actorContext = connectionActor;
        } catch {
          closeAfterAuthFailure(4001, 'Unauthorized');
          return;
        }

        switch (msg.type) {
          case 'chat.send': {
            if ((msg as any).protocolVersion === 2) {
              const parsed = validateChatSendV2(msg);
              if (!parsed.ok) {
                this.sendSocketEvent(ws, { type: 'protocol.error', code: 'error' in parsed ? parsed.error : 'PROTOCOL_INVALID' });
                return;
              }
            } else if ((msg as any).protocolVersion !== undefined) {
              this.sendSocketEvent(ws, { type: 'protocol.error', code: 'PROTOCOL_VERSION_UNSUPPORTED' });
              return;
            }
            const messageActor = connectionActor;
            const rawSessionKey = (msg.sessionKey as string | undefined)?.trim() || '';
            // Validate sessionKey length to prevent resource exhaustion (WR-03)
            if (rawSessionKey.length > 512) {
              this.sendSocketEvent(ws, { type: 'error', error: 'Session key too long' });
              return;
            }
            // Parse session key (agent format): agent:<agentId>:<actualKey> → actualKey
            let sessionKey = rawSessionKey.startsWith('agent:')
              ? rawSessionKey.split(':').slice(2).join(':') || rawSessionKey
              : rawSessionKey;
            const userMessage = (msg.message as string) || '';
            if (!userMessage) {
              this.sendSocketEvent(ws, { type: 'error', error: 'Message is required' });
              return;
            }
            if (userMessage.length > this.runtimeLimits.maxMessageChars) {
              this.sendSocketEvent(ws, { type: 'protocol.error', code: 'MESSAGE_TOO_LARGE' });
              return;
            }

            const idempotencyKey = msg.idempotencyKey as string | undefined;
            const messageId = msg.messageId as string | undefined;
            if (idempotencyKey && messageId) {
              pendingMessages.set(messageId, idempotencyKey);
              try {
                let existingRun = await agentRunService.findByIdempotencyKey(
                  messageActor.userId,
                  idempotencyKey,
                );
                if (existingRun) {
                  if (existingRun.messageId !== messageId
                    || (rawSessionKey && existingRun.sessionId !== sessionKey)) {
                    this.sendSocketEvent(ws, { type: 'protocol.error', code: 'IDEMPOTENCY_CONFLICT' });
                    return;
                  }
                  await chatDatabaseService.authorizeSession(messageActor, existingRun.sessionId, 'append');
                  subscribeToSession(existingRun.sessionId);
                  try {
                    existingRun = await agentRunService.recoverCompletion(existingRun);
                  } catch {
                    this.sendSocketEvent(ws, { type: 'run.snapshot', run: existingRun, messageId, sessionKey: existingRun.sessionId });
                    this.sendSocketEvent(ws, { type: 'error', code: 'COMPLETION_STORAGE_FAILED', retryable: true,
                      error: '回答保存未确认，请重试或重连恢复。', runId: existingRun.id, sessionKey: existingRun.sessionId });
                    return;
                  }
                  this.sendSocketEvent(ws, {
                    type: 'run.snapshot',
                    run: existingRun,
                    messageId,
                    sessionKey: existingRun.sessionId,
                  });
                  if (existingRun.state === 'completed') await this.extractCompletedMemory(messageActor, existingRun.sessionId, existingRun.id);
                  return;
                }
              } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                this.sendSocketEvent(ws, { type: 'error', error: errorMsg });
                return;
              }
            }

            if (!this.runLimiter.acquire(messageActor.userId)) {
              this.sendSocketEvent(ws, { type: 'protocol.error', code: 'RUN_CONCURRENCY_LIMIT' });
              return;
            }

            const controller = new AbortController();
            const chatPolicy = this.policies.chat;
            const runTimeout = chatPolicy.runTimeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new Error('CHAT_TIMED_OUT')), chatPolicy.runTimeoutMs);

            let persistentRun: { run: AgentRun; created: boolean } | undefined;
            let completionAttempted = false;
            try {
              if (!sessionKey) {
                const created = await chatDatabaseService.createSession(messageActor, { title: '新会话' });
                sessionKey = created.session_id;
                this.sendSocketEvent(ws, { type: 'session.created', sessionKey, messageId });
              } else {
                await chatDatabaseService.authorizeSession(messageActor, sessionKey, 'append');
              }

              persistentRun = idempotencyKey && messageId
                ? await agentRunService.claim(messageActor.userId, sessionKey, messageId, idempotencyKey)
                : undefined;
              if (persistentRun && !persistentRun.created) {
                if (persistentRun.run.messageId !== messageId) {
                  this.sendSocketEvent(ws, { type: 'protocol.error', code: 'IDEMPOTENCY_CONFLICT' });
                  return;
                }
                sessionKey = persistentRun.run.sessionId;
                await chatDatabaseService.authorizeSession(messageActor, sessionKey, 'append');
                persistentRun.run = await agentRunService.recoverCompletion(persistentRun.run);
                subscribeToSession(sessionKey, typeof msg.subscriptionId === 'string' ? msg.subscriptionId : undefined);
                this.sendSocketEvent(ws, {
                  type: 'run.snapshot',
                  run: persistentRun.run,
                  messageId,
                  sessionKey,
                });
                if (persistentRun.run.state === 'completed') await this.extractCompletedMemory(messageActor, sessionKey, persistentRun.run.id, controller.signal);
                return;
              }
              if (persistentRun) {
                this.activeRuns.set(persistentRun.run.id, { actorId: messageActor.userId, sessionId: sessionKey, controller });
                subscribeToSession(sessionKey, typeof msg.subscriptionId === 'string' ? msg.subscriptionId : undefined);
                this.sendSocketEvent(ws, { type: 'run.started', runId: persistentRun.run.id, sessionKey, messageId });
              }

              const userFactId = persistentRun ? `run_${persistentRun.run.id}_user` : `msg_${randomUUID()}_user`;
              await chatDatabaseService.addMessage(messageActor, sessionKey, {
                messageId: userFactId,
                role: 'user',
                content: userMessage,
                metadata: { canonicalRunId: persistentRun?.run.id ?? userFactId, canonicalTurnId: userFactId },
              });

              // Authorization succeeds before the connection joins broadcasts.
              subscribeToSession(sessionKey, typeof msg.subscriptionId === 'string' ? msg.subscriptionId : undefined);

              let completionEvent: Extract<ChatEvent, { type: 'complete' }> | undefined;
              let failureEvent: Extract<ChatEvent, { type: 'error' | 'cancelled' }> | undefined;
              const response = new ChatResponse();
              const chatResult = await this.chat(sessionKey, userMessage, async (event) => {
                response.observe(event);
                // Normal completion uses the durable commit and replay path below.
                if (event.type === 'complete') { completionEvent = event; return; }
                if (event.type === 'cancelled' || event.type === 'error') {
                  const assistant = response.message();
                  if (assistant) {
                    event = { ...event, messageSequence: await chatDatabaseService.addMessage(messageActor, sessionKey, {
                      messageId: event.messageParts?.id ?? `msg_${randomUUID()}_asst`,
                      role: 'assistant',
                      ...assistant,
                      metadata: { ...assistant.metadata, stopReason: event.type === 'cancelled' ? 'cancelled' : 'failed', canonicalRunId: persistentRun?.run.id, canonicalTurnId: userFactId },
                      parentId: userFactId,
                    }) };
                  }
                }
                // Reconnect must observe the durable terminal state as soon as
                // the client receives a failure/cancellation event.
                if (persistentRun && (event.type === 'error' || event.type === 'cancelled')) {
                  failureEvent = event;
                  return;
                }
                sendToSession(sessionKey, {
                  ...event,
                  ...(persistentRun ? { runId: persistentRun.run.id, sessionKey } : {}),
                });
              }, messageActor, controller.signal, idempotencyKey, persistentRun?.run.id, userFactId);
              if (chatResult.stopReason === 'completed') {
                completionAttempted = true;
                const event = completionEvent ?? { type: 'complete' as const, finalContent: chatResult.finalContent ?? '', resolution: chatResult.resolution };
                if (persistentRun) {
                  const committed = await agentRunService.complete(persistentRun.run, event);
                  sendToSession(sessionKey, { type: 'run.snapshot', run: committed, messageId, sessionKey });
                  if (committed.state === 'completed') {
                    sendToSession(sessionKey, { ...(committed.result as { event: ChatEvent }).event, runId: committed.id, sessionKey });
                    await this.extractCompletedMemory(messageActor, sessionKey, committed.id, controller.signal);
                  }
                } else {
                  if (event.finalContent || event.thinkingContent) {
                    const content = event.thinkingContent
                      ? `<think>${event.thinkingContent}</think>\n\n${event.finalContent || ''}` : event.finalContent!;
                    event.messageSequence = await chatDatabaseService.addMessage(messageActor, sessionKey, {
                      messageId: event.messageParts?.id ?? `msg_${randomUUID()}_asst`, role: 'assistant', content, parentId: userFactId,
                      metadata: { canonicalRunId: event.messageParts?.runId, canonicalTurnId: userFactId, messageParts: event.messageParts },
                    });
                    if (event.messageParts) {
                      event.messageParts = persistedMessageParts({ ...event.messageParts.legacy, messageParts: event.messageParts, metadata: { stopReason: 'completed' } } as import('@slide/agent-core').SessionEntry).messageParts;
                      if (event.projection) event.projection = { ...event.projection, operations: [...event.projection.operations,
                        { type: 'parts.persisted', documents: projectionDocuments([event.messageParts!]) },
                        { type: 'run.terminal', outcome: 'completed', durable: event.messageParts!.durable }] };
                    }
                  }
                  sendToSession(sessionKey, { ...event });
                }
              }
              if (persistentRun && chatResult.stopReason !== 'completed') {
                const terminal = chatResult.stopReason === 'max_iterations' ? 'partial'
                  : chatResult.stopReason === 'cancelled' ? 'cancelled'
                  : chatResult.stopReason === 'timed_out' ? 'timed_out'
                  : 'failed';
                await agentRunService.finish(persistentRun.run.id, terminal, { stopReason: chatResult.stopReason, resolution: chatResult.resolution });
                this.activeRuns.delete(persistentRun.run.id);
                if (failureEvent) sendToSession(sessionKey, { ...failureEvent, runId: persistentRun.run.id, sessionKey });
              }
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              // A failed chat retains its run record so replay returns the terminal snapshot.
              if (persistentRun?.created) {
                try {
                  if (completionAttempted) await agentRunService.failUnstagedCompletion(persistentRun.run.id);
                  else await agentRunService.finish(persistentRun.run.id, 'failed', undefined, { message: errorMsg });
                  this.activeRuns.delete(persistentRun.run.id);
                } catch { /* preserve the original request failure */ }
              }
              const failure = { type: 'error', error: completionAttempted ? '回答保存未确认，请重试或重连恢复。' : errorMsg,
                ...(completionAttempted ? { code: 'COMPLETION_STORAGE_FAILED', retryable: true } : {}),
                ...(persistentRun ? { runId: persistentRun.run.id, sessionKey } : {}),
              };
              if (this.sessionSubscribers.get(sessionKey)?.has(ws)) sendToSession(sessionKey, failure);
              else if (ws.readyState === WebSocket.OPEN) this.socketWriter.send(ws, JSON.stringify(failure));
            } finally {
              if (persistentRun?.created) this.activeRuns.delete(persistentRun.run.id);
              clearTimeout(runTimeout);
              const unsettled = this.sessionOperations.get(sessionKey);
              if (unsettled?.size) void Promise.all(unsettled).then(() => this.runLimiter.release(messageActor.userId));
              else this.runLimiter.release(messageActor.userId);
              if (messageId) pendingMessages.delete(messageId);
            }
            break;
          }

          case 'chat.cancel': {
            const runId = typeof msg.runId === 'string' ? msg.runId : '';
            const cancelSession = typeof msg.sessionKey === 'string' ? msg.sessionKey : '';
            const active = this.activeRuns.get(runId);
            if (!active || active.actorId !== connectionActor.userId || active.sessionId !== cancelSession) {
              this.sendSocketEvent(ws, { type: 'protocol.error', code: 'RUN_NOT_CANCELLABLE' });
              return;
            }
            if (await agentRunService.cancelForActor(runId, connectionActor.userId, cancelSession)) {
              active.controller.abort();
            } else this.sendSocketEvent(ws, { type: 'protocol.error', code: 'RUN_NOT_CANCELLABLE' });
            break;
          }

          case 'memory.list':
          case 'memory.export':
          case 'memory.delete':
          case 'memory.share':
          case 'memory.import':
          case 'memory.stop':
          case 'memory.retry': {
            try {
              const result = await this.businessMemory.request(connectionActor, String(msg.sessionKey ?? ''), msg.type!, msg);
              if (ws.readyState === WebSocket.OPEN) this.sendSocketEvent(ws, { type: 'memory.result', operation: msg.type, messageId: msg.messageId, result });
            } catch {
              if (ws.readyState === WebSocket.OPEN) this.sendSocketEvent(ws, { type: 'error', messageId: msg.messageId, error: 'Memory request failed' });
            }
            break;
          }

          case 'chat.history': {
            const historySessionKey = (msg.sessionKey as string) || '';
            try {
              const messages = await chatDatabaseService.getMessages(connectionActor, historySessionKey, 200);
              // Map DB records to frontend-compatible message format
              const mapped = messages.map((m) => ({
                id: m.message_id,
                sequence: m.sequence,
                role: m.role,
                content: m.content,
                messageParts: m.messageParts,
                createdAt: m.created_at instanceof Date ? m.created_at.toISOString() : m.created_at,
              }));
              this.sendSocketEvent(ws, { type: 'complete', messages: mapped });
            } catch (dbErr) {
              console.error('[DirectAdapter] chat.history failed:', dbErr instanceof Error ? dbErr.message : String(dbErr));
              this.sendSocketEvent(ws, { type: 'error', error: 'Failed to load chat history' });
            }
            break;
          }

          case 'chat.unwatch': {
            if (typeof msg.sessionKey === 'string') {
              this.sessionSubscribers.get(msg.sessionKey)?.delete(ws);
              this.displayStreams.unwatch(ws, msg.sessionKey);
              subscriptionRequests.delete(msg.sessionKey);
            }
            break;
          }
          case 'chat.watch': {
            // Subscribe WS to session for invoke() completion broadcasts
            const watchKey = (msg.sessionKey as string) || '';
            if (watchKey) {
              try {
                await chatDatabaseService.authorizeSession(connectionActor, watchKey, 'watch');
                if (this.partsPeers.has(ws) && subscriptionRequests.get(watchKey) !== msg.subscriptionId) break;
                if (!this.sessionSubscribers.has(watchKey)) this.sessionSubscribers.set(watchKey, new Set());
                this.sessionSubscribers.get(watchKey)!.add(ws);
                if (this.partsPeers.has(ws)) {
                  const ok = this.displayStreams.watch(ws, watchKey, typeof msg.subscriptionId === 'string' ? msg.subscriptionId : '',
                    event => this.socketWriter.send(ws, JSON.stringify(event)), msg.cursor as DisplayCursor | undefined);
                  if (!ok) this.sendSocketEvent(ws, { type: 'protocol.error', code: 'STREAM_SUBSCRIPTION_LIMIT' });
                } else {
                  const stream = this.displayStreams.legacySnapshot(watchKey);
                  if (stream) this.socketWriter.send(ws, JSON.stringify(stream));
                }
                // Refresh/reconnect need not retain the original request key.
                for (const pending of await agentRunService.pendingCompletions(connectionActor.userId, watchKey)) {
                  try {
                    const recovered = await agentRunService.recoverCompletion(pending);
                    sendToSession(watchKey, { type: 'run.snapshot', run: recovered, messageId: recovered.messageId, sessionKey: watchKey });
                    if (recovered.state === 'completed') {
                      sendToSession(watchKey, { ...(recovered.result as { event: ChatEvent }).event, runId: recovered.id, sessionKey: watchKey });
                      await this.extractCompletedMemory(connectionActor, watchKey, recovered.id);
                    }
                  } catch {
                    if (ws.readyState === WebSocket.OPEN) this.sendSocketEvent(ws, { type: 'run.snapshot', run: pending, messageId: pending.messageId, sessionKey: watchKey });
                    sendToSession(watchKey, { type: 'error', code: 'COMPLETION_STORAGE_FAILED', retryable: true,
                      error: '回答保存未确认，请重试或重连恢复。', runId: pending.id, sessionKey: watchKey });
                  }
                }
              } catch {
                this.sendSocketEvent(ws, { type: 'error', error: 'Chat session not found' });
              }
            }
            break;
          }

          default:
            this.sendSocketEvent(ws, { type: 'error', error: `Unknown message type: ${msg.type}` });
        }
      };

      // EventEmitter does not await async listeners. Contain failures here so a
      // single message cannot become a process-level unhandled rejection.
      ws.on('message', async (raw: Buffer) => {
        try {
          await handleMessage(raw);
        } catch {
          clearAuthentication();
          platformLogs.record({ component: 'ws', eventType: 'message.error', status: 'failed', correlationId: connectionId, errorCode: 'WS_MESSAGE_HANDLER_ERROR' });
          console.error('[DirectAdapter] WS message handling failed', JSON.stringify({ connectionId, errorCode: 'WS_MESSAGE_HANDLER_ERROR' }));
          if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'Message handling failed');
        }
      });

      ws.on('error', (err: Error & { code?: string }) => {
        const errorCode = typeof err.code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(err.code)
          ? err.code : 'WS_TRANSPORT_ERROR';
        platformLogs.record({ component: 'ws', eventType: 'connection.error', status: 'failed', correlationId: connectionId, errorCode });
        // Exception text may contain client input; retain only bounded codes.
        console.error('[DirectAdapter] WS error:', JSON.stringify({ connectionId, errorCode }));
      });
    });

    this.wsServer.on('error', (err) => {
      platformLogs.record({ component: 'ws', eventType: 'server.error', status: 'failed', errorCode: 'WS_SERVER_ERROR' });
      console.error('[DirectAdapter] WS server error:', err.message);
    });

    console.log(`[DirectAdapter] WS transport listening on port ${port}`);
  }

  private observeSessionOperation(sessionKey: string, operation: Promise<unknown>): void {
    let operations = this.sessionOperations.get(sessionKey);
    if (!operations) { operations = new Set(); this.sessionOperations.set(sessionKey, operations); }
    const settled = operation.then(() => {}, () => {});
    operations.add(settled);
    void settled.then(() => operations!.delete(settled));
  }

  private async withSessionLock<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(sessionKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.sessionLocks.set(sessionKey, current);
    await previous;
    try {
      return await task();
    } finally {
      const operations = this.sessionOperations.get(sessionKey);
      const releaseOwned = () => {
        this.sessionOperations.delete(sessionKey);
        release();
        if (this.sessionLocks.get(sessionKey) === current) this.sessionLocks.delete(sessionKey);
      };
      if (operations?.size) void Promise.all(operations).then(releaseOwned);
      else releaseOwned();
    }
  }

  // ── chat() — streaming chat session with subsystem integration ──

  async chat(
    sessionKey: string,
    message: string,
    onEvent: ChatEventConsumer,
    _actor?: ActorContext,
    signal?: AbortSignal,
    idempotencyKey?: string,
    runtimeRunId?: string,
    persistedUserId?: string,
  ): Promise<ChatResult> {
    return this.withSessionLock(sessionKey, () =>
      this.runChat(sessionKey, message, onEvent, _actor, signal, idempotencyKey, runtimeRunId, persistedUserId),
    );
  }

  private async runChat(
    sessionKey: string,
    message: string,
    onEvent: ChatEventConsumer,
    _actor?: ActorContext,
    signal?: AbortSignal,
    idempotencyKey?: string,
    runtimeRunId?: string,
    persistedUserId?: string,
  ): Promise<ChatResult> {
    const policy = this.policies.chat;
    // Actor-owned facts/checkpoints come from MySQL. File entries cannot confer
    // access or become durable business answers before the completion transaction.
    const cacheKey = _actor ? `db:${_actor.userId}:${sessionKey}` : sessionKey;
    const requestKey = idempotencyKey ? createHash('sha256').update(idempotencyKey).digest('hex') : randomUUID();
    let session: Session;
    try { session = this.sessionManager.getOrCreate(cacheKey); }
    catch (error) { if (!_actor) throw error; session = new Session(cacheKey); }
    const sessMeta = _actor ? await chatDatabaseService.getSessionMetadata(_actor, sessionKey) : null;
    if (_actor) {
      await chatDatabaseService.authorizeSession(_actor, sessionKey, 'append');
      const page = await canonicalStore.getPage(_actor, sessionKey, 1000);
      session.messages = [];
      session.appendFacts(page.messages);
      session.last_consolidated = 0;
      session.metadata.runtime_checkpoint = sessMeta?.canonicalRuntimeCheckpoint as Record<string, unknown> | undefined;
      if (sessMeta?.canonicalRuntimeCheckpoint === undefined) {
        // Upgrade only a checkpoint bound to this exact request; unbound file
        // facts never become actor-owned database authority by content similarity.
        const legacy = this.sessionManager._load(sessionKey)?.metadata.runtime_checkpoint;
        const pendingLegacy = legacy?.pendingToolCalls ?? legacy?.pending_tool_calls;
        if (legacy?.runtime_request_key === requestKey) {
          session.metadata.runtime_checkpoint = legacy;
          await canonicalStore.saveCheckpoint(_actor, sessionKey, legacy);
        } else if (Array.isArray(pendingLegacy) && pendingLegacy.length) {
          throw new Error('LEGACY_CHECKPOINT_RECONCILIATION_REQUIRED');
        }
      }
    }
    let resumeCheckpoint = session.metadata?.runtime_checkpoint as Record<string, unknown> | undefined;
    const pending = resumeCheckpoint?.pendingToolCalls ?? resumeCheckpoint?.pending_tool_calls;
    if (resumeCheckpoint?.terminal_resolution && resumeCheckpoint.runtime_request_key
      && resumeCheckpoint.runtime_request_key !== requestKey && !(Array.isArray(pending) && pending.length)) {
      delete session.metadata.runtime_checkpoint;
      resumeCheckpoint = undefined;
    }
    // The business history already contains every durably recorded tool fact.
    if (resumeCheckpoint && !_actor) this.runner._restoreRuntimeCheckpoint(session as any);
    // A retry belongs to the checkpoint's original turn. An unresolved tool
    // also retains that identity until the runner reports its settlement guard.
    const retainsIdentity = (!runtimeRunId || resumeCheckpoint?.canonical_run_id === runtimeRunId)
      && (resumeCheckpoint?.runtime_request_key === requestKey || (Array.isArray(pending) && pending.length > 0));
    const checkpointTurnId = retainsIdentity && typeof resumeCheckpoint?.canonical_turn_id === 'string'
      ? resumeCheckpoint.canonical_turn_id : undefined;
    const checkpointRunId = retainsIdentity && typeof resumeCheckpoint?.canonical_run_id === 'string'
      ? resumeCheckpoint.canonical_run_id : undefined;
    const userFactId = persistedUserId ?? checkpointTurnId ?? randomUUID();
    const runId = runtimeRunId ?? checkpointRunId ?? userFactId;
    const usesCheckpointTurn = checkpointTurnId === userFactId;
    if (_actor && !persistedUserId && !usesCheckpointTurn) await chatDatabaseService.addMessage(_actor, sessionKey, {
      messageId: userFactId, role: 'user', content: message,
      metadata: { canonicalRunId: runId, canonicalTurnId: userFactId },
    });
    const currentIndex = session.messages.findIndex(m => m.id === userFactId);
    const resumingTurn = currentIndex >= 0 && usesCheckpointTurn;
    if (currentIndex >= 0 && !resumingTurn) session.messages = session.messages.slice(0, currentIndex);
    const historyBeforeCurrentMessage = session.getHistory(120) as any[];
    if (!resumingTurn) session.addMessage('user', message, { id: userFactId, runId, turnId: userFactId });
    const sessThinkingLevel = (sessMeta?.thinkingLevel as string) || undefined;
    const reasoningEffort = normalizeThinkingLevel(sessThinkingLevel);

    // Build messages with ContextBuilder (D-12)
    const skillNames = this.skillsLoader.listSkills().map(s => s.name);
    const memoryScope = _actor ? this.businessMemory.contextScope(_actor, sessionKey) : undefined;
    const retrieved = memoryScope && _actor ? await this.businessMemory.retrieve(_actor, sessionKey, message, runId) : undefined;
    const contextMessages = await this.contextBuilder.buildMessages(
      historyBeforeCurrentMessage,
      message,
      skillNames,
      // Retrieval is request-local: do not retain actor identity or selections on the shared builder.
      { memoryScope, memory: retrieved },
    );

    // A resumed request already has its durable user + tool facts in history.
    // Remove only the request-local duplicate user frame added by ContextBuilder.
    if (resumingTurn && historyBeforeCurrentMessage.some(m => m.id === userFactId)) {
      const index = contextMessages.findLastIndex(m => m.role === 'user');
      if (index >= 0) contextMessages.splice(index, 1);
    }

    // Create checkpoint callback that persists to session metadata
    const checkpointCallback = async (payload: Record<string, unknown>) => {
      const streamState = payload.stream_state_v1 as import('@slide/agent-core').StreamSnapshot | undefined;
      if (streamState) streamState.sequence = Math.max(streamState.sequence, sequence);
      const checkpoint: Record<string, unknown> = { ...payload, canonical_run_id: runId, canonical_turn_id: userFactId,
        runtime_request_key: requestKey,
        runtime_policy: { entry: policy.entry, source: policy.source, longChat: policy.longChat, maxIterations: policy.maxIterations, runTimeoutMs: policy.runTimeoutMs } };
      // Final response_ready is a candidate, retained in checkpoint until durable commit.
      const facts = checkpointFacts(checkpoint, runId).filter(m => m.role === 'tool' || m.tool_calls?.length)
        .map(m => {
          const legacy = { ...m, runId, turnId: userFactId }; delete legacy.messageParts;
          const doc = projection.document(m.id!, legacy);
          return { ...m, runId, turnId: userFactId, ...(doc.parts.length ? { messageParts: doc } : {}) };
        });
      const documents = projectionDocuments(facts.map(m => persistedMessageParts(m, _actor ? 'checkpoint' : 'jsonl',
        m.tool_calls?.some(call => !facts.some(result => result.tool_call_id === call.id)) ? 'partial' : 'completed').messageParts!));
      const staged = documents.length ? reduceMessageProjection(projection.state, { version: 1, runId, attempt, sequence: sequence + 1,
        operations: [{ type: 'parts.persisted', documents }] }) : projection.state;
      checkpoint.message_projection_v1 = staged;
      const anchorChanged = streamState?.anchor && streamState.anchor.checkpointId !== projection.anchor.id;
      const anchorState = { ...structuredClone(staged), anchorId: streamState?.anchor?.checkpointId ?? projection.anchor.id,
        parts: anchorChanged ? structuredClone(staged.parts).filter(p => p.part.type !== 'tool_input').map(p => ({ ...p, part: { ...p.part, generation: 'ended' as const,
          durable: p.part.durable ?? { kind: 'checkpoint' as const, reference: streamState!.anchor!.checkpointId } } })) : structuredClone(projection.anchor.parts) };
      checkpoint.message_projection_anchor_v1 = anchorState;
      if (_actor) {
        if (facts.length) await canonicalStore.appendToolFacts(_actor, sessionKey, userFactId, facts, Number(payload.iteration ?? 0), checkpoint);
        else await canonicalStore.saveCheckpoint(_actor, sessionKey, checkpoint);
      }
      const previousCheckpoint = session.metadata.runtime_checkpoint;
      const previousMessages = [...session.messages];
      session.appendFacts(facts);
      session.metadata.runtime_checkpoint = checkpoint;
      try { await this.sessionManager.save(session); }
      catch (error) {
        if (!_actor) { session.messages = previousMessages; session.metadata.runtime_checkpoint = previousCheckpoint; throw error; }
        this.sessionManager.invalidate(cacheKey);
      }
      if (documents.length) await deliver({ type: 'message_parts', operations: [{ type: 'parts.persisted', documents }] });
      if (anchorChanged) {
        projection.anchor = { id: streamState!.anchor!.checkpointId, parts: structuredClone(anchorState.parts) };
        projection.state.anchorId = projection.anchor.id;
      }
    };

    // Create streaming hook that maps to ChatEvent.
    // thinkingHolder captures reasoning text from emitReasoning so it can be
    // embedded in the final message (matching external <think> tag behavior).
    // streamHolder accumulates text deltas for progressive display.
    const restoredStream = (resumeCheckpoint?.canonical_run_id === undefined || resumeCheckpoint.canonical_run_id === runId
      ? resumeCheckpoint?.stream_state_v1 : undefined) as import('@slide/agent-core').StreamSnapshot | undefined;
    const thinkingHolder: { text: string } = { text: restoredStream?.anchor?.reasoning ?? '' };
    const streamHolder: { text: string; safeContent?: string; resetSnapshot?: import('@slide/agent-core').StreamReset } = { text: restoredStream?.anchor?.text ?? '', safeContent: restoredStream?.anchor?.text ?? '' };
    let sequence = restoredStream?.sequence ?? 0;
    let attempt = restoredStream?.attempt ?? 0;
    let sourceRequestId = restoredStream?.sourceRequestId;
    // Explicit admission IDs remain authoritative; never graft another run's
    // projection onto a newly admitted run, including an unresolved old tool.
    const projection = new AdapterMessageProjection(runId, resumeCheckpoint?.canonical_run_id === runId
      ? resumeCheckpoint.message_projection_anchor_v1 : undefined);
    const recoveredFacts = session.messages.filter(m => m.runId === runId && (m.role === 'assistant' || m.role === 'tool') && m.messageParts?.durable).map(m => m.messageParts!);
    if (recoveredFacts.length) projection.state = reduceMessageProjection(projection.state, { version: 1, runId, attempt: projection.state.attempt,
      sequence: projection.state.sequence + 1, operations: [{ type: 'parts.persisted', documents: projectionDocuments(recoveredFacts) }] });
    sequence = Math.max(sequence, projection.state.sequence);
    this.displayStreams.start(sessionKey, runId, userFactId, () => projection.state);
    const consume = orderedChatConsumer(onEvent, this.streamingLimits);
    let streamClosed = false;
    const deliver: ChatEventConsumer = (event, writerSignal) => {
      if (streamClosed && !['complete', 'error', 'cancelled'].includes(event.type)) return;
      const ordinal = ++sequence;
      const frame = projection.observe(event, attempt, ordinal);
      const ordered = { ...event, sequence: ordinal, attempt, sourceRequestId, projection: frame };
      const terminal = ['complete', 'error', 'cancelled'].includes(event.type);
      if (terminal) streamClosed = true;
      // Actor completion is published only by its existing durable transaction owner.
      if (!terminal || !_actor) this.displayStreams.publish(sessionKey, frame);
      return consume(ordered, writerSignal ?? (['complete', 'error', 'cancelled'].includes(event.type) || (event.type === 'tool_error' && ['unknown', 'cancelled'].includes(event.outcome ?? '')) ? undefined : signal));
    };
    const hook = mapHookEventToChatEvent({ beforeIteration: async ctx => {
      attempt = ctx.streamAttempt ?? attempt + 1; sourceRequestId = ctx.sourceRequestId;
      projection.begin(ctx.messageId ?? `model_${sourceRequestId ?? runId}`);
      await deliver({ type: 'message_parts', operations: [{ type: 'run.status', phase: 'generating' }] });
    } }, deliver, thinkingHolder, streamHolder, runId, projection);

    let terminalEmitted = false;
    try {
      const provider = this.providerForPurpose ? await this.providerForPurpose('chat') : this.provider;
      const runner = this.providerForPurpose ? new AgentRunner(provider) : this.runner;

      const result = await runner.run({
        initialMessages: contextMessages as Message[],
        tools: _actor && this.toolsForActor ? this.toolsForActor(_actor) : new ToolRegistry(),
        model: provider.getDefaultModel(),
        ...runtimeSpec(policy),
        streamingLimits: this.streamingLimits,
        runtimeRunId: runId,
        onRuntimeEvent: recordRuntimeEvent,
        maxToolResultChars: this.runtimeLimits.maxToolResultChars,
        concurrentTools: this.concurrentTools,
        temperature: 0.0,
        reasoningEffort,
        hook,
        checkpointCallback,
        resumeCheckpoint,
        onProviderRequest: request => this.observeSessionOperation(sessionKey, request),
        onToolExecution: request => this.observeSessionOperation(sessionKey, request),
        sessionKey,
        signal,
        idempotencyKey,
        onToolEvent: async event => {
          const base = { toolCallId: event.toolCallId, toolName: event.toolName, occurredAt: event.occurredAt, outcome: event.outcome };
          const args = event.args ? boundedToolValue(event.args, redactSensitiveText) as Record<string, unknown> : undefined;
          if (event.progress) {
            await deliver({ ...base, type: 'tool_progress', progress: boundedToolValue(event.progress, redactSensitiveText) as Record<string, unknown> });
          } else if (event.phase === 'running') {
            await deliver({ ...base, type: 'tool_start', args: args ?? {} });
          } else if (event.phase === 'settled') {
            const preview = buildToolPreview(event.result, event.toolCallId, redactSensitiveText);
            if (event.outcome === 'ok') await deliver({ ...base, type: 'tool_result', result: preview.text, preview });
            else await deliver({ ...base, type: 'tool_error', error: preview.text, preview });
          } else await deliver({ ...base, type: 'tool_state', phase: event.phase, ...(args ? { args } : {}) });
        },
      }).catch(async error => {
        if (!signal?.aborted || !(error === signal.reason || error instanceof RuntimeError
          && ['USER_CANCELLED', 'RUN_DEADLINE'].includes(error.code))) throw error;
        const cancelled = cancellationError(signal);
        const stopReason = cancelled.code === 'RUN_DEADLINE' ? 'timed_out' as const : 'cancelled' as const;
        const resolution = { kind: stopReason, reasonCode: cancelled.code, retryable: false,
          safePartialContent: streamHolder.safeContent ?? streamHolder.text };
        const checkpoint = session.metadata.runtime_checkpoint;
        const counters = checkpoint?.runtime_state_v1 as { usage?: Record<string, number> } | undefined;
        // Cancellation inside a control hook bypasses TurnLoop's normal exit.
        // Preserve cumulative counters and the terminal marker; storage errors
        // still propagate and cannot be converted into a successful cancellation.
        if (checkpoint) {
          const { reasonCode: _reason, ...stream } = streamHolder.resetSnapshot ?? { reasonCode: '' };
          await checkpointCallback({ ...checkpoint, ...(streamHolder.resetSnapshot ? { stream_state_v1: stream } : {}),
            ...(checkpoint.phase === 'final_response' ? { phase: 'stream_reset', assistantMessage: undefined, assistant_message: undefined } : {}), terminal_resolution: resolution });
        }
        return { stopReason, finalContent: null, usage: counters?.usage, error: cancelled.message, resolution };
      });

      // Embed reasoning as <think> tags in the session/DB content string.
      // The frontend uses extractThinking() to render it as a collapsible section.
      // The API parses <think> tags back into structured content blocks.
      const stopReason = result.stopReason === 'cancelled' && signal?.reason?.message === 'CHAT_TIMED_OUT'
        ? 'timed_out' : result.stopReason;
      if (stopReason === 'timed_out' && result.stopReason === 'cancelled') {
        result.resolution = { ...result.resolution, kind: 'timed_out', reasonCode: 'RUN_DEADLINE', retryable: false };
      }
      // Failed runner results may contain synthetic error text, not an assistant reply.
      const cleanContent = stopReason === 'completed' ? (result.finalContent ?? '')
        : (result.resolution?.safePartialContent ?? streamHolder.safeContent ?? streamHolder.text);
      streamHolder.safeContent = cleanContent;
      const thinkingContent = thinkingHolder.text || undefined;
      const displayContent = thinkingContent
        ? `<think>${thinkingContent}</think>\n\n${cleanContent}`
        : cleanContent;

      // Keep only acknowledged content if local finalization fails.
      const previousMessages = [...session.messages];
      const previousCheckpoint = session.metadata.runtime_checkpoint;
      // Keep partial replies in the session context as well as database history.
      if (displayContent && !_actor) {
        const extra: any = {};
        if (thinkingContent) extra.reasoning_content = thinkingContent;
        const legacy = { id: `run_${runId}_assistant`, runId, turnId: userFactId, role: 'assistant' as const, content: displayContent, source: 'fact' as const };
        const doc = projection.finalDocument(legacy, stopReason !== 'completed');
        session.addMessage('assistant', displayContent, { ...extra, ...legacy, messageParts: doc, metadata: { stopReason } });
      }

      // Clear checkpoint on successful completion
      if (!_actor && stopReason === 'completed' && session.metadata && 'runtime_checkpoint' in session.metadata) {
        delete session.metadata['runtime_checkpoint'];
      }

      if (!_actor) {
        try { await this.sessionManager.save(session); }
        catch (error) { session.messages = previousMessages; session.metadata.runtime_checkpoint = previousCheckpoint; throw error; }
      }

      terminalEmitted = true;
      const legacy = { id: `run_${runId}_assistant`, runId, turnId: userFactId, role: 'assistant' as const, content: displayContent, source: 'fact' as const };
      let messageParts = projection.finalDocument(legacy, stopReason !== 'completed');
      if (!_actor && displayContent) messageParts = persistedMessageParts({ ...legacy, messageParts, metadata: { stopReason } }, 'jsonl').messageParts!;
      const terminalContent = { finalContent: cleanContent, thinkingContent, stopReason, resolution: result.resolution, messageParts };
      if (stopReason === 'completed') {
        await deliver({ type: 'complete', ...terminalContent });
      } else if (stopReason === 'cancelled') {
        await deliver({ type: 'cancelled', ...terminalContent });
      } else {
        await deliver({ type: 'error', error: result.error || `Agent run ended: ${stopReason}`, ...terminalContent });
      }
      return { finalContent: cleanContent, thinkingContent, usage: result.usage, stopReason, resolution: result.resolution };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const anchor = (session.metadata.runtime_checkpoint?.stream_state_v1 as import('@slide/agent-core').StreamSnapshot | undefined)?.anchor;
      streamHolder.text = streamHolder.safeContent = anchor?.text ?? '';
      thinkingHolder.text = anchor?.reasoning ?? '';
      this.displayStreams.end(sessionKey, runId);
      // Do not emit a second terminal event if persistence or delivery failed.
      if (!terminalEmitted) {
        await deliver({ type: 'error', error: errorMessage, stopReason: 'error',
          finalContent: streamHolder.safeContent ?? streamHolder.text, thinkingContent: thinkingHolder.text || undefined });
      }
      throw err;
    } finally { this.displayStreams.end(sessionKey, runId); }
  }

  // ── invoke() — fire-and-forget task execution ──

  async invoke(
    sessionKey: string,
    message: string,
    systemPrompt?: string,
    options?: InvokeOptions,
  ): Promise<InvokeResult> {
    return this.withSessionLock(sessionKey, () =>
      this.runInvoke(sessionKey, message, systemPrompt, options),
    );
  }

  private async runInvoke(
    sessionKey: string,
    message: string,
    systemPrompt?: string,
    options?: InvokeOptions,
  ): Promise<InvokeResult> {
    options?.signal?.throwIfAborted();
    // Get or create session so invoke() runs are persisted and visible in chat history (CR-07)
    const session = this.sessionManager.getOrCreate(sessionKey);

    // Use ContextBuilder if no custom system prompt provided
    let messages: Message[];
    if (!systemPrompt && this.contextBuilder) {
      const ctxMessages = await this.contextBuilder.buildMessages([], message);
      messages = ctxMessages as Message[];
    } else {
      messages = [
        { role: 'system', content: systemPrompt ?? 'You are a helpful database operations assistant.' },
        { role: 'user', content: message },
      ];
    }

    // invoke() is intentionally detached from a browser ActorContext. It may retain
    // ephemeral agent state, but must never use a maintenance path to mutate a
    // user-owned chat session.
    const invokeRunId = options?.runtimeRunId ?? randomUUID();
    session.addMessage('user', message, { runId: invokeRunId, turnId: invokeRunId });

    const thinkingHolder: { text: string } = { text: '' };
    const toolCalls: Array<{ name: string; args: any; result?: string; status: string }> = [];

    const invokeHook: AgentHook = {
      // Background analyses have no interactive consumer. A non-streaming
      // request applies the runner's wall-clock timeout and avoids retaining a
      // long-lived streaming connection while waiting for persistence.
      wantsStreaming: () => false,
      beforeIteration: async () => {},
      onCandidateRejected: async ctx => { thinkingHolder.text = ctx.streamReset?.anchor?.reasoning ?? ''; },
      onStream: async (_ctx: any, delta: string) => { thinkingHolder.text += delta; },
      onStreamEnd: async () => {},
      beforeExecuteTools: async (ctx: any) => {
        for (const tc of ctx.toolCalls) {
          toolCalls.push({ name: tc.name, args: tc.arguments, status: 'running' });
        }
      },
      afterIteration: async (ctx: any) => {
        for (const te of ctx.toolEvents) {
          const existing = toolCalls.find(t => t.name === te.name && t.status === 'running');
          if (existing) {
            existing.status = te.status || 'ok';
            existing.result = typeof te.detail === 'string' ? te.detail.slice(0, 500) : JSON.stringify(te.detail).slice(0, 500);
          }
        }
      },
      emitReasoning: async (text: string | null) => { if (text) thinkingHolder.text += text; },
      emitReasoningEnd: async () => {},
      finalizeContent: (_ctx: any, c: string | null) => c,
    };

    const controller = new AbortController();
    const cancel = () => controller.abort(options?.signal?.reason);
    options?.signal?.addEventListener('abort', cancel, { once: true });
    if (options?.signal?.aborted) cancel();
    const policy = this.policies.invoke;
    const timeout = setTimeout(() => controller.abort(new Error('ANALYSIS_TIMED_OUT')), policy.runTimeoutMs);
    try {
      const selectedProvider = this.providerForPurpose ? await this.providerForPurpose(options?.purpose || 'default') : this.provider;
      const provider = options?.beforeProviderRequest
        ? guardedAnalysisProvider(selectedProvider, options.beforeProviderRequest, controller.signal, options.recordAnalysisExecution) : selectedProvider;
      const runner = this.providerForPurpose || options?.beforeProviderRequest ? new AgentRunner(provider) : this.runner;
      const result = await runner.run({
        initialMessages: messages,
        // A generic background invoke receives no tools. Analysis runs receive
        // one completion tool bound to the operator-created analysis record.
        tools: analysisCompletionTools(options?.analysisId, options?.completeAnalysis),
        model: provider.getDefaultModel(),
        ...runtimeSpec(policy),
        onRuntimeEvent: recordRuntimeEvent,
        maxToolResultChars: 20000,
        temperature: 0.0,
        hook: invokeHook as any,
        runtimeRunId: invokeRunId,
        checkpointCallback: async payload => {
          const cp = { ...payload, canonical_run_id: invokeRunId, canonical_turn_id: invokeRunId };
          session.appendFacts(checkpointFacts(cp, invokeRunId).filter(m => m.role === 'tool' || m.tool_calls?.length));
          session.metadata.runtime_checkpoint = cp;
          await this.sessionManager.save(session);
        },
        signal: controller.signal,
        onProviderRequest: request => this.observeSessionOperation(sessionKey, request),
        onToolExecution: request => this.observeSessionOperation(sessionKey, request),
      });

      await options?.recordAnalysisExecution?.({ kind: 'finalized' });

      // Embed thinking as <think> tags so chat UI renders collapsible thinking section
      const thinkingContent = thinkingHolder.text || '';
      const finalContent = thinkingContent
        ? `<think>${thinkingContent}</think>

${result.finalContent || ''}`
        : (result.finalContent || '');
      if (finalContent) {
        if (result.stopReason === 'completed') session.addMessage('assistant', finalContent, { id: `run_${invokeRunId}_assistant`, runId: invokeRunId, turnId: invokeRunId });
      }
      if (result.stopReason === 'completed') delete session.metadata.runtime_checkpoint;
      await this.sessionManager.save(session);

      // Broadcast completion to WebSocket clients viewing this session
      const subs = this.sessionSubscribers.get(sessionKey);
      if (subs && subs.size > 0 && (finalContent || result.stopReason !== 'completed')) {
        const msg = JSON.stringify(result.stopReason === 'completed'
          ? { type: 'complete', finalContent, stopReason: result.stopReason, resolution: result.resolution }
          : { type: 'error', finalContent, stopReason: result.stopReason, resolution: result.resolution, error: result.error || result.resolution?.reasonCode || result.stopReason });
        for (const ws of subs) {
          try { this.socketWriter.send(ws, msg); } catch { /* client may have disconnected */ }
        }
      }

      return {
        content: finalContent,
        resolution: result.resolution,
        usage: result.usage,
        toolEvents: result.toolEvents,
        stopReason: result.stopReason,
        error: controller.signal.aborted ? String(controller.signal.reason?.message ?? 'Cancelled') : result.error,
        iterationCount: result.messages ? Math.ceil(result.messages.length / 2) : 0,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[DirectAdapter] invoke() failed for session ${sessionKey}:`, errorMessage);
      // Save session even on error so partial state is not lost
      try { await this.sessionManager.save(session); } catch { /* best-effort */ }
      throw err;
    } finally {
      clearTimeout(timeout);
      options?.signal?.removeEventListener('abort', cancel);
    }
  }

  // ── listTools() — return registered tool schemas ──

  listTools(): ToolSchema[] {
    return this.registry.getDefinitions();
  }

  // ── capabilities() ──

  capabilities(): AgentCapabilities {
    const model = this.provider.getDefaultModel();
    const profile = this.provider.getModelCapabilities?.(model);
    const context = resolveContextConfig({ model }, this.provider);
    return {
      streaming: true,
      toolCalling: profile?.supportsTools ?? true,
      maxContextTokens: context.contextWindowTokens,
      supportsCustomSystemPrompt: true,
      features: {
        sessions: { state: 'supported' },
        files: { state: 'unsupported', reason: 'DirectAdapter has no agent workspace file API' },
        tools: { state: 'unsupported', reason: 'DirectAdapter has no tool policy editor API' },
        skills: { state: 'unsupported', reason: 'DirectAdapter has no per-agent skill editor API' },
        cron: { state: 'unsupported', reason: 'Cron is managed outside the DirectAdapter agent UI' },
        modelSelection: { state: 'unsupported', reason: 'Model selection is configured in LLM settings' },
        fallback: { state: 'unsupported', reason: 'Fallback configuration is not exposed by DirectAdapter' },
        reload: { state: 'unsupported', reason: 'Provider reload is managed by LLM settings' },
        edit: { state: 'unsupported', reason: 'DirectAdapter has no agent edit API' },
      },
    };
  }

  /**
   * Replace the LLM provider at runtime. Called when LLM config changes
   * so chat picks up new API keys / models without a server restart.
   */
  setProvider(newProvider: import('@slide/agent-core').LLMProvider): void {
    this.provider = newProvider;
    this.runner.setProvider(newProvider);
    console.log('[DirectAdapter] Provider reloaded');
  }

  /**
   * Dispose the adapter — close the WS server if running.
   * Used for test cleanup. Not part of IAgentEngine interface.
   */
  async dispose(): Promise<void> {
    this.displayStreams.dispose();
    await this.businessMemory.close();
    if (this.wsServer) {
      for (const ws of this.wsServer.clients) {
        if (ws.readyState === WebSocket.OPEN) ws.close(1012, 'Service restart');
      }
      this.wsServer.close();
      this.wsServer = null;
    }
  }
}
