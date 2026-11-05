import { dbConnection } from '../db-connection.js';

/** Record the explicit request before allowing a compatibility write/probe.
 * Failure is closed; this records intent, not a claim that the write succeeded. */
export async function recordSshTrustRequest(actorId: number, resourceType: string, resourceId: string, mode: unknown): Promise<void> {
  if (mode !== 'insecure') return;
  const pool = dbConnection.getPool();
  if (!pool || !Number.isSafeInteger(actorId) || actorId <= 0) throw new Error('SSH_TRUST_AUDIT_UNAVAILABLE');
  await pool.execute('INSERT INTO ssh_trust_decisions (actor_id, resource_type, resource_id, mode) VALUES (?, ?, ?, ?)',
    [actorId, resourceType, resourceId, 'insecure']);
}
