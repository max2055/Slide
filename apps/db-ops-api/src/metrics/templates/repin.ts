/**
 * MAX-238 / COLLECTION-DISPLAY-E2E-R1 — version compatibility for a fixed pin.
 *
 * A converted template pins one exact release per item. When the live target's
 * version is outside that release's applicability, the right move is **not** to
 * rewrite the published version (it is immutable) and **not** to relax
 * applicability: it is a new immutable template version whose item pins an
 * already-installed release with the same metric, unit and raw-field semantics.
 *
 * This module performs exactly that migration through the accepted template
 * service (`selectMetric` → `updateDraft` → `publish` → `setCurrent`), so every
 * existing rejection (unit/dimension mismatch, mapping missing, duplicate metric)
 * still applies. It never edits a published version, never changes a release and
 * never invents a target version.
 */
import type { Resource } from '../../contracts/metrics/index.js';
import type { ActorContext } from '../../auth/actor-context.js';
import type { TemplateItemVersion, TemplateVersion } from './model.js';
import type { TemplatePin } from '../../contracts/metrics/templates.js';
import { MetricTemplateService } from './service.js';
import type { TemplateRepository } from './repository.js';
import type { PackageRegistry, PackageRelease } from '../packages/model.js';
import { checkApplicability } from '../packages/applicability.js';

export type RepinErrorCode =
  | 'REPIN_TEMPLATE_NOT_FOUND'
  | 'REPIN_VERSION_NOT_FOUND'
  | 'REPIN_NO_COMPATIBLE_RELEASE'
  | 'REPIN_SEMANTICS_MISMATCH'
  | 'REPIN_PUBLISH_FAILED';

export class RepinError extends Error {
  constructor(public readonly code: RepinErrorCode, public readonly item_id: string | null = null) {
    super(code);
    this.name = 'RepinError';
  }
}

export interface RepinChange {
  item_id: string;
  from: { version: number; release: string; implementation_id: string };
  to: { version: number; release: string; implementation_id: string };
  reason: 'target_version_incompatible';
}

export interface RepinResult {
  template_id: string;
  from_version: number;
  to_version: number;
  content_hash: string;
  changes: RepinChange[];
  version: TemplateVersion;
}

/** The service actor for a maintenance publish: id 0 is the accepted non-human value. */
export const maintenanceActor = (requestId: string): ActorContext => ({
  userId: 0, username: 'template-migration', roles: [], permissions: ['metric:view', 'metric:manage'],
  sessionVersion: 0, instanceScopes: {}, requestId,
});

const parseRelease = (ref: string): { id: string; version: string; digest: string } => {
  const at = ref.lastIndexOf('@'), hash = ref.lastIndexOf('#');
  return { id: ref.slice(0, at), version: ref.slice(at + 1, hash), digest: ref.slice(hash + 1) };
};

const metricKey = (metric: { id: string; semantic_version: string }) => `${metric.id}@${metric.semantic_version}`;

/** The upstream raw field and unit pair an item version was built from. */
function mappingOf(release: PackageRelease, item: TemplateItemVersion, sameImplementation = true): {
  raw_field: string; input_unit: string; output_unit: string; implementation_id: string;
} | null {
  for (const collector of release.package.collectors) {
    for (const mapping of collector.mappings) {
      if (metricKey(mapping.metric) === metricKey(item.canonical_metric)
        && (!sameImplementation || collector.implementation_ref === item.collector_ref.implementation_id)) {
        return { raw_field: mapping.raw_field, input_unit: mapping.input_unit,
          output_unit: mapping.output_unit, implementation_id: collector.implementation_ref };
      }
    }
  }
  return null;
}

/**
 * Choose the installed release for this item that (a) applies to the target,
 * (b) provides the same metric through the same raw field with the same input and
 * output units, and (c) has the highest version. Same package id first; a
 * different package is never substituted implicitly.
 */
export function chooseCompatibleRelease(
  registry: PackageRegistry, item: TemplateItemVersion, original: PackageRelease, resource: Resource, at: string,
): PackageRelease | null {
  const originalMapping = mappingOf(original, item);
  if (originalMapping === null) throw new RepinError('REPIN_SEMANTICS_MISMATCH', item.item_id);
  const candidates = registry.list()
    .filter(release => release.package.id === original.package.id
      && release.package.resource_type === original.package.resource_type)
    .filter(release => checkApplicability(release.package, resource, at).every(check => check.status === 'supported'))
    .filter(release => {
      const mapping = mappingOf(release, item, false);
      return mapping !== null && mapping.raw_field === originalMapping.raw_field
        && mapping.input_unit === originalMapping.input_unit
        && mapping.output_unit === originalMapping.output_unit;
    })
    .sort((left, right) => right.package.version.localeCompare(left.package.version, undefined, { numeric: true }));
  return candidates[0] ?? null;
}

