import bcrypt from 'bcrypt';
import type { MigrationConnection } from './types.js';

const seedHash = '4f32fc2ba7f8dfa43328d1ee7e5eb7607c78ab2e73c5cd001979aeaf5532c817';

/** Runs under the schema migration lock, before any authentication listener starts. */
export async function bootstrapProductionAdmin(connection: MigrationConnection, env: NodeJS.ProcessEnv): Promise<void> {
  await connection.query('START TRANSACTION');
  try {
    const [seeds] = await connection.query<Array<{ id: number; password_hash: string }>>(
      "SELECT id,password_hash FROM users WHERE LOWER(username) IN ('admin','user') FOR UPDATE",
    );
    for (const seed of seeds) {
      const knownPassword = seed.password_hash === seedHash
        || (seed.password_hash.startsWith('$2') && await bcrypt.compare('Tpam1234', seed.password_hash));
      if (knownPassword) {
        // Preserve identity/history/password evidence; invalidate every existing session.
        await connection.query("UPDATE users SET status='inactive', session_version=session_version+1 WHERE id=? AND status <> 'inactive'", [seed.id]);
      }
    }
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
    throw error;
  }
}
