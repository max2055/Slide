/**
 * MAX-237 / T1 — template persistence port.
 *
 * The port is deliberately small and every mutating method is a *conditional*
 * write, because the guarantees the domain needs are transaction guarantees:
 *
 * | method        | production condition (draft DDL: MAX-236/08 §1.1)                       |
 * |---------------|--------------------------------------------------------------------------|
 * | `create`      | INSERT template + draft in one transaction; PK `template_id` rejects a re-used identity (`TEMPLATE_EXISTS`) |
 * | `updateDraft` | `UPDATE … WHERE template_id=? AND revision=?`; 0 affected rows ⇒ `TEMPLATE_DRAFT_CONFLICT` |
 * | `updateTemplate` | `UPDATE … WHERE template_id=? AND revision=?`; 0 rows ⇒ `TEMPLATE_REVISION_CONFLICT` |
 * | `putItemVersion` | append-only `MAX(version)+1` under `SELECT … FOR UPDATE`; the locked row must also stay compatible with the stable item identity (canonical metric, unit, dimension key set) or `TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE`; `UNIQUE(template_id,item_id,version)`; identical latest content returns the existing row instead of writing |
 * | `publish`     | one transaction: `SELECT template FOR UPDATE` → check `revision` → `SELECT version WHERE (template_id, content_hash)` (hit ⇒ idempotent no-op) → INSERT version with `UNIQUE(template_id,version)`+`UNIQUE(template_id,content_hash)` → `UPDATE template SET revision=revision+1, current_published_version=?` → `UPDATE draft SET revision=revision+1, published_version=?` |
 *
 * The in-memory implementation below is a **test double only**. Each method body
 * runs synchronously, so the read-check-write block is atomic inside one event
 * loop; that is NOT multi-process safety and it is not registered as a storage
 * adapter. There is no process lock anywhere in this module.
 */
import { TemplateError, requireTemplate } from './errors.js';
import {
  TemplateDraftSchema, TemplateItemVersionSchema, TemplateRecordSchema, TemplateVersionSchema, canonicalKey,
  type HashId, type MetricRef, type PackageCompositionEntry, type ParameterValue, type Revision,
  type SourceChain, type TemplateDraft, type TemplateDraftAggregate, type TemplateItemVersion,
  type TemplatePublishedAggregate, type TemplateRecord, type TemplateStatus, type TemplateVersion,
  type TemplateVersionSummary, type VersionNumber,
} from './model.js';
import { stable } from '../packages/model.js';

export interface TemplateSummary {
  template_id: string;
  name: string;
  status: TemplateStatus;
  current_published_version: VersionNumber | null;
  revision: Revision;
}

export interface TemplateListQuery {
  status?: TemplateStatus;
  cursor?: string;
  limit?: number;
}

export interface TemplateListPage {
  items: TemplateSummary[];
  next_cursor: string | null;
}

export interface TemplatePatch {
  name?: string;
  status?: TemplateStatus;
  /** Only ever a pointer move; the referenced version row is never rewritten. */
  current_published_version?: VersionNumber;
  updated_at: string;
}

export interface DraftUpdate {
  aggregate: TemplateDraftAggregate;
  updated_by: number | null;
  updated_at: string;
}

export interface ItemVersionInput {
  template_id: string;
  item_id: string;
  display_name: string;
  canonical_metric: MetricRef;
  unit: TemplateItemVersion['unit'];
  dimensions: TemplateItemVersion['dimensions'];
  collector_ref: TemplateItemVersion['collector_ref'];
  params_default: Record<string, ParameterValue>;
  source_chain: SourceChain;
}

export interface ItemVersionResult {
  item: TemplateItemVersion;
  /** `true` when identical content already existed and no new version was appended. */
  reused: boolean;
}

export interface PublishCommand {
  templateId: string;
  expectedTemplateRevision: Revision;
  expectedDraftRevision: Revision;
  contentHash: HashId;
  aggregate: TemplatePublishedAggregate;
  items: TemplateItemVersion[];
  packageComposition: PackageCompositionEntry[];
  sourceChain: SourceChain;
  publishedAt: string;
  draftUpdatedAt: string;
  actorId: number | null;
}

