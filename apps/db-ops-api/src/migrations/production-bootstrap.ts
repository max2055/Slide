import bcrypt from 'bcrypt';
import { disableDevelopmentAccountSeeds, prepareBaselineAccountScope } from './development-account-seeds.js';
import type { MigrationConnection } from './types.js';

/** Runs under the schema migration lock, before any authentication listener starts. */
export async function bootstrapProductionAdmin(connection: MigrationConnection, env: NodeJS.ProcessEnv, legacyChecksums: readonly string[]): Promise<void> {
  const baselineChecksum = await prepareBaselineAccountScope(connection);
  await connection.query('START TRANSACTION');
  try {
    await disableDevelopmentAccountSeeds(connection, env, legacyChecksums, baselineChecksum);
    const [existing] = await connection.query<Array<{ id: number; status: string }>>(
      'SELECT id,status FROM users WHERE username=? FOR UPDATE', [env.INITIAL_ADMIN_USERNAME],
    );
    if (existing.length) {
      const [roles] = await connection.query<Array<{ name: string }>>(
        "SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=? AND r.name='admin'", [existing[0].id],
      );
      if (existing[0].status !== 'active' || !roles.length) {
        throw new Error('INITIAL_ADMIN_USERNAME conflicts with an existing non-active-admin account; choose an unused bootstrap identity');
      }
    } else {
      const passwordHash = await bcrypt.hash(env.INITIAL_ADMIN_PASSWORD!, 12);
      const [result] = await connection.query<{ insertId: number }>(
        "INSERT INTO users(username,password_hash,status) VALUES (?,?,'active')", [env.INITIAL_ADMIN_USERNAME, passwordHash],
      );
      const [grant] = await connection.query<{ affectedRows: number }>(
        "INSERT INTO user_roles(user_id,role_id) SELECT ?,id FROM roles WHERE name='admin'", [result.insertId],
      );
      if (grant.affectedRows !== 1) throw new Error('Bootstrap administrator role is missing');
    }
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    if (error instanceof Error && error.message === 'LEGACY_DEVELOPMENT_ACCOUNTS_RECONCILIATION_REQUIRED') console.error(error.message);
    throw error;
  }
}
