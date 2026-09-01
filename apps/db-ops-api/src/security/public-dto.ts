import { decryptData } from '../db-connection.js';

interface CredentialAssessment {
  /** A secret is stored, even if it cannot currently be decrypted. */
  hasCredential: boolean;
  /** The secret can be used for a health check right now. */
  usable: boolean;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isV2Envelope(value: string): boolean {
  const parts = value.split(':');
  return parts.length === 5
    && parts[0] === 'v2'
    && /^[0-9a-f]{12}$/i.test(parts[1])
    && /^[0-9a-f]{24}$/i.test(parts[2])
    && /^[0-9a-f]{32}$/i.test(parts[3])
    && /^[0-9a-f]*$/i.test(parts[4])
    && parts[4].length % 2 === 0;
}

function isLegacyEnvelope(value: string): boolean {
  const parts = value.split(':');
  return parts.length === 2
    && /^[0-9a-f]{32}$/i.test(parts[0])
    && /^[0-9a-f]{32,}$/i.test(parts[1])
    && parts[1].length % 2 === 0;
}

function assessCredential(instance: Record<string, unknown>, encrypted: unknown): CredentialAssessment {
  // Internal callers may provide the already decrypted value. Never let that
  // value pass through the public DTO, but use it to avoid guessing from a
  // ciphertext whose plaintext may be empty.
  if (Object.prototype.hasOwnProperty.call(instance, 'password')) {
    const usable = hasText(instance.password);
    return { hasCredential: usable, usable };
  }

  if (!hasText(encrypted)) return { hasCredential: false, usable: false };
  const ciphertext = encrypted.trim();
  const recognizable = isV2Envelope(ciphertext) || isLegacyEnvelope(ciphertext);
  if (!recognizable) {
    // Keep presence compatibility with callers that carry an opaque
    // ciphertext, but do not treat it as health evidence we can verify.
    return { hasCredential: true, usable: false };
  }

  try {
    const usable = hasText(decryptData(ciphertext));
    return { hasCredential: usable, usable };
  } catch {
    // The secret is stored, but an invalid/undecryptable envelope cannot back
    // a health observation. Preserve presence while failing readiness closed.
    return { hasCredential: true, usable: false };
  }
}

export function publicInstanceDto(instance: Record<string, unknown>) {
  const { password_encrypted, connection_string, password: _password, ...publicFields } = instance;
  const credential = assessCredential(instance, password_encrypted);
  const hasCredential = credential.hasCredential;
  const healthStatus = publicFields.health_status ?? 'unknown';
  const instanceStatus = publicFields.status;
  const hasUsername = hasText(publicFields.username);
  const credentialsReady = credential.usable && hasUsername;
  const publicHealthStatus = !credentialsReady
    ? 'unknown'
    : instanceStatus === 'error'
      ? 'error'
      : instanceStatus === 'pending_credentials' || instanceStatus === 'inactive'
        ? 'unknown'
        : healthStatus;
  const readyForHealthScore = credentialsReady
    && publicHealthStatus !== 'unknown'
    && publicHealthStatus !== 'error'
    && instanceStatus !== 'pending_credentials'
    && instanceStatus !== 'inactive'
    && instanceStatus !== 'error';
  return {
    ...publicFields,
    health_status: publicHealthStatus,
    health_score: readyForHealthScore ? publicFields.health_score : 0,
    hasCredential,
    credentialVersion: hasCredential ? 1 : 0,
  };
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
