import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seedRuntimeResources } from './investigation-runtime-eval.js';
import { startFeedbackFixture } from '../../apps/db-ops-api/src/investigations/feedback-test-fixture.js';
const corpus = JSON.parse(readFileSync(new URL('./fixtures/investigations/cases.json', import.meta.url), 'utf8'));
test('all frozen resource IDs exist under real unique constraints; reseeding is idempotent', { skip: !process.env.T11_TEST_MYSQL_PORT }, async () => {
  const f = await startFeedbackFixture(Number(process.env.T11_TEST_MYSQL_PORT));
  try {
    await seedRuntimeResources(f, corpus.samples);
    await seedRuntimeResources(f, corpus.samples);
    for (const s of corpus.samples.filter((s: any) => s.subject.kind === 'resource')) {
      const ref = s.subject.resource;
      const table = ref.type === 'instance' ? 'database_instances' : ref.type === 'server' ? 'servers' : 'network_devices';
      assert.equal((await f.rows(`SELECT id FROM ${table} WHERE id=?`, [ref.id])).length, 1, s.id);
      if (ref.type === 'instance') assert.equal((await f.rows('SELECT access_level FROM instance_permissions WHERE user_id=101 AND instance_id=?', [ref.id]))[0].access_level, 'read-only');
    }
  } finally { await f.close(); }
});