export interface PublishOutcome {
  noop: boolean;
  version: VersionNumber;
  content_hash: HashId;
  /** Template revision after the call; unchanged for an idempotent no-op. */
  revision: Revision;
}

export interface TemplateRepository {
  /** One transaction: template row, draft row and (for copy) the full item-version set. */
  create(template: TemplateRecord, draft: TemplateDraft, items?: ItemVersionInput[]): Promise<TemplateItemVersion[]>;
  getTemplate(templateId: string): Promise<TemplateRecord | null>;
  listTemplates(query: TemplateListQuery): Promise<TemplateListPage>;
  updateTemplate(templateId: string, expectedRevision: Revision, patch: TemplatePatch): Promise<TemplateRecord>;
  getDraft(templateId: string): Promise<TemplateDraft | null>;
  updateDraft(templateId: string, expectedRevision: Revision, next: DraftUpdate): Promise<TemplateDraft>;
  putItemVersion(input: ItemVersionInput): Promise<ItemVersionResult>;
  getItemVersion(templateId: string, itemId: string, version: VersionNumber): Promise<TemplateItemVersion | null>;
  latestItemVersions(templateId: string): Promise<TemplateItemVersion[]>;
  getVersion(templateId: string, version: VersionNumber): Promise<TemplateVersion | null>;
  listVersions(templateId: string): Promise<TemplateVersionSummary[]>;
  findVersionByContentHash(templateId: string, contentHash: HashId): Promise<TemplateVersion | null>;
  publish(command: PublishCommand): Promise<PublishOutcome>;
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Item content that participates in "is this the same item version?" — lineage
 * and version do not. Exported so a storage adapter reuses this exact rule
 * instead of defining a second identity comparison (MAX-237 T2A).
 */
export const itemContent = (item: Omit<ItemVersionInput, 'source_chain'>): string => stable({
  display_name: item.display_name,
  canonical_metric: item.canonical_metric,
  unit: item.unit,
  dimensions: item.dimensions,
  collector_ref: item.collector_ref,
  params_default: item.params_default,
});

/**
 * A stable item identity is `(template_id, item_id)`. Only compatible content may
 * append a new version under it: the canonical metric reference, the unit and the
 * dimension key set are the identity's semantics, and they are the same three
 * things publish re-checks against the canonical definition. A display rename, a
 * default-parameter change or a compatible implementation pin update keep it.
 */
const sameDimensionKeys = (left: Record<string, string>, right: Record<string, string>): boolean => {
  const a = Object.keys(left).sort(), b = Object.keys(right).sort();
  return a.length === b.length && a.every((key, index) => key === b[index]);
};

export const identityConflict = (latest: TemplateItemVersion, next: Omit<ItemVersionInput, 'source_chain'>): string | null => {
  const before = canonicalKey(latest.canonical_metric);
  const after = canonicalKey(next.canonical_metric);
  if (before !== after) return `canonical metric ${before} → ${after}`;
  if (latest.unit !== next.unit) return `unit ${latest.unit} → ${next.unit}`;
  if (!sameDimensionKeys(latest.dimensions, next.dimensions)) {
    const declared = Object.keys(latest.dimensions).sort().join(',');
    const incoming = Object.keys(next.dimensions).sort().join(',');
    return `dimensions [${declared}] → [${incoming}]`;
  }
  return null;
};

export class InMemoryTemplateRepository implements TemplateRepository {
  private readonly templates = new Map<string, TemplateRecord>();
  private readonly drafts = new Map<string, TemplateDraft>();
  private readonly items = new Map<string, Map<string, TemplateItemVersion[]>>();
  private readonly versions = new Map<string, TemplateVersion[]>();

