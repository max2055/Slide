export function publicInstanceDto(instance: Record<string, unknown>) {
  const { password_encrypted, connection_string, ...publicFields } = instance;
  return { ...publicFields, hasCredential: Boolean(password_encrypted), credentialVersion: password_encrypted ? 1 : 0 };
}

export function publicServerDto(server: Record<string, unknown>) {
  const { credential_encrypted, ...publicFields } = server;
  return { ...publicFields, hasCredential: Boolean(credential_encrypted), credentialVersion: credential_encrypted ? 1 : 0 };
}

/** Network device DTOs never include credential rows or encrypted material. */
export function publicNetworkDeviceDto(device: Record<string, unknown>) {
  // Keep this an allowlist. Network rows may be joined with credential or
  // backup tables, and a blacklist is easy to bypass with a new/camelCase
  // secret column. Only inventory metadata is part of the public contract.
  const aliases: Record<string, string[]> = {
    id: ['id'], name: ['name'], label: ['label'], host: ['host'], site: ['site'],
    vendor: ['vendor'], model: ['model'], os_version: ['os_version', 'osVersion'],
    serial_number: ['serial_number', 'serialNumber'], snmp_port: ['snmp_port', 'snmpPort'],
    ssh_port: ['ssh_port', 'sshPort'], status: ['status'], last_check_at: ['last_check_at', 'lastCheckAt'],
    created_at: ['created_at', 'createdAt'], updated_at: ['updated_at', 'updatedAt'],
  };
  const dto: Record<string, unknown> = {};
  for (const [field, names] of Object.entries(aliases)) {
    const source = names.find((name) => Object.prototype.hasOwnProperty.call(device, name) && device[name] !== undefined);
    if (source) dto[field] = device[source];
  }
  dto.collection_enabled = Boolean(device.collection_enabled ?? device.collectionEnabled);
  dto.hasSnmpCredential = Boolean(device.hasSnmpCredential ?? device.has_snmp_credential);
  dto.hasSshCredential = Boolean(device.hasSshCredential ?? device.has_ssh_credential);
  return dto;
}

export function publicNotificationDto(channel: Record<string, unknown>) {
  const rawConfig = (channel.config && typeof channel.config === 'object' ? channel.config : {}) as Record<string, unknown>;
  const { secret, secret_encrypted, token, password, password_encrypted, oauth2_refresh_token, oauth2_refresh_token_encrypted, apiKey, webhook_url, ...config } = rawConfig;
  let endpoint: string | undefined;
  if (typeof webhook_url === 'string') {
    try { const url = new URL(webhook_url); endpoint = `${url.protocol}//${url.host}`; } catch { endpoint = undefined; }
  }
  return { ...channel, config: { ...config, endpoint, hasCredential: Boolean(secret || secret_encrypted || token || password || password_encrypted || oauth2_refresh_token || oauth2_refresh_token_encrypted || apiKey) } };
}
