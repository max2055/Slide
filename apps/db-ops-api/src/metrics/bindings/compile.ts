/**
 * MAX-238 / B2A — registered-release verification and internal collector
 * candidate compilation on top of the accepted B1 preflight.
 *
 * This is still an **unmounted internal** step: it proves that every selected
 * template item names a collector that the *installed* package registry actually
 * provides for that canonical metric with a matching unit and satisfiable
 * dimensions. It does not resolve parameters or triggers, authorize a resource,
 * compare revisions, produce test digests, apply anything or perform collection
 * I/O (see `docs/slide/development/MAX-238/b2a-release-compile.md`).
 *
 * The entry is `compileBindingCandidate(input, port, registry)`: it always goes
 * through `preflightResourceBinding`, so a hand-built preflight result cannot skip
 * B1's pin/identity/hash/overlap checks.
 */
import {
  validateDimensions, type CollectorDefinition, type MetricDefinition,
} from '../../contracts/metrics/index.js';
import type {
  ResourceBindingCandidate, SourceChain, TemplateItemVersion, TemplateParameters,
  TemplatePin, TemplateVersion, VersionNumber,
} from '../../contracts/metrics/templates.js';
import type { PackageRelease, PackageRegistry } from '../packages/model.js';
import {
  canonicalKey, packageReleaseRef, parsePackageReleaseRef, type MetricRef, type PackageReleaseRef,
} from '../templates/model.js';
import {
  preflightResourceBinding, type BindingPreflightLegacy, type TemplateVersionReadPort,
} from './preflight.js';

/**
 * Stable internal machine codes. Registry/driver messages are never propagated;
 * a failed lookup is collapsed into `CANDIDATE_RELEASE_UNAVAILABLE` so the raw
 * `PACKAGE_PIN` text (or anything a fake registry throws) cannot leak.
 */
export type BindingCandidateErrorCode =
  | 'CANDIDATE_RELEASE_UNAVAILABLE'
  | 'CANDIDATE_TEMPLATE_NOT_EXECUTABLE'
  | 'CANDIDATE_IMPLEMENTATION_UNAVAILABLE'
  | 'CANDIDATE_METRIC_UNAVAILABLE'
  | 'CANDIDATE_METRIC_UNDEFINED'
  | 'CANDIDATE_DERIVED_UNREPRESENTABLE'
  | 'CANDIDATE_UNIT_MISMATCH'
  | 'CANDIDATE_DIMENSION_INVALID';

/**
 * Where a candidate rejection happened. Identity is these structured fields,
 * never the error message: a caller can point at the pin and item even when two
 * failures share a code.
 */
export interface BindingCandidateLocation {
  pin: TemplatePin;
  item: { item_id: string; version: VersionNumber } | null;
  release: PackageReleaseRef | null;
}

export class BindingCandidateError extends Error {
  constructor(
    public readonly code: BindingCandidateErrorCode,
    public readonly location: BindingCandidateLocation,
  ) {
    super(code);
    this.name = 'BindingCandidateError';
  }
}

type Mapping = CollectorDefinition['mappings'][number];

/** The registry-validated mapping for one selected item, copied out of the release. */
export interface BindingCandidateMapping {
  metric: MetricRef;
  raw_field: string;
  input_unit: Mapping['input_unit'];
  output_unit: Mapping['output_unit'];
  transform_version: string;
  steps: Mapping['steps'];
}

/** One selected item with everything needed to locate it later. */
export interface BindingCandidateItem {
  pin: TemplatePin;
  template_id: string;
  item_id: string;
  item_version: VersionNumber;
  canonical_metric: MetricRef;
  unit: TemplateItemVersion['unit'];
  dimensions: TemplateItemVersion['dimensions'];
  release: PackageReleaseRef;
  release_ref: string;
  collector_id: string;
  implementation_id: string;
  method: CollectorDefinition['method'];
  mapping: BindingCandidateMapping;
}

/**
 * One candidate collection request. Grouping is only within the same exact
 * release, collector, implementation and method; a collector or implementation
 * id that reappears in another release stays a separate group and its items are
 * never moved between releases.
 */
export interface BindingCandidateCollector {
  release: PackageReleaseRef;
  release_ref: string;
  collector_id: string;
  implementation_id: string;
  method: CollectorDefinition['method'];
  /** Only the mappings selected by items, never every metric of the release. */
  mappings: BindingCandidateMapping[];
  items: BindingCandidateItem[];
}

/**
 * Per-pin inputs a later resolver still owns. `parameters` is the template
 * schema/defaults, `trigger_refs` are unresolved references and `source_chain`
 * is provenance — none of them is an effective setting, trigger or test value.
 */
export interface BindingCandidatePinSource {
  pin: TemplatePin;
  unresolved: {
    parameters: TemplateParameters;
    trigger_refs: TemplateVersion['aggregate']['triggers'];
    source_chain: SourceChain;
  };
}

