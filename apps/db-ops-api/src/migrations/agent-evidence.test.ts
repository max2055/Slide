import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('creates owner and resource scoped persistent evidence with indexed bounded reads', async () => {
  const sql = await readFile(new URL('../../sql/migrations/087_agent_evidence.sql', import.meta.url), 'utf8').catch(() => '');
  expect(sql).toContain('PRIMARY KEY (owner_user_id, id)');
  expect(sql).toContain('idx_agent_evidence_resource_time (owner_user_id, resource_type, resource_id, observed_at)');
  expect(sql).toContain('FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE');
  expect(sql).not.toContain('tenant_id');
});