  async create(template: TemplateRecord, draft: TemplateDraft, items: ItemVersionInput[] = []): Promise<TemplateItemVersion[]> {
    const record = TemplateRecordSchema.parse(template), next = TemplateDraftSchema.parse(draft);
    if (this.templates.has(record.template_id)) {
      throw new TemplateError('TEMPLATE_EXISTS', `template ${record.template_id} already exists`);
    }
    if (next.template_id !== record.template_id || next.revision !== 0 || record.revision !== 0) {
      throw new TemplateError('TEMPLATE_EXISTS', 'a new template starts at revision 0 with its own draft');
    }
    const perTemplate = new Map<string, TemplateItemVersion[]>();
    for (const input of items) {
      if (input.template_id !== record.template_id) {
        throw new TemplateError('TEMPLATE_ITEM_NOT_FOUND', 'copied item versions must belong to the new template');
      }
      const bucket = perTemplate.get(input.item_id) ?? [];
      if (bucket.length) throw new TemplateError('TEMPLATE_ITEM_DUPLICATE', `item ${input.item_id} appears twice in one copy`);
      const item = TemplateItemVersionSchema.parse({ ...input, version: 1 });
      perTemplate.set(input.item_id, [clone(item)]);
    }
    this.templates.set(record.template_id, clone(record));
    this.drafts.set(record.template_id, clone(next));
    this.items.set(record.template_id, perTemplate);
    this.versions.set(record.template_id, []);
    return this.latestItemVersions(record.template_id);
  }

  async getTemplate(templateId: string): Promise<TemplateRecord | null> {
    const record = this.templates.get(templateId);
    return record ? clone(record) : null;
  }

  async listTemplates(query: TemplateListQuery): Promise<TemplateListPage> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const rows = [...this.templates.values()]
      .filter(template => (query.status === undefined ? true : template.status === query.status))
      .filter(template => (query.cursor === undefined ? true : template.template_id > query.cursor))
      .sort((a, b) => (a.template_id < b.template_id ? -1 : 1))
      .map(template => ({
        template_id: template.template_id,
        name: template.name,
        status: template.status,
        current_published_version: template.current_published_version,
        revision: template.revision,
      }));
    const page = rows.slice(0, limit);
    return { items: page, next_cursor: rows.length > limit ? page[page.length - 1]!.template_id : null };
  }