/**
 * Publish one new template version whose incompatible items pin a compatible
 * installed release. No-op when every item already applies to the target.
 */
export async function repinTemplateVersion(options: {
  repository: TemplateRepository;
  registry: PackageRegistry;
  templateId: string;
  resource: Resource;
  at?: string;
  requestId?: string;
  /**
   * The caller of an HTTP request. The published version carries the real
   * operator in its audit; only an offline maintenance run without a caller is
   * attributed to the accepted non-human maintenance identity.
   */
  actor?: ActorContext;
}): Promise<RepinResult | { unchanged: true; template_id: string; version: number }> {
  const { repository, registry, templateId, resource } = options;
  const at = options.at ?? new Date().toISOString();
  const requestId = options.requestId ?? 'max238-template-repin';
  const service = new MetricTemplateService(repository, registry, { now: () => at });
  const actor = options.actor ?? maintenanceActor(requestId);

  const template = await repository.getTemplate(templateId);
  if (!template) throw new RepinError('REPIN_TEMPLATE_NOT_FOUND');
  const currentVersion = template.current_published_version
    ?? Math.max(0, ...(await repository.listVersions(templateId)).map(summary => summary.version));
  const version = currentVersion ? await repository.getVersion(templateId, currentVersion) : null;
  if (!version) throw new RepinError('REPIN_VERSION_NOT_FOUND');

  const changes: RepinChange[] = [];
  const items = [] as Array<{ item_id: string; version: number }>;
  for (const item of version.items) {
    const originalPin = parseRelease(item.collector_ref.package_release);
    const original = registry.get(originalPin);
    const applicable = checkApplicability(original.package, resource, at).every(check => check.status === 'supported');
    if (applicable) { items.push({ item_id: item.item_id, version: item.version }); continue; }

    const replacement = chooseCompatibleRelease(registry, item, original, resource, at);
    if (!replacement) throw new RepinError('REPIN_NO_COMPATIBLE_RELEASE', item.item_id);
    const selected = await service.selectMetric(actor, templateId, {
      item_id: item.item_id,
      display_name: item.display_name,
      package: { id: replacement.package.id, version: replacement.package.version, digest: replacement.package.digest },
      metric: item.canonical_metric,
    });
    items.push({ item_id: item.item_id, version: selected.item.version });
    changes.push({
      item_id: item.item_id,
      from: { version: item.version, release: item.collector_ref.package_release, implementation_id: item.collector_ref.implementation_id },
      to: { version: selected.item.version, release: selected.item.collector_ref.package_release,
        implementation_id: selected.item.collector_ref.implementation_id },
      reason: 'target_version_incompatible',
    });
  }
  if (changes.length === 0) return { unchanged: true, template_id: templateId, version: currentVersion };

  const draft = await repository.getDraft(templateId);
  if (!draft) throw new RepinError('REPIN_PUBLISH_FAILED');
  const aggregate = {
    ...draft.aggregate,
    items: items.sort((left, right) => left.item_id.localeCompare(right.item_id)),
  };
  const updated = await service.updateDraft(actor, templateId, { expected_draft_revision: draft.revision, aggregate });
  const current = await repository.getTemplate(templateId);
  if (!current) throw new RepinError('REPIN_PUBLISH_FAILED');
  const published = await service.publish(actor, templateId, {
    expected_draft_revision: updated.revision, expected_revision: current.revision,
  });
  const after = await repository.getTemplate(templateId);
  if (!after) throw new RepinError('REPIN_PUBLISH_FAILED');
  await service.setCurrent(actor, templateId, { version: published.version, expected_revision: after.revision });
  const publishedVersion = await repository.getVersion(templateId, published.version);
  if (!publishedVersion) throw new RepinError('REPIN_PUBLISH_FAILED');
  return {
    template_id: templateId, from_version: currentVersion, to_version: published.version,
    content_hash: published.content_hash, changes, version: publishedVersion,
  };
}

export const templatePinOf = (version: TemplateVersion): TemplatePin => ({
  template_id: version.template_id, version: version.version, content_hash: version.content_hash,
});
