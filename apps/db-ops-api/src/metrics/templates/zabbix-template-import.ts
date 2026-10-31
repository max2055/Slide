/**
 * MAX-237 / T3 — write converted official templates through the accepted
 * template repository port.
 *
 * Nothing here is mounted and nothing creates its own pool: the caller passes a
 * `TemplateRepository`. Identity is the upstream template uuid, so importing the
 * same document twice never creates a second template; identical content is an
 * idempotent no-op and changed content appends immutable versions.
 *
 * Migration lineage uses `actor_id: null` because the accepted schemas define
 * nullable actors for migrations with no human author. No user is impersonated.
 */
import type { PackageRegistry } from '../packages/model.js';
import { RegisteredCapabilityCatalog } from './catalog.js';
import type { ItemVersionInput, TemplateRepository } from './repository.js';
import {
  TemplateDraftAggregateSchema, type HashId, type PackageCompositionEntry, type SourceChain,
  type TemplateDraft, type TemplateDraftAggregate, type TemplateItemVersion, type TemplatePublishedAggregate,
  type TemplateRecord, type TemplateVersion, emptyDraftAggregate, templateContentHash,
} from './model.js';
import type { ConvertedTemplate } from './zabbix-official-templates.js';

export interface ImportOptions {
  now: string;
  request_id?: string;
  migration_ref?: string;
  /** Set after publish so an imported template is selectable; default true. */
  activate?: boolean;
}

export interface ImportResult {
  template_id: string;
  action: 'created' | 'versioned' | 'noop';
  version: number;
  content_hash: HashId;
  item_count: number;
  item_ids: string[];
  template: TemplateRecord;
  current: TemplateVersion;
  items: TemplateItemVersion[];
  /** Raw field → canonical metric trace resolved from the pinned releases. */
  mapping_trace: { item_id: string; metric: string; package_release: string; implementation_id: string; raw_field: string; unit: string }[];
}

const DEFAULT_REQUEST_ID = 'max237-t3-import';
const DEFAULT_MIGRATION_REF = 'zabbix-7.0.21@6542e21f';

const sourceChain = (options: Required<Pick<ImportOptions, 'now' | 'request_id' | 'migration_ref'>>, base: SourceChain['base']): SourceChain => ({
  actor_id: null,
  request_id: options.request_id,
  base,
  created_at: options.now,
  published_at: options.now,
  retired_at: null,
  migration_ref: options.migration_ref,
});

const compositionOf = (items: { item_id: string; package_release: string }[]): PackageCompositionEntry[] => {
  const byRelease = new Map<string, string[]>();
  for (const item of items) {
    const list = byRelease.get(item.package_release) ?? [];
    list.push(item.item_id);
    byRelease.set(item.package_release, list);
  }
  return [...byRelease.entries()]
    .map(([release, ids]) => ({ release, items: ids.sort() }))
    .sort((a, b) => (a.release < b.release ? -1 : 1));
};

const aggregateOf = (converted: ConvertedTemplate, versions: Map<string, number>): TemplateDraftAggregate =>
  TemplateDraftAggregateSchema.parse({
    ...emptyDraftAggregate(converted.template_id),
    items: converted.items.map(item => ({ item_id: item.item_id, version: versions.get(item.item_id) ?? 1 })),
    triggers: [],
    parameters: converted.parameters,
  });

/**
 * Resolve every converted item against the registry the caller supplies. The
 * converter already did this; repeating it here makes the importer refuse a
 * hand-edited report or a registry whose release changed between plan and write.
 */
function itemInputs(converted: ConvertedTemplate, registry: PackageRegistry, chain: SourceChain): ItemVersionInput[] {
  const catalog = new RegisteredCapabilityCatalog(registry);
  return converted.items.map(item => {
    const at = item.package_release.lastIndexOf('@');
    const hash = item.package_release.lastIndexOf('#');
    const pin = {
      id: item.package_release.slice(0, at),
      version: item.package_release.slice(at + 1, hash),
      digest: item.package_release.slice(hash + 1),
    };
    const candidate = catalog.autofill({ package: pin, metric: item.metric });
    if (candidate.package_release !== item.package_release
      || candidate.implementation_id !== item.implementation_id
      || candidate.unit !== item.unit) {
      throw new Error(`ZABBIX_IMPORT_MAPPING_DRIFT:${item.item_id}`);
    }
    return {
      template_id: converted.template_id,
      item_id: item.item_id,
      display_name: item.display_name,
      canonical_metric: candidate.metric,
      unit: candidate.unit,
      dimensions: Object.fromEntries(candidate.dimensions.map(dimension => [dimension.name, dimension.meaning])),
      collector_ref: { package_release: candidate.package_release, implementation_id: candidate.implementation_id },
      params_default: {},
      source_chain: chain,
    };
  });
}

