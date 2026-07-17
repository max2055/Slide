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

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  AgentRunner,
  NoopHook,
  ToolRegistry,
  SessionManager,
  ContextBuilder,
  SkillsLoader,
  MemoryStore,
} from '@slide/agent-core';
import type { AgentHook, AgentHookContext, Message, ToolSchema, RuntimeCheckpoint } from '@slide/agent-core';
import type { IAgentEngine, ChatEvent, AgentCapabilities, ChatResult, InvokeResult } from './types.js';
import { chatDatabaseService } from '../chat-database-service.js';
import { SubagentManager } from '../agents/subagent-manager.js';
import { setSubagentManager } from '../agents/subagent-spawn-tool.js';
import {
  actorContextService,
  type ActorContext,
  type ActorContextService,
} from '../auth/actor-context.js';

let _subagentManagerInitialized = false;

// ── Helper: maps Hook tool events to ChatEvent ──

function mapHookEventToChatEvent(
  hook: Partial<AgentHook>,
  onEvent: (event: ChatEvent) => void,
  thinkingHolder?: { text: string },
  streamHolder?: { text: string },
): AgentHook {
  return {
    wantsStreaming: () => true,
    beforeIteration: async () => {},
    onStream: async (_ctx: AgentHookContext, delta: string) => {
      // Accumulate full text and send as delta so the frontend's chatStream
      // replacement renders as progressively building text (not flickering chars).
      if (streamHolder) streamHolder.text += delta;
      onEvent({ type: 'text_delta', delta: streamHolder ? streamHolder.text : delta });
    },
    onStreamEnd: async () => {},
    beforeExecuteTools: async (ctx: AgentHookContext) => {
      for (const tc of ctx.toolCalls) {
        onEvent({ type: 'tool_start', toolName: tc.name, args: tc.arguments });
      }
    },
    emitReasoning: async (text: string | null) => {
      if (text) {
        if (thinkingHolder) thinkingHolder.text += text;
        if (streamHolder) {
          streamHolder.text += text;
          onEvent({ type: 'text_delta', delta: streamHolder.text });
        }
      }
    },
    emitReasoningEnd: async () => {
      // Only insert separator if reasoning text was accumulated (WR-08)
      if (thinkingHolder && !thinkingHolder.text) return;
      if (streamHolder) {
        streamHolder.text += '\n\n';
        onEvent({ type: 'text_delta', delta: streamHolder.text });
      }
    },
    afterIteration: async (ctx: AgentHookContext) => {
      for (const te of ctx.toolEvents) {
        if (te.status === 'ok') {
          onEvent({ type: 'tool_result', toolName: te.name, result: te.detail });
        } else {
          onEvent({ type: 'tool_error', toolName: te.name, error: te.detail });
        }
      }
    },
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
  tools: ToolRegistry;
  llmProvider: import('@slide/agent-core').LLMProvider;
  workspace?: string;              // workspace root path (defaults to process.cwd())
  sessionManager?: SessionManager; // optional, created from workspace if not provided
  contextBuilder?: ContextBuilder; // optional, created from workspace if not provided
  skillsLoader?: SkillsLoader;     // optional, created from workspace if not provided
  memoryStore?: MemoryStore;       // optional, created from workspace if not provided
  actorContextService?: Pick<ActorContextService, 'authenticateAccessToken' | 'revalidateActor'>;
  heartbeatIntervalMs?: number;
}

// ── DirectAdapter ──

export class DirectAdapter implements IAgentEngine {
  private runner: AgentRunner;
  private registry: ToolRegistry;
  private provider: import('@slide/agent-core').LLMProvider;
  private sessionManager: SessionManager;
  private contextBuilder: ContextBuilder;
  private skillsLoader: SkillsLoader;
  private memoryStore: MemoryStore;
  private actorContexts: Pick<ActorContextService, 'authenticateAccessToken' | 'revalidateActor'>;
  private heartbeatIntervalMs: number;
  private wsServer: WebSocketServer | null = null;
  /** Track WebSocket clients subscribed to each session for invoke() broadcast. */
  private sessionSubscribers = new Map<string, Set<WebSocket>>();

  constructor(opts: DirectAdapterOptions) {
    this.runner = new AgentRunner(opts.llmProvider);
    this.registry = opts.tools;
    this.provider = opts.llmProvider;
    this.actorContexts = opts.actorContextService || actorContextService;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs || 30_000;

    const workspace = opts.workspace || process.cwd();
    this.memoryStore = opts.memoryStore || new MemoryStore(workspace);
    this.skillsLoader = opts.skillsLoader || new SkillsLoader(workspace);
    this.sessionManager = opts.sessionManager || new SessionManager(workspace);
    this.contextBuilder = opts.contextBuilder || new ContextBuilder(workspace, {
      memoryStore: this.memoryStore,
      skillsLoader: this.skillsLoader,
    });
  }

  // ── start() — minimal WS transport (D-25 Option B) ──

  async start(): Promise<void> {
    // Initialize SubagentManager so spawn_subagent tool can actually execute subagents
    if (!_subagentManagerInitialized) {
      const subagentManager = new SubagentManager(this.runner, this.registry);
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

    this.wsServer = new WebSocketServer({ port });

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

    this.wsServer.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
      console.log('[DirectAdapter] WS client connected');
      (ws as any)._isAlive = true;
      type ConnectionAuthState = 'unauthenticated' | 'authenticating' | 'authenticated' | 'closed';
      let authState: ConnectionAuthState = 'unauthenticated';
      let authGeneration = 0;
      let connectionActor: ActorContext | undefined;
      let revalidationInFlight = false;
      (ws as any)._authState = authState;
      (ws as any)._actorContext = undefined;

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

      ws.on('close', () => {
        clearInterval(heartbeatTimer);
        clearAuthentication();
        // Unsubscribe from all session broadcasts
        for (const [, subs] of this.sessionSubscribers) {
          subs.delete(ws);
        }
      });

      ws.on('message', async (raw: Buffer) => {
        let msg: { type?: string; sessionKey?: string; message?: string; [key: string]: unknown };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
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
            if (ws.readyState === WebSocket.OPEN
              && authState === 'authenticating'
              && authGeneration === authenticationGeneration) {
              connectionActor = authenticatedActor;
              authState = 'authenticated';
              (ws as any)._actorContext = authenticatedActor;
              (ws as any)._authState = authState;
              ws.send(JSON.stringify({ type: 'auth_ok' }));
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

        // Per-connection idempotency tracking to prevent duplicate messages (WR-04)
        const seenIdempotencyKeys = new Set<string>();
        const IDEMPOTENCY_CACHE_SIZE = 100;

        switch (msg.type) {
          case 'chat.send': {
            const messageActor = connectionActor;
            const rawSessionKey = (msg.sessionKey as string | undefined)?.trim() || '';
            // Validate sessionKey length to prevent resource exhaustion (WR-03)
            if (rawSessionKey.length > 512) {
              ws.send(JSON.stringify({ type: 'error', error: 'Session key too long' }));
              return;
            }
            // Parse session key (agent format): agent:<agentId>:<actualKey> → actualKey
            let sessionKey = rawSessionKey.startsWith('agent:')
              ? rawSessionKey.split(':').slice(2).join(':') || rawSessionKey
              : rawSessionKey;
            const userMessage = (msg.message as string) || '';
            if (!userMessage) {
              ws.send(JSON.stringify({ type: 'error', error: 'Message is required' }));
              return;
            }

            // Deduplicate via idempotencyKey (WR-04)
            const idempotencyKey = msg.idempotencyKey as string | undefined;
            if (idempotencyKey) {
              if (seenIdempotencyKeys.has(idempotencyKey)) {
                // Already processed, skip silently
                return;
              }
              seenIdempotencyKeys.add(idempotencyKey);
              if (seenIdempotencyKeys.size > IDEMPOTENCY_CACHE_SIZE) {
                const first = seenIdempotencyKeys.values().next().value;
                if (first !== undefined) seenIdempotencyKeys.delete(first);
              }
            }

            try {
              if (!sessionKey) {
                const created = await chatDatabaseService.createSession(messageActor, { title: '新会话' });
                sessionKey = created.session_id;
                ws.send(JSON.stringify({ type: 'session.created', sessionKey }));
              } else {
                await chatDatabaseService.authorizeSession(messageActor, sessionKey, 'append');
              }

              await chatDatabaseService.addMessage(messageActor, sessionKey, {
                messageId: `msg_${Date.now()}_user`,
                role: 'user',
                content: userMessage,
              });

              // Authorization succeeds before the connection joins broadcasts.
              if (!this.sessionSubscribers.has(sessionKey)) {
                this.sessionSubscribers.set(sessionKey, new Set());
              }
              this.sessionSubscribers.get(sessionKey)!.add(ws);

              await this.chat(sessionKey, userMessage, async (event) => {
                // Persist assistant's final response BEFORE sending to client,
                // so the history API returns the complete conversation.
                if (event.type === 'complete' && event.finalContent) {
                  try {
                    // Embed thinking as <think> tags in the content for DB storage.
                    // The API parses these back into structured content blocks.
                    const thinking = (event as any).thinkingContent as string | undefined;
                    const dbContent = thinking
                      ? `<think>${thinking}</think>\n\n${event.finalContent}`
                      : event.finalContent;
                    await chatDatabaseService.addMessage(messageActor, sessionKey, {
                      messageId: `msg_${Date.now()}_asst`,
                      role: 'assistant',
                      content: dbContent,
                    });
                  } catch (dbErr) {
                    console.error('[DirectAdapter] Failed to persist assistant message:', dbErr instanceof Error ? dbErr.message : String(dbErr));
                  }
                }
                ws.send(JSON.stringify(event));
              }, messageActor);
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              ws.send(JSON.stringify({ type: 'error', error: errorMsg }));
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
                role: m.role,
                content: m.content,
                createdAt: m.created_at instanceof Date ? m.created_at.toISOString() : m.created_at,
              }));
              ws.send(JSON.stringify({ type: 'complete', messages: mapped }));
            } catch (dbErr) {
              console.error('[DirectAdapter] chat.history failed:', dbErr instanceof Error ? dbErr.message : String(dbErr));
              ws.send(JSON.stringify({ type: 'error', error: 'Failed to load chat history' }));
            }
            break;
          }

          case 'chat.watch': {
            // Subscribe WS to session for invoke() completion broadcasts
            const watchKey = (msg.sessionKey as string) || '';
            if (watchKey) {
              try {
                await chatDatabaseService.authorizeSession(connectionActor, watchKey, 'watch');
                if (!this.sessionSubscribers.has(watchKey)) {
                  this.sessionSubscribers.set(watchKey, new Set());
                }
                this.sessionSubscribers.get(watchKey)!.add(ws);
              } catch {
                ws.send(JSON.stringify({ type: 'error', error: 'Chat session not found' }));
              }
            }
            break;
          }

          default:
            ws.send(JSON.stringify({ type: 'error', error: `Unknown message type: ${msg.type}` }));
        }
      });

      ws.on('close', () => {
        console.log('[DirectAdapter] WS client disconnected');
      });

      ws.on('error', (err) => {
        console.error('[DirectAdapter] WS error:', err.message);
      });
    });

    this.wsServer.on('error', (err) => {
      console.error('[DirectAdapter] WS server error:', err.message);
    });

    console.log(`[DirectAdapter] WS transport listening on port ${port}`);
  }

  // ── chat() — streaming chat session with subsystem integration ──

  async chat(
    sessionKey: string,
    message: string,
    onEvent: (event: ChatEvent) => void,
    _actor?: ActorContext,
  ): Promise<ChatResult> {
    // Get or create session via SessionManager (D-07)
    const session = this.sessionManager.getOrCreate(sessionKey);

    // Checkpoint restore at turn start (D-17): recover from crashed turns
    if (session.metadata && 'runtime_checkpoint' in session.metadata) {
      this.runner._restoreRuntimeCheckpoint(session as any);
    }

    // Push user message
    session.addMessage('user', message);

    // Read session settings (model, thinkingLevel) from DB metadata.
    // The frontend stores these via sessions.patch → chat_sessions.metadata.
    const sessMeta = _actor
      ? await chatDatabaseService.getSessionMetadata(_actor, sessionKey)
      : null;
    const sessModel = (sessMeta?.model as string) || undefined;
    const sessThinkingLevel = (sessMeta?.thinkingLevel as string) || undefined;
    const reasoningEffort = normalizeThinkingLevel(sessThinkingLevel);

    // Build messages with ContextBuilder (D-12)
    const skillNames = this.skillsLoader.listSkills().map(s => s.name);
    const contextMessages = await this.contextBuilder.buildMessages(
      session.getHistory(120) as any[],
      message,
      skillNames,
    );

    // Create checkpoint callback that persists to session metadata
    const checkpointCallback = async (payload: Record<string, unknown>) => {
      if (session.metadata) {
        session.metadata['runtime_checkpoint'] = payload;
      }
      await this.sessionManager.save(session);
    };

    // Create streaming hook that maps to ChatEvent.
    // thinkingHolder captures reasoning text from emitReasoning so it can be
    // embedded in the final message (matching external <think> tag behavior).
    // streamHolder accumulates text deltas for progressive display.
    const thinkingHolder: { text: string } = { text: '' };
    const streamHolder: { text: string } = { text: '' };
    const hook = mapHookEventToChatEvent({}, onEvent, thinkingHolder, streamHolder);

    try {
      const result = await this.runner.run({
        initialMessages: contextMessages as Message[],
        tools: this.registry,
        model: sessModel || this.provider.getDefaultModel(),
        maxIterations: 200,
        maxToolResultChars: 20000,
        temperature: 0.0,
        reasoningEffort,
        hook,
        checkpointCallback,
        contextWindowTokens: 200_000,
        maxTokens: 4096,
        sessionKey,
      });

      // Embed reasoning as <think> tags in the session/DB content string.
      // The frontend uses extractThinking() to render it as a collapsible section.
      // The API parses <think> tags back into structured content blocks.
      const thinkingContent = thinkingHolder.text || undefined;
      const displayContent = thinkingContent
        ? `<think>${thinkingContent}</think>\n\n${result.finalContent || ''}`
        : (result.finalContent || '');
      const cleanContent = result.finalContent || '';

      // On success: push assistant response (with thinking tags for persistence),
      // clear checkpoint, save session
      if (displayContent) {
        const extra: any = {};
        if (thinkingContent) extra.reasoning_content = thinkingContent;
        session.addMessage('assistant', displayContent, extra);
      }

      // Clear checkpoint on successful completion
      if (session.metadata && 'runtime_checkpoint' in session.metadata) {
        delete session.metadata['runtime_checkpoint'];
      }

      await this.sessionManager.save(session);

      onEvent({
        type: 'complete',
        finalContent: cleanContent || undefined,
        thinkingContent,
      });
      return { finalContent: cleanContent || null, usage: result.usage };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Checkpoint remains in metadata for next turn to restore
      onEvent({ type: 'error', error: errorMessage });
      throw err;
    }
  }

  // ── invoke() — fire-and-forget task execution ──

  async invoke(
    sessionKey: string,
    message: string,
    systemPrompt?: string,
  ): Promise<InvokeResult> {
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

    // Persist user message to both SessionManager (JSONL) and chatDatabaseService (MySQL)
    const userMsgId = `msg_${Date.now()}_user`;
    session.addMessage('user', message);
    try {
      await chatDatabaseService.addMessageForMaintenance(sessionKey, {
        messageId: userMsgId,
        role: 'user',
        content: message,
      });
    } catch (dbErr) {
      console.error('[DirectAdapter] invoke() failed to persist user message to DB:', dbErr instanceof Error ? dbErr.message : String(dbErr));
    }

    const thinkingHolder: { text: string } = { text: '' };
    const toolCalls: Array<{ name: string; args: any; result?: string; status: string }> = [];

    const invokeHook: AgentHook = {
      wantsStreaming: () => true,
      beforeIteration: async () => {},
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

    try {
      const result = await this.runner.run({
        initialMessages: messages,
        tools: this.registry,
        model: this.provider.getDefaultModel(),
        maxIterations: 200,
        maxToolResultChars: 20000,
        temperature: 0.0,
        hook: invokeHook as any,
        contextWindowTokens: 200_000,
        maxTokens: 100_000,
      });

      // Embed thinking as <think> tags so chat UI renders collapsible thinking section
      const thinkingContent = thinkingHolder.text || '';
      const finalContent = thinkingContent
        ? `<think>${thinkingContent}</think>

${result.finalContent || ''}`
        : (result.finalContent || '');
      if (finalContent) {
        session.addMessage('assistant', finalContent);
        try {
          await chatDatabaseService.addMessageForMaintenance(sessionKey, {
            messageId: `msg_${Date.now()}_asst`,
            role: 'assistant',
            content: finalContent,
          });
        } catch (dbErr) {
          console.error('[DirectAdapter] invoke() failed to persist assistant message to DB:', dbErr instanceof Error ? dbErr.message : String(dbErr));
        }
      }
      await this.sessionManager.save(session);

      // Broadcast completion to WebSocket clients viewing this session
      const subs = this.sessionSubscribers.get(sessionKey);
      if (subs && subs.size > 0 && finalContent) {
        const msg = JSON.stringify({ type: 'complete', finalContent });
        for (const ws of subs) {
          try { ws.send(msg); } catch { /* client may have disconnected */ }
        }
      }

      return {
        content: finalContent,
        usage: result.usage,
        toolEvents: result.toolEvents,
        stopReason: result.stopReason,
        iterationCount: result.messages ? Math.ceil(result.messages.length / 2) : 0,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[DirectAdapter] invoke() failed for session ${sessionKey}:`, errorMessage);
      // Persist error as system message so it's visible in chat
      try {
        await chatDatabaseService.addMessageForMaintenance(sessionKey, {
          messageId: `msg_${Date.now()}_error`,
          role: 'system',
          content: `分析失败: ${errorMessage}`,
        });
      } catch { /* best-effort */ }
      // Save session even on error so partial state is not lost
      try { await this.sessionManager.save(session); } catch { /* best-effort */ }
      throw err;
    }
  }

  // ── listTools() — return registered tool schemas ──

  listTools(): ToolSchema[] {
    return this.registry.getDefinitions();
  }

  // ── capabilities() ──

  capabilities(): AgentCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      maxContextTokens: 200_000,
      supportsCustomSystemPrompt: true,
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
    if (this.wsServer) {
      this.wsServer.close();
      this.wsServer = null;
    }
  }
}
