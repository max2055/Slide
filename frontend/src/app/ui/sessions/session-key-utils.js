/**
 * Session key utilities for parsing agent session keys.
 * Simplified version for Slide project.
 */

/**
 * Parses an agent session key into its components.
 * Format: agent:{agentId}:{rest}
 */
export function parseAgentSessionKey(sessionKey) {
  if (!sessionKey || typeof sessionKey !== "string") {
    return null;
  }

  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return null;
  }

  // Legacy or alias format: agent:xxx or direct:xxx
  if (trimmed.startsWith("agent:")) {
    const parts = trimmed.split(":");
    if (parts.length >= 3) {
      // Format: agent:{agentId}:{rest}
      return {
        agentId: parts[1],
        rest: parts.slice(2).join(":"),
      };
    }
  }

  return null;
}

/**
 * Checks if a session key is a subagent session key.
 */
export function isSubagentSessionKey(sessionKey) {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  // Subagent keys have a specific format with subagent prefix
  return parsed.rest.includes("subagent:") || parsed.agentId.includes("subagent");
}

/**
 * Checks if a session key is a cron session key.
 */
export function isCronSessionKey(sessionKey) {
  if (!sessionKey || typeof sessionKey !== "string") {
    return false;
  }
  return sessionKey.startsWith("cron:");
}

/**
 * Checks if a session key is an ACP session key.
 */
export function isAcpSessionKey(sessionKey) {
  if (!sessionKey || typeof sessionKey !== "string") {
    return false;
  }
  return sessionKey.startsWith("acp:");
}

/**
 * Gets the subagent depth from a session key.
 */
export function getSubagentDepth(sessionKey) {
  if (!sessionKey || typeof sessionKey !== "string") {
    return 0;
  }
  const matches = sessionKey.match(/subagent:/g);
  return matches ? matches.length : 0;
}
