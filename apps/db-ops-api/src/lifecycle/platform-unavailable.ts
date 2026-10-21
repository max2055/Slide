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
