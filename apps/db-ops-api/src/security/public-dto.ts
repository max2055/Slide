export function publicInstanceDto(instance: Record<string, unknown>) {
  const { password_encrypted, connection_string, ...publicFields } = instance;
  return { ...publicFields, hasCredential: Boolean(password_encrypted), credentialVersion: password_encrypted ? 1 : 0 };
}

export function publicServerDto(server: Record<string, unknown>) {
  const { credential_encrypted, ...publicFields } = server;
  return { ...publicFields, hasCredential: Boolean(credential_encrypted), credentialVersion: credential_encrypted ? 1 : 0 };
}

export function publicNotificationDto(channel: Record<string, unknown>) {
  const rawConfig = (channel.config && typeof channel.config === 'object' ? channel.config : {}) as Record<string, unknown>;
  const { secret, token, password, password_encrypted, apiKey, webhook_url, ...config } = rawConfig;
  let endpoint: string | undefined;
  if (typeof webhook_url === 'string') {
    try { const url = new URL(webhook_url); endpoint = `${url.protocol}//${url.host}`; } catch { endpoint = undefined; }
  }
  return { ...channel, config: { ...config, endpoint, hasCredential: Boolean(secret || token || password || password_encrypted || apiKey) } };
}
