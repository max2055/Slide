/**
 * Irreversible recovery when an operator has confirmed the old encryption key
 * is permanently unavailable. It does not delete managed resources; it marks
 * old credentials unusable, disables dependent automation, and writes a
 * mode-0600 audit containing only SHA-256 fingerprints of prior ciphertext.
 *
 * The confirmation and the new key are taken only from this process, before
 * the project env file is read. The same names in that file are ignored, so a
 * value left in the file cannot authorize a later run.
 *
 * Required in the invoking process (a shell prefix counts; the env file does not):
 *   ENCRYPTION_KEY=<new non-default key>
 *   SLIDE_ROTATE_LOST_ENCRYPTION_KEY=CONFIRM_LOST_KEY_ROTATION
 *
 * Optional argument, applied only after that check:
 *   --env-file <path>   database settings file (default apps/db-ops-api/.env)
 *
 * Exit 1 when the invocation check, arguments, or rotation fails.
 * Refusal output names neither the key nor the confirmation value.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireEncryptionKey } from '../../apps/db-ops-api/src/config/security-config.js';
import { LOST_KEY_ROTATION_SENTINEL } from '../../apps/db-ops-api/src/credential-rotation.js';

const CONFIRMATION = 'CONFIRM_LOST_KEY_ROTATION';
const INVOCATION_ONLY_KEYS = new Set(['SLIDE_ROTATE_LOST_ENCRYPTION_KEY', 'ENCRYPTION_KEY']);

export const REFUSAL_MESSAGE = 'Refusing lost-key rotation: this invocation must set SLIDE_ROTATE_LOST_ENCRYPTION_KEY and ENCRYPTION_KEY before the project env file is loaded.';
export const USAGE = 'Usage: rotate-lost-encryption-key.ts [--env-file <path>]';

export interface InvocationSecrets {
  confirmation: string | undefined;
  encryptionKey: string | undefined;
}

export function captureInvocationSecrets(env: Record<string, string | undefined>): InvocationSecrets {
  return {
    confirmation: env.SLIDE_ROTATE_LOST_ENCRYPTION_KEY,
    encryptionKey: env.ENCRYPTION_KEY,
  };
}

export function invocationIsAuthorized(secrets: InvocationSecrets): secrets is { confirmation: string; encryptionKey: string } {
  return secrets.confirmation === CONFIRMATION && typeof secrets.encryptionKey === 'string' && secrets.encryptionKey.length > 0;
}

export function defaultProjectEnvFile(scriptDir = import.meta.dirname): string {
  return resolve(scriptDir, '../../apps/db-ops-api/.env');
}

export function parseRecoveryArgs(argv: readonly string[], scriptDir = import.meta.dirname): { envFile: string } {
  const args = argv.slice(2);
  if (args.length === 0) return { envFile: defaultProjectEnvFile(scriptDir) };
  if (args.length === 2 && args[0] === '--env-file' && args[1] !== undefined && args[1] !== '' && !args[1].startsWith('-')) {
    return { envFile: resolve(args[1]) };
  }
  throw new Error(USAGE);
}

/** First value wins. Invocation-only keys are never taken from the file. */
export function projectEnvAssignments(text: string, current: Record<string, string | undefined>): Record<string, string> {
  const assigned: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (!key || INVOCATION_ONLY_KEYS.has(key) || current[key] !== undefined || assigned[key] !== undefined) continue;
    assigned[key] = match[2] ?? '';
  }
  return assigned;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function auditPath(): string {
  const configured = process.env.SLIDE_CREDENTIAL_ROTATION_AUDIT_PATH;
  return resolve(configured || `${process.env.HOME}/.config/slide/recovery/lost-encryption-key-rotation.json`);
}

function pinInvocationSecrets(secrets: { confirmation: string; encryptionKey: string }): void {
  process.env.SLIDE_ROTATE_LOST_ENCRYPTION_KEY = secrets.confirmation;
  process.env.ENCRYPTION_KEY = secrets.encryptionKey;
}

