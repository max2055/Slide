/** Stable receivers keep async sends, reducers and stream timers in their session. */
type Host = Record<string, unknown>;
const defaults = () => ({
  sessionKey: '', chatMessage: '', chatAttachments: [], chatQueue: [],
  chatMessages: [], chatToolMessages: [], chatStreamSegments: [],
  chatLoading: false, chatSending: false, chatRunId: null,
  chatStream: null, chatStreamStartedAt: null, chatStreamPartId: undefined,
  chatCancelRequested: false, chatRuntimePhase: null, chatMessageProjection: null,
  chatStreamRecovery: undefined, chatThinkingText: '', chatThinkingComplete: false,
  chatThinkingLevel: null, chatSideResult: null, chatSideResultTerminalRuns: new Set(),
  chatRecoveryNotice: null, lastError: null, compactionStatus: null, fallbackStatus: null,
  chatAvatarUrl: null, toolStreamById: new Map(), toolStreamOrder: [], toolStreamSyncTimer: null,
  sidebarOpen: false, sidebarContent: null, sidebarError: null,
  chatAccessDenied: false, chatRunStatus: null, chatRunStatusClearTimer: null,
  compactionClearTimer: null, fallbackClearTimer: null,
});
type Scope = { values: Host; host: Host; valid: boolean };
type Sessions = { root: Host; active: Scope; byKey: Map<string, Scope>; byMessage: Map<string, Scope>; valid: boolean; denied?: string };
const sessions = new WeakMap<object, Sessions>();
const receivers = new WeakMap<object, { sessions: Sessions; scope: Scope }>();

function createScope(store: Sessions, key: string, initial?: Host): Scope {
  const values: Host = defaults();
  if (initial) for (const field of Object.keys(values)) {
    if (field in initial) values[field] = initial[field];
  }
  values.sessionKey = key;
  if (store.denied) { values.chatAccessDenied = true; values.lastError = store.denied; }
  const scope: Scope = { values, host: {}, valid: true };
  scope.host = new Proxy(values, {
    get(_, field) {
      if (typeof field === 'string' && field in values) {
        return store.valid && scope.valid && store.active === scope && store.root.sessionKey === values.sessionKey && field in store.root
          ? store.root[field] : values[field];
      }
      const value = store.root[field as string];
      // DOM methods need the real element as their receiver.
      return typeof value === 'function' ? value.bind(store.root) : value;
    },
    set(_, field, value) {
      if (!store.valid || !scope.valid) return true;
      if (typeof field === 'string' && field in values) {
        const visible = store.active === scope && store.root.sessionKey === values.sessionKey;
        if (field === 'sessionKey' && value !== values.sessionKey) {
          if (values.sessionKey) store.byKey.delete(String(values.sessionKey));
          if (value) store.byKey.set(String(value), scope);
        }
        values[field] = value;
        if (visible) store.root[field] = value;
      } else store.root[field as string] = value;
      return true;
    },
  });
  receivers.set(scope.host, { sessions: store, scope });
  if (key) store.byKey.set(key, scope);
  return scope;
}

export function chatSessionHost<T extends object>(host: T): T {
  if (receivers.has(host)) return host;
  const root = host as Host;
  let store = sessions.get(host);
  if (!store) {
    store = { root, active: undefined as unknown as Scope, byKey: new Map(), byMessage: new Map(), valid: true };
    store.active = createScope(store, String(root.sessionKey ?? ''), root);
    sessions.set(host, store);
  } else if (root.sessionKey !== store.active.values.sessionKey) {
    // Compatibility for callers assigning the session directly (URL/bootstrap).
    store.active = createScope(store, String(root.sessionKey ?? ''), root);
  }
  return store.active.host as T;
}

export function isVisibleChatSession(host: object): boolean {
  const receiver = receivers.get(host);
  return !receiver || receiver.sessions.valid && receiver.scope.valid && receiver.sessions.active === receiver.scope
    && receiver.sessions.root.sessionKey === receiver.scope.values.sessionKey;
}

export function isCurrentChatSession(host: object): boolean {
  const receiver = receivers.get(host);
  return !receiver || receiver.sessions.valid && receiver.scope.valid;
}

export function chatAccessDenial(error: unknown): { message: string; all: boolean } | null {
  if (!error || typeof error !== 'object') return null;
  const { status, code } = error as { status?: number; code?: string };
  if (status === 401) return { message: '登录已失效，请重新登录。', all: true };
  if (status === 403 || code === 'CHAT_FORBIDDEN') return { message: '无权使用聊天，请联系管理员。', all: true };
  if (status === 404 || code === 'CHAT_SESSION_NOT_FOUND') return { message: '会话不存在或不可见。', all: false };
  return null;
}

