import { describe, expect, it } from 'vitest';
import type { ActorContext } from '../../auth/actor-context.js';
import { builtinReleases, createBuiltinRegistry } from '../packages/builtins.js';
import type { PackageRelease } from '../packages/model.js';
import { TemplateError } from './errors.js';
import { emptyDraftAggregate } from './model.js';
import { InMemoryTemplateRepository } from './repository.js';
import { MetricTemplateService } from './service.js';

const AT = '2026-10-27T01:00:00.000Z';
const mysql = (): PackageRelease => builtinReleases()
  .find(release => release.package.id === 'mysql-basic' && release.package.version === '1.0.0')!;
const pin = () => ({ id: mysql().package.id, version: mysql().package.version, digest: mysql().package.digest });
const releaseRef = () => `${pin().id}@${pin().version}#${pin().digest}`;
const UPTIME = { id: 'db.uptime_seconds', semantic_version: '1.0.0' };
const QUERIES = { id: 'mysql.queries.total', semantic_version: '1.0.0' };

const actor = (overrides: Partial<ActorContext> = {}): ActorContext => ({
  userId: 7, username: 'developer', roles: [], permissions: ['metric:view', 'metric:manage'],
  sessionVersion: 1, instanceScopes: {}, requestId: 'req-7', ...overrides,
});
const manager = () => actor();
const viewer = () => actor({ userId: 8, requestId: 'req-8', permissions: ['metric:view'] });

function setup() {
  const registry = createBuiltinRegistry();
  const repository = new InMemoryTemplateRepository();
  let sequence = 200;
  let tick = 0;
  const service = new MetricTemplateService(repository, registry, {
    now: () => new Date(Date.parse(AT) + tick++ * 1000).toISOString(),
    newTemplateId: () => `tpl-${sequence++}`,
    newItemId: () => `itm-${sequence++}`,
  });
  return { registry, repository, service };
}

async function code(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateError);
    return (error as TemplateError).code;
  }
  throw new Error('expected the call to fail');
}

const chain = () => ({
  actor_id: 7, request_id: 'req-7', base: null, created_at: AT, published_at: AT, retired_at: null, migration_ref: null,
});
const hostileItem = (templateId: string, overrides: Record<string, unknown> = {}) => ({
  template_id: templateId, item_id: 'uptime', display_name: 'Uptime', canonical_metric: UPTIME,
  unit: 's' as const, dimensions: {}, collector_ref: { package_release: releaseRef(), implementation_id: 'builtin:mysql.status.v1' },
  params_default: {}, source_chain: chain(), ...overrides,
});

async function draftRevision(repository: InMemoryTemplateRepository, templateId: string): Promise<number> {
  return (await repository.getDraft(templateId))!.revision;
}

/** A template with two collectable items and a valid template-level cadence. */
async function mysqlTemplate(service: MetricTemplateService) {
  const who = manager();
  const created = await service.create(who, { name: 'MySQL basic' });
  const uptime = await service.selectMetric(who, created.template_id, { item_id: 'uptime', package: pin(), metric: UPTIME });
  const queries = await service.selectMetric(who, created.template_id, { item_id: 'queries', package: pin(), metric: QUERIES });
  const draft = await service.updateDraft(who, created.template_id, {
    expected_draft_revision: 0,
    aggregate: {
      ...emptyDraftAggregate(created.template_id),
      items: [{ item_id: 'queries', version: queries.item.version }, { item_id: 'uptime', version: uptime.item.version }],
      parameters: { schema: { interval_ms: { type: 'integer', min: 1000, max: 86400000 } }, defaults: { interval_ms: 60000 } },
    },
  });
  return { created, uptime, queries, draft };
}

