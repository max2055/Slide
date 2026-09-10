import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('creates durable owner-scoped decisions with a resource lookup index', async () => {
  const sql = await readFile(new URL('../../sql/migrations/088_agent_evidence_decisions.sql', import.meta.url), 'utf8').catch(() => '');
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS agent_evidence_decisions');
  expect(sql).toContain('owner_user_id, resource_type, resource_id, created_at');
  expect(sql).toContain('FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE');
  for (const column of ['id', 'owner_user_id', 'resource_type', 'resource_id', 'record_json', 'created_at']) expect(sql.split('\n').find(line => line.trim().startsWith(column + ' '))).toContain('COMMENT');
  expect(sql).toMatch(/\) ENGINE=.*COMMENT=/);
});
