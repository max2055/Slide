import { setLastActiveSessionKey } from "./app-last-active-session.ts";
import { scheduleChatScroll, resetChatScroll } from "./app-scroll.ts";
import { resetToolStream } from "./app-tool-stream.ts";
import type { ChatSideResult } from "./chat/side-result.ts";
import { executeSlashCommand } from "./chat/slash-command-executor.ts";
import { parseSlashCommand, refreshSlashCommands } from "./chat/slash-commands.ts";
import {
  loadChatHistory,
  sendChatMessage,
  sendDetachedChatMessage,
  restoreChatDraft,
  unconfirmedChatMessageId,
  updateChatDraft,
  type ChatState,
} from "./controllers/chat.ts";
import { loadSessions, type SessionsState } from "./controllers/sessions.ts";
import type { DirectGatewayClient } from "./direct-gateway.ts";
import { normalizeBasePath } from "./navigation.ts";
import { parseAgentSessionKey } from "./session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";
import type { ChatModelOverride, ModelCatalogEntry } from "./types.ts";
import type { SessionsListResult } from "./types.ts";
import type { ChatAttachment, ChatQueueItem } from "./ui-types.ts";
import { generateUUID } from "./uuid.ts";
import { chatSessionHost, isCurrentChatSession, isVisibleChatSession } from './chat-session-state.ts';

export type ChatHost = {
  client: DirectGatewayClient | null;
  chatMessages: unknown[];
  chatStream: string | null;
  connected: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatDraftRevision?: number;
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatSending: boolean;
  chatCancelRequested?: boolean;
  lastError?: string | null;
  sessionKey: string;
  basePath: string;
  hello: Record<string, unknown> | null;
  chatAvatarUrl: string | null;
  chatSideResult?: ChatSideResult | null;
  chatSideResultTerminalRuns?: Set<string>;
  chatModelOverrides: Record<string, ChatModelOverride | null>;
  chatModelsLoading: boolean;
  chatModelCatalog: ModelCatalogEntry[];
  sessionsResult?: SessionsListResult | null;
  updateComplete?: Promise<unknown>;
  refreshSessionsAfterChat: Set<string>;
  chatThinkingText?: string;
  chatThinkingComplete?: boolean;
  /** Callback for slash-command side effects that need app-level access. */
  onSlashAction?: (action: string) => void;
};

export const CHAT_SESSIONS_ACTIVE_MINUTES = 120;
export const CHAT_SESSIONS_REFRESH_LIMIT = 100;

export function isChatBusy(host: ChatHost) {
  return host.chatSending || Boolean(host.chatRunId);
}

export function isChatStopCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  return normalized === "/stop";
}

function isChatResetCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (normalized === "/new" || normalized === "/reset") {
    return true;
  }
  return normalized.startsWith("/new ") || normalized.startsWith("/reset ");
}

function isBtwCommand(text: string) {
  return /^\/btw(?::|\s|$)/i.test(text.trim());
}

export async function handleAbortChat(host: ChatHost) {
  if (!host.client || !host.connected || !host.chatRunId || !host.sessionKey) return;
  if (host.chatCancelRequested) return;
  host.chatCancelRequested = true;
  try {
    if (host.client.cancelChat(host.chatRunId, host.sessionKey) === false) {
      host.chatCancelRequested = false;
      host.lastError = "取消请求未送达，请在连接恢复后重试。";
      return;
    }
  } catch {
    host.chatCancelRequested = false;
    host.lastError = "取消请求未送达，请在连接恢复后重试。";
    return;
  }
  host.chatSending = true;
}

function enqueueChatMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
  localCommand?: { args: string; name: string },
) {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return;
  }
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      text: trimmed,
      createdAt: Date.now(),
      attachments: hasAttachments ? attachments?.map((att) => ({ ...att })) : undefined,
      refreshSessions,
      localCommandArgs: localCommand?.args,
      localCommandName: localCommand?.name,
    },
  ];
}

function enqueuePendingRunMessage(host: ChatHost, text: string, pendingRunId: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      text: trimmed,
      createdAt: Date.now(),
      pendingRunId,
    },
  ];
}