async function main(): Promise<void> {
  const invocation = captureInvocationSecrets(process.env);
  const { envFile } = parseRecoveryArgs(process.argv);
  if (!invocationIsAuthorized(invocation)) throw new Error(REFUSAL_MESSAGE);
  requireEncryptionKey(invocation.encryptionKey);

  const envText = await readFile(envFile, 'utf8');
  for (const [key, value] of Object.entries(projectEnvAssignments(envText, process.env))) process.env[key] = value;
  pinInvocationSecrets(invocation);

  // db-connection imports dotenv/config. Keep that loader on the selected file
  // too, so cwd/.env cannot fill in settings omitted by the selected file.
  process.env.DOTENV_CONFIG_PATH = envFile;
  const dbConnection = await import('../../apps/db-ops-api/src/db-connection.js');
  const mysql = await import('../../apps/db-ops-api/node_modules/mysql2/promise.js');
  pinInvocationSecrets(invocation);

  const createConnection = mysql.createConnection;
  const instanceSentinel = dbConnection.encryptData(LOST_KEY_ROTATION_SENTINEL, invocation.encryptionKey);
  const serverSentinel = dbConnection.encryptData(LOST_KEY_ROTATION_SENTINEL, invocation.encryptionKey);
  const db = await createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'db_ops_ai',
  });
  try {
    const [instanceRows] = await db.query<Array<{ id: number; password_encrypted: string; connection_string: string | null }>>(
      'SELECT id, password_encrypted, connection_string FROM database_instances ORDER BY id',
    );
    const [serverRows] = await db.query<Array<{ id: number; credential_encrypted: string }>>(
      'SELECT id, credential_encrypted FROM servers ORDER BY id',
    );
    const [providerRows] = await db.query<Array<{ id: number; api_key_encrypted: string | null }>>(
      'SELECT id, api_key_encrypted FROM llm_providers ORDER BY id',
    );
    const [channelRows] = await db.query<Array<{ id: number; config: unknown; enabled: number }>>(
      'SELECT id, config, enabled FROM notification_channels ORDER BY id',
    );
    const audit = {
      kind: 'lost-encryption-key-rotation',
      createdAt: new Date().toISOString(),
      irreversible: true,
      entries: {
        instances: instanceRows.map((row) => ({ id: row.id, ciphertextFingerprint: fingerprint(row.password_encrypted), connectionStringFingerprint: fingerprint(row.connection_string) })),
        servers: serverRows.map((row) => ({ id: row.id, ciphertextFingerprint: fingerprint(row.credential_encrypted) })),
        providers: providerRows.map((row) => ({ id: row.id, ciphertextFingerprint: fingerprint(row.api_key_encrypted) })),
        channels: channelRows.map((row) => ({ id: row.id, configFingerprint: fingerprint(row.config), enabled: Boolean(row.enabled) })),
      },
    };
    const path = auditPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(audit, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

    await db.beginTransaction();
    try {
      await db.execute(
        "UPDATE database_instances SET password_encrypted = ?, connection_string = NULL, status = 'inactive', health_status = 'unknown'",
        [instanceSentinel],
      );
      await db.execute(
        "UPDATE servers SET credential_encrypted = ?, collection_enabled = 0, status = 'offline', host_key_fingerprint = NULL",
        [serverSentinel],
      );
      await db.execute("UPDATE llm_providers SET api_key_encrypted = NULL, enabled = CASE WHEN deployment_type = 'local' THEN enabled ELSE 0 END, is_default = CASE WHEN deployment_type = 'local' THEN is_default ELSE 0 END");
      await db.execute('UPDATE llm_providers_backup SET api_key_encrypted = NULL');
      await db.execute(`UPDATE notification_channels
        SET enabled = CASE WHEN JSON_CONTAINS_PATH(config, 'one', '$.secret', '$.secret_encrypted', '$.password', '$.password_encrypted', '$.oauth2_refresh_token', '$.oauth2_refresh_token_encrypted', '$.token', '$.apiKey') THEN 0 ELSE enabled END,
            config = JSON_REMOVE(config, '$.secret', '$.secret_encrypted', '$.password', '$.password_encrypted', '$.oauth2_refresh_token', '$.oauth2_refresh_token_encrypted', '$.token', '$.apiKey')`);
      await db.commit();
    } catch (error) {
      await db.rollback();
      throw error;
    }
    console.log(JSON.stringify({
      rotated: true,
      auditPath: path,
      invalidated: { instances: instanceRows.length, servers: serverRows.length, providers: providerRows.length, channels: channelRows.length },
    }));
  } finally {
    await db.end();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
