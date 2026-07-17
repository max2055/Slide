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
  if (!validSecret(config.encryptionKey)) throw new SecurityConfigurationError('ENCRYPTION_KEY must be a non-default secret of at least 32 characters');
  if (config.jwtSecret === config.encryptionKey) throw new SecurityConfigurationError('JWT_SECRET_KEY and ENCRYPTION_KEY must be different');
  if (!config.initialAdminConfigured) throw new SecurityConfigurationError('INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required in production');
  return config;
}

export function requireEncryptionKey(key = process.env.ENCRYPTION_KEY): string {
  if (!validSecret(key)) throw new SecurityConfigurationError('ENCRYPTION_KEY must be configured with a non-default secret of at least 32 characters');
  return key;
}
