/**
 * Shared Error Codes
 *
 * Extracted from gateway/error-codes.ts — non-OpenClaw-specific
 * error constants and helpers shared across adapters.
 *
 * Plan 2 will migrate gateway code to use these shared types directly.
 */

export const ErrorCodes = {
  // 通用错误
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAVAILABLE: 'UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // 会话错误
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_INVALID: 'SESSION_INVALID',
  SESSION_EXPIRED: 'SESSION_EXPIRED',

  // 消息错误
  MESSAGE_TOO_LARGE: 'MESSAGE_TOO_LARGE',
  MESSAGE_INVALID: 'MESSAGE_INVALID',

  // 数据库错误
  DATABASE_ERROR: 'DATABASE_ERROR',
  DATABASE_NOT_FOUND: 'DATABASE_NOT_FOUND',

  // 流式错误
  STREAM_ERROR: 'STREAM_ERROR',
  STREAM_ABORTED: 'STREAM_ABORTED',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorShape {
  code: ErrorCode | string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
}

/**
 * 创建标准错误响应
 */
export function errorShape(
  code: ErrorCode | string,
  message: string,
  opts?: { details?: unknown; retryable?: boolean; retryAfterMs?: number },
): ErrorShape {
  return {
    code,
    message,
    details: opts?.details,
    retryable: opts?.retryable,
    retryAfterMs: opts?.retryAfterMs,
  };
}

/**
 * 创建 INVALID_REQUEST 错误
 */
export function invalidRequestError(message: string, details?: unknown): ErrorShape {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, { details });
}

/**
 * 创建 SESSION_NOT_FOUND 错误
 */
export function sessionNotFoundError(sessionKey: string): ErrorShape {
  return errorShape(
    ErrorCodes.SESSION_NOT_FOUND,
    `Session not found: ${sessionKey.length > 20 ? sessionKey.slice(0, 20) + '...' : sessionKey}`,
  );
}

/**
 * 创建 DATABASE_ERROR 错误
 */
export function databaseError(message: string, details?: unknown): ErrorShape {
  return errorShape(ErrorCodes.DATABASE_ERROR, message, { details });
}

/**
 * 创建 UNAVAILABLE 错误
 */
export function unavailableError(message: string, retryAfterMs?: number): ErrorShape {
  return errorShape(ErrorCodes.UNAVAILABLE, message, { retryable: true, retryAfterMs });
}
