/**
 * DB-Ops 字符串规范化辅助函数
 *
 * string-coerce 模式（复用上游设计）
 */

/**
 * 规范化可选字符串为小写
 *
 * 复用上游 normalizeOptionalLowercaseString
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
 * 复用上游 normalizeOptionalString
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
