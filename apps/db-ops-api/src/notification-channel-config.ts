/**
 * Validation and normalization for notification channel configurations.
 *
 * Channel configuration is user supplied JSON.  Keep this logic outside the
 * delivery service so create/update APIs can reject bad email settings before
 * they are persisted, while the delivery path can use the same rules for
 * legacy rows and direct callers.
 */

export const NOTIFICATION_CHANNEL_TYPES = ['email', 'dingtalk', 'wecom', 'feishu', 'webhook'] as const;
export type NotificationChannelType = (typeof NOTIFICATION_CHANNEL_TYPES)[number];

export type NotificationConfigErrorCode =
  | 'NOTIFICATION_CHANNEL_TYPE_INVALID'
  | 'NOTIFICATION_CHANNEL_CONFIG_INVALID'
  | 'EMAIL_CONFIGURATION_INVALID';

export interface NotificationConfigValidationOptions {
  /** Permit omitted required fields for a PATCH-like partial update. */
  partial?: boolean;
  /** Internal rows contain encrypted credentials; HTTP clients must not set them. */
  allowEncryptedCredentials?: boolean;
}

export type NotificationConfigValidation =
  | { valid: true; config: Record<string, unknown> }
  | { valid: false; code: NotificationConfigErrorCode; field?: string; message: string };

const EMAIL_PATTERN = /^[^@\s<>]+@[^@\s<>]+$/;
const EMAIL_AUTH_MODES = new Set(['password', 'oauth2']);

export function isNotificationChannelType(value: unknown): value is NotificationChannelType {
  return typeof value === 'string' && NOTIFICATION_CHANNEL_TYPES.includes(value as NotificationChannelType);
}

function invalid(field: string | undefined, message: string, code: NotificationConfigErrorCode = 'EMAIL_CONFIGURATION_INVALID'): NotificationConfigValidation {
  return { valid: false, code, field, message };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function nonEmptyString(value: unknown, field: string, maxLength: number): NotificationConfigValidation | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return invalid(field, `${field} 必须为非空字符串`);
  }
  if (value.length > maxLength) return invalid(field, `${field} 长度不能超过 ${maxLength} 个字符`);
  if (/[\u0000-\u001f\u007f]/.test(value)) return invalid(field, `${field} 不能包含控制字符`);
  return null;
}

function normalizeAddressList(value: unknown, field: string): { value?: string; error?: NotificationConfigValidation } {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) return { error: invalid(field, `${field} 至少需要一个邮箱地址`) };
  const addresses: string[] = [];
  for (const item of values) {
    if (typeof item !== 'string') return { error: invalid(field, `${field} 必须为邮箱地址字符串`) };
    // Accept the common comma/semicolon-separated form used by SMTP UIs.
    for (const candidate of item.split(/[;,]/).map((part) => part.trim()).filter(Boolean)) {
      const address = candidate.match(/^([^<>]*)<([^<>]+)>$/)?.[2]?.trim() ?? candidate;
      if (!EMAIL_PATTERN.test(address)) return { error: invalid(field, `${field} 包含无效邮箱地址`) };
      addresses.push(candidate);
    }
  }
  if (addresses.length === 0) return { error: invalid(field, `${field} 至少需要一个邮箱地址`) };
  return { value: addresses.join(', ') };
}

