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

import { generateUUID } from './uuid.ts';
import type { DeviceIdentity } from './device-identity.ts';

export type AdapterTextDeltaEvent = { type: 'text_delta'; delta: string };
export type AdapterToolStartEvent = { type: 'tool_start'; toolName: string; args: Record<string, unknown> };
export type AdapterToolResultEvent = { type: 'tool_result'; toolName: string; result: unknown };
export type AdapterToolErrorEvent = { type: 'tool_error'; toolName: string; error: string };
export type AdapterToolProgressEvent = { type: 'tool_progress'; toolName: string; progress: Record<string, unknown> };
export type AdapterThinkingDeltaEvent = { type: 'thinking_delta'; delta: string };
export type AdapterThinkingEndEvent = { type: 'thinking_end' };
export type AdapterCompleteEvent = { type: 'complete'; finalContent?: string; thinkingContent?: string; messageSequence?: number };
export type AdapterCancelledEvent = { type: 'cancelled'; runId?: string; sessionKey?: string };
export type AdapterErrorEvent = { type: 'error'; error: string };
export type AdapterSessionCreatedEvent = { type: 'session.created'; sessionKey: string };
export type AdapterRunStartedEvent = { type: 'run.started'; runId: string; sessionKey: string };
export type AdapterProtocolErrorEvent = { type: 'protocol.error'; code: string };

/** ChatEvent discriminated union — mirrors apps/db-ops-api/src/adapter/types.ts */
export type AdapterChatEvent =
  | AdapterSessionCreatedEvent
  | AdapterRunStartedEvent
  | AdapterProtocolErrorEvent
  | AdapterTextDeltaEvent
  | AdapterToolStartEvent
  | AdapterToolResultEvent
  | AdapterToolErrorEvent
  | AdapterToolProgressEvent
  | AdapterThinkingDeltaEvent
  | AdapterThinkingEndEvent
  | AdapterCompleteEvent
  | AdapterCancelledEvent
  | AdapterErrorEvent;

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'auth_failed' | 'exhausted';
export type ConnectionStateCallback = (state: ConnectionState) => void;

export type DirectGatewayClientOptions = {
  /** Default: same-origin /agent-ws (proxied to DirectAdapter). */
  url?: string;
  /** Callback for incoming AdapterChatEvent payloads from DirectAdapter WS */
  onEvent: (event: AdapterChatEvent) => void;
  /** Callback for connection state changes */
  onStateChange: ConnectionStateCallback;
};

const configuredAdapterUrl = (import.meta as ImportMeta & { env?: { VITE_AGENT_WS_URL?: string } })
  .env?.VITE_AGENT_WS_URL?.trim();