describe('template lifecycle', () => {
  it('creates a server-identified draft and enforces metric:manage', async () => {
    const { service } = setup();
    const created = await service.create(manager(), { name: '  DB basic  ' });
    expect(created.name).toBe('DB basic');
    expect(created.template_id).toBe('tpl-200');
    expect(created.revision).toBe(0);
    expect(created.current_published_version).toBeNull();
    expect(await code(service.create(viewer(), { name: 'nope' }))).toBe('TEMPLATE_FORBIDDEN');
    expect(await code(service.create(manager(), { name: '   ' }))).toBe('TEMPLATE_NAME_EMPTY');
    expect(await code(service.create(manager(), { name: 5 }))).toBe('TEMPLATE_INVALID_INPUT');
    const detail = await service.detail(viewer(), created.template_id);
    expect(detail.current).toBeNull();
    expect(detail.items).toEqual([]);
    expect((await service.list(viewer(), { limit: 5 })).items).toHaveLength(1);
  });

  it('auto-fills a selected metric and keeps the item identity across a rename', async () => {
    const { service } = setup();
    const created = await service.create(manager(), { name: 'MySQL basic' });
    const first = await service.selectMetric(manager(), created.template_id, {
      item_id: 'uptime', package: pin(), metric: UPTIME,
    });
    expect(first.reused).toBe(false);
    expect(first.item.version).toBe(1);
    expect(first.item.unit).toBe('s');
    expect(first.item.collector_ref).toEqual({ package_release: releaseRef(), implementation_id: 'builtin:mysql.status.v1' });
    expect(first.auto.raw_field).toBe('Uptime');
    expect(first.auto.default_interval_ms).toBe(60000);
    const same = await service.selectMetric(manager(), created.template_id, { item_id: 'uptime', package: pin(), metric: UPTIME });
    expect(same.reused).toBe(true);
    expect(same.item.version).toBe(1);
    const renamed = await service.selectMetric(manager(), created.template_id, {
      item_id: 'uptime', display_name: 'Database uptime', package: pin(), metric: UPTIME,
    });
    expect(renamed.item.item_id).toBe('uptime');
    expect(renamed.item.version).toBe(2);
    expect(renamed.item.source_chain.base).toEqual({ kind: 'item', template_id: created.template_id, id: 'uptime', version: 1 });
    expect(await code(service.selectMetric(viewer(), created.template_id, { package: pin(), metric: UPTIME })))
      .toBe('TEMPLATE_FORBIDDEN');
  });

  it('auto-fills dimensions and composes a template that spans releases', async () => {
    const { service, repository } = setup();
    const created = await service.create(manager(), { name: 'Mixed' });
    const linux = builtinReleases().find(release => release.package.id === 'linux-host')!;
    const filesystem = await service.selectMetric(manager(), created.template_id, {
      item_id: 'filesystem', package: { id: linux.package.id, version: linux.package.version, digest: linux.package.digest },
      metric: { id: 'host.filesystem.used_bytes', semantic_version: '1.0.0' },
    });
    expect(Object.keys(filesystem.item.dimensions).sort()).toEqual(['device', 'fs_type', 'mount']);
    expect(filesystem.item.unit).toBe('By');
    const uptime = await service.selectMetric(manager(), created.template_id, { item_id: 'uptime', package: pin(), metric: UPTIME });
    await service.updateDraft(manager(), created.template_id, {
      expected_draft_revision: 0,
      aggregate: {
        ...emptyDraftAggregate(created.template_id),
        items: [{ item_id: 'filesystem', version: filesystem.item.version }, { item_id: 'uptime', version: uptime.item.version }],
      },
    });
    const published = await service.publish(manager(), created.template_id, { expected_draft_revision: 1, expected_revision: 0 });
    expect(published.mapping_trace.map(entry => [entry.item_id, entry.raw_field])).toEqual([
      ['filesystem', 'filesystem_used_bytes'], ['uptime', 'Uptime'],
    ]);
    const version = await repository.getVersion(created.template_id, 1);
    expect(version!.package_composition.map(entry => [entry.release.split('@')[0], entry.items])).toEqual([
      ['linux-host', ['filesystem']], ['mysql-basic', ['uptime']],
    ]);
  });

  it('publishes an immutable version with a per-item raw-field trace', async () => {
    const { service, repository } = setup();
    const { created } = await mysqlTemplate(service);
    const published = await service.publish(manager(), created.template_id, {
      expected_draft_revision: 1, expected_revision: 0,
    });
    expect(published).toMatchObject({ version: 1, noop: false, template_revision: 1 });
    expect(published.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(published.deferred_capabilities).toEqual(['discovery', 'graphs']);
    expect(published.mapping_trace).toEqual([
      expect.objectContaining({ item_id: 'queries', raw_field: 'Queries', input_unit: 'count', method: 'sql',
        implementation_id: 'builtin:mysql.status.v1', package_release: releaseRef(), steps: ['decode', 'normalize'] }),
      expect.objectContaining({ item_id: 'uptime', raw_field: 'Uptime', output_unit: 's' }),
    ]);
    const version = await repository.getVersion(created.template_id, 1);
    expect(version!.package_composition).toEqual([{ release: releaseRef(), items: ['queries', 'uptime'] }]);
    expect(version!.aggregate.package_composition).toEqual(version!.package_composition);
    expect(version!.items.map(item => item.canonical_metric.id).sort()).toEqual(['db.uptime_seconds', 'mysql.queries.total']);
    expect(version!.source_chain.base).toBeNull();
    const detail = await service.detail(viewer(), created.template_id);
    expect(detail.template.current_published_version).toBe(1);
    expect(detail.versions).toEqual([{ version: 1, content_hash: published.content_hash, status: 'published' }]);
  });

  it('treats a rename as history-preserving and republishing as a no-op', async () => {
    const { service, repository } = setup();
    const { created } = await mysqlTemplate(service);
    const first = await service.publish(manager(), created.template_id, { expected_draft_revision: 1, expected_revision: 0 });
    const renamed = await service.rename(manager(), created.template_id, { name: 'MySQL baseline', expected_revision: 1 });
    expect(renamed.template_id).toBe(created.template_id);
    expect(renamed.name).toBe('MySQL baseline');
    expect(renamed.revision).toBe(2);
    const second = await service.publish(manager(), created.template_id, { expected_draft_revision: 2, expected_revision: 2 });
    expect(second).toMatchObject({ noop: true, version: 1, content_hash: first.content_hash, template_revision: 2 });
    expect(await repository.listVersions(created.template_id)).toHaveLength(1);
    expect((await repository.getVersion(created.template_id, 1))!.content_hash).toBe(first.content_hash);
  });

  it('creates a new template version when an item version changes', async () => {
    const { service } = setup();
    const { created } = await mysqlTemplate(service);
    const first = await service.publish(manager(), created.template_id, { expected_draft_revision: 1, expected_revision: 0 });
    const renamed = await service.selectMetric(manager(), created.template_id, {
      item_id: 'uptime', display_name: 'Host uptime', package: pin(), metric: UPTIME,
    });
    expect(renamed.item.version).toBe(2);
    await service.updateDraft(manager(), created.template_id, {
      expected_draft_revision: 2,
      aggregate: {
        ...emptyDraftAggregate(created.template_id),
        items: [{ item_id: 'queries', version: 1 }, { item_id: 'uptime', version: 2 }],
        parameters: { schema: { interval_ms: { type: 'integer', min: 1000, max: 86400000 } }, defaults: { interval_ms: 60000 } },
      },
    });
    const second = await service.publish(manager(), created.template_id, { expected_draft_revision: 3, expected_revision: 1 });
    expect(second.noop).toBe(false);
    expect(second.version).toBe(2);
    expect(second.content_hash).not.toBe(first.content_hash);
    expect(second.mapping_trace.find(entry => entry.item_id === 'uptime')!.item_version).toBe(2);
  });

  it('copies into a new template identity without continuing the source history', async () => {
    const { service, repository } = setup();
    const { created } = await mysqlTemplate(service);
    const source = await service.publish(manager(), created.template_id, { expected_draft_revision: 1, expected_revision: 0 });
    // Publish a second version whose uptime item is v2, then copy the current content.
    await service.selectMetric(manager(), created.template_id, {
      item_id: 'uptime', display_name: 'Uptime v2', package: pin(), metric: UPTIME,
    });
    await service.updateDraft(manager(), created.template_id, {
      expected_draft_revision: 2,
      aggregate: {
        ...emptyDraftAggregate(created.template_id),
        items: [{ item_id: 'queries', version: 1 }, { item_id: 'uptime', version: 2 }],
        parameters: { schema: { interval_ms: { type: 'integer', min: 1000, max: 86400000 } }, defaults: { interval_ms: 60000 } },
      },
    });
    const current = await service.publish(manager(), created.template_id, { expected_draft_revision: 3, expected_revision: 1 });
    expect(current.version).toBe(2);
    const copy = await service.copy(manager(), created.template_id, { name: 'MySQL copy' });
    expect(copy.template_id).not.toBe(created.template_id);
    expect(copy.current_published_version).toBeNull();
    const copyDetail = await service.detail(manager(), copy.template_id);
    expect(copyDetail.current).toBeNull();
    expect(copyDetail.items.map(item => item.item_id).sort()).toEqual(['queries', 'uptime']);
    expect(copyDetail.items.every(item => item.template_id === copy.template_id)).toBe(true);
    const draft = await repository.getDraft(copy.template_id);
    expect(draft!.aggregate.base).toBeNull();
    expect(draft!.aggregate.items).toEqual([{ item_id: 'queries', version: 1 }, { item_id: 'uptime', version: 1 }]);
    const publishedCopy = await service.publish(manager(), copy.template_id, { expected_draft_revision: 0, expected_revision: 0 });
    expect(publishedCopy.version).toBe(1);
    expect(publishedCopy.content_hash).not.toBe(current.content_hash);
    expect(publishedCopy.content_hash).not.toBe(source.content_hash);
    expect(publishedCopy.mapping_trace.map(entry => entry.raw_field)).toEqual(['Queries', 'Uptime']);
    expect(await repository.listVersions(created.template_id)).toHaveLength(2);
  });

  it('moves only the current pointer and refuses a stale revision', async () => {
    const { service, repository } = setup();
    const { created } = await mysqlTemplate(service);
    await service.publish(manager(), created.template_id, { expected_draft_revision: 1, expected_revision: 0 });
    await service.selectMetric(manager(), created.template_id, { item_id: 'uptime', display_name: 'Uptime v2', package: pin(), metric: UPTIME });
    await service.updateDraft(manager(), created.template_id, {
      expected_draft_revision: 2,
      aggregate: {
        ...emptyDraftAggregate(created.template_id),
        items: [{ item_id: 'queries', version: 1 }, { item_id: 'uptime', version: 2 }],
        parameters: { schema: { interval_ms: { type: 'integer', min: 1000, max: 86400000 } }, defaults: { interval_ms: 60000 } },
      },
    });
    await service.publish(manager(), created.template_id, { expected_draft_revision: 3, expected_revision: 1 });
    const second = await repository.getVersion(created.template_id, 2);
    const back = await service.setCurrent(manager(), created.template_id, { version: 1, expected_revision: 2 });
    expect(back.current_published_version).toBe(1);
    expect(back.revision).toBe(3);
    expect(await repository.getVersion(created.template_id, 2)).toEqual(second);
    expect(await code(service.setCurrent(manager(), created.template_id, { version: 1, expected_revision: 2 })))
      .toBe('TEMPLATE_REVISION_CONFLICT');
    expect(await code(service.setCurrent(manager(), created.template_id, { version: 9, expected_revision: 3 })))
      .toBe('TEMPLATE_NOT_FOUND');
  });

  it('lets exactly one of two publishes at the same revision win', async () => {
    const { service, repository } = setup();
    const { created } = await mysqlTemplate(service);
    const results = await Promise.allSettled([
      service.publish(manager(), created.template_id, { expected_draft_revision: 1, expected_revision: 0 }),
      service.publish(manager(), created.template_id, { expected_draft_revision: 1, expected_revision: 0 }),
    ]);
    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(TemplateError);
    // The template pointer is locked first, so the loser fails on the template CAS.
    expect(((rejected[0] as PromiseRejectedResult).reason as TemplateError).code).toBe('TEMPLATE_REVISION_CONFLICT');
    expect(await repository.listVersions(created.template_id)).toHaveLength(1);
    // A retry with the fresh revisions is the documented idempotent path.
    const retry = await service.publish(manager(), created.template_id, { expected_draft_revision: 2, expected_revision: 1 });
    expect(retry).toMatchObject({ noop: true, version: 1, template_revision: 1 });
    expect(await repository.listVersions(created.template_id)).toHaveLength(1);
  });

  it('returns detached copies from reads', async () => {
    const { service } = setup();
    const { created } = await mysqlTemplate(service);
    await service.publish(manager(), created.template_id, { expected_draft_revision: 1, expected_revision: 0 });
    const detail = await service.detail(manager(), created.template_id);
    detail.current!.aggregate.items.push({ item_id: 'ghost', version: 1 });
    detail.items[0]!.display_name = 'mutated';
    const again = await service.detail(manager(), created.template_id);
    expect(again.current!.aggregate.items).toEqual([{ item_id: 'queries', version: 1 }, { item_id: 'uptime', version: 1 }]);
    expect(again.items.map(item => item.display_name).sort()).toEqual(['mysql.queries.total', 'db.uptime_seconds'].sort());
  });
});

describe('publish rejections', () => {
  it('rejects an empty template, an unresolved base and a blank name', async () => {
    const { service } = setup();
    const empty = await service.create(manager(), { name: 'Empty' });
    expect(await code(service.publish(manager(), empty.template_id, { expected_draft_revision: 0, expected_revision: 0 })))
      .toBe('TEMPLATE_EMPTY');
    const based = await service.create(manager(), { name: 'Based' });
    await service.updateDraft(manager(), based.template_id, {
      expected_draft_revision: 0,
      aggregate: {
        ...emptyDraftAggregate(based.template_id),
        base: { template_id: empty.template_id, version: 1 },
      },
    });
    expect(await code(service.publish(manager(), based.template_id, { expected_draft_revision: 1, expected_revision: 0 })))
      .toBe('TEMPLATE_BASE_INHERITANCE_UNAVAILABLE');
  });

  it('rejects an illegal cadence when the draft is saved and again at publish', async () => {
    const { service, repository } = setup();
    const { created } = await mysqlTemplate(service);
    const aggregate = {
      ...emptyDraftAggregate(created.template_id),
      items: [{ item_id: 'uptime', version: 1 }],
      parameters: { schema: { interval_ms: { type: 'number' as const } }, defaults: {} },
    };
    expect(await code(service.updateDraft(manager(), created.template_id, {
      expected_draft_revision: 1, aggregate,
    }))).toBe('TEMPLATE_INVALID_PERIOD');
    expect(await code(service.updateDraft(manager(), created.template_id, {
      expected_draft_revision: 1,
      aggregate: { ...aggregate, parameters: { schema: { interval_ms: { type: 'integer' as const } }, defaults: { interval_ms: 500 } } },
    }))).toBe('TEMPLATE_INVALID_PERIOD');
    expect(await code(service.updateDraft(manager(), created.template_id, {
      expected_draft_revision: 1,
      aggregate: {
        ...aggregate,
        parameters: { schema: { interval_ms: { type: 'integer' as const, min: 100, max: 86400000 } }, defaults: {} },
      },
    }))).toBe('TEMPLATE_INVALID_PERIOD');
    // Publish re-validates the stored draft, not just the editor input.
    await repository.updateDraft(created.template_id, 1, { aggregate, updated_by: 7, updated_at: AT });
    expect(await code(service.publish(manager(), created.template_id, { expected_draft_revision: 2, expected_revision: 0 })))
      .toBe('TEMPLATE_INVALID_PERIOD');
    expect(await repository.listVersions(created.template_id)).toEqual([]);
  });

  it('rejects an item-level cadence and undeclared item parameters', async () => {
    const { service, repository } = setup();
    const created = await service.create(manager(), { name: 'Cadence' });
    const item = await repository.putItemVersion(hostileItem(created.template_id, { params_default: { interval_ms: 30000 } }));
    await service.updateDraft(manager(), created.template_id, {
      expected_draft_revision: 0,
      aggregate: { ...emptyDraftAggregate(created.template_id), items: [{ item_id: 'uptime', version: item.item.version }] },
    });
    expect(await code(service.publish(manager(), created.template_id, { expected_draft_revision: 1, expected_revision: 0 })))
      .toBe('TEMPLATE_ITEM_CADENCE');
  });

  it('rejects a unit or dimension mismatch against the canonical definition', async () => {
    const { service, repository } = setup();
    const created = await service.create(manager(), { name: 'Mismatch' });
    const wrongUnit = await repository.putItemVersion(hostileItem(created.template_id, { unit: 'ms' }));
    await service.updateDraft(manager(), created.template_id, {
      expected_draft_revision: 0,
      aggregate: { ...emptyDraftAggregate(created.template_id), items: [{ item_id: 'uptime', version: wrongUnit.item.version }] },
    });
    expect(await code(service.publish(manager(), created.template_id, { expected_draft_revision: 1, expected_revision: 0 })))
      .toBe('TEMPLATE_UNIT_MISMATCH');

    const other = await service.create(manager(), { name: 'Dimensions' });
    const wrongDimensions = await repository.putItemVersion(hostileItem(other.template_id, { dimensions: { host: 'fixture' } }));
    await service.updateDraft(manager(), other.template_id, {
      expected_draft_revision: 0,
      aggregate: { ...emptyDraftAggregate(other.template_id), items: [{ item_id: 'uptime', version: wrongDimensions.item.version }] },
    });
    expect(await code(service.publish(manager(), other.template_id, { expected_draft_revision: 1, expected_revision: 0 })))
      .toBe('TEMPLATE_DIMENSIONS_MISMATCH');
  });

  it('rejects a missing implementation pin and an uninstalled release', async () => {
    const { service, repository } = setup();
    const created = await service.create(manager(), { name: 'Mapping' });
    const wrongImpl = await repository.putItemVersion(hostileItem(created.template_id, {
      collector_ref: { package_release: releaseRef(), implementation_id: 'builtin:mysql.status.v9' },
    }));
    await service.updateDraft(manager(), created.template_id, {
      expected_draft_revision: 0,
      aggregate: { ...emptyDraftAggregate(created.template_id), items: [{ item_id: 'uptime', version: wrongImpl.item.version }] },
    });
    expect(await code(service.publish(manager(), created.template_id, { expected_draft_revision: 1, expected_revision: 0 })))
      .toBe('TEMPLATE_MAPPING_MISSING');

    const ghost = await service.create(manager(), { name: 'Ghost pin' });
    const ghostItem = await repository.putItemVersion(hostileItem(ghost.template_id, {
      collector_ref: { package_release: `mysql-basic@9.9.9#sha256:${'f'.repeat(64)}`, implementation_id: 'builtin:mysql.status.v1' },
    }));
    await service.updateDraft(manager(), ghost.template_id, {
      expected_draft_revision: 0,
      aggregate: { ...emptyDraftAggregate(ghost.template_id), items: [{ item_id: 'uptime', version: ghostItem.item.version }] },
    });
    expect(await code(service.publish(manager(), ghost.template_id, { expected_draft_revision: 1, expected_revision: 0 })))
      .toBe('TEMPLATE_PIN_NOT_FOUND');
  });

  it('rejects the same metric selected by two items', async () => {
    const { service } = setup();
    const created = await service.create(manager(), { name: 'Duplicates' });
    const first = await service.selectMetric(manager(), created.template_id, { item_id: 'uptime-a', package: pin(), metric: UPTIME });
    const second = await service.selectMetric(manager(), created.template_id, { item_id: 'uptime-b', package: pin(), metric: UPTIME });
    await service.updateDraft(manager(), created.template_id, {
      expected_draft_revision: 0,
      aggregate: {
        ...emptyDraftAggregate(created.template_id),
        items: [{ item_id: 'uptime-a', version: first.item.version }, { item_id: 'uptime-b', version: second.item.version }],
      },
    });
    expect(await code(service.publish(manager(), created.template_id, { expected_draft_revision: 1, expected_revision: 0 })))
      .toBe('TEMPLATE_METRIC_DUPLICATE');
  });

  it('rejects stale draft and template revisions without writing a version', async () => {
    const { service, repository } = setup();
    const { created } = await mysqlTemplate(service);
    expect(await code(service.publish(manager(), created.template_id, { expected_draft_revision: 0, expected_revision: 0 })))
      .toBe('TEMPLATE_DRAFT_CONFLICT');
    expect(await code(service.publish(manager(), created.template_id, { expected_draft_revision: 1, expected_revision: 9 })))
      .toBe('TEMPLATE_REVISION_CONFLICT');
    expect(await repository.listVersions(created.template_id)).toEqual([]);
    expect(await code(service.updateDraft(manager(), created.template_id, {
      expected_draft_revision: 0, aggregate: emptyDraftAggregate(created.template_id),
    }))).toBe('TEMPLATE_DRAFT_CONFLICT');
  });

  it('rejects references to item versions that do not exist', async () => {
    const { service, repository } = setup();
    const created = await service.create(manager(), { name: 'Dangling' });
    expect(await code(service.updateDraft(manager(), created.template_id, {
      expected_draft_revision: 0,
      aggregate: { ...emptyDraftAggregate(created.template_id), items: [{ item_id: 'ghost', version: 3 }] },
    }))).toBe('TEMPLATE_ITEM_NOT_FOUND');
    expect(await draftRevision(repository, created.template_id)).toBe(0);
  });

  it('forbids writes for a metric:view-only actor', async () => {
    const { service, repository } = setup();
    const { created } = await mysqlTemplate(service);
    expect(await code(service.publish(viewer(), created.template_id, { expected_draft_revision: 1, expected_revision: 0 })))
      .toBe('TEMPLATE_FORBIDDEN');
    expect(await code(service.updateDraft(viewer(), created.template_id, {
      expected_draft_revision: 1, aggregate: emptyDraftAggregate(created.template_id),
    }))).toBe('TEMPLATE_FORBIDDEN');
    expect(await code(service.rename(viewer(), created.template_id, { name: 'x', expected_revision: 0 })))
      .toBe('TEMPLATE_FORBIDDEN');
    expect(await repository.listVersions(created.template_id)).toEqual([]);
    expect((await repository.getTemplate(created.template_id))!.name).toBe('MySQL basic');
  });

  it('maps failure codes to the intended status', async () => {
    const { service } = setup();
    const created = await service.create(manager(), { name: 'Status' });
    try {
      await service.publish(manager(), created.template_id, { expected_draft_revision: 0, expected_revision: 0 });
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as TemplateError).status).toBe(422);
    }
    try {
      await service.detail(manager(), 'tpl-missing');
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as TemplateError).status).toBe(404);
    }
  });
});
