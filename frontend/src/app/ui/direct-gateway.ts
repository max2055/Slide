/**
 * DirectAdapter WS client — Phase 109-04
 *
 * Minimal WebSocket client for DirectAdapter native protocol.
 * No auth handshake, no heartbeat, no request/response frame IDs.
 * Protocol: chat.send + ChatEvent stream.
 *
 * The onEvent callback receives the raw adapter ChatEvent payload.
 * initChatClient() maps adapter ChatEvent to frontend ChatEventPayload.
 *
 * @slide/direct-adapter integration
 */

export type AdapterTextDeltaEvent = { type: 'text_delta'; delta: string };
export type AdapterToolStartEvent = { type: 'tool_start'; toolName: string; args: Record<string, unknown> };
export type AdapterToolResultEvent = { type: 'tool_result'; toolName: string; result: unknown };
export type AdapterToolErrorEvent = { type: 'tool_error'; toolName: string; error: string };
export type AdapterThinkingDeltaEvent = { type: 'thinking_delta'; delta: string };
export type AdapterThinkingEndEvent = { type: 'thinking_end' };
export type AdapterCompleteEvent = { type: 'complete'; finalContent?: string; thinkingContent?: string };
export type AdapterErrorEvent = { type: 'error'; error: string };

/** ChatEvent discriminated union — mirrors apps/db-ops-api/src/adapter/types.ts */
export type AdapterChatEvent =
  | AdapterTextDeltaEvent
  | AdapterToolStartEvent
  | AdapterToolResultEvent
  | AdapterToolErrorEvent
  | AdapterThinkingDeltaEvent
  | AdapterThinkingEndEvent
  | AdapterCompleteEvent
  | AdapterErrorEvent;

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'auth_failed' | 'exhausted';
export type ConnectionStateCallback = (state: ConnectionState) => void;

export type DirectGatewayClientOptions = {
  /** Default: ws://${location.hostname}:28888 */
  url?: string;
  /** Callback for incoming AdapterChatEvent payloads from DirectAdapter WS */
  onEvent: (event: AdapterChatEvent) => void;
  /** Callback for connection state changes */
  onStateChange: ConnectionStateCallback;
};

