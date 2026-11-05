import { redactJsonSensitiveValues } from '@slide/agent-core/tool-stream';

const SENSITIVE_KEY = /password|passwd|secret|token|authorization|api[_-]?key|credential|private[_-]?key|webhook/i;
const ASSIGNMENT_KEY = 'password|passwd|secret|token|api[_-]?key|authorization|cookie';
const JSON_SENSITIVE_KEY = /password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|credential|connection[_-]?string|private[_-]?key|webhook/i;
// Spaces stay inside a value. Comma, semicolon, and newline still end it, as does the next
// assignment. Authorization and Cookie headers consume the rest of the line because their
// authentication parameters and cookies can contain commas and semicolons.
const SPACED_VALUE = `[^\\s,;\\r\\n]+(?:[^\\S\\r\\n]+(?!(?:${ASSIGNMENT_KEY})[^\\S\\r\\n]*[=:])[^\\s,;\\r\\n]+)*`;
const SENSITIVE_TEXT = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /(\bauthorization[ \t]*:[ \t]*)[^\r\n]+/gi,
  /(\b(?:set-)?cookie\s*:\s*)[^\r\n]+/gi,
  new RegExp(`(\\b(?:cookie|authorization)[^\\S\\r\\n]*=[^\\S\\r\\n]*)${SPACED_VALUE}`, 'gi'),
  new RegExp(`((?:password|passwd|secret|token|api[_-]?key)[^\\S\\r\\n]*[=:][^\\S\\r\\n]*)${SPACED_VALUE}`, 'gi'),
  /(\/open-apis\/bot\/v2\/hook\/)[^\s/?#]+/gi,
];

export function redactSensitiveText(value: string): string {
  return SENSITIVE_TEXT.reduce((text, pattern) => text.replace(pattern, '$1[REDACTED]'), redactJsonSensitiveValues(value, JSON_SENSITIVE_KEY));
}

export function redactLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value instanceof Error) return { name: value.name, message: redactSensitiveText(value.message) };
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactLogValue(entry, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactLogValue(entry, seen),
  ]));
}

export function installConsoleRedaction(target: Pick<Console, 'error' | 'warn'> = console): void {
  for (const level of ['error', 'warn'] as const) {
    const original = target[level].bind(target);
    target[level] = ((...args: unknown[]) => original(...args.map((value) => redactLogValue(value)))) as typeof target[typeof level];
  }
}