/** Replace receivers so pending reads, sends and timers cannot repopulate a denied view. */
export function denyChatSessions(host: object, message: string, all: boolean): void {
  const active = chatSessionHost(host);
  const { sessions: store, scope: target } = receivers.get(active)!;
  if (!store.valid || !target.valid) return;
  if (all) store.denied = message;
  const scopes = all ? new Set([store.active, ...store.byKey.values(), ...store.byMessage.values()]) : new Set([target]);
  for (const scope of scopes) {
    const key = String(scope.host.sessionKey ?? '');
    (store.root.refreshSessionsAfterChat as Set<string> | undefined)?.delete(String(scope.host.chatRunId ?? ''));
    for (const field of ['toolStreamSyncTimer', 'chatRunStatusClearTimer', 'compactionClearTimer', 'fallbackClearTimer']) {
      const timer = scope.host[field];
      if (timer != null) clearTimeout(timer as ReturnType<typeof setTimeout>);
    }
    scope.valid = false;
    Object.assign(scope.values, defaults(), { sessionKey: key, chatAccessDenied: true, lastError: message });
    const replacement = createScope(store, key);
    replacement.values.chatAccessDenied = true;
    replacement.values.lastError = message;
    for (const [id, sending] of store.byMessage) if (sending === scope) store.byMessage.delete(id);
    if (store.active === scope) {
      store.active = replacement;
      Object.assign(store.root, replacement.values);
    }
  }
  if (all) (store.root.refreshSessionsAfterChat as Set<string> | undefined)?.clear();
}

/** Only a fresh authorized history read can reopen a denied receiver. */
export function allowChatSession(host: object): boolean {
  const receiver = receivers.get(host);
  if (!receiver || !isCurrentChatSession(host)) return false;
  const denied = !!receiver.scope.host.chatAccessDenied;
  receiver.scope.host.chatAccessDenied = false;
  receiver.sessions.denied = undefined;
  return denied;
}

export function registerChatSend(host: object, messageId: string): void {
  chatSessionHost(host);
  const receiver = receivers.get(host) ?? receivers.get(chatSessionHost(host))!;
  receiver.sessions.byMessage.set(messageId, receiver.scope);
  // Bound completed acceptance identities; active sends remain referenced by session key.
  while (receiver.sessions.byMessage.size > 100) {
    receiver.sessions.byMessage.delete(receiver.sessions.byMessage.keys().next().value!);
  }
}

export function chatSessionForEvent<T extends object>(host: T, event: {
  sessionKey?: string; messageId?: string; runId?: string;
}, requireAssociation = false): T | null {
  const active = chatSessionHost(host) as Host;
  const { sessions: store } = receivers.get(active)!;
  // A denial names the requested session; never infer it from the visible view.
  const sessionKey = event.sessionKey?.trim();
  if (requireAssociation && sessionKey) {
    return (store.byKey.get(sessionKey)?.host as T) ?? null;
  }
  if (event.messageId) {
    const sending = store.byMessage.get(event.messageId);
    if (sending) return sending.host as T;
  }
  if (event.sessionKey) {
    if (event.sessionKey === active.sessionKey) return active as T;
    return (store.byKey.get(event.sessionKey)?.host as T) ?? null;
  }
  // Legacy events without a session must still match the run when one is known.
  if (event.runId && (requireAssociation || active.chatRunId && event.runId !== active.chatRunId)) {
    if (active.chatRunId === event.runId) return active as T;
    for (const scope of store.byKey.values()) if (scope.host.chatRunId === event.runId) return scope.host as T;
    return null;
  }
  return requireAssociation ? null : active as T;
}

export function activateChatSession(host: object, key: string): void {
  const active = chatSessionHost(host) as Host;
  const { sessions: store, scope: previous } = receivers.get(active)!;
  for (const field of Object.keys(previous.values)) previous.values[field] = active[field];
  // Each empty view is a distinct pending conversation, even before server admission.
  const next = (key && store.byKey.get(key)) || createScope(store, key);
  store.active = next;
  for (const [field, value] of Object.entries(next.values)) store.root[field] = value;
  // Retain busy views and unsent work; older clean views can be reloaded from history.
  for (const [oldKey, scope] of store.byKey) {
    if (store.byKey.size <= 20) break;
    if (scope === next || scope.host.chatRunId || scope.host.chatSending || scope.host.chatMessage
      || (scope.host.chatQueue as unknown[]).length || (scope.host.chatAttachments as unknown[]).length) continue;
    store.byKey.delete(oldKey);
    for (const [id, sending] of store.byMessage) if (sending === scope) store.byMessage.delete(id);
  }
}

export function clearChatSessions(host: object): void {
  const store = sessions.get(host) ?? receivers.get(host)?.sessions;
  if (!store) return;
  store.valid = false;
  for (const scope of new Set([store.active, ...store.byKey.values(), ...store.byMessage.values()])) {
    for (const field of ['toolStreamSyncTimer', 'chatRunStatusClearTimer', 'compactionClearTimer', 'fallbackClearTimer']) {
      const timer = scope.host[field];
      if (timer != null) clearTimeout(timer as ReturnType<typeof setTimeout>);
    }
    scope.valid = false;
    Object.assign(scope.values, defaults());
  }
  store.byKey.clear(); store.byMessage.clear();
  sessions.delete(store.root);
}

/** Connection loss affects every watched execution, including hidden busy views. */
export function chatSessionHosts(host: object): Host[] {
  const active = chatSessionHost(host);
  const { sessions: store } = receivers.get(active)!;
  return [...new Set([store.active, ...store.byKey.values()])].map(scope => scope.host);
}
