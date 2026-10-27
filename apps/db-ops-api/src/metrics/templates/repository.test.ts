import { describe, expect, it } from 'vitest';
import { TemplateError } from './errors.js';
import {
  emptyDraftAggregate, templateContentHash, type SourceChain, type TemplateDraft, type TemplateItemVersion,
  type TemplatePublishedAggregate, type TemplateRecord,
} from './model.js';
import { InMemoryTemplateRepository, type PublishCommand } from './repository.js';

const AT = '2026-10-27T00:00:00.000Z';
const RELEASE = `mysql-basic@1.0.0#sha256:${'a'.repeat(64)}`;

const chain = (): SourceChain => ({
  actor_id: 1, request_id: 'req-1', base: null, created_at: AT, published_at: AT, retired_at: null, migration_ref: null,
});
const template = (templateId = 'tpl-a'): TemplateRecord => ({
  template_id: templateId, name: 'Template A', status: 'draft', current_published_version: null,
  revision: 0, created_by: 1, created_at: AT, updated_at: AT,
});
const draft = (templateId = 'tpl-a'): TemplateDraft => ({
  template_id: templateId, revision: 0, aggregate: emptyDraftAggregate(templateId),
  published_version: null, updated_by: 1, updated_at: AT,
});
const item = (templateId = 'tpl-a', version = 1, displayName = 'Uptime'): TemplateItemVersion => ({
  template_id: templateId, item_id: 'uptime', version, display_name: displayName,
  canonical_metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, unit: 's', dimensions: {},
  collector_ref: { package_release: RELEASE, implementation_id: 'builtin:mysql.status.v1' },
  params_default: {}, source_chain: chain(),
});
const aggregate = (templateId = 'tpl-a'): TemplatePublishedAggregate => ({
  ...emptyDraftAggregate(templateId),
  items: [{ item_id: 'uptime', version: 1 }],
  package_composition: [{ release: RELEASE, items: ['uptime'] }],
});
const command = (overrides: Partial<PublishCommand> = {}): PublishCommand => ({
  templateId: 'tpl-a',
  expectedTemplateRevision: 0,
  expectedDraftRevision: 0,
  contentHash: templateContentHash(aggregate()),
  aggregate: aggregate(),
  items: [item()],
  packageComposition: [{ release: RELEASE, items: ['uptime'] }],
  sourceChain: chain(),
  publishedAt: AT,
  draftUpdatedAt: AT,
  actorId: 1,
  ...overrides,
});

async function code(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateError);
    return (error as TemplateError).code;
  }
  throw new Error('expected the call to fail');
}