function validateEmailConfig(
  rawConfig: unknown,
  options: NotificationConfigValidationOptions = {},
): NotificationConfigValidation {
  const input = asRecord(rawConfig);
  if (!input) return invalid(undefined, 'email 渠道 config 必须是对象', 'NOTIFICATION_CHANNEL_CONFIG_INVALID');

  const partial = options.partial === true;
  const allowEncrypted = options.allowEncryptedCredentials !== false;
  const config: Record<string, unknown> = { ...input };

  const requiredStringFields: Array<[string, number]> = [
    ['smtp_host', 253],
    ['smtp_username', 320],
  ];
  for (const [field, maxLength] of requiredStringFields) {
    if (!hasOwn(input, field)) {
      if (!partial) return invalid(field, `缺少必填字段：${field}`);
      continue;
    }
    const error = nonEmptyString(input[field], field, maxLength);
    if (error) return error;
    const value = String(input[field]).trim();
    // A host is a hostname/IP, not a URL or an arbitrary command fragment.
    if (field === 'smtp_host' && (value.includes('://') || /[\\/\s]/.test(value))) {
      return invalid(field, 'smtp_host 必须是主机名或 IP 地址，不能包含 URL 或空白字符');
    }
    config[field] = value;
  }

  if (hasOwn(input, 'smtp_port') || !partial) {
    if (!hasOwn(input, 'smtp_port')) return invalid('smtp_port', '缺少必填字段：smtp_port');
    const port = typeof input.smtp_port === 'number' || typeof input.smtp_port === 'string'
      ? Number(input.smtp_port)
      : Number.NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return invalid('smtp_port', 'smtp_port 必须是 1-65535 范围内的整数');
    }
    config.smtp_port = port;
  }

  if (hasOwn(input, 'smtp_secure')) {
    if (typeof input.smtp_secure !== 'boolean') return invalid('smtp_secure', 'smtp_secure 必须是布尔值');
    config.smtp_secure = input.smtp_secure;
  }
  if (hasOwn(input, 'smtp_require_tls')) {
    if (typeof input.smtp_require_tls !== 'boolean') return invalid('smtp_require_tls', 'smtp_require_tls 必须是布尔值');
    config.smtp_require_tls = input.smtp_require_tls;
  }

  // A partial update must not invent an authentication mode. The existing
  // channel config is merged by the persistence layer, so an omitted mode
  // means "leave the current mode unchanged".
  const auth = hasOwn(input, 'smtp_auth') ? input.smtp_auth : partial ? undefined : 'password';
  if (auth !== undefined) {
    if (typeof auth !== 'string' || !EMAIL_AUTH_MODES.has(auth)) {
      return invalid('smtp_auth', 'smtp_auth 只能是 password 或 oauth2');
    }
    config.smtp_auth = auth;
  }

  const encryptedFields = ['password_encrypted', 'oauth2_refresh_token_encrypted'];
  if (!allowEncrypted && encryptedFields.some((field) => hasOwn(input, field))) {
    const field = encryptedFields.find((candidate) => hasOwn(input, candidate));
    return invalid(field === 'password_encrypted' ? 'password' : 'oauth2_refresh_token', '加密凭据由服务端管理，不能由客户端提交');
  }

  if (auth === undefined) {
    for (const [field, maxLength] of [['oauth2_tenant', 256], ['oauth2_client_id', 512]] as Array<[string, number]>) {
      if (!hasOwn(input, field)) continue;
      const error = nonEmptyString(input[field], field, maxLength);
      if (error) return error;
      config[field] = String(input[field]).trim();
    }
    for (const [field, label] of [
      ['password', 'password'],
      ['password_encrypted', 'password'],
      ['oauth2_refresh_token', 'oauth2_refresh_token'],
      ['oauth2_refresh_token_encrypted', 'oauth2_refresh_token'],
    ] as Array<[string, string]>) {
      if (!hasOwn(input, field)) continue;
      if (typeof input[field] !== 'string' || input[field].length === 0) {
        return invalid(label, `${field} 必须为非空字符串`);
      }
    }
  } else if (auth === 'password') {
    const hasPassword = typeof input.password === 'string' && input.password.length > 0;
    const hasEncryptedPassword = typeof input.password_encrypted === 'string' && input.password_encrypted.length > 0;
    if (!partial && !hasPassword && !hasEncryptedPassword) {
      return invalid('password', 'password 是 password 认证模式的必填凭据');
    }
    if (hasOwn(input, 'password') && (typeof input.password !== 'string' || input.password.length === 0)) {
      return invalid('password', 'password 必须为非空字符串');
    }
    if (hasOwn(input, 'password_encrypted') && (typeof input.password_encrypted !== 'string' || input.password_encrypted.length === 0)) {
      return invalid('password', 'password_encrypted 无效');
    }
  } else {
    const oauthFields: Array<[string, number]> = [
      ['oauth2_tenant', 256],
      ['oauth2_client_id', 512],
    ];
    for (const [field, maxLength] of oauthFields) {
      if (!hasOwn(input, field)) {
        if (!partial) return invalid(field, `缺少 OAuth2 必填字段：${field}`);
        continue;
      }
      const error = nonEmptyString(input[field], field, maxLength);
      if (error) return error;
      config[field] = String(input[field]).trim();
    }
    const hasRefreshToken = typeof input.oauth2_refresh_token === 'string' && input.oauth2_refresh_token.length > 0;
    const hasEncryptedRefreshToken = typeof input.oauth2_refresh_token_encrypted === 'string' && input.oauth2_refresh_token_encrypted.length > 0;
    if (!partial && !hasRefreshToken && !hasEncryptedRefreshToken) {
      return invalid('oauth2_refresh_token', 'oauth2_refresh_token 是 OAuth2 认证模式的必填凭据');
    }
    if (hasOwn(input, 'oauth2_refresh_token') && (typeof input.oauth2_refresh_token !== 'string' || input.oauth2_refresh_token.length === 0)) {
      return invalid('oauth2_refresh_token', 'oauth2_refresh_token 必须为非空字符串');
    }
    if (hasOwn(input, 'oauth2_refresh_token_encrypted') && (typeof input.oauth2_refresh_token_encrypted !== 'string' || input.oauth2_refresh_token_encrypted.length === 0)) {
      return invalid('oauth2_refresh_token', 'oauth2_refresh_token_encrypted 无效');
    }
  }

  for (const [field, maxLength] of [['from', 4096], ['to', 4096] ] as Array<[string, number]>) {
    if (!hasOwn(input, field)) {
      if (!partial) return invalid(field, `缺少必填字段：${field}`);
      continue;
    }
    const addresses = normalizeAddressList(input[field], field);
    if (addresses.error) return addresses.error;
    if ((addresses.value?.length ?? 0) > maxLength) return invalid(field, `${field} 长度不能超过 ${maxLength} 个字符`);
    config[field] = addresses.value;
  }

  return { valid: true, config };
}

export function validateEmailChannelConfig(
  config: unknown,
  options: NotificationConfigValidationOptions = {},
): NotificationConfigValidation {
  return validateEmailConfig(config, options);
}

export function validateNotificationChannelConfig(
  type: unknown,
  config: unknown,
  options: NotificationConfigValidationOptions = {},
): NotificationConfigValidation {
  if (!isNotificationChannelType(type)) {
    return invalid(undefined, '不支持的通知渠道类型', 'NOTIFICATION_CHANNEL_TYPE_INVALID');
  }
  if (type === 'email') return validateEmailConfig(config, options);
  if (!asRecord(config)) return invalid(undefined, '通知渠道 config 必须是对象', 'NOTIFICATION_CHANNEL_CONFIG_INVALID');
  return { valid: true, config: { ...(config as Record<string, unknown>) } };
}