  async updateTemplate(templateId: string, expectedRevision: Revision, patch: TemplatePatch): Promise<TemplateRecord> {
    const current = this.templates.get(templateId);
    requireTemplate(current, 'TEMPLATE_NOT_FOUND', `template ${templateId} does not exist`);
    if (current.revision !== expectedRevision) {
      throw new TemplateError('TEMPLATE_REVISION_CONFLICT',
        `template ${templateId} is at revision ${current.revision}, expected ${expectedRevision}`);
    }
    const next = TemplateRecordSchema.parse({
      ...current,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.current_published_version === undefined
        ? {} : { current_published_version: patch.current_published_version }),
      revision: current.revision + 1,
      updated_at: patch.updated_at,
    });
    this.templates.set(templateId, clone(next));
    return clone(next);
  }

  async getDraft(templateId: string): Promise<TemplateDraft | null> {
    const draft = this.drafts.get(templateId);
    return draft ? clone(draft) : null;
  }

  async updateDraft(templateId: string, expectedRevision: Revision, next: DraftUpdate): Promise<TemplateDraft> {
    const current = this.drafts.get(templateId);
    requireTemplate(current, 'TEMPLATE_NOT_FOUND', `draft for template ${templateId} does not exist`);
    if (current.revision !== expectedRevision) {
      throw new TemplateError('TEMPLATE_DRAFT_CONFLICT',
        `draft ${templateId} is at revision ${current.revision}, expected ${expectedRevision}`);
    }
    const updated = TemplateDraftSchema.parse({
      ...current,
      revision: current.revision + 1,
      aggregate: next.aggregate,
      updated_by: next.updated_by,
      updated_at: next.updated_at,
    });
    this.drafts.set(templateId, clone(updated));
    return clone(updated);
  }

  async putItemVersion(input: ItemVersionInput): Promise<ItemVersionResult> {
    const template = this.templates.get(input.template_id);
    requireTemplate(template, 'TEMPLATE_NOT_FOUND', `template ${input.template_id} does not exist`);
    const perTemplate = this.items.get(input.template_id) ?? new Map<string, TemplateItemVersion[]>();
    this.items.set(input.template_id, perTemplate);
    const perItem = perTemplate.get(input.item_id) ?? [];
    perTemplate.set(input.item_id, perItem);
    const latest = perItem[perItem.length - 1];
    // The compatibility check sits on the conditional append itself, so a racing
    // caller cannot bypass the service's read by interleaving between the two.
    if (latest) {
      const conflict = identityConflict(latest, input);
      if (conflict) {
        throw new TemplateError('TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE',
          `item ${input.item_id} is v${latest.version} with ${conflict}; a stable item identity cannot switch to incompatible semantics, use a new item_id`);
      }
      if (itemContent(latest) === itemContent(input)) {
        return { item: clone(latest), reused: true };
      }
    }
    const version = (latest?.version ?? 0) + 1;
    const item = TemplateItemVersionSchema.parse({ ...input, version });
    // Append-only: an existing (template_id, item_id, version) is never rewritten.
    perItem.push(clone(item));
    return { item: clone(item), reused: false };
  }

  async getItemVersion(templateId: string, itemId: string, version: VersionNumber): Promise<TemplateItemVersion | null> {
    const item = this.items.get(templateId)?.get(itemId)?.find(candidate => candidate.version === version);
    return item ? clone(item) : null;
  }

  async latestItemVersions(templateId: string): Promise<TemplateItemVersion[]> {
    const perTemplate = this.items.get(templateId);
    if (!perTemplate) return [];
    return [...perTemplate.keys()].sort().flatMap(itemId => {
      const versions = perTemplate.get(itemId)!;
      return versions.length ? [clone(versions[versions.length - 1]!)] : [];
    });
  }

  async getVersion(templateId: string, version: VersionNumber): Promise<TemplateVersion | null> {
    const found = this.versions.get(templateId)?.find(candidate => candidate.version === version);
    return found ? clone(found) : null;
  }

  async listVersions(templateId: string): Promise<TemplateVersionSummary[]> {
    return (this.versions.get(templateId) ?? []).map(version => ({
      version: version.version, content_hash: version.content_hash, status: version.status,
    }));
  }

  async findVersionByContentHash(templateId: string, contentHash: HashId): Promise<TemplateVersion | null> {
    const found = this.versions.get(templateId)?.find(candidate => candidate.content_hash === contentHash);
    return found ? clone(found) : null;
  }

  async publish(command: PublishCommand): Promise<PublishOutcome> {
    const template = this.templates.get(command.templateId);
    requireTemplate(template, 'TEMPLATE_NOT_FOUND', `template ${command.templateId} does not exist`);
    const draft = this.drafts.get(command.templateId);
    requireTemplate(draft, 'TEMPLATE_NOT_FOUND', `draft for template ${command.templateId} does not exist`);
    if (template.revision !== command.expectedTemplateRevision) {
      throw new TemplateError('TEMPLATE_REVISION_CONFLICT',
        `template ${command.templateId} is at revision ${template.revision}, expected ${command.expectedTemplateRevision}`);
    }
    if (draft.revision !== command.expectedDraftRevision) {
      throw new TemplateError('TEMPLATE_DRAFT_CONFLICT',
        `draft ${command.templateId} is at revision ${draft.revision}, expected ${command.expectedDraftRevision}`);
    }
    const versions = this.versions.get(command.templateId) ?? [];
    this.versions.set(command.templateId, versions);
    const existing = versions.find(candidate => candidate.content_hash === command.contentHash);
    if (existing) {
      // Identical content was already published: idempotent, pointer untouched.
      return { noop: true, version: existing.version, content_hash: existing.content_hash, revision: template.revision };
    }
    const version = (versions[versions.length - 1]?.version ?? 0) + 1;
    const record = TemplateVersionSchema.parse({
      template_id: command.templateId,
      version,
      status: 'published',
      content_hash: command.contentHash,
      aggregate: command.aggregate,
      items: command.items,
      package_composition: command.packageComposition,
      source_chain: command.sourceChain,
      published_at: command.publishedAt,
      retired_at: null,
    });
    versions.push(clone(record));
    this.templates.set(command.templateId, clone({
      ...template,
      current_published_version: version,
      revision: template.revision + 1,
      updated_at: command.publishedAt,
    }));
    this.drafts.set(command.templateId, clone({
      ...draft,
      revision: draft.revision + 1,
      published_version: version,
      updated_by: command.actorId,
      updated_at: command.draftUpdatedAt,
    }));
    return { noop: false, version, content_hash: command.contentHash, revision: template.revision + 1 };
  }
}