/** Template pins verified against installed releases; still not a production plan. */
export interface BindingTemplateCandidate {
  kind: 'template_candidate';
  /** No resolve, authorization, revision CAS, test digest or application happened. */
  compiled: false;
  binding: ResourceBindingCandidate;
  pins: BindingCandidatePinSource[];
  collectors: BindingCandidateCollector[];
}

/** The explicit single-package compatibility branch, passed through from B1 unchanged. */
export type BindingCandidateOutcome = BindingPreflightLegacy | BindingTemplateCandidate;

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const copyPin = (pin: TemplatePin): TemplatePin => ({
  template_id: pin.template_id, version: pin.version, content_hash: pin.content_hash,
});
const copyRelease = (release: PackageReleaseRef): PackageReleaseRef => ({
  id: release.id, version: release.version, digest: release.digest,
});

const pinLocator = (pin: TemplatePin) => ({
  pin: copyPin(pin),
  item: null,
  release: null,
});

const itemLocator = (pin: TemplatePin, item: TemplateItemVersion, release: PackageReleaseRef) => ({
  pin: copyPin(pin),
  item: { item_id: item.item_id, version: item.version },
  release: copyRelease(release),
});

const copyMapping = (mapping: Mapping): BindingCandidateMapping => ({
  metric: { ...mapping.metric },
  raw_field: mapping.raw_field,
  input_unit: mapping.input_unit,
  output_unit: mapping.output_unit,
  transform_version: mapping.transform_version,
  steps: [...mapping.steps],
});

const groupKey = (releaseRef: string, collector: CollectorDefinition): string =>
  `${releaseRef}\u0000${collector.id}\u0000${collector.implementation_ref}\u0000${collector.method}`;

const compareMapping = (left: BindingCandidateMapping, right: BindingCandidateMapping): number =>
  compare(left.metric.id, right.metric.id)
  || compare(left.metric.semantic_version, right.metric.semantic_version)
  || compare(left.raw_field, right.raw_field);

const compareItem = (left: BindingCandidateItem, right: BindingCandidateItem): number =>
  compare(left.template_id, right.template_id)
  || compare(left.item_id, right.item_id)
  || left.item_version - right.item_version;

interface VerifiedRelease {
  release: PackageRelease;
  definitions: MetricDefinition[];
}

/**
 * Resolve one exact `(id, version, digest)` through the installed registry.
 * `registry.get` was already the digest/implementation/dependency authority at
 * install time, so this reuses it instead of building a second allow-list. No
 * fallback to `current`, another version or a compatible package exists here.
 */
function readRelease(
  registry: PackageRegistry,
  release: PackageReleaseRef,
  position: BindingCandidateLocation,
  cache: Map<string, VerifiedRelease>,
): VerifiedRelease {
  const ref = packageReleaseRef(release);
  const cached = cache.get(ref);
  if (cached !== undefined) return cached;
  try {
    const verified = {
      release: registry.get({ id: release.id, version: release.version, digest: release.digest }),
      definitions: registry.catalog({ id: release.id, version: release.version, digest: release.digest }),
    };
    cache.set(ref, verified);
    return verified;
  } catch {
    // Never expose the registry/driver message; the locator carries the pin/item/release.
    throw new BindingCandidateError('CANDIDATE_RELEASE_UNAVAILABLE', position);
  }
}

interface Provider {
  collector: CollectorDefinition;
  mapping: Mapping;
}

interface ProviderLookup {
  /** Whether this exact release has a collector for the item's implementation id. */
  implementation: boolean;
  provider: Provider | null;
}

/**
 * A provider is a collector of *this exact release* whose `implementation_ref`
 * is the item's `implementation_id` and whose validated mapping names the
 * canonical metric. A same-named implementation elsewhere, another collector of
 * the same package, or a global metric lookup is not a provider.
 */
function lookupProvider(release: PackageRelease, item: TemplateItemVersion): ProviderLookup {
  const sameImplementation = release.package.collectors.filter(
    collector => collector.implementation_ref === item.collector_ref.implementation_id,
  );
  for (const collector of sameImplementation) {
    const mapping = collector.mappings.find(entry => canonicalKey(entry.metric) === canonicalKey(item.canonical_metric));
    if (mapping !== undefined) return { implementation: true, provider: { collector, mapping } };
  }
  return { implementation: sameImplementation.length > 0, provider: null };
}

const isDerived = (release: PackageRelease, item: TemplateItemVersion): boolean =>
  release.derived.some(entry => canonicalKey(entry.output) === canonicalKey(item.canonical_metric));

const sortPins = (pins: BindingCandidatePinSource[]): BindingCandidatePinSource[] =>
  pins.sort((left, right) => compare(left.pin.template_id, right.pin.template_id)
    || left.pin.version - right.pin.version);

