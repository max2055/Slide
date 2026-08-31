export type ExecuteCodeRiskLevel = 'low' | 'medium' | 'high';
export type ExecuteCodeApprovalScope = 'none' | 'once' | 'window' | 'session';

export interface ExecuteCodeRisk {
  level: ExecuteCodeRiskLevel;
  scope: ExecuteCodeApprovalScope;
  requiresApproval: boolean;
}

const READ_ONLY_SHELL_COMMANDS = new Set([
  'pwd', 'ls', 'cat', 'head', 'tail', 'find', 'grep', 'wc', 'du', 'stat',
]);

const HIGH_RISK_PATTERNS = [
  /\b(?:nmap|nc|netcat|curl|wget|ssh|scp|telnet|ftp)\b/i,
  /\b(?:rm|rmdir|mkfs|dd|chmod|chown|sudo|su|kill|shutdown|reboot|mount|umount|docker|podman)\b/i,
  /(?:;|&&|\|\||\||\$\(|`)/,
  /\b(?:subprocess|child_process|os\.system|os\.popen|process\.exec|execFile|spawn)\b/i,
  /\b(?:eval|Function)\s*\(/i,
  /\b(?:fetch|XMLHttpRequest|https?\.request|net\.connect)\b/i,
  /\b(?:unlink|rmtree|writeFile|appendFile|chmod|chown)\b/i,
];

const NETWORK_PATTERNS = [
  /\b(?:nmap|nc|netcat|curl|wget|ssh|scp|telnet|ftp)\b/i,
  /\b(?:fetch|XMLHttpRequest|https?\.request|net\.connect|socket|requests?\.|urllib|http\.client|paramiko|dns\.|tls\.)\b/i,
];

export function executeCodeRequiresNetwork(input: { runtime: string; code: string }): boolean {
  return NETWORK_PATTERNS.some((pattern) => pattern.test(`${input.runtime}\n${input.code}`));
}

function classifyShell(code: string): ExecuteCodeRiskLevel {
  const source = code.trim();
  if (HIGH_RISK_PATTERNS.some((pattern) => pattern.test(source))) return 'high';

  const command = source.match(/^([a-z][a-z0-9_-]*)\b/i)?.[1]?.toLowerCase();
  const hasUnsafePath = /(?:^|\s)(?:\/|\.\.|~\/)/.test(source);
  if (command && READ_ONLY_SHELL_COMMANDS.has(command) && !hasUnsafePath) return 'low';
  return 'medium';
}

export function classifyExecuteCodeRisk(input: {
  runtime: string;
  code: string;
  files?: unknown[];
}): ExecuteCodeRisk {
  const runtime = input.runtime.toLowerCase();
  const code = input.code.trim();
  let level: ExecuteCodeRiskLevel;

  if (runtime === 'shell') {
    level = classifyShell(code);
  } else if (runtime === 'python' || runtime === 'node') {
    level = HIGH_RISK_PATTERNS.some((pattern) => pattern.test(code)) ? 'high' : 'medium';
  } else {
    level = 'high';
  }

  // Supporting files are writes into the sandbox workspace, so they cannot
  // be treated as a read-only command even when the command itself is benign.
  if (level === 'low' && (input.files?.length ?? 0) > 0) level = 'medium';

  return level === 'low'
    ? { level, scope: 'none', requiresApproval: false }
    : { level, scope: level === 'high' ? 'once' : 'window', requiresApproval: true };
}