export async function importConvertedTemplate(
  repository: TemplateRepository,
  registry: PackageRegistry,
  converted: ConvertedTemplate,
  options: ImportOptions,
): Promise<ImportResult> {
  if (converted.items.length === 0) throw new Error(`ZABBIX_IMPORT_EMPTY:${converted.template_id}`);
  const resolved: Required<Pick<ImportOptions, 'now' | 'request_id' | 'migration_ref'>> = {
    now: options.now,
    request_id: options.request_id ?? DEFAULT_REQUEST_ID,
    migration_ref: options.migration_ref ?? DEFAULT_MIGRATION_REF,
  };
  const chain = sourceChain(resolved, null);
  const inputs = itemInputs(converted, registry, chain);
  const templateId = converted.template_id;

  const existing = await repository.getTemplate(templateId);
  let action: ImportResult['action'];
  let version: number;
  let publishedHash: HashId;

  if (!existing) {
    const template: TemplateRecord = {
      template_id: templateId,
      name: converted.name,
      status: 'draft',
      current_published_version: null,
      revision: 0,
      created_by: null,
      created_at: resolved.now,
      updated_at: resolved.now,
    };
    const draft: TemplateDraft = {
      template_id: templateId,
      revision: 0,
      aggregate: aggregateOf(converted, new Map()),
      published_version: null,
      updated_by: null,
      updated_at: resolved.now,
    };
    const createdItems = await repository.create(template, draft, inputs);
    const aggregate: TemplatePublishedAggregate = {
      ...draft.aggregate,
      package_composition: compositionOf(createdItems.map(item => ({
        item_id: item.item_id, package_release: item.collector_ref.package_release,
      }))),
    };
    const hash = templateContentHash(aggregate);
    const outcome = await repository.publish({
      templateId,
      expectedTemplateRevision: 0,
      expectedDraftRevision: 0,
      contentHash: hash,
      aggregate,
      items: createdItems,
      packageComposition: aggregate.package_composition,
      sourceChain: chain,
      publishedAt: resolved.now,
      draftUpdatedAt: resolved.now,
      actorId: null,
    });
    action = 'created';
    version = outcome.version;
    publishedHash = outcome.content_hash;
  } else {
    const current = existing.current_published_version === null
      ? null : await repository.getVersion(templateId, existing.current_published_version);
    const draft = await repository.getDraft(templateId);
    if (!draft) throw new Error(`ZABBIX_IMPORT_DRAFT_MISSING:${templateId}`);

    // Append versions for every item first; identical content reuses the row.
    const appended: TemplateItemVersion[] = [];
    for (const input of inputs) {
      appended.push((await repository.putItemVersion(input)).item);
    }
    const versions = new Map(appended.map(item => [item.item_id, item.version]));
    const aggregateDraft = aggregateOf(converted, versions);
    const aggregate: TemplatePublishedAggregate = {
      ...aggregateDraft,
      package_composition: compositionOf(appended.map(item => ({
        item_id: item.item_id, package_release: item.collector_ref.package_release,
      }))),
    };
    const hash = templateContentHash(aggregate);
    if (current && current.content_hash === hash) {
      action = 'noop';
      version = current.version;
      publishedHash = current.content_hash;
    } else {
      const updatedDraft = await repository.updateDraft(templateId, draft.revision, {
        aggregate: aggregateDraft,
        updated_by: null,
        updated_at: resolved.now,
      });
      const outcome = await repository.publish({
        templateId,
        expectedTemplateRevision: existing.revision,
        expectedDraftRevision: updatedDraft.revision,
        contentHash: hash,
        aggregate,
        items: appended,
        packageComposition: aggregate.package_composition,
        sourceChain: sourceChain(resolved, current === null
          ? null : { kind: 'template', id: templateId, version: current.version }),
        publishedAt: resolved.now,
        draftUpdatedAt: resolved.now,
        actorId: null,
      });
      action = outcome.noop ? 'noop' : 'versioned';
      version = outcome.version;
      publishedHash = outcome.content_hash;
    }
  }

  // Publish leaves the lifecycle status untouched; an imported, published
  // template is marked active through the same CAS patch, never by rewriting a
  // version row.
  let template = (await repository.getTemplate(templateId))!;
  if ((options.activate ?? true) && template.status !== 'active') {
    template = await repository.updateTemplate(templateId, template.revision, {
      status: 'active',
      updated_at: resolved.now,
    });
  }
  const current = (await repository.getVersion(templateId, version))!;
  const items = await repository.latestItemVersions(templateId);
  return {
    template_id: templateId,
    action,
    version,
    content_hash: publishedHash,
    item_count: items.length,
    item_ids: items.map(item => item.item_id).sort(),
    template,
    current,
    items,
    mapping_trace: items.map(item => {
      const itemInput = inputs.find(entry => entry.item_id === item.item_id)!;
      return {
        item_id: item.item_id,
        metric: `${item.canonical_metric.id}@${item.canonical_metric.semantic_version}`,
        package_release: item.collector_ref.package_release,
        implementation_id: item.collector_ref.implementation_id,
        raw_field: converted.items.find(entry => entry.item_id === item.item_id)!.raw_field,
        unit: itemInput.unit,
      };
    }),
  };
}
