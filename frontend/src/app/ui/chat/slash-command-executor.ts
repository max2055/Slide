/**
 * Client-side execution engine for slash commands.
 * Calls gateway RPC methods and returns formatted results.
 */

import type { DirectGatewayClient } from "../direct-gateway.ts";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../session-key.ts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../string-coerce.ts";
import type {
  AgentsListResult,
  ChatModelOverride,
  GatewaySessionRow,
  ModelCatalogEntry,
  SessionsListResult,
} from "../types.ts";
import { SLASH_COMMANDS } from "./slash-commands.ts";

export type SlashCommandResult = {
  /** Unknown means a side-effecting request may have reached the server. Never auto-replay. */
  failure?: "retryable" | "unknown";
  /** Markdown-formatted result to display in chat. */
  content: string;
  /** Side-effect action the caller should perform after displaying the result. */
  action?:
    | "refresh"
    | "export"
    | "new-session"
    | "reset"
    | "stop"
    | "clear"
    | "toggle-focus"
    | "navigate-usage";
  /** Optional session-level directive changes that the caller should mirror locally. */
  sessionPatch?: {
    modelOverride?: ChatModelOverride | null;
  };
  /** When set, the caller should track this as the active run (enables Abort, blocks concurrent sends). */
  trackRunId?: string;
  /** When set, the caller should surface a visible pending item tied to the current run. */
  pendingCurrentRun?: boolean;
};

export type SlashCommandContext = {
  chatModelCatalog?: ModelCatalogEntry[];
  modelCatalog?: ModelCatalogEntry[];
  sessionsResult?: SessionsListResult | null;
};

export async function executeSlashCommand(
  client: DirectGatewayClient,
  sessionKey: string,
  commandName: string,
  args: string,
  context: SlashCommandContext = {},
): Promise<SlashCommandResult> {
  switch (commandName) {
    case "help":
      return executeHelp();
    case "new":
      return { content: "Starting new session...", action: "new-session" };
    case "reset":
      return { content: "Resetting session...", action: "reset" };
    case "clear":
      return { content: "Chat history cleared.", action: "clear" };
    case "focus":
      return { content: "Toggled focus mode.", action: "toggle-focus" };
    case "export-session":
      return { content: "Exporting session...", action: "export" };
    case "usage":
      return await executeUsage(client, sessionKey);
    case "agents":
      return await executeAgents(client);
    case "steer":
      return await executeSteer(client, sessionKey, args, context);
    default:
      return { content: `Unknown command: \`/${commandName}\`` };
  }
}

// ── Command Implementations ──

function executeHelp(): SlashCommandResult {
  const lines = ["**Available Commands**\n"];
  const groups = new Map<string, typeof SLASH_COMMANDS>();
  for (const cmd of SLASH_COMMANDS) {
    const cat = cmd.category ?? "session";
    groups.set(cat, [...(groups.get(cat) ?? []), cmd]);
  }
  for (const [cat, commands] of groups) {
    lines.push(`**${cat.charAt(0).toUpperCase() + cat.slice(1)}**`);
    for (const cmd of commands) {
      const argStr = cmd.args ? ` ${cmd.args}` : "";
      const local = cmd.executeLocal ? "" : " *(agent)*";
      lines.push(`\`/${cmd.name}${argStr}\` — ${cmd.description}${local}`);
    }
  }

  lines.push("\nType `/` to open the command menu.");
  return { content: lines.join("\n") };
}

async function executeUsage(
  client: DirectGatewayClient,
  sessionKey: string,
): Promise<SlashCommandResult> {
  try {
    const sessions = await client.request<SessionsListResult>("sessions.list", {});
    const session = resolveCurrentSession(sessions, sessionKey);
    if (!session) {
      return { content: "No active session." };
    }
    const measured = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0;
    const input = measured(session.inputTokens) ? session.inputTokens : null;
    const output = measured(session.outputTokens) ? session.outputTokens : null;
    const total = measured(session.totalTokens) ? session.totalTokens
      : input !== null && output !== null ? input + output : null;
    const format = (value: number | null) => value === null ? "不可用" : `**${fmtTokens(value)}** tokens`;
    const lines = [
      "**Session Usage**",
      `Input: ${format(input)}`,
      `Output: ${format(output)}`,
      `Total: ${format(total)}`,
      // Cumulative input usage is not current context occupancy. REST does not
      // currently expose a trustworthy occupancy measurement.
      "Context: 不可用",
    ];
    if (session.model) {
      lines.push(`Model: \`${session.model}\``);
    }
    return { content: lines.join("\n") };
  } catch (err) {
    return { content: `Failed to get usage: ${String(err)}`, failure: "retryable" };
  }
}