export const defaultAdapterUrl = () => {
  if (configuredAdapterUrl) return configuredAdapterUrl;
  if (typeof location === 'undefined') return 'ws://localhost/agent-ws';
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/agent-ws`;
};
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
  private pendingMessages: Array<{ sessionKey?: string; message: string; messageId: string; idempotencyKey: string }> = [];
  private deviceIdentity: DeviceIdentity | null = null;
  private deviceAuth: { deviceId: string; publicKey: string; signature: string; timestamp: number; nonce: string } | null = null;

  constructor(opts: DirectGatewayClientOptions) {
    this.url = opts.url ?? defaultAdapterUrl();
    this.onEvent = opts.onEvent;
    this.onStateChange = opts.onStateChange;
  }

  setDeviceIdentity(identity: DeviceIdentity | null): void {
    this.deviceIdentity = identity;
  }

  setDeviceAuth(auth: typeof this.deviceAuth): void {
    this.deviceAuth = auth;
  }

  connect(): void {
    if (this.closed) {
      return;
    }
    this.authenticated = false;
    this.onStateChange('connecting');
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.onStateChange('connected');
      const token = typeof window !== 'undefined'
        ? (window as any).__apiClient?.getToken?.()
        : null;
      if (token) {
        this.ws!.send(JSON.stringify({ type: 'auth', token, deviceIdentity: this.deviceIdentity, deviceAuth: this.deviceAuth }));
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
      const sessionKey = typeof p?.sessionKey === 'string' && p.sessionKey.trim()
        ? p.sessionKey.trim()
        : undefined;
      const message = (p?.message as string) || '';
      const accepted = this.sendChat(sessionKey, message, {
        idempotencyKey: typeof p?.idempotencyKey === 'string' ? p.idempotencyKey : undefined,
        attachments: Array.isArray(p?.attachments) ? p.attachments : undefined,
      });
      if (!accepted) {
        throw new Error('[DirectGatewayClient] chat.send could not be queued because the WebSocket is not connected');
      }
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
        if (!r.ok) {
          throw new Error(`[DirectGatewayClient] REST API error: ${r.status} ${r.statusText}`);
        }
        const data = await r.json();
        const rawMessages = Array.isArray(data) ? data : (data?.messages ?? []);
        return { messages: rawMessages };
      }) as unknown as T;
    }
    if (method === 'agents.list') {
      return this._fetchJson<T>('/api/agents');
    }
    if (method === 'sessions.list') {
      return this._fetchJson<T>('/api/sessions');
    }
    if (method === 'sessions.patch') {
      const p = params as { key: string; model?: string | null; thinkingLevel?: string | null };
      const token = this._getToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      return fetch(`/api/sessions/${encodeURIComponent(p.key)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ model: p.model, thinkingLevel: p.thinkingLevel }),
      }).then(async r => {
        if (!r.ok) throw new Error(`PATCH /api/sessions failed: ${r.status}`);
        return r.json();
      }) as unknown as T;
    }
    if (method === 'models.list') {
      return this._fetchJson<T>('/api/models');
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

  sendChat(sessionKey: string | undefined, message: string, options?: { idempotencyKey?: string; attachments?: unknown[] }): boolean {
    const frame = this.chatSendFrame(sessionKey, message, options);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[DirectGatewayClient] cannot sendChat: not connected');
      return false;
    }
    // Queue messages until auth_ok is received to avoid race condition
    if (!this.authenticated) {
      this.pendingMessages.push(frame as { sessionKey?: string; message: string; messageId: string; idempotencyKey: string });
      return true;
    }
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  cancelChat(runId: string, sessionKey: string): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.authenticated) {
      this.ws.send(JSON.stringify({ type: 'chat.cancel', runId, sessionKey }));
    }
  }

  requestHistory(sessionKey: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[DirectGatewayClient] cannot requestHistory: not connected');
      return;
    }
    this.ws.send(JSON.stringify({ type: 'chat.history', sessionKey }));
  }

  /** Subscribe to invoke() completion broadcasts for a session. */
  watchSession(sessionKey: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify({ type: 'chat.watch', sessionKey }));
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
        this.ws?.send(JSON.stringify(pendingMsg));
      }
      return;
    }

    // Forward known AdapterChatEvent shapes
    switch (type) {
      case 'session.created':
      case 'run.started':
      case 'protocol.error':
      case 'text_delta':
      case 'thinking_delta':
      case 'thinking_end':
      case 'tool_start':
      case 'tool_result':
      case 'tool_error':
      case 'tool_progress':
      case 'complete':
      case 'cancelled':
      case 'error':
        this.onEvent(data as AdapterChatEvent);
        break;
      default:
        // Unknown type — drop silently
        break;
    }
  }

  private chatSendFrame(sessionKey: string | undefined, message: string, options?: { idempotencyKey?: string; attachments?: unknown[] }): Record<string, unknown> {
    return {
      type: 'chat.send',
      protocolVersion: 2,
      messageId: generateUUID(),
      idempotencyKey: options?.idempotencyKey || generateUUID(),
      ...(sessionKey ? { sessionKey } : {}),
      ...(options?.attachments ? { attachments: options.attachments } : {}),
      message,
    };
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
    case 'cancelled':
      return {
        runId: event.runId ?? runId ?? '',
        sessionKey: event.sessionKey ?? sessionKey,
        state: 'aborted',
      };
    case 'protocol.error':
      return {
        runId: runId ?? '',
        sessionKey,
        state: 'error',
        errorMessage: event.code,
      };
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

type PendingDirectStreamUpdate = {
  thinkingText?: string;
  thinkingComplete?: boolean;
  textPayload?: ChatEventPayload;
  timer: ReturnType<typeof setTimeout> | null;
};

const pendingDirectStreamUpdates = new WeakMap<object, PendingDirectStreamUpdate>();

function pendingStreamUpdateFor(host: Record<string, unknown>): PendingDirectStreamUpdate {
  const key = host as object;
  let pending = pendingDirectStreamUpdates.get(key);
  if (!pending) {
    pending = { timer: null };
    pendingDirectStreamUpdates.set(key, pending);
  }
  return pending;
}

function flushDirectStreamUpdates(host: Record<string, unknown>): void {
  const key = host as object;
  const pending = pendingDirectStreamUpdates.get(key);
  if (!pending) return;
  if (pending.timer !== null) {
    clearTimeout(pending.timer);
  }
  pending.timer = null;
  if (pending.thinkingText !== undefined) {
    host.chatThinkingText = pending.thinkingText;
  }
  if (pending.thinkingComplete !== undefined) {
    host.chatThinkingComplete = pending.thinkingComplete;
  }
  const payload = pending.textPayload;
  pending.thinkingText = undefined;
  pending.thinkingComplete = undefined;
  pending.textPayload = undefined;
  if (payload) {
    handleChatGatewayEvent(host, payload);
  }
  if (pending.timer === null && !pending.thinkingText && !pending.thinkingComplete && !pending.textPayload) {
    pendingDirectStreamUpdates.delete(key);
  }
}

function scheduleDirectStreamFlush(host: Record<string, unknown>): void {
  const pending = pendingStreamUpdateFor(host);
  if (pending.timer !== null) return;
  pending.timer = setTimeout(() => flushDirectStreamUpdates(host), 16);
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

export function handleDirectAdapterEvent(host: Record<string, unknown>, event: AdapterChatEvent): void {
  const runId = host.chatRunId as string | null;
  const sessionKey = host.sessionKey as string;

  switch (event.type) {
    case 'run.started':
      host.chatRunId = event.runId;
      host.sessionKey = event.sessionKey;
      break;
    case 'session.created': {
      const nextSessionKey = event.sessionKey.trim();
      if (!nextSessionKey) break;
      host.sessionKey = nextSessionKey;
      const settings = host.settings as Record<string, unknown> | undefined;
      const applySettings = host.applySettings as ((next: Record<string, unknown>) => void) | undefined;
      if (settings && applySettings) {
        applySettings.call(host, {
          ...settings,
          sessionKey: nextSessionKey,
          lastActiveSessionKey: nextSessionKey,
        });
      }
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        url.searchParams.set('session', nextSessionKey);
        window.history.replaceState({}, '', url);
      }
      void loadSessions(host as unknown as SessionsState, {
        activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
      });
      break;
    }
    case 'thinking_delta':
      // Accumulate thinking text
      {
        const pending = pendingStreamUpdateFor(host);
        pending.thinkingText = (pending.thinkingText ?? (host.chatThinkingText as string) ?? '') + event.delta;
        pending.thinkingComplete = false;
        scheduleDirectStreamFlush(host);
      }
      break;
    case 'thinking_end':
      flushDirectStreamUpdates(host);
      host.chatThinkingComplete = true;
      break;
    case 'text_delta': {
      const payload = mapAdapterChatEventToPayload(event, runId, sessionKey);
      if (payload) {
        pendingStreamUpdateFor(host).textPayload = payload;
        scheduleDirectStreamFlush(host);
      }
      break;
    }
    case 'complete':
    case 'cancelled':
    case 'protocol.error':
    case 'error': {
      flushDirectStreamUpdates(host);
      const payload = mapAdapterChatEventToPayload(event, runId, sessionKey);
      if (payload) {
        handleChatGatewayEvent(host, payload);
      }
      break;
    }
    case 'tool_start':
    case 'tool_result':
    case 'tool_error': {
      flushDirectStreamUpdates(host);
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
    case 'tool_progress': {
      flushDirectStreamUpdates(host);
      const agentPayload: AgentEventPayload = {
        runId: runId ?? '',
        seq: Number(event.progress.sequence ?? 0),
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
    url: defaultAdapterUrl(),
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

  // JWT authentication is the primary login path. Device registration is
  // additive, so do not make the WebSocket connection wait for an optional
  // dynamic module or its network requests.
  directClient.connect();

  void import('./device-identity.ts').then(async ({ loadOrCreateDeviceIdentity }) => {
    try {
      const identity = await loadOrCreateDeviceIdentity();
      directClient.setDeviceIdentity(identity);
      const token = apiClient.getToken();
      if (token) {
        await fetch('/api/device/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ deviceId: identity.deviceId, publicKey: identity.publicKey }),
        });
        const challengeResponse = await fetch('/api/device/challenge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ deviceId: identity.deviceId }),
        });
        if (challengeResponse.ok) {
          const challenge = await challengeResponse.json() as { nonce: string };
          const { signDevicePayload } = await import('./device-identity.ts');
          const timestamp = Date.now();
          const payload = [identity.deviceId, timestamp, challenge.nonce, 'GET', '/ws/auth', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'].join('.');
          directClient.setDeviceAuth({ deviceId: identity.deviceId, publicKey: identity.publicKey, signature: await signDevicePayload(identity.privateKey, payload), timestamp, nonce: challenge.nonce });
        }
      }
    } catch {
      // Device registration is additive; JWT login remains available if it fails.
    }
  }).catch(() => {
    // A stale Vite optimized dependency must not leave the user on the login gate.
  });
}