describe('in-memory template repository', () => {
  it('refuses to reuse a template identity', async () => {
    const repository = new InMemoryTemplateRepository();
    await repository.create(template(), draft());
    expect(await code(repository.create(template(), draft()))).toBe('TEMPLATE_EXISTS');
    expect((await repository.getTemplate('tpl-a'))!.revision).toBe(0);
  });

  it('applies draft and template writes only at the expected revision', async () => {
    const repository = new InMemoryTemplateRepository();
    await repository.create(template(), draft());
    const updated = await repository.updateDraft('tpl-a', 0, {
      aggregate: { ...emptyDraftAggregate('tpl-a'), items: [{ item_id: 'uptime', version: 1 }] },
      updated_by: 1,
      updated_at: AT,
    });
    expect(updated.revision).toBe(1);
    expect(await code(repository.updateDraft('tpl-a', 0, {
      aggregate: emptyDraftAggregate('tpl-a'), updated_by: 1, updated_at: AT,
    }))).toBe('TEMPLATE_DRAFT_CONFLICT');
    expect((await repository.getDraft('tpl-a'))!.aggregate.items).toEqual([{ item_id: 'uptime', version: 1 }]);
    expect(await code(repository.updateTemplate('tpl-a', 5, { name: 'B', updated_at: AT }))).toBe('TEMPLATE_REVISION_CONFLICT');
  });

  it('keeps item identity stable and appends only on real content change', async () => {
    const repository = new InMemoryTemplateRepository();
    await repository.create(template(), draft());
    const base = {
      template_id: 'tpl-a', item_id: 'uptime', canonical_metric: item().canonical_metric, unit: 's' as const,
      dimensions: {}, collector_ref: item().collector_ref, params_default: {}, source_chain: chain(),
    };
    const first = await repository.putItemVersion({ ...base, display_name: 'Uptime' });
    expect(first.reused).toBe(false);
    expect(first.item.version).toBe(1);
    const again = await repository.putItemVersion({ ...base, display_name: 'Uptime' });
    expect(again.reused).toBe(true);
    expect(again.item.version).toBe(1);
    const renamed = await repository.putItemVersion({ ...base, display_name: 'Database uptime' });
    expect(renamed.reused).toBe(false);
    expect(renamed.item.item_id).toBe('uptime');
    expect(renamed.item.version).toBe(2);
    expect(renamed.item.source_chain.base).toBeNull();
    expect((await repository.getItemVersion('tpl-a', 'uptime', 1))!.display_name).toBe('Uptime');
    expect((await repository.latestItemVersions('tpl-a')).map(entry => entry.version)).toEqual([2]);
  });

  it('refuses an incompatible semantic change on a stable item identity', async () => {
    const repository = new InMemoryTemplateRepository();
    await repository.create(template(), draft());
    const base = {
      template_id: 'tpl-a', item_id: 'uptime', display_name: 'Uptime', canonical_metric: item().canonical_metric,
      unit: 's' as const, dimensions: {}, collector_ref: item().collector_ref, params_default: {}, source_chain: chain(),
    };
    const first = await repository.putItemVersion(base);
    expect(first.item.version).toBe(1);
    // A different canonical metric under the same item_id is a new identity, not v2.
    expect(await code(repository.putItemVersion({
      ...base, canonical_metric: { id: 'mysql.queries.total', semantic_version: '1.0.0' },
    }))).toBe('TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE');
    // Same for a unit change and a dimension key change.
    expect(await code(repository.putItemVersion({ ...base, unit: 'ms' }))).toBe('TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE');
    expect(await code(repository.putItemVersion({ ...base, dimensions: { host: 'host identifier' } })))
      .toBe('TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE');
    // A compatible implementation pin update and a rename still append under the same identity.
    const repinned = await repository.putItemVersion({
      ...base,
      display_name: 'Database uptime',
      collector_ref: { package_release: `mysql-basic@1.0.0#sha256:${'b'.repeat(64)}`, implementation_id: 'builtin:mysql.status.v1' },
    });
    expect(repinned.reused).toBe(false);
    expect(repinned.item.version).toBe(2);
    expect(repinned.item.item_id).toBe('uptime');
    expect(repinned.item.canonical_metric).toEqual(item().canonical_metric);
    // A rejected append leaves the stored versions untouched.
    expect(await repository.getItemVersion('tpl-a', 'uptime', 1)).toEqual(first.item);
    expect((await repository.latestItemVersions('tpl-a')).map(entry => entry.version)).toEqual([2]);
  });

  it('applies the identity guard on the conditional append, not only in the service', async () => {
    const repository = new InMemoryTemplateRepository();
    await repository.create(template(), draft());
    const base = {
      template_id: 'tpl-a', item_id: 'uptime', display_name: 'Uptime', canonical_metric: item().canonical_metric,
      unit: 's' as const, dimensions: {}, collector_ref: item().collector_ref, params_default: {}, source_chain: chain(),
    };
    const results = await Promise.allSettled([
      repository.putItemVersion(base),
      repository.putItemVersion({ ...base, canonical_metric: { id: 'mysql.queries.total', semantic_version: '1.0.0' } }),
    ]);
    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(((rejected[0] as PromiseRejectedResult).reason as TemplateError).code)
      .toBe('TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE');
    expect((await repository.latestItemVersions('tpl-a')).map(entry => entry.version)).toEqual([1]);
  });

  it('publishes v1, treats identical content as a no-op and never rewrites a version', async () => {
    const repository = new InMemoryTemplateRepository();
    await repository.create(template(), draft());
    const published = await repository.publish(command());
    expect(published).toMatchObject({ noop: false, version: 1, revision: 1 });
    expect((await repository.getTemplate('tpl-a'))!.current_published_version).toBe(1);
    const noop = await repository.publish(command({ expectedTemplateRevision: 1, expectedDraftRevision: 1 }));
    expect(noop).toMatchObject({ noop: true, version: 1, revision: 1 });
    expect(await repository.listVersions('tpl-a')).toHaveLength(1);
    const changed = aggregate();
    changed.parameters = { schema: { interval_ms: { type: 'integer', min: 1000 } }, defaults: { interval_ms: 60000 } };
    const second = await repository.publish(command({
      expectedTemplateRevision: 1,
      expectedDraftRevision: 1,
      aggregate: changed,
      packageComposition: changed.package_composition,
      contentHash: templateContentHash(changed),
    }));
    expect(second).toMatchObject({ noop: false, version: 2, revision: 2 });
    const first = await repository.getVersion('tpl-a', 1);
    expect(first!.content_hash).toBe(templateContentHash(aggregate()));
    expect(first!.aggregate.parameters.defaults).toEqual({});
    expect((await repository.getDraft('tpl-a'))!.published_version).toBe(2);
  });

  it('leaves no trace when the publish guards fail', async () => {
    const repository = new InMemoryTemplateRepository();
    await repository.create(template(), draft());
    expect(await code(repository.publish(command({ expectedTemplateRevision: 3 })))).toBe('TEMPLATE_REVISION_CONFLICT');
    expect(await code(repository.publish(command({ expectedDraftRevision: 3 })))).toBe('TEMPLATE_DRAFT_CONFLICT');
    expect(await code(repository.publish(command({ templateId: 'tpl-missing' })))).toBe('TEMPLATE_NOT_FOUND');
    expect(await repository.listVersions('tpl-a')).toEqual([]);
    expect((await repository.getTemplate('tpl-a'))!.current_published_version).toBeNull();
    expect((await repository.getTemplate('tpl-a'))!.revision).toBe(0);
  });

  it('rejects a version snapshot that disagrees with the aggregate', async () => {
    const repository = new InMemoryTemplateRepository();
    await repository.create(template(), draft());
    await expect(repository.publish(command({ items: [] }))).rejects.toThrow(/TEMPLATE_ITEM_SNAPSHOT/);
    expect(await repository.listVersions('tpl-a')).toEqual([]);
  });

  it('returns detached copies from every read', async () => {
    const repository = new InMemoryTemplateRepository();
    await repository.create(template(), draft());
    await repository.putItemVersion({
      template_id: 'tpl-a', item_id: 'uptime', display_name: 'Uptime', canonical_metric: item().canonical_metric,
      unit: 's', dimensions: {}, collector_ref: item().collector_ref, params_default: {}, source_chain: chain(),
    });
    const read = (await repository.getItemVersion('tpl-a', 'uptime', 1))!;
    read.display_name = 'mutated';
    expect((await repository.getItemVersion('tpl-a', 'uptime', 1))!.display_name).toBe('Uptime');
    const draftRead = (await repository.getDraft('tpl-a'))!;
    draftRead.aggregate.items.push({ item_id: 'x', version: 1 });
    expect((await repository.getDraft('tpl-a'))!.aggregate.items).toEqual([]);
    await repository.publish(command());
    const version = (await repository.getVersion('tpl-a', 1))!;
    version.aggregate.items.push({ item_id: 'y', version: 1 });
    expect((await repository.getVersion('tpl-a', 1))!.aggregate.items).toEqual([{ item_id: 'uptime', version: 1 }]);
  });

  it('pages templates by ascending id without repeating or skipping rows', async () => {
    const repository = new InMemoryTemplateRepository();
    for (const id of ['tpl-c', 'tpl-a', 'tpl-b']) await repository.create(template(id), draft(id));
    const first = await repository.listTemplates({ limit: 2 });
    expect(first.items.map(entry => entry.template_id)).toEqual(['tpl-a', 'tpl-b']);
    expect(first.next_cursor).toBe('tpl-b');
    const second = await repository.listTemplates({ limit: 2, cursor: first.next_cursor! });
    expect(second.items.map(entry => entry.template_id)).toEqual(['tpl-c']);
    expect(second.next_cursor).toBeNull();
  });
});
