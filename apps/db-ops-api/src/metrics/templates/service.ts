/**
 * MAX-237 / T1 — internal template domain service (drafts, immutable versions,
 * registered-metric selection and the explicit mapping that joins them).
 *
 * Not mounted: no route, process registration, database adapter, collector,
 * scheduler, notification or model call references this module. Everything it
 * proves is proven by focused tests against the in-memory repository.
 *
 * Permissions are the existing ones — reads need `metric:view`, writes need
 * `metric:manage` — matched with the shared wildcard matcher in
 * `src/auth/require-permission.ts`. No permission code is added or widened.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ActorContext } from '../../auth/actor-context.js';
import { hasPermission } from '../../auth/require-permission.js';
import { MetricRefSchema, VersionSchema } from '../../contracts/metrics/index.js';
import type { PackageRegistry } from '../packages/model.js';
import { RegisteredCapabilityCatalog, type CapabilityCandidate, type PackagePin } from './catalog.js';
import { TemplateError, requireTemplate } from './errors.js';
import {
  HashIdSchema, ItemIdSchema, RevisionSchema, TemplateDraftAggregateSchema, TemplateIdSchema,
  TemplatePublishedAggregateSchema, VersionNumberSchema, canonicalKey, emptyDraftAggregate, parsePackageReleaseRef,
  templateContentHash,
  type HashId, type MetricRef, type PackageCompositionEntry, type ParameterValue, type Revision,
  type SourceChain, type TemplateDraft, type TemplateDraftAggregate, type TemplateItemVersion,
  type TemplatePublishedAggregate, type TemplateRecord, type TemplateStatus, type TemplateVersion,
  type TemplateVersionSummary, type VersionNumber,
} from './model.js';
import type { ItemVersionInput, TemplateListPage, TemplateRepository } from './repository.js';

const CreateTemplateRequestSchema = z.strictObject({ name: z.string() });
const RenameTemplateRequestSchema = z.strictObject({ name: z.string(), expected_revision: RevisionSchema });
const UpdateDraftRequestSchema = z.strictObject({
  expected_draft_revision: RevisionSchema,
  aggregate: TemplateDraftAggregateSchema,
});
const SelectMetricRequestSchema = z.strictObject({
  item_id: ItemIdSchema.optional(),
  display_name: z.string().optional(),
  package: z.strictObject({ id: z.string().min(1).max(256), version: VersionSchema, digest: HashIdSchema }),
  metric: MetricRefSchema,
});
const CopyTemplateRequestSchema = z.strictObject({ name: z.string() });
const PublishTemplateRequestSchema = z.strictObject({
  expected_draft_revision: RevisionSchema,
  expected_revision: RevisionSchema,
});
const SwitchCurrentRequestSchema = z.strictObject({
  version: VersionNumberSchema,
  expected_revision: RevisionSchema,
});
const ListQuerySchema = z.strictObject({
  status: z.enum(['draft', 'active', 'deprecated', 'archived']).optional(),
  cursor: TemplateIdSchema.optional(),
  limit: z.number().int().positive().max(100).optional(),
});

/** Existing platform cadence bounds (`SettingsSchema.interval_ms` in `metrics/packages/model.ts`). */
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 86_400_000;

export interface MappingTrace {
  item_id: string;
  item_version: VersionNumber;
  canonical_metric: MetricRef;
  package_release: string;
  implementation_id: string;
  collector_id: string;
  raw_field: string;
  input_unit: string;
  output_unit: string;
  transform_version: string;
  steps: string[];
  method: 'sql' | 'ssh' | 'snmp';
}

export interface TemplateDetail {
  template: TemplateRecord;
  current: TemplateVersion | null;
  versions: TemplateVersionSummary[];
  /** Latest version of every item that exists for this template. */
  items: TemplateItemVersion[];
}

export interface PublishResult {
  version: VersionNumber;
  content_hash: HashId;
  noop: boolean;
  template_revision: Revision;
  /** Raw field → metric trace actually resolved from the pinned releases. */
  mapping_trace: MappingTrace[];
  /** Capability placeholders carried by this version; none of them is executable here. */
  deferred_capabilities: string[];
}