async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    restoreDraft?: boolean;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    restoreAttachments?: boolean;
    refreshSessions?: boolean;
  },
) {
  resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
  // Reset scroll state before sending to ensure auto-scroll works for the response
  resetChatScroll(host as unknown as Parameters<typeof resetChatScroll>[0]);
  // Reset thinking state for new message
  host.chatThinkingText = '';
  host.chatThinkingComplete = false;
  const draftRevision = host.chatDraftRevision;
  const result = await sendChatMessage(host as unknown as ChatState, message, opts?.attachments);
  if (!isCurrentChatSession(host)) return null;
  const runId = result?.runId;
  if (!runId && host.chatDraftRevision === draftRevision && !host.chatMessage && !host.chatAttachments.length
    && (opts?.previousDraft !== undefined || opts?.previousAttachments?.length)) {
    restoreChatDraft(host as unknown as ChatState, opts?.previousDraft ?? "", opts?.previousAttachments ?? [],
      result?.unconfirmedMessageId);
  }
  if (runId && isVisibleChatSession(host)) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      host.sessionKey,
    );
  }
  if (runId && host.chatDraftRevision === draftRevision) {
    const draft = opts?.restoreDraft && opts.previousDraft?.trim() ? opts.previousDraft : host.chatMessage;
    const attachments = opts?.restoreAttachments && opts.previousAttachments?.length
      ? opts.previousAttachments : host.chatAttachments;
    if (draft !== host.chatMessage || attachments !== host.chatAttachments) updateChatDraft(host, draft, attachments);
  }
  // Force scroll after sending to ensure viewport is at bottom for incoming stream
  if (isVisibleChatSession(host)) scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0], true);
  if (runId && !host.chatRunId) {
    void flushChatQueue(host);
  }
  if (runId && opts?.refreshSessions) {
    host.refreshSessionsAfterChat.add(runId);
  }
  return result;
}

async function sendDetachedBtwMessage(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
  },
) {
  const draftRevision = host.chatDraftRevision;
  const result = await sendDetachedChatMessage(
    host as unknown as ChatState,
    message,
    opts?.attachments,
  );
  if (!isCurrentChatSession(host)) return;
  const runId = result?.runId;
  if (!runId && host.chatDraftRevision === draftRevision && !host.chatMessage && !host.chatAttachments.length
    && (opts?.previousDraft !== undefined || opts?.previousAttachments?.length)) {
    restoreChatDraft(host as unknown as ChatState, opts?.previousDraft ?? "", opts?.previousAttachments ?? [],
      result?.unconfirmedMessageId);
  }
  if (runId && isVisibleChatSession(host)) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      host.sessionKey,
    );
  }
}

async function flushChatQueue(host: ChatHost) {
  if (!isVisibleChatSession(host) || !host.connected || isChatBusy(host)) {
    return;
  }
  const nextIndex = host.chatQueue.findIndex((item) => !item.pendingRunId && !item.unconfirmedMessageId);
  if (nextIndex < 0) {
    return;
  }
  const next = host.chatQueue[nextIndex];
  const state = host as unknown as ChatState;
  if (unconfirmedChatMessageId(state, next.text, next.attachments)) return;
  host.chatQueue = host.chatQueue.filter((_, index) => index !== nextIndex);
  const draftRevision = host.chatDraftRevision;
  let ok = false;
  let unconfirmedMessageId: string | undefined;
  try {
    if (next.localCommandName) {
      ok = await dispatchSlashCommand(host, next.localCommandName, next.localCommandArgs ?? "");
    } else {
      const result = await sendChatMessageNow(host, next.text, {
        attachments: next.attachments,
        refreshSessions: next.refreshSessions,
      });
      ok = Boolean(result?.runId);
      unconfirmedMessageId = result?.unconfirmedMessageId;
    }
  } catch (err) {
    host.lastError = String(err);
  }
  if (!ok) {
    if (unconfirmedMessageId && host.chatDraftRevision === draftRevision && !host.chatMessage && !host.chatAttachments.length) {
      restoreChatDraft(state, next.text, next.attachments ?? [], unconfirmedMessageId);
    } else {
      host.chatQueue = [{ ...next, unconfirmedMessageId }, ...host.chatQueue];
    }
  } else if (host.chatQueue.length > 0) {
    // Continue draining — local commands don't block on server response
    void flushChatQueue(host);
  }
}

export function removeQueuedMessage(host: ChatHost, id: string) {
  host.chatQueue = host.chatQueue.filter((item) => item.id !== id);
}