const sortCollectors = (collectors: BindingCandidateCollector[]): BindingCandidateCollector[] =>
  collectors.sort((left, right) => compare(left.release_ref, right.release_ref)
    || compare(left.collector_id, right.collector_id)
    || compare(left.implementation_id, right.implementation_id)
    || compare(left.method, right.method));

/**
 * Compile an internal collector candidate from an existing `payload.binding`
 * snapshot. Contract and behavior:
 *
 * - Every path goes through {@link preflightResourceBinding}; B1 rejections
 *   (including canonical overlap and an empty binding) are preserved verbatim.
 * - The legacy branch is the B1 outcome untouched: no registry call, no claim
 *   that a multi-release candidate was produced.
 * - A pin with no items is not an executable candidate and is rejected.
 * - Every item is checked against its exact release only; any failure rejects the
 *   whole call, so no partial candidate is ever returned.
 * - `params_default` is never read: it cannot grant credentials, SQL, extra
 *   implementations or support.
 */
export async function compileBindingCandidate(
  input: unknown,
  port: TemplateVersionReadPort,
  registry: PackageRegistry,
): Promise<BindingCandidateOutcome> {
  const preflight = await preflightResourceBinding(input, port);
  if (preflight.kind === 'legacy') return preflight;

  const cache = new Map<string, VerifiedRelease>();
  const pins: BindingCandidatePinSource[] = [];
  const groups = new Map<string, BindingCandidateCollector>();

  for (const resolved of preflight.pins) {
    if (resolved.items.length === 0) {
      throw new BindingCandidateError('CANDIDATE_TEMPLATE_NOT_EXECUTABLE', pinLocator(resolved.pin));
    }
    pins.push({
      pin: copyPin(resolved.pin),
      unresolved: {
        parameters: resolved.parameters,
        trigger_refs: resolved.triggers,
        source_chain: resolved.source_chain,
      },
    });

    for (const item of [...resolved.items].sort((left, right) =>
      compare(left.item_id, right.item_id) || left.version - right.version)) {
      const release = parsePackageReleaseRef(item.collector_ref.package_release);
      const location = itemLocator(resolved.pin, item, release);
      const verified = readRelease(registry, release, location, cache);

      const lookup = lookupProvider(verified.release, item);
      if (!lookup.implementation) {
        throw new BindingCandidateError('CANDIDATE_IMPLEMENTATION_UNAVAILABLE', location);
      }
      if (lookup.provider === null) {
        // The template item shape has no derived reference; a derived-only metric
        // cannot be expressed without inventing a public field (minimal gap).
        throw new BindingCandidateError(
          isDerived(verified.release, item) ? 'CANDIDATE_DERIVED_UNREPRESENTABLE' : 'CANDIDATE_METRIC_UNAVAILABLE',
          location,
        );
      }

      const definition = verified.definitions.find(
        entry => canonicalKey(entry) === canonicalKey(item.canonical_metric),
      );
      if (definition === undefined) {
        throw new BindingCandidateError('CANDIDATE_METRIC_UNDEFINED', location);
      }
      if (item.unit !== definition.unit) {
        throw new BindingCandidateError('CANDIDATE_UNIT_MISMATCH', location);
      }
      try {
        // Existing contract rule: no unknown key, every required key present, allowed values and length.
        validateDimensions(item.dimensions, definition);
      } catch {
        throw new BindingCandidateError('CANDIDATE_DIMENSION_INVALID', location);
      }

      const { collector, mapping } = lookup.provider;
      const releaseRef = packageReleaseRef(release);
      const key = groupKey(releaseRef, collector);
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          release: copyRelease(release),
          release_ref: releaseRef,
          collector_id: collector.id,
          implementation_id: collector.implementation_ref,
          method: collector.method,
          mappings: [],
          items: [],
        };
        groups.set(key, group);
      }
      const candidateMapping = copyMapping(mapping);
      if (!group.mappings.some(entry => canonicalKey(entry.metric) === canonicalKey(candidateMapping.metric))) {
        group.mappings.push(candidateMapping);
      }
      group.items.push({
        pin: copyPin(resolved.pin),
        template_id: item.template_id,
        item_id: item.item_id,
        item_version: item.version,
        canonical_metric: { ...item.canonical_metric },
        unit: item.unit,
        dimensions: { ...item.dimensions },
        release: copyRelease(release),
        release_ref: releaseRef,
        collector_id: collector.id,
        implementation_id: collector.implementation_ref,
        method: collector.method,
        mapping: copyMapping(mapping),
      });
    }
  }

  const collectors = [...groups.values()];
  for (const collector of collectors) {
    collector.mappings.sort(compareMapping);
    collector.items.sort(compareItem);
  }

  return {
    kind: 'template_candidate',
    compiled: false,
    binding: preflight.binding,
    pins: sortPins(pins),
    collectors: sortCollectors(collectors),
  };
}
