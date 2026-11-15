const SMTP_SEND_SCOPE = 'offline_access https://outlook.office.com/SMTP.Send';

export async function exchangeMicrosoftSmtpRefreshToken(input: {
  tenant: string;
  clientId: string;
  refreshToken: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ accessToken: string; refreshToken?: string }> {
  input.signal?.throwIfAborted();
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) {
    throw new Error('MICROSOFT_OAUTH_TIMEOUT_INVALID');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal!.reason);
  input.signal?.addEventListener('abort', abort, { once: true });
  // Keep the deadline active through response body consumption, not just headers.
  const timer = setTimeout(() => controller.abort(new Error('MICROSOFT_OAUTH_TOKEN_EXCHANGE_TIMEOUT')), timeoutMs);
  let response: Response | undefined;
  try {
    const body = new URLSearchParams({
      client_id: input.clientId,
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      scope: SMTP_SEND_SCOPE,
    });
    response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(input.tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('MICROSOFT_OAUTH_TOKEN_EXCHANGE_FAILED');
    const payload = await response.json() as { access_token?: unknown; refresh_token?: unknown };
    controller.signal.throwIfAborted();
    if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      throw new Error('MICROSOFT_OAUTH_TOKEN_INVALID');
    }
    return {
      accessToken: payload.access_token,
      ...(typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0
        ? { refreshToken: payload.refresh_token }
        : {}),
    };
  } catch (error) {
    input.signal?.throwIfAborted();
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
    // Error responses may contain credentials; release them without logging them.
    if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
  }
}