export interface SelectMetricResult {
  item: TemplateItemVersion;
  reused: boolean;
  auto: CapabilityCandidate;
}

export interface TemplateServiceOptions {
  now?: () => string;
  newTemplateId?: () => string;
  newItemId?: () => string;
}

interface ResolvedItem {
  item: TemplateItemVersion;
  candidate: CapabilityCandidate;
}

export class MetricTemplateService {
  private readonly catalog: RegisteredCapabilityCatalog;
  private readonly now: () => string;
  private readonly newTemplateId: () => string;
  private readonly newItemId: () => string;

  constructor(
    private readonly repository: TemplateRepository,
    registry: PackageRegistry,
    options: TemplateServiceOptions = {},
  ) {
    this.catalog = new RegisteredCapabilityCatalog(registry);
    this.now = options.now ?? (() => new Date().toISOString());
    this.newTemplateId = options.newTemplateId ?? (() => `tpl-${randomUUID().replace(/-/g, '').slice(0, 16)}`);
    this.newItemId = options.newItemId ?? (() => `itm-${randomUUID().replace(/-/g, '').slice(0, 16)}`);
  }

  // ---------------------------------------------------------------- reads

  private assertPermission(actor: ActorContext, code: 'metric:view' | 'metric:manage'): void {
    if (!hasPermission(new Set(actor.permissions), code)) {
      throw new TemplateError('TEMPLATE_FORBIDDEN', `${code} is required`);
    }
  }

  /** Selectable metrics plus every registered metric that is not selectable and why. */
  capabilities(actor: ActorContext) {
    this.assertPermission(actor, 'metric:view');
    return { candidates: this.catalog.candidates(), unavailable: this.catalog.unavailable() };
  }

  explainMetric(actor: ActorContext, metric: MetricRef) {
    this.assertPermission(actor, 'metric:view');
    return this.catalog.explain(metric);
  }

  async list(actor: ActorContext, query: unknown = {}): Promise<TemplateListPage> {
    this.assertPermission(actor, 'metric:view');
    return this.repository.listTemplates(this.parse(ListQuerySchema, query));
  }

  async detail(actor: ActorContext, templateId: string): Promise<TemplateDetail> {
    this.assertPermission(actor, 'metric:view');
    const template = await this.requireTemplate(templateId);
    const current = template.current_published_version === null
      ? null : await this.repository.getVersion(templateId, template.current_published_version);
    return {
      template,
      current,
      versions: await this.repository.listVersions(templateId),
      items: await this.repository.latestItemVersions(templateId),
    };
  }

  // --------------------------------------------------------------- writes

  async create(actor: ActorContext, input: unknown): Promise<TemplateRecord> {
    this.assertPermission(actor, 'metric:manage');
    const request = this.parse(CreateTemplateRequestSchema, input);
    const name = this.requireName(request.name);
    const templateId = this.newTemplateId();
    const at = this.now();
    const template = {
      template_id: templateId,
      name,
      status: 'draft' as TemplateStatus,
      current_published_version: null,
      revision: 0,
      created_by: actor.userId,
      created_at: at,
      updated_at: at,
    };
    const draft = {
      template_id: templateId,
      revision: 0,
      aggregate: emptyDraftAggregate(templateId),
      published_version: null,
      updated_by: actor.userId,
      updated_at: at,
    };
    await this.repository.create(template, draft);
    return template;
  }

  /** Renaming never changes `template_id`, and the old versions keep their snapshots. */
  async rename(actor: ActorContext, templateId: string, input: unknown): Promise<TemplateRecord> {
    this.assertPermission(actor, 'metric:manage');
    const request = this.parse(RenameTemplateRequestSchema, input);
    const name = this.requireName(request.name);
    await this.requireTemplate(templateId);
    return this.repository.updateTemplate(templateId, request.expected_revision, { name, updated_at: this.now() });
  }

  async updateDraft(actor: ActorContext, templateId: string, input: unknown): Promise<TemplateDraft> {
    this.assertPermission(actor, 'metric:manage');
    const request = this.parse(UpdateDraftRequestSchema, input);
    await this.requireTemplate(templateId);
    if (request.aggregate.template_id !== templateId) {
      throw new TemplateError('TEMPLATE_DRAFT_IDENTITY',
        `draft aggregate names ${request.aggregate.template_id}, not ${templateId}`);
    }
    await this.assertItemReferences(templateId, request.aggregate);
    this.validateParameters(request.aggregate);
    return this.repository.updateDraft(templateId, request.expected_draft_revision, {
      aggregate: request.aggregate,
      updated_by: actor.userId,
      updated_at: this.now(),
    });
  }