export function clearPendingQueueItemsForRun(host: ChatHost, runId: string | undefined) {
  if (!runId) {
    return;
  }
  host.chatQueue = host.chatQueue.filter((item) => item.pendingRunId !== runId);
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: { restoreDraft?: boolean },
) {
  host = chatSessionHost(host);
  if (messageOverride?.trim().toLowerCase() === '/new') {
    host.onSlashAction?.('switch-session:');
    return;
  }
  if (!host.connected) {
    return;
  }
  const previousDraft = host.chatMessage;
  const draftRevision = host.chatDraftRevision;
  const message = (messageOverride ?? host.chatMessage).trim();
  const attachments = host.chatAttachments ?? [];
  const attachmentsToSend = messageOverride == null ? attachments : [];
  const hasAttachments = attachmentsToSend.length > 0;

  if (!message && !hasAttachments) {
    return;
  }

  if (isChatStopCommand(message)) {
    await handleAbortChat(host);
    return;
  }

  if (isBtwCommand(message)) {
    if (messageOverride == null) {
      updateChatDraft(host, "", []);
    }
    await sendDetachedBtwMessage(host, message, {
      previousDraft: messageOverride == null ? previousDraft : undefined,
      attachments: hasAttachments ? attachmentsToSend : undefined,
      previousAttachments: messageOverride == null ? attachments : undefined,
    });
    return;
  }

  // Intercept local slash commands (/status, /model, /compact, etc.)
  const parsed = parseSlashCommand(message);
  if (parsed?.command.executeLocal) {
    if (hasAttachments) {
      host.lastError = "本地斜杠命令不支持附件，请移除附件后执行，或将图片作为普通消息发送。草稿和附件已保留。";
      return;
    }
    if (isChatBusy(host) && shouldQueueLocalSlashCommand(parsed.command.key)) {
      if (messageOverride == null) {
        updateChatDraft(host, "", []);
      }
      enqueueChatMessage(host, message, undefined, isChatResetCommand(message), {
        args: parsed.args,
        name: parsed.command.key,
      });
      return;
    }
    // Keep the draft until success; failures must not destroy unsent work.
    const ok = await dispatchSlashCommand(host, parsed.command.key, parsed.args);
    if (ok && messageOverride == null && host.chatDraftRevision === draftRevision
      && host.chatMessage === previousDraft && host.chatAttachments === attachments) {
      updateChatDraft(host, "", []);
    }
    return;
  }

  const refreshSessions = isChatResetCommand(message);
  if (messageOverride == null) {
    updateChatDraft(host, "", []);
  }

  if (isChatBusy(host)) {
    enqueueChatMessage(host, message, attachmentsToSend, refreshSessions);
    return;
  }

  await sendChatMessageNow(host, message, {
    previousDraft: messageOverride == null ? previousDraft : undefined,
    restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
    attachments: hasAttachments ? attachmentsToSend : undefined,
    previousAttachments: messageOverride == null ? attachments : undefined,
    restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
    refreshSessions,
  });
}

function shouldQueueLocalSlashCommand(name: string): boolean {
  return !["stop", "focus", "export-session", "steer", "redirect", "new", "clear"].includes(name);
}

// ── Slash Command Dispatch ──

async function dispatchSlashCommand(
  host: ChatHost,
  name: string,
  args: string,
): Promise<boolean> {
  switch (name) {
    case "stop":
      await handleAbortChat(host);
      return true;
    case "new":
    case "reset":
      host.onSlashAction?.("switch-session:");
      return true;
    case "clear":
      await clearChatHistory(host);
      return false;
    case "focus":
      host.onSlashAction?.("toggle-focus");
      return true;
    case "export-session":
      host.onSlashAction?.("export");
      return true;
  }

  if (!host.client) {
    host.lastError = "命令未执行，请连接恢复后重试。";
    return false;
  }

  host.lastError = null;
  const targetSessionKey = host.sessionKey;
  const result = await executeSlashCommand(host.client, targetSessionKey, name, args, {
    chatModelCatalog: host.chatModelCatalog,
    sessionsResult: host.sessionsResult,
  });
  if (!isVisibleChatSession(host)) return !result.failure;

  if (result.content) {
    injectCommandResult(host, result.content);
  }

  if (result.failure) {
    host.lastError = result.failure === "unknown"
      ? "命令执行结果未知，请先核对会话状态再决定是否重新执行；未自动重试。"
      : "命令未完成，可重试。草稿已保留；排队命令仍在队列中。";
    return false;
  }

  if (result.trackRunId) {
    host.chatRunId = result.trackRunId;
    host.chatStream = "";
    host.chatSending = false;
  }

  if (result.pendingCurrentRun && host.chatRunId) {
    enqueuePendingRunMessage(host, `/${name} ${args}`.trim(), host.chatRunId);
  }

  if (result.sessionPatch && "modelOverride" in result.sessionPatch) {
    host.chatModelOverrides = {
      ...host.chatModelOverrides,
      [targetSessionKey]: result.sessionPatch.modelOverride ?? null,
    };
    host.onSlashAction?.("refresh-tools-effective");
  }

  if (result.action === "refresh") {
    await refreshChat(host);
  }

  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  return true;
}

