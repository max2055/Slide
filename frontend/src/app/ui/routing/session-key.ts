export function buildAgentMainSessionKey(agentId: string): string {
  return `${agentId}:main`;
}

export function parseAgentSessionKey(sessionKey: string): { agentId: string; sessionType: string } | null {
  const parts = sessionKey.split(":");
  if (parts.length < 2) return null;
  return { agentId: parts[0], sessionType: parts[1] };
}

export function resolveAgentIdFromSessionKey(sessionKey: string): string | undefined {
  return parseAgentSessionKey(sessionKey)?.agentId;
}
