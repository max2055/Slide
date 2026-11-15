import type { Pool } from 'mysql2/promise';
import { encryptData } from './db-connection.js';
import { applicableNotificationConfig } from './notification-channel-config.js';

/**
 * Forward-only JSON data upgrade, run after the schema ledger and before
 * exposing routes/workers. No DDL/checksum edits and no plaintext snapshots.
 * Batches hold row locks on one connection; reruns only touch legacy fields.
 */
export async function migrateNotificationCredentials(pool: Pool): Promise<number> {
  let cursor = 0;
  let migrated = 0;
  let connection: Awaited<ReturnType<Pool['getConnection']>> | undefined;
  try {
    connection = await pool.getConnection();
    while (true) {
      await connection.beginTransaction();
      const [rows] = await connection.query<any[]>(
        'SELECT id, type, config FROM notification_channels WHERE id > ? ORDER BY id LIMIT 100 FOR UPDATE', [cursor],
      );
      for (const row of rows) {
        const original = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
        if (!original || typeof original !== 'object' || Array.isArray(original)) {
          throw new Error('NOTIFICATION_CREDENTIAL_MIGRATION_FAILED');
        }
        const config = applicableNotificationConfig(row.type, original);
        for (const field of ['webhook_url', 'password', 'secret', 'oauth2_refresh_token']) {
          if (!Object.hasOwn(config, field)) continue;
          if (typeof config[field] !== 'string' && config[field] !== null) {
            throw new Error('NOTIFICATION_CREDENTIAL_MIGRATION_FAILED');
          }
          // Keep a newer envelope when a historical row contains both formats.
          if (!config[field + '_encrypted'] && typeof config[field] === 'string' && config[field]) {
            config[field + '_encrypted'] = encryptData(config[field]);
          }
          delete config[field];
        }
        if (Object.keys(original).length !== Object.keys(config).length
          || Object.keys(original).some(key => original[key] !== config[key])) {
          await connection.execute('UPDATE notification_channels SET config = ?, updated_at = updated_at WHERE id = ?',
            [JSON.stringify(config), row.id]);
          migrated++;
        }
        cursor = row.id;
      }
      await connection.commit();
      if (rows.length < 100) return migrated;
    }
  } catch {
    try { await connection?.rollback(); } catch { /* Keep original failure; never replay unknown writes. */ }
    throw new Error('NOTIFICATION_CREDENTIAL_MIGRATION_FAILED');
  } finally {
    connection?.release();
  }
}
