const SMTP_SEND_SCOPE = 'offline_access https://outlook.office.com/SMTP.Send';

export async function exchangeMicrosoftSmtpRefreshToken(input: {
  tenant: string;
  clientId: string;
  refreshToken: string;
}): Promise<{ accessToken: string; refreshToken?: string }> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    scope: SMTP_SEND_SCOPE,
  });
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(input.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new Error('MICROSOFT_OAUTH_TOKEN_EXCHANGE_FAILED');
  const payload = await response.json() as { access_token?: unknown; refresh_token?: unknown };
  if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new Error('MICROSOFT_OAUTH_TOKEN_INVALID');
  }
  return {
    accessToken: payload.access_token,
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0
      ? { refreshToken: payload.refresh_token }
      : {}),
  };
}
