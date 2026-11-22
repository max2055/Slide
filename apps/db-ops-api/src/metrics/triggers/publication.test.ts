import type { Pool } from 'mysql2/promise';
import { afterEach, expect, it, vi } from 'vitest';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { templateContentHash } from '../templates/model.js';
import { MySqlTemplateRepository } from '../templates/mysql-repository.js';
import { MetricTemplateService } from '../templates/service.js';
import { TriggerPublicationService } from './publication.js';
import { averageRule, baseline, fixtureRegistry, thresholdRule } from './test-support.js';

afterEach(() => vi.restoreAllMocks());

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

it.each(['clone', 'child'])('keeps the upstream rule ID when revising it in a %s', async kind => {
  const { version: source } = await baseline();
  const templateId = `template-${kind}`;
  const base = kind === 'child' ? { template_id: source.template_id, version: source.version } : null;
  const { package_composition: _composition, ...sourceAggregate } = source.aggregate;
  const draftAggregate = { ...sourceAggregate, template_id: templateId, base,
    ...(base ? { items: [], triggers: [] } : {}) };
  const effective = { ...source.aggregate, template_id: templateId, base, ...(base ? { inheritance: {
    items: Object.fromEntries(source.aggregate.items.map(item => [item.item_id, base])),
    parameters: {},
    triggers: Object.fromEntries(source.aggregate.triggers.map(ref => [`${ref.rule_id}:${ref.scope}`, base])),
  } } : {}) };
  const contentHash = templateContentHash(effective);
  const current = { ...source, template_id: templateId, content_hash: contentHash, aggregate: effective,
    items: source.items.map(item => ({ ...item, template_id: templateId })) };
  const actor = { userId: 7, username: 'fixture', roles: [], permissions: ['metric:manage'],
    sessionVersion: 1, instanceScopes: {}, requestId: 'revise-shared-rule' };
  const at = '2026-11-21T00:00:00.000Z';
  const draft = { template_id: templateId, revision: 1, aggregate: draftAggregate, published_version: 1,
    updated_by: actor.userId, updated_at: at };
  vi.spyOn(MySqlTemplateRepository.prototype, 'getTemplate').mockResolvedValue({
    template_id: templateId, name: templateId, revision: 1, status: 'active', current_published_version: 1,
    created_by: actor.userId, created_at: at, updated_at: at,
  });
  vi.spyOn(MySqlTemplateRepository.prototype, 'getVersion').mockImplementation(async id => id === templateId ? current : source);
  vi.spyOn(MySqlTemplateRepository.prototype, 'getDraft').mockResolvedValue(draft);
  const update = vi.spyOn(MetricTemplateService.prototype, 'updateDraft').mockResolvedValue({ ...draft, revision: 2 });
  vi.spyOn(MetricTemplateService.prototype, 'publish').mockResolvedValue({
    version: 2, content_hash: contentHash, template_revision: 2, noop: false, mapping_trace: [], deferred_capabilities: [],
  });
  const upstream = thresholdRule();
  const downstream = averageRule({ severity: 'critical', dependencies: [upstream.rule_id] });
  const connection = {
    execute: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT payload')) return [[{ payload: values?.[0] === upstream.rule_id ? upstream : downstream }], []];
      if (sql.includes('COALESCE(MAX(version)')) return [[{ version: 1 }], []];
      return [[], []];
    }),
    beginTransaction: vi.fn(async () => {}), rollback: vi.fn(async () => {}),
    commit: vi.fn(async () => {}), release: vi.fn(),
  };
  const publication = new TriggerPublicationService({ getConnection: async () => connection } as unknown as Pool,
    fixtureRegistry(), async () => actor);
  const { parameters, problem, recovery, quality, clock } = upstream;
  const result = await publication.publish(actor, templateId, {
    expected_version: 1, expected_content_hash: contentHash, item_id: 'alpha',
    parameters, problem, recovery, quality, clock, dependencies: [],
  });
  expect(result.rule).toMatchObject({ rule_id: upstream.rule_id, version: 2 });
  expect(result.rule).not.toHaveProperty('dependencies');
  expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining('LIMIT 1 FOR UPDATE'), [upstream.rule_id]);
  const replacement = { rule_id: upstream.rule_id, scope: upstream.scope, version: 2 };
  expect(update.mock.calls[0][2]).toMatchObject({ aggregate: { triggers: base ? [replacement] : [
    { rule_id: downstream.rule_id, scope: downstream.scope, version: 1 }, replacement,
  ] } });
  expect(connection.commit).toHaveBeenCalledOnce();
});