async function executeAgents(client: DirectGatewayClient): Promise<SlashCommandResult> {
  try {
    const result = await client.request<AgentsListResult>("agents.list", {});
    const agents = result?.agents ?? [];
    if (agents.length === 0) {
      return { content: "No agents configured." };
    }
    const lines = [`**Agents** (${agents.length})\n`];
    for (const agent of agents) {
      const isDefault = agent.id === result?.defaultId;
      const name = agent.identity?.name || agent.name || agent.id;
      const marker = isDefault ? " *(default)*" : "";
      lines.push(`- \`${agent.id}\` — ${name}${marker}`);
    }
    return { content: lines.join("\n") };
  } catch (err) {
    return { content: `Failed to list agents: ${String(err)}`, failure: "retryable" };
  }
}

function isWithinCurrentSessionSubtree(
  candidateSessionKey: string,
  currentSessionKey: string,
  sessionIndex: Map<string, GatewaySessionRow>,
  currentAgentId: string | undefined,
  candidateAgentId: string | undefined,
): boolean {
  if (!currentAgentId || candidateAgentId !== currentAgentId) {
    return false;
  }

  const currentAliases = resolveEquivalentSessionKeys(currentSessionKey, currentAgentId);
  const seen = new Set<string>();
  let parentSessionKey = normalizeSessionKey(sessionIndex.get(candidateSessionKey)?.spawnedBy);
  while (parentSessionKey && !seen.has(parentSessionKey)) {
    if (currentAliases.has(parentSessionKey)) {
      return true;
    }
    seen.add(parentSessionKey);
    parentSessionKey = normalizeSessionKey(sessionIndex.get(parentSessionKey)?.spawnedBy);
  }

  // Older gateways may not include spawnedBy on session rows yet; keep prefix
  // matching for nested subagent sessions as a compatibility fallback.
  return isSubagentSessionKey(currentSessionKey)
    ? candidateSessionKey.startsWith(`${currentSessionKey}:subagent:`)
    : false;
}

function buildSessionIndex(sessions: GatewaySessionRow[]): Map<string, GatewaySessionRow> {
  const index = new Map<string, GatewaySessionRow>();
  for (const session of sessions) {
    const normalizedKey = normalizeSessionKey(session?.key);
    if (!normalizedKey) {
      continue;
    }
    index.set(normalizedKey, session);
  }
  return index;
}

function normalizeSessionKey(key?: string | null): string | undefined {
  return normalizeOptionalLowercaseString(key);
}

function resolveEquivalentSessionKeys(
  currentSessionKey: string,
  currentAgentId: string | undefined,
): Set<string> {
  const keys = new Set<string>([currentSessionKey]);
  if (currentAgentId === DEFAULT_AGENT_ID) {
    const canonicalDefaultMain = `agent:${DEFAULT_AGENT_ID}:main`;
    if (currentSessionKey === DEFAULT_MAIN_KEY) {
      keys.add(canonicalDefaultMain);
    } else if (currentSessionKey === canonicalDefaultMain) {
      keys.add(DEFAULT_MAIN_KEY);
    }
  }
  return keys;
}

function resolveCurrentSession(
  sessions: SessionsListResult | undefined,
  sessionKey: string,
): GatewaySessionRow | undefined {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  const currentAgentId =
    parseAgentSessionKey(normalizedSessionKey ?? "")?.agentId ??
    (normalizedSessionKey === DEFAULT_MAIN_KEY ? DEFAULT_AGENT_ID : undefined);
  const aliases = normalizedSessionKey
    ? resolveEquivalentSessionKeys(normalizedSessionKey, currentAgentId)
    : new Set<string>();
  return sessions?.sessions?.find((session: GatewaySessionRow) => {
    const key = normalizeSessionKey(session.key);
    return key ? aliases.has(key) : false;
  });
}

/**
 * Match a target name against active subagent sessions by key/label only.
 * Unlike resolveKillTargets, this does NOT match by agent id (avoiding
 * false positives for common words like "main") and filters to active
 * sessions (no endedAt) so stale subagents are not targeted.
 */