  /**
   * Create (or bump) an item version from a registered capability. Identity rules:
   * `item_id` is stable across renames, `display_name` and defaults may change,
   * and every change appends a new immutable `(template_id, item_id, version)`.
   */
  async selectMetric(actor: ActorContext, templateId: string, input: unknown): Promise<SelectMetricResult> {
    this.assertPermission(actor, 'metric:manage');
    const request = this.parse(SelectMetricRequestSchema, input);
    await this.requireTemplate(templateId);
    const auto = this.catalog.autofill({ package: request.package as PackagePin, metric: request.metric });
    const itemId = request.item_id ?? this.newItemId();
    const displayName = this.requireName(request.display_name ?? auto.display_name_default);
    const previous = (await this.repository.latestItemVersions(templateId))
      .find(item => item.item_id === itemId);
    const at = this.now();
    const sourceChain: SourceChain = {
      actor_id: actor.userId,
      request_id: actor.requestId,
      base: previous === undefined
        ? null : { kind: 'item', template_id: templateId, id: itemId, version: previous.version },
      created_at: at,
      published_at: at,
      retired_at: null,
      migration_ref: null,
    };
    const { item, reused } = await this.repository.putItemVersion({
      template_id: templateId,
      item_id: itemId,
      display_name: displayName,
      canonical_metric: auto.metric,
      unit: auto.unit,
      dimensions: Object.fromEntries(auto.dimensions.map(dimension => [dimension.name, dimension.meaning])),
      collector_ref: { package_release: auto.package_release, implementation_id: auto.implementation_id },
      params_default: {},
      source_chain: sourceChain,
    });
    return { item, reused, auto };
  }

  /**
   * Copy the current published content (or the draft when nothing is published)
   * into a NEW template identity. Versions published by the source are not
   * copied, so the copy cannot silently continue the source's history.
   */
  async copy(actor: ActorContext, templateId: string, input: unknown): Promise<TemplateRecord> {
    this.assertPermission(actor, 'metric:manage');
    const request = this.parse(CopyTemplateRequestSchema, input);
    const name = this.requireName(request.name);
    const source = await this.requireTemplate(templateId);
    const sourceVersion = source.current_published_version === null
      ? null : await this.repository.getVersion(templateId, source.current_published_version);
    const sourceAggregate: TemplateDraftAggregate | TemplatePublishedAggregate = sourceVersion
      ? sourceVersion.aggregate
      : (await this.requireDraft(templateId)).aggregate;
    const newId = this.newTemplateId();
    const at = this.now();
    const copiedItems: ItemVersionInput[] = [];
    for (const ref of sourceAggregate.items) {
      const item = await this.repository.getItemVersion(templateId, ref.item_id, ref.version);
      requireTemplate(item, 'TEMPLATE_ITEM_NOT_FOUND',
        `item ${ref.item_id}@${ref.version} is referenced by ${templateId} but does not exist`);
      copiedItems.push({
        template_id: newId,
        item_id: item.item_id,
        display_name: item.display_name,
        canonical_metric: item.canonical_metric,
        unit: item.unit,
        dimensions: item.dimensions,
        collector_ref: item.collector_ref,
        params_default: item.params_default,
        source_chain: {
          actor_id: actor.userId,
          request_id: actor.requestId,
          base: { kind: 'item' as const, template_id: templateId, id: item.item_id, version: item.version },
          created_at: at,
          published_at: at,
          retired_at: null,
          migration_ref: null,
        },
      });
    }
    const copiedAggregate = structuredClone(sourceAggregate) as Record<string, unknown>;
    // A copy starts as its own draft: composition is re-derived at publish, and the
    // unresolved inheritance pointer is dropped because D1 has no merge rule for it.
    delete copiedAggregate.package_composition;
    copiedAggregate.template_id = newId;
    copiedAggregate.base = null;
    // Every copied item starts at version 1 under the new template, so the draft
    // must reference the new numbering instead of the source's version numbers.
    copiedAggregate.items = sourceAggregate.items.map(ref => ({ item_id: ref.item_id, version: 1 }));
    const template = {
      template_id: newId,
      name,
      status: 'draft' as TemplateStatus,
      current_published_version: null,
      revision: 0,
      created_by: actor.userId,
      created_at: at,
      updated_at: at,
    };
    const draft = {
      template_id: newId,
      revision: 0,
      aggregate: copiedAggregate as unknown as TemplateDraftAggregate,
      published_version: null,
      updated_by: actor.userId,
      updated_at: at,
    };
    await this.repository.create(template, draft, copiedItems);
    return template;
  }

