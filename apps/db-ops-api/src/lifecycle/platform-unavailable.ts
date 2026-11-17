/** An authority/dependency read failed; never interpret this as invalid credentials. */
export class PlatformUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'PLATFORM_UNAVAILABLE';
  constructor(cause?: unknown) {
    super('平台服务暂不可用，请稍后重试', { cause });
    this.name = 'PlatformUnavailableError';
  }
}

export const platformUnavailableResponse = { error: 'PLATFORM_UNAVAILABLE', message: '平台服务暂不可用，请稍后重试' };

/** SQL authority reads: classify transport/capacity failures, never business or syntax errors. */
export function rethrowAuthorityReadError(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
    'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'PROTOCOL_SEQUENCE_TIMEOUT',
    'ER_SERVER_SHUTDOWN', 'ER_CON_COUNT_ERROR', 'ER_TOO_MANY_USER_CONNECTIONS',
    'ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK',
  ]).has(code)) throw new PlatformUnavailableError(error);
  throw error;
}