function resolveSteerSubagent(
  sessions: GatewaySessionRow[],
  currentSessionKey: string,
  target: string,
): string[] {
  const normalizedTarget = normalizeLowercaseStringOrEmpty(target);
  if (!normalizedTarget) {
    return [];
  }
  const normalizedCurrentSessionKey = normalizeLowercaseStringOrEmpty(currentSessionKey);
  const currentParsed = parseAgentSessionKey(normalizedCurrentSessionKey);
  const currentAgentId =
    currentParsed?.agentId ??
    (normalizedCurrentSessionKey === DEFAULT_MAIN_KEY ? DEFAULT_AGENT_ID : undefined);
  const sessionIndex = buildSessionIndex(sessions);

  const keys = new Set<string>();
  for (const session of sessions) {
    const key = session?.key?.trim();
    if (!key || !isSubagentSessionKey(key)) {
      continue;
    }
    const normalizedKey = normalizeLowercaseStringOrEmpty(key);
    const parsed = parseAgentSessionKey(normalizedKey);
    const belongsToCurrentSession = isWithinCurrentSessionSubtree(
      normalizedKey,
      normalizedCurrentSessionKey,
      sessionIndex,
      currentAgentId,
      parsed?.agentId,
    );
    if (!belongsToCurrentSession) {
      continue;
    }
    // P2: match only on subagent key suffix or label, not agent id
    const isMatch =
      normalizedKey === normalizedTarget ||
      normalizedKey.endsWith(`:subagent:${normalizedTarget}`) ||
      normalizedKey === `subagent:${normalizedTarget}` ||
      normalizeLowercaseStringOrEmpty(session.label) === normalizedTarget;
    if (isMatch) {
      keys.add(key);
    }
  }
  return [...keys];
}

/**
 * Resolve an optional subagent target from the first word of args.
 * Returns the resolved session key and the remaining message, or
 * falls back to the current session key with the full args as message.
 *
 * Ended subagents are still resolved here so explicit `/steer <id> ...`
 * can surface the correct no-active-run message instead of silently steering
 * the current session.
 */
async function resolveSteerTarget(
  client: DirectGatewayClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<
  | { key: string; message: string; label?: string; sessions?: SessionsListResult }
  | { error: string }
> {
  const trimmed = args.trim();
  if (!trimmed) {
    return { error: "empty" };
  }
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx > 0) {
    const maybeTarget = trimmed.slice(0, spaceIdx);
    const rest = trimmed.slice(spaceIdx + 1).trim();
    // Skip "all" — resolveKillTargets treats it as a wildcard, but steer
    // target a single session, so "all good now" should not match subagents.
    if (rest && normalizeLowercaseStringOrEmpty(maybeTarget) !== "all") {
      const sessions =
        context.sessionsResult ?? (await client.request<SessionsListResult>("sessions.list", {}));
      const matched = resolveSteerSubagent(sessions?.sessions ?? [], sessionKey, maybeTarget);
      if (matched.length === 1) {
        return { key: matched[0], message: rest, label: maybeTarget, sessions };
      }
      if (matched.length > 1) {
        return { error: `Multiple sub-agents match \`${maybeTarget}\`. Be more specific.` };
      }
    }
  }
  return { key: sessionKey, message: trimmed };
}

/** The server selects and checks the active Run atomically with admission. */
async function executeSteer(
  client: DirectGatewayClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  let submitted = false;
  try {
    const resolved = await resolveSteerTarget(client, sessionKey, args, context);
    if ("error" in resolved) {
      return { content: resolved.error === "empty" ? "用法：`/steer [id] <message>`" : resolved.error, failure: "retryable" };
    }
    submitted = true;
    const result = await client.request<{ status: string; runId?: string }>("chat.steer", {
      sessionKey: resolved.key,
      message: resolved.message,
    });
    if (result.status === "no_active_run") {
      return { content: "没有可调整的活动运行，请使用聊天输入框发送新消息。", failure: "retryable" };
    }
    if (result.status !== "queued" || !result.runId) {
      return { content: "未能将消息加入运行，请先核对会话状态。", failure: ["invalid", "ambiguous", "queue_full"].includes(result.status) ? "retryable" : "unknown" };
    }
    return { content: resolved.label ? `已为 \`${resolved.label}\` 的活动运行排队。` : "已为活动运行排队。" };
  } catch (err) {
    return { content: `调整运行失败：${String(err)}`, failure: submitted ? "unknown" : "retryable" };
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(n);
}