  /**
   * Publish the draft as an immutable version. Rejections are decided here, before
   * any write: empty name, unresolvable base, empty template, illegal cadence,
   * duplicate items/metrics, missing implementation or mapping, unit/dimension
   * mismatch, deprecated or non-collectable candidates.
   */
  async publish(actor: ActorContext, templateId: string, input: unknown): Promise<PublishResult> {
    this.assertPermission(actor, 'metric:manage');
    const request = this.parse(PublishTemplateRequestSchema, input);
    const template = await this.requireTemplate(templateId);
    const draft = await this.requireDraft(templateId);
    this.requireName(template.name);
    if (draft.revision !== request.expected_draft_revision) {
      throw new TemplateError('TEMPLATE_DRAFT_CONFLICT',
        `draft ${templateId} is at revision ${draft.revision}, expected ${request.expected_draft_revision}`);
    }
    if (template.revision !== request.expected_revision) {
      throw new TemplateError('TEMPLATE_REVISION_CONFLICT',
        `template ${templateId} is at revision ${template.revision}, expected ${request.expected_revision}`);
    }
    const aggregate = this.parse(TemplateDraftAggregateSchema, draft.aggregate);
    if (aggregate.base !== null) {
      throw new TemplateError('TEMPLATE_BASE_INHERITANCE_UNAVAILABLE',
        `template ${templateId} declares base ${aggregate.base.template_id}@${aggregate.base.version}; D1 has no frozen rule for merging base content, so this cannot be published`);
    }
    if (aggregate.items.length === 0 && aggregate.triggers.length === 0) {
      throw new TemplateError('TEMPLATE_EMPTY', `template ${templateId} has no items or triggers; an empty template is not publishable`);
    }
    this.validateParameters(aggregate);

    const resolved = await this.resolveItems(templateId, aggregate);
    const metrics = new Set<string>();
    for (const { item } of resolved) {
      const key = canonicalKey(item.canonical_metric);
      if (metrics.has(key)) {
        throw new TemplateError('TEMPLATE_METRIC_DUPLICATE', `${key} is selected by more than one item`);
      }
      metrics.add(key);
    }
    const packageComposition = this.compositionOf(resolved);
    const published: TemplatePublishedAggregate = TemplatePublishedAggregateSchema.parse({
      ...aggregate,
      package_composition: packageComposition,
    });
    const contentHash = templateContentHash(published);
    const at = this.now();
    const sourceChain: SourceChain = {
      actor_id: actor.userId,
      request_id: actor.requestId,
      base: template.current_published_version === null
        ? null : { kind: 'template', id: templateId, version: template.current_published_version },
      created_at: at,
      published_at: at,
      retired_at: null,
      migration_ref: null,
    };
    const outcome = await this.repository.publish({
      templateId,
      expectedTemplateRevision: request.expected_revision,
      expectedDraftRevision: request.expected_draft_revision,
      contentHash,
      aggregate: published,
      items: resolved.map(entry => entry.item),
      packageComposition,
      sourceChain,
      publishedAt: at,
      draftUpdatedAt: at,
      actorId: actor.userId,
    });
    return {
      version: outcome.version,
      content_hash: outcome.content_hash,
      noop: outcome.noop,
      template_revision: outcome.revision,
      mapping_trace: resolved.map(entry => this.traceOf(entry)),
      deferred_capabilities: ['discovery', 'graphs'],
    };
  }

