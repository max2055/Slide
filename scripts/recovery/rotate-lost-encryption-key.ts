/**
 * Irreversible recovery when an operator has confirmed the old encryption key
 * is permanently unavailable. It does not delete managed resources; it marks
 * old credentials unusable, disables dependent automation, and writes a
 * mode-0600 audit containing only SHA-256 fingerprints of prior ciphertext.
 *
 * Required environment:
 *   ENCRYPTION_KEY=<new non-default key>
 *   SLIDE_ROTATE_LOST_ENCRYPTION_KEY=CONFIRM_LOST_KEY_ROTATION
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';
import { encryptData } from '../../apps/db-ops-api/src/db-connection.js';
import { LOST_KEY_ROTATION_SENTINEL } from '../../apps/db-ops-api/src/credential-rotation.js';

const confirmation = 'CONFIRM_LOST_KEY_ROTATION';

async function loadProjectEnv(): Promise<void> {
  const envText = await readFile(resolve(import.meta.dirname, '../../apps/db-ops-api/.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function auditPath(): string {
  const configured = process.env.SLIDE_CREDENTIAL_ROTATION_AUDIT_PATH;
  return resolve(configured || `${process.env.HOME}/.config/slide/recovery/lost-encryption-key-rotation.json`);
}

async function main() {
  await loadProjectEnv();
  if (process.env.SLIDE_ROTATE_LOST_ENCRYPTION_KEY !== confirmation) {
    throw new Error('Refusing credential rotation without SLIDE_ROTATE_LOST_ENCRYPTION_KEY=CONFIRM_LOST_KEY_ROTATION');
  }

  // encryptData validates that the new key is non-default before any database write.
  const instanceSentinel = encryptData(LOST_KEY_ROTATION_SENTINEL);
  const serverSentinel = encryptData(LOST_KEY_ROTATION_SENTINEL);
  const db = await mysql.createConnection({
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
