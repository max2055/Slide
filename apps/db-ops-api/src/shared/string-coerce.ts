/**
 * DB-Ops 字符串规范化辅助函数
 *
 * 复用 OpenClaw 的 string-coerce.ts 模式
 * 参考：openclaw_source_code/src/shared/string-coerce.ts
 */

/**
 * 规范化可选字符串为小写
 *
 * 复用 OpenClaw 的 normalizeOptionalLowercaseString
 */
export function normalizeOptionalLowercaseString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed.toLowerCase() : undefined;
  }
  return undefined;
}

/**
 * 规范化可选字符串
 *
 * 复用 OpenClaw 的 normalizeOptionalString
 */
export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

/**
 * 规范化字符串为小写
 */
export function normalizeLowercaseString(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim().toLowerCase();
  }
  return '';
}

/**
 * 规范化字符串
 */
export function normalizeString(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  return '';
}