  /** Move the `current` pointer without rewriting any version row. */
  async setCurrent(actor: ActorContext, templateId: string, input: unknown): Promise<TemplateRecord> {
    this.assertPermission(actor, 'metric:manage');
    const request = this.parse(SwitchCurrentRequestSchema, input);
    await this.requireTemplate(templateId);
    const version = await this.repository.getVersion(templateId, request.version);
    if (!version) {
      throw new TemplateError('TEMPLATE_NOT_FOUND', `template ${templateId} has no version ${request.version}`);
    }
    if (version.status !== 'published') {
      throw new TemplateError('TEMPLATE_VERSION_IMMUTABLE', `version ${request.version} is ${version.status} and cannot become current`);
    }
    return this.repository.updateTemplate(templateId, request.expected_revision, {
      current_published_version: request.version,
      updated_at: this.now(),
    });
  }

  // ------------------------------------------------------------ internals

  /** Shape failures become the same typed error surface as domain rejections. */
  private parse<T>(schema: z.ZodType<T>, input: unknown): T {
    try {
      return schema.parse(input);
    } catch (error) {
      const detail = error instanceof z.ZodError
        ? error.issues.map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
        : String(error);
      throw new TemplateError('TEMPLATE_INVALID_INPUT', detail);
    }
  }

  private requireName(value: string): string {
    const name = value.trim();
    if (!name) throw new TemplateError('TEMPLATE_NAME_EMPTY', 'template and item names must not be blank');
    return name;
  }

  private async requireTemplate(templateId: string): Promise<TemplateRecord> {
    const template = await this.repository.getTemplate(templateId);
    if (!template) throw new TemplateError('TEMPLATE_NOT_FOUND', `template ${templateId} does not exist`);
    return template;
  }

  private async requireDraft(templateId: string): Promise<TemplateDraft> {
    const draft = await this.repository.getDraft(templateId);
    if (!draft) throw new TemplateError('TEMPLATE_NOT_FOUND', `draft for ${templateId} does not exist`);
    return draft;
  }

  private async assertItemReferences(templateId: string, aggregate: TemplateDraftAggregate): Promise<void> {
    for (const ref of aggregate.items) {
      const item = await this.repository.getItemVersion(templateId, ref.item_id, ref.version);
      if (!item) {
        throw new TemplateError('TEMPLATE_ITEM_NOT_FOUND',
          `item ${ref.item_id}@${ref.version} does not exist in template ${templateId}`);
      }
    }
  }

  /** Re-resolve every item against the pinned registry release; nothing is trusted from the draft. */
  private async resolveItems(templateId: string, aggregate: TemplateDraftAggregate): Promise<ResolvedItem[]> {
    const resolved: ResolvedItem[] = [];
    for (const ref of aggregate.items) {
      const item = await this.repository.getItemVersion(templateId, ref.item_id, ref.version);
      if (!item) {
        throw new TemplateError('TEMPLATE_ITEM_NOT_FOUND',
          `item ${ref.item_id}@${ref.version} does not exist in template ${templateId}`);
      }
      const pin = parsePackageReleaseRef(item.collector_ref.package_release) as PackagePin;
      const candidate = this.catalog.autofill({ package: pin, metric: item.canonical_metric });
      if (candidate.implementation_id !== item.collector_ref.implementation_id) {
        throw new TemplateError('TEMPLATE_MAPPING_MISSING',
          `item ${item.item_id} pins implementation ${item.collector_ref.implementation_id}, but ${candidate.package_release} maps ${canonicalKey(item.canonical_metric)} through ${candidate.implementation_id}`);
      }
      if (item.unit !== candidate.unit) {
        throw new TemplateError('TEMPLATE_UNIT_MISMATCH',
          `item ${item.item_id} declares unit ${item.unit}, ${canonicalKey(item.canonical_metric)} is ${candidate.unit}`);
      }
      const declared = Object.keys(item.dimensions).sort().join(',');
      const expected = candidate.dimensions.map(dimension => dimension.name).sort().join(',');
      if (declared !== expected) {
        throw new TemplateError('TEMPLATE_DIMENSIONS_MISMATCH',
          `item ${item.item_id} declares dimensions [${declared}], ${canonicalKey(item.canonical_metric)} has [${expected}]`);
      }
      this.validateItemParameters(item, aggregate);
      resolved.push({ item, candidate });
    }
    return resolved;
  }

