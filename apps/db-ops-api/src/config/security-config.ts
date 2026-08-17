const KNOWN_DEFAULTS = new Set([
  'change-this-to-a-random-32-char-key',
  'your-secret-key-min-32-chars',
  'your-jwt-secret-key',
  'secret',
]);

export class SecurityConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityConfigurationError';
  }
}

export interface SecurityConfig {
  production: boolean;
  jwtSecret?: string;
  encryptionKey?: string;
  initialAdminConfigured: boolean;
}

function validSecret(value: string | undefined): value is string {
  return typeof value === 'string' && value.length >= 32 && !KNOWN_DEFAULTS.has(value.trim().toLowerCase());
}

function validEncryptionSecret(value: string | undefined): value is string {
  if (!validSecret(value)) return false;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return true;
  if (Buffer.byteLength(value, 'utf8') === 32) return true;
  return /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32;
}

function validCidrs(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  return value.split(',').every((raw) => {
    const cidr = raw.trim();
    const slash = cidr.lastIndexOf('/');
    if (slash <= 0) return false;
    const address = cidr.slice(0, slash);
    const version = isIP(address);
    const prefix = Number(cidr.slice(slash + 1));
    return Boolean(version) && Number.isInteger(prefix) && prefix >= 0 && prefix <= (version === 4 ? 32 : 128);
  });
}

function validPorts(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  return value.split(',').every((raw) => {
    const portText = raw.trim();
    const port = Number(portText);
    return /^\d+$/.test(portText) && Number.isInteger(port) && port > 0 && port <= 65535;
  });
}

export function loadSecurityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const production = env.NODE_ENV === 'production';
  const config: SecurityConfig = {
    production,
    jwtSecret: env.JWT_SECRET_KEY,
    encryptionKey: env.ENCRYPTION_KEY,
    initialAdminConfigured: Boolean(env.INITIAL_ADMIN_USERNAME && env.INITIAL_ADMIN_PASSWORD),
  };
  if (!production) return config;
  if (!validSecret(config.jwtSecret)) throw new SecurityConfigurationError('JWT_SECRET_KEY must be a non-default secret of at least 32 characters');
  if (!validEncryptionSecret(config.encryptionKey)) throw new SecurityConfigurationError('ENCRYPTION_KEY must encode exactly 32 bytes as UTF-8, hex, or base64');
  if (config.jwtSecret === config.encryptionKey) throw new SecurityConfigurationError('JWT_SECRET_KEY and ENCRYPTION_KEY must be different');
  if (!config.initialAdminConfigured) throw new SecurityConfigurationError('INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required in production');
  for (const name of ['DB_ALLOWED_CIDRS', 'SERVER_ALLOWED_CIDRS'] as const) {
    if (!validCidrs(env[name])) throw new SecurityConfigurationError(`${name} must contain explicit valid CIDRs in production`);
  }
  for (const name of ['DB_ALLOWED_PORTS', 'SERVER_ALLOWED_PORTS'] as const) {
    if (!validPorts(env[name])) throw new SecurityConfigurationError(`${name} must contain explicit valid ports in production`);
  }
  return config;
}

export function requireEncryptionKey(key = process.env.ENCRYPTION_KEY): string {
  if (!validEncryptionSecret(key)) throw new SecurityConfigurationError('ENCRYPTION_KEY must encode exactly 32 bytes as UTF-8, hex, or base64');
  return key;
}
import { isIP } from 'node:net';
