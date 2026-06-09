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
import jwt from 'jsonwebtoken';
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

// ── DirectAdapter Options ──

export interface DirectAdapterOptions {
  tools: ToolRegistry;
  llmProvider: import('@slide/agent-core').LLMProvider;
  workspace?: string;              // workspace root path (defaults to process.cwd())
  sessionManager?: SessionManager; // optional, created from workspace if not provided
  contextBuilder?: ContextBuilder; // optional, created from workspace if not provided
  skillsLoader?: SkillsLoader;     // optional, created from workspace if not provided
  memoryStore?: MemoryStore;       // optional, created from workspace if not provided
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
  private wsServer: WebSocketServer | null = null;

  constructor(opts: DirectAdapterOptions) {
    this.runner = new AgentRunner(opts.llmProvider);
    this.registry = opts.tools;
    this.provider = opts.llmProvider;

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

      // Heartbeat ping every 30s, terminate if pong not received (WR-07)
      const heartbeatTimer = setInterval(() => {
        if ((ws as any)._isAlive === false) {
          console.warn('[DirectAdapter] WS heartbeat timeout, terminating connection');
          ws.terminate();
          return;
        }
        (ws as any)._isAlive = false;
        ws.ping();
      }, 30_000);

      ws.on('pong', () => {
        (ws as any)._isAlive = true;
      });

      ws.on('close', () => {
        clearInterval(heartbeatTimer);
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
          const token = msg.token as string;
          const JWT_SECRET = process.env.JWT_SECRET_KEY;
          if (!JWT_SECRET) {
            console.error('[DirectAdapter] JWT_SECRET_KEY not set, rejecting all auth');
            ws.close(4001, 'Server misconfigured: JWT_SECRET_KEY not set');
            return;
          }
          try {
            const decoded = jwt.verify(token, JWT_SECRET);
            (ws as any)._authUserId = (decoded as any).userId;
            ws.send(JSON.stringify({ type: 'auth_ok' }));
          } catch {
            ws.close(4001, 'Unauthorized');
          }
          return;
        }

        // D-11: Reject unauthenticated messages before auth
        if (!(ws as any)._authUserId) {
          ws.close(4002, 'Authenticate first');
          return;
        }

        // Per-connection idempotency tracking to prevent duplicate messages (WR-04)
        const seenIdempotencyKeys = new Set<string>();
        const IDEMPOTENCY_CACHE_SIZE = 100;

        switch (msg.type) {
          case 'chat.send': {
            const rawSessionKey = (msg.sessionKey as string) || `session_${Date.now()}`;
            // Validate sessionKey length to prevent resource exhaustion (WR-03)
            if (rawSessionKey.length > 512) {
              ws.send(JSON.stringify({ type: 'error', error: 'Session key too long' }));
              return;
            }
            // Parse session key (agent format): agent:<agentId>:<actualKey> → actualKey
            const sessionKey = rawSessionKey.startsWith('agent:')
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
              // Persist user message
              const userId = (msg as any).userId || 1;
              try {
                await chatDatabaseService.addMessage(sessionKey, `msg_${Date.now()}_user`, 'user', userMessage, null, null, null, null);
              } catch (dbErr) {
                console.error('[DirectAdapter] Failed to persist user message:', dbErr instanceof Error ? dbErr.message : String(dbErr));
              }

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
                    await chatDatabaseService.addMessage(sessionKey, `msg_${Date.now()}_asst`, 'assistant', dbContent, null, null, null, null);
                  } catch (dbErr) {
                    console.error('[DirectAdapter] Failed to persist assistant message:', dbErr instanceof Error ? dbErr.message : String(dbErr));
                  }
                }
                ws.send(JSON.stringify(event));
              });
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              ws.send(JSON.stringify({ type: 'error', error: errorMsg }));
            }
            break;
          }

          case 'chat.history': {
            // Return empty history for now; will integrate with chatDatabaseService later
            ws.send(JSON.stringify({ type: 'complete', history: [] }));
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
  ): Promise<ChatResult> {
    // Get or create session via SessionManager (D-07)
    const session = this.sessionManager.getOrCreate(sessionKey);

    // Checkpoint restore at turn start (D-17): recover from crashed turns
    if (session.metadata && 'runtime_checkpoint' in session.metadata) {
      this.runner._restoreRuntimeCheckpoint(session as any);
    }

    // Push user message
    session.addMessage('user', message);

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
        model: this.provider.getDefaultModel(),
        maxIterations: 10,
        maxToolResultChars: 20000,
        temperature: 0.0,
        reasoningEffort: 'medium',
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
      await chatDatabaseService.addMessage(sessionKey, userMsgId, 'user', message, null, null, null, null);
    } catch (dbErr) {
      console.error('[DirectAdapter] invoke() failed to persist user message to DB:', dbErr instanceof Error ? dbErr.message : String(dbErr));
    }

    try {
      const result = await this.runner.run({
        initialMessages: messages,
        tools: this.registry,
        model: this.provider.getDefaultModel(),
        maxIterations: 5,
        maxToolResultChars: 20000,
        temperature: 0.0,
        hook: new NoopHook(),
        contextWindowTokens: 200_000,
        maxTokens: 2048,
      });

      // Persist assistant response to both SessionManager (JSONL) and chatDatabaseService (MySQL)
      const finalContent = result.finalContent || '';
      if (finalContent) {
        session.addMessage('assistant', finalContent);
        try {
          await chatDatabaseService.addMessage(sessionKey, `msg_${Date.now()}_asst`, 'assistant', finalContent, null, null, null, null);
        } catch (dbErr) {
          console.error('[DirectAdapter] invoke() failed to persist assistant message to DB:', dbErr instanceof Error ? dbErr.message : String(dbErr));
        }
      }
      await this.sessionManager.save(session);

      return { content: finalContent, usage: result.usage };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[DirectAdapter] invoke() failed for session ${sessionKey}:`, errorMessage);
      // Persist error as system message so it's visible in chat
      try {
        await chatDatabaseService.addMessage(sessionKey, `msg_${Date.now()}_error`, 'system', `分析失败: ${errorMessage}`, null, null, null, null);
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