const DEFAULT_PORT = 28888;
export const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export class DirectGatewayClient {
  private ws: WebSocket | null = null;
  private url: string;
  private onEvent: (event: AdapterChatEvent) => void;
  private onStateChange: ConnectionStateCallback;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS;
  private closed = false;
  private authenticated = false;
  private pendingMessages: Array<{ sessionKey: string; message: string }> = [];

  constructor(opts: DirectGatewayClientOptions) {
    this.url = opts.url ?? `ws://${typeof location !== 'undefined' ? location.hostname : 'localhost'}:${DEFAULT_PORT}`;
    this.onEvent = opts.onEvent;
    this.onStateChange = opts.onStateChange;
  }

  connect(): void {
    if (this.closed) {
      return;
    }
    this.authenticated = false;
    this.pendingMessages = [];
    this.onStateChange('connecting');
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.onStateChange('connected');
      const token = typeof window !== 'undefined'
        ? (window as any).__apiClient?.getToken?.()
        : null;
      if (token) {
        this.ws!.send(JSON.stringify({ type: 'auth', token }));
      }
    };


    this.ws.onmessage = (ev: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.dispatchEvent(parsed);
    };

    this.ws.onclose = (ev: CloseEvent) => {
      this.ws = null;
      if (ev.code === 4001) {
        this.onStateChange('auth_failed');
        return; // Don't schedule reconnect — permanent auth failure
      }
      if (ev.code === 4002) {
        // Unauthenticated message sent before auth_ok — retryable (WR-01)
        this.authenticated = false;
      }
      this.onStateChange('disconnected');
      if (!this.closed) {
        this.scheduleReconnect();
      }
    };


    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  disconnect(): void {
    this.closed = true;
    this.authenticated = false;
    this.pendingMessages = [];
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.onclose = null; // Prevent auto-reconnect on intentional close
      this.ws.close();
      this.ws = null;
    }
    this.onStateChange('disconnected');
  }

  /**
   * Compatibility shim: expose a GatewayBrowserClient-compatible request() method
   * so chat controllers can use the same API regardless of adapter mode.
   *
   * Supports known methods via REST API; throws for unsupported methods
   * instead of silently returning undefined.
   */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (method === 'chat.send') {
      const p = params as Record<string, unknown> | undefined;
      const sessionKey = (p?.sessionKey as string) || `ui_${Date.now()}`;
      const message = (p?.message as string) || '';
      this.sendChat(sessionKey, message);
      return undefined as T;
    }
    if (method === 'chat.history') {
      // Fetch from REST API; API returns array, wrap as {messages: [...]} for chat controller
      const p = params as Record<string, unknown> | undefined;
      const rawSessionKey = (p?.sessionKey as string) || '';
      // Parse session key (agent format): agent:<agentId>:<actualKey> → actualKey
      let sessionKey = rawSessionKey;
      if (rawSessionKey.startsWith('agent:')) {
        const parts = rawSessionKey.split(':');
        if (parts.length >= 3) {
          sessionKey = parts.slice(2).join(':');
        }
      }
      const limit = p?.limit ? Number(p.limit) : 200;
      const params_ = new URLSearchParams();
      if (sessionKey) params_.set('sessionKey', sessionKey);
      params_.set('limit', String(limit));
      const url = `/api/chat/history?${params_.toString()}`;
      const headers: Record<string, string> = {};
      const token = this._getToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      return fetch(url, { headers }).then(async r => {
        const data = await r.json();
        const rawMessages = Array.isArray(data) ? data : (data?.messages ?? []);
        return { messages: rawMessages };
      }).catch(() => {
        return { messages: [] };
      }) as unknown as T;
    }
    if (method === 'agents.list') {
      return this._fetchJson<T>('/api/agents');
    }
    if (method === 'sessions.list') {
      return this._fetchJson<T>('/api/sessions');
    }
    // Unsupported methods — throw clear error instead of silent undefined
    throw new Error(`[DirectGatewayClient] Method "${method}" is not supported in DirectAdapter mode`);
  }

  /**
   * Get the JWT auth token from the API client if available.
   */
  private _getToken(): string | null {
    if (typeof window === 'undefined') return null;
    return (window as any).__apiClient?.getToken?.() ?? localStorage.getItem('token') ?? null;
  }

  /**
   * Fetch JSON from the backend REST API with auth headers.
   */
  private async _fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      ...(options?.headers as Record<string, string>),
    };
    const token = this._getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      throw new Error(`[DirectGatewayClient] REST API error: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  sendChat(sessionKey: string, message: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[DirectGatewayClient] cannot sendChat: not connected');
      return;
    }
    // Queue messages until auth_ok is received to avoid race condition
    if (!this.authenticated) {
      this.pendingMessages.push({ sessionKey, message });
      return;
    }
    this.ws.send(JSON.stringify({ type: 'chat.send', sessionKey, message }));
  }

  requestHistory(sessionKey: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[DirectGatewayClient] cannot requestHistory: not connected');
      return;
    }
    this.ws.send(JSON.stringify({ type: 'chat.history', sessionKey }));
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Manual reconnect — resets retry counter. Used after exhausted state. */
  reconnect(): void {
    this.closed = false;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.connect();
  }

  private dispatchEvent(data: unknown): void {
    if (!data || typeof data !== 'object') {
      return;
    }
    const msg = data as Record<string, unknown>;
    const type = msg.type;

    // Handle auth_ok to flush pending messages (CR-04 race condition fix)
    if (type === 'auth_ok') {
      this.authenticated = true;
      // Flush queued messages
      const pending = this.pendingMessages;
      this.pendingMessages = [];
      for (const pendingMsg of pending) {
        this.ws?.send(JSON.stringify({ type: 'chat.send', sessionKey: pendingMsg.sessionKey, message: pendingMsg.message }));
      }
      return;
    }

    // Forward known AdapterChatEvent shapes
    switch (type) {
      case 'text_delta':
      case 'thinking_delta':
      case 'thinking_end':
      case 'tool_start':
      case 'tool_result':
      case 'tool_error':
      case 'complete':
      case 'error':
        this.onEvent(data as AdapterChatEvent);
        break;
      default:
        // Unknown type — drop silently
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) {
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.onStateChange('exhausted');
      return;
    }
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    ) * (0.5 + Math.random() * 0.5); // 50-100% jitter to avoid thundering herd (WR-06)
    this.reconnectAttempts++;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// ─── initChatClient — initialization orchestration ───────────────────────
// Moved from the deleted app-gateway.ts (Phase 112 cleanup).
// Maps DirectAdapter ChatEvent types to frontend ChatEventPayload and
// wires a DirectGatewayClient to the app host component.

import { apiClient } from "../../api/index.ts";
import {
  CHAT_SESSIONS_ACTIVE_MINUTES,
  clearPendingQueueItemsForRun,
  flushChatQueueForEvent,
} from "./app-chat.ts";
import {
  refreshActiveTab,
  setLastActiveSessionKey,
} from "./app-settings.ts";
import { handleAgentEvent, resetToolStream, type AgentEventPayload } from "./app-tool-stream.ts";
import { shouldReloadHistoryForFinalEvent } from "./chat-event-reload.ts";
import { loadAgents, type AgentsState } from "./controllers/agents.ts";
import {
  loadChatHistory,
  handleChatEvent,
  type ChatEventPayload,
  type ChatState,
} from "./controllers/chat.ts";
import { loadSessions, type SessionsState } from "./controllers/sessions.ts";

/**
 * Map AdapterChatEvent (from DirectAdapter WS) to frontend ChatEventPayload.
 */
function mapAdapterChatEventToPayload(
  event: AdapterChatEvent,
  runId: string | null,
  sessionKey: string,
): ChatEventPayload | null {
  switch (event.type) {
    case 'text_delta':
      return {
        runId: runId ?? '',
        sessionKey,
        state: 'delta',
        message: { content: [{ type: 'text', text: event.delta }] },
      };
    case 'complete': {
      const thinking = (event as any).thinkingContent as string | undefined;
      const content: Array<{ type: string; [key: string]: unknown }> = [];
      if (thinking) {
        content.push({ type: 'thinking', thinking });
      }
      content.push({ type: 'text', text: (event as any).finalContent || '' });
      return {
        runId: runId ?? '',
        sessionKey,
        state: 'final',
        message: { role: 'assistant', content },
      };
    }
    case 'error':
      return {
        runId: runId ?? '',
        sessionKey,
        state: 'error',
        errorMessage: event.error,
      };
    default:
      return null;
  }
}

function isTerminalChatState(
  state: ChatEventPayload["state"] | ReturnType<typeof handleChatEvent> | null | undefined,
): state is "final" | "aborted" | "error" {
  return state === "final" || state === "aborted" || state === "error";
}

function isEventForDifferentActiveRun(
  payload: ChatEventPayload | undefined,
  activeRunId: string | null,
): boolean {
  return Boolean(activeRunId && payload && payload.runId !== activeRunId);
}

function handleTerminalChatEvent(
  host: Record<string, unknown>,
  payload: ChatEventPayload | undefined,
  state: ReturnType<typeof handleChatEvent>,
  activeRunIdBeforeEvent: string | null,
): boolean {
  if (state !== "final" && state !== "error" && state !== "aborted") {
    return false;
  }
  if (isEventForDifferentActiveRun(payload, activeRunIdBeforeEvent)) {
    return false;
  }
  const toolHost = host as unknown as Parameters<typeof resetToolStream>[0];
  const hadToolEvents = (toolHost as any).toolStreamOrder?.length > 0;
  const flushQueue = () =>
    void flushChatQueueForEvent(host as unknown as Parameters<typeof flushChatQueueForEvent>[0]);
  clearPendingQueueItemsForRun(
    host as unknown as Parameters<typeof clearPendingQueueItemsForRun>[0],
    payload?.runId,
  );
  const runId = payload?.runId;
  if (runId && (host.refreshSessionsAfterChat as Set<string>)?.has(runId)) {
    (host.refreshSessionsAfterChat as Set<string>).delete(runId);
    if (state === "final") {
      void loadSessions(host as unknown as SessionsState, {
        activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
      });
    }
  }
  if (hadToolEvents && state === "final") {
    const completedRunId = runId ?? null;
    void loadChatHistory(host as unknown as ChatState).finally(() => {
      if (completedRunId && host.chatRunId && host.chatRunId !== completedRunId) {
        return;
      }
      resetToolStream(toolHost);
      flushQueue();
    });
    return true;
  }
  resetToolStream(toolHost);
  flushQueue();
  return false;
}

function handleChatGatewayEvent(host: Record<string, unknown>, payload: ChatEventPayload | undefined) {
  if (payload?.sessionKey) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      payload.sessionKey,
    );
  }
  const activeRunIdBeforeEvent = host.chatRunId as string | null;
  const state = handleChatEvent(host as unknown as ChatState, payload);
  const terminalEventIsForDifferentActiveRun = isEventForDifferentActiveRun(
    payload,
    activeRunIdBeforeEvent,
  );
  const historyReloaded = handleTerminalChatEvent(host, payload, state, activeRunIdBeforeEvent);
  const finalEventNeedsHistoryReload =
    state === "final" && shouldReloadHistoryForFinalEvent(payload);
  if (finalEventNeedsHistoryReload && !historyReloaded && !terminalEventIsForDifferentActiveRun) {
    void loadChatHistory(host as unknown as ChatState);
    return;
  }
}

function handleDirectAdapterEvent(host: Record<string, unknown>, event: AdapterChatEvent): void {
  const runId = host.chatRunId as string | null;
  const sessionKey = host.sessionKey as string;

  switch (event.type) {
    case 'thinking_delta':
    case 'thinking_end':
      break;
    case 'text_delta':
    case 'complete':
    case 'error': {
      const payload = mapAdapterChatEventToPayload(event, runId, sessionKey);
      if (payload) {
        handleChatGatewayEvent(host, payload);
      }
      break;
    }
    case 'tool_start':
    case 'tool_result':
    case 'tool_error': {
      const agentPayload: AgentEventPayload = {
        runId: runId ?? '',
        seq: 0,
        stream: 'tool',
        ts: Date.now(),
        sessionKey,
        data: event as unknown as Record<string, unknown>,
      };
      handleAgentEvent(
        host as unknown as Parameters<typeof handleAgentEvent>[0],
        agentPayload,
      );
      break;
    }
  }
}

/**
 * Initialize DirectGatewayClient and wire it to the app host.
 * Replaces the old connectGateway (which used GatewayBrowserClient).
 */
export function initChatClient(host: Record<string, unknown>): void {
  const hasJwt = !!(typeof window !== 'undefined' && localStorage.getItem('token'));
  if (!hasJwt) {
    host.connected = false;
    return;
  }

  const existingClient = host.client as DirectGatewayClient | null;
  if (existingClient) {
    existingClient.disconnect();
  }

  const directClient = new DirectGatewayClient({
    url: `ws://${typeof location !== 'undefined' ? location.hostname : 'localhost'}:28888`,
    onEvent: (event) => {
      handleDirectAdapterEvent(host, event);
    },
    onStateChange: (state) => {
      if (state === 'connected') {
        host.connected = true;
        host.lastError = null;
        const loadState = async () => {
          try {
            await loadAgents(host as unknown as AgentsState);
            await loadSessions(host as unknown as SessionsState, {
              activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
            });
          } catch { /* best-effort */ }
          const token = apiClient.getToken();
          if (token && !localStorage.getItem('permissions')) {
            fetch('/api/auth/permissions', {
              headers: { 'Authorization': `Bearer ${token}` }
            }).then(r => r.json()).then((perms: string[]) => {
              localStorage.setItem('permissions', JSON.stringify(perms));
              window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: perms } }));
            }).catch(() => {});
          }
          refreshActiveTab(host as unknown as Parameters<typeof refreshActiveTab>[0]);
        };
        loadState();
      } else if (state === 'disconnected') {
        host.connected = false;
      } else if (state === 'auth_failed') {
        host.connected = false;
        host.lastError = '认证失败，请重新登录';
      } else if (state === 'exhausted') {
        host.connected = false;
        host.lastError = '连接失败，请点击重试';
      }
    },
  });

  host.client = directClient;
  directClient.connect();
}