async function clearChatHistory(host: ChatHost) {
  // Deleting a session or starting a new one is not a history reset.
  host.lastError = "当前不支持清空历史：后端未提供保留会话的清空接口。历史记录未修改；如需开始新对话，请使用 /new。";
}

function injectCommandResult(host: ChatHost, content: string) {
  host.chatMessages = [
    ...host.chatMessages,
    {
      role: "system",
      content,
      timestamp: Date.now(),
    },
  ];
}

export async function refreshChat(host: ChatHost, opts?: { scheduleScroll?: boolean; clearNotices?: boolean }) {
  // Subscribe WS to session for invoke() completion broadcasts (e.g., RCA analysis)
  try { (host.client as any)?.watchSession?.(host.sessionKey); } catch { /* best-effort */ }
  await Promise.all([
    loadChatHistory(host as unknown as ChatState, { clearNotices: opts?.clearNotices }),
    loadSessions(host as unknown as SessionsState, {
      activeMinutes: 0,
      limit: 0,
      includeGlobal: true,
      includeUnknown: true,
    }),
    refreshChatAvatar(host),
    refreshChatModels(host),
    refreshChatCommands(host),
  ]);
  if (opts?.scheduleScroll !== false) {
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  }
}

async function refreshChatModels(host: ChatHost) {
  if (!host.client || !host.connected) {
    host.chatModelsLoading = false;
    host.chatModelCatalog = [];
    return;
  }
  host.chatModelsLoading = true;
  try {
    const catalog = await host.client.request<Array<{
      id: string; name: string; provider: string; alias?: string;
      contextWindow?: number; reasoning?: boolean;
      input?: Array<"text" | "image" | "document">;
    }>>("models.list");
    host.chatModelCatalog = Array.isArray(catalog) ? catalog : [];
  } catch {
    host.chatModelCatalog = [];
  } finally {
    host.chatModelsLoading = false;
  }
}

async function refreshChatCommands(host: ChatHost) {
  await refreshSlashCommands({
    client: host.client,
    agentId: resolveAgentIdForSession(host),
  });
}

export const flushChatQueueForEvent = flushChatQueue;
const chatAvatarRequestVersions = new WeakMap<object, number>();

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
};

function beginChatAvatarRequest(host: ChatHost): number {
  const key = host as object;
  const nextVersion = (chatAvatarRequestVersions.get(key) ?? 0) + 1;
  chatAvatarRequestVersions.set(key, nextVersion);
  return nextVersion;
}

function shouldApplyChatAvatarResult(host: ChatHost, version: number, sessionKey: string): boolean {
  return (
    host.connected && chatAvatarRequestVersions.get(host as object) === version && host.sessionKey === sessionKey
  );
}

function resolveAgentIdForSession(host: ChatHost): string | null {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const fallback = snapshot?.sessionDefaults?.defaultAgentId?.trim();
  return fallback || "main";
}

function buildAvatarMetaUrl(basePath: string, agentId: string): string {
  const base = normalizeBasePath(basePath);
  const encoded = encodeURIComponent(agentId);
  return base ? `${base}/avatar/${encoded}?meta=1` : `avatar/${encoded}?meta=1`;
}

export async function refreshChatAvatar(host: ChatHost) {
  const requestVersion = beginChatAvatarRequest(host);
  if (!host.connected) {
    host.chatAvatarUrl = null;
    return;
  }
  const sessionKey = host.sessionKey;
  const agentId = resolveAgentIdForSession(host);
  if (!agentId) {
    if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      host.chatAvatarUrl = null;
    }
    return;
  }
  host.chatAvatarUrl = null;
  const url = buildAvatarMetaUrl(host.basePath, agentId);
  try {
    const res = await fetch(url, { method: "GET" });
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      return;
    }
    if (!res.ok) {
      host.chatAvatarUrl = null;
      return;
    }
    const data = (await res.json()) as { avatarUrl?: unknown };
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      return;
    }
    const avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
    host.chatAvatarUrl = avatarUrl || null;
  } catch {
    if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      host.chatAvatarUrl = null;
    }
  }
}