  /** Every item belongs to exactly one release; entries are ascending by release. */
  private compositionOf(resolved: ResolvedItem[]): PackageCompositionEntry[] {
    const byRelease = new Map<string, string[]>();
    for (const { item } of resolved) {
      const items = byRelease.get(item.collector_ref.package_release) ?? [];
      items.push(item.item_id);
      byRelease.set(item.collector_ref.package_release, items);
    }
    return [...byRelease.entries()]
      .map(([release, items]) => ({ release, items: items.sort() }))
      .sort((a, b) => (a.release < b.release ? -1 : 1));
  }

  private traceOf({ item, candidate }: ResolvedItem): MappingTrace {
    return {
      item_id: item.item_id,
      item_version: item.version,
      canonical_metric: item.canonical_metric,
      package_release: candidate.package_release,
      implementation_id: candidate.implementation_id,
      collector_id: candidate.collector_id,
      raw_field: candidate.raw_field,
      input_unit: candidate.input_unit,
      output_unit: candidate.output_unit,
      transform_version: candidate.transform_version,
      steps: candidate.steps,
      method: candidate.method,
    };
  }

  private validateParameters(aggregate: TemplateDraftAggregate): void {
    const { schema, defaults } = aggregate.parameters;
    const period = schema.interval_ms;
    if (period) {
      if (period.type !== 'integer') {
        throw new TemplateError('TEMPLATE_INVALID_PERIOD', 'interval_ms must be declared as an integer parameter');
      }
      if ((period.min !== undefined && period.min < MIN_INTERVAL_MS)
        || (period.max !== undefined && period.max > MAX_INTERVAL_MS)) {
        throw new TemplateError('TEMPLATE_INVALID_PERIOD',
          `interval_ms bounds must stay within [${MIN_INTERVAL_MS}, ${MAX_INTERVAL_MS}]`);
      }
    }
    for (const [name, value] of Object.entries(defaults)) this.checkParameterValue(name, schema[name]!, value);
  }

  private checkParameterValue(name: string, spec: { type: 'number' | 'integer' | 'boolean' | 'string'; min?: number; max?: number }, value: ParameterValue): void {
    const invalid = (detail: string): never => {
      throw new TemplateError(name === 'interval_ms' ? 'TEMPLATE_INVALID_PERIOD' : 'TEMPLATE_PARAMETER_INVALID',
        `${name}: ${detail}`);
    };
    // The declared type selects the branch, so a number can never satisfy a
    // boolean/string parameter (and a boolean/string never satisfies a numeric one).
    if (spec.type === 'boolean' || spec.type === 'string') {
      if (typeof value !== spec.type) invalid(`expected ${spec.type}`);
      return;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid(`expected ${spec.type}`);
      if (spec.type === 'integer' && !Number.isInteger(value)) invalid('expected an integer');
      if (spec.min !== undefined && value < spec.min) invalid(`below minimum ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) invalid(`above maximum ${spec.max}`);
      if (name === 'interval_ms' && (value < MIN_INTERVAL_MS || value > MAX_INTERVAL_MS)) {
        invalid(`must stay within [${MIN_INTERVAL_MS}, ${MAX_INTERVAL_MS}]`);
      }
      return;
    }
    invalid(`expected ${spec.type}`);
  }

  /** Per-item defaults must be declared template parameters, and cadence stays template-level. */
  private validateItemParameters(item: TemplateItemVersion, aggregate: TemplateDraftAggregate): void {
    for (const [name, value] of Object.entries(item.params_default)) {
      if (name === 'interval_ms') {
        throw new TemplateError('TEMPLATE_ITEM_CADENCE',
          `item ${item.item_id} sets its own interval_ms; the existing plan compiler uses one cadence per resource`);
      }
      const spec = aggregate.parameters.schema[name];
      if (!spec) {
        throw new TemplateError('TEMPLATE_PARAMETER_UNDECLARED',
          `item ${item.item_id} sets parameter ${name}, which the template does not declare`);
      }
      this.checkParameterValue(name, spec, value);
    }
  }
}
