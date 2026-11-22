import type { Pool } from 'mysql2/promise';
import { expect, it, vi } from 'vitest';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { TriggerPublicationService } from './publication.js';

it('rejects direct writes to a built-in template under its publication lock', async () => {
  const at = '2026-11-21T00:00:00.000Z';
  const row = {
    template_id: 'builtin-template', name: 'Built-in', status: 'active', created_by: null,
    current_published_version: 1, revision: 1, created_at: at, updated_at: at,
  };
  const connection = {
    execute: vi.fn(async (sql: string) => sql.includes('created_by') ? [[row], []] : [[], []]),
    beginTransaction: vi.fn(async () => {}), rollback: vi.fn(async () => {}),
    commit: vi.fn(async () => {}), release: vi.fn(),
  };
  const pool = { getConnection: async () => connection } as unknown as Pool;
  const actor = { userId: 7, username: 'fixture', roles: [], permissions: ['metric:manage'],
    sessionVersion: 1, instanceScopes: {}, requestId: 'builtin-write-refusal' };
  const publication = new TriggerPublicationService(pool, createBuiltinRegistry(), async () => actor);

  const condition = { node: 'compare', select: { aggregation: 'last' }, operator: '>',
    threshold: { kind: 'constant', value: 90 } } as const;
  await expect(publication.publish(actor, row.template_id, {
    expected_version: 1, expected_content_hash: `sha256:${'a'.repeat(64)}`, item_id: 'uptime',
    parameters: { schema: {}, defaults: {} }, problem: condition, recovery: { ...condition, operator: '<' },
    quality: { accepted_quality: ['good'], min_coverage: 1, allow_estimated: false },
    clock: { stale_after_ms: 120000, nodata: { enabled: false } },
  })).rejects.toMatchObject({ code: 'TRIGGER_FORBIDDEN', status: 403 });
  expect(connection.execute.mock.calls.some(([sql]) => sql.includes('FOR UPDATE'))).toBe(true);
  expect(connection.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
  expect(connection.rollback).toHaveBeenCalledOnce();
  expect(connection.commit).not.toHaveBeenCalled();
});
