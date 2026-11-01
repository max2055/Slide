import { createHash } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { expect } from 'vitest';
import { stable } from '../packages/model.js';

/** MAX-239 integration regression: publication audits and historical snapshots share a table.
 * These config suites publish but never apply/collect. Check both records by revision,
 * so replay, rejection and rollback assertions cannot hide an extra history write.
 */
export async function publicationAuditCount(pool: Pool, target: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT payload FROM metric_policy_audit WHERE target = ? ORDER BY id', [target]);
  const records = rows.map(row => typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload);
  const operations = records.filter(record => ['binding.publish', 'group.publish'].includes(record.action));
  const snapshots = records.filter(record => record.action === 'configuration.snapshot');
  expect(records.every(record => record.target === target
    && ['binding.publish', 'group.publish', 'configuration.snapshot'].includes(record.action))).toBe(true);
  // Exactly one immutable publication snapshot for each successful resource revision.
  const revisions = operations.map(record => record.revision).sort((a, b) => a - b);
  expect(new Set(revisions).size).toBe(revisions.length);
  expect(snapshots.map(record => record.revision).sort((a, b) => a - b)).toEqual(revisions);
  for (const snapshot of snapshots) {
    const history = snapshot.configuration_history;
    expect(history).toMatchObject({ format: 'configuration-history-v1', basis: 'publication', sample_ids: [] });
    expect(history.payload.binding.revision).toBe(snapshot.revision);
    expect(`${history.payload.binding.resource.type}:${history.payload.binding.resource.id}`).toBe(target);
    expect(history.digest).toBe(`sha256:${createHash('sha256').update(stable(history.payload)).digest('hex')}`);
    const operation = operations.find(record => record.revision === snapshot.revision)!;
    expect(history.at).toBe(operation.at);
    if (operation.action === 'binding.publish') {
      expect(history.payload.binding.package).toEqual(operation.configuration.package);
      expect(history.payload.binding.overrides).toEqual(operation.configuration.overrides);
    }
  }
  return operations.length;
}
