/**
 * MAX-238 / B1 — fixed template pin preflight.
 *
 * This is an **unmounted internal** read-only preflight over an existing
 * `payload.binding` candidate snapshot: it resolves the exact pinned versions
 * through an injected read port, verifies pin/identity/content hashes, keeps
 * per-template item ownership and rejects cross-template canonical-metric
 * overlap. It compiles nothing, applies nothing, persists nothing, evaluates no
 * trigger and touches no route, store or scheduler.
 *
 * What a successful result proves is exactly `preflight` / uncompiled input for
 * a later binder: resource authorization, revision CAS, formal test digests,
 * parameter override resolution, package registry verification and a real
 * multi-release compiler stay outside this package (see
 * `docs/slide/development/MAX-238/b1-binding-preflight.md`).
 */
import {
  ResourceBindingCandidateSchema, TemplateVersionSchema,
  type HashId, type PackageCompositionEntry, type PackagePin, type ResourceBindingCandidate,
  type SourceChain, type TemplateItemVersion, type TemplateParameters, type TemplatePin,
  type TemplateVersion, type VersionNumber,
} from '../../contracts/metrics/templates.js';
import { canonicalKey, templateContentHash } from '../templates/model.js';

/** The exact read port accepted from MAX-237 `TemplateRepository.getVersion`. */
export interface TemplateVersionReadPort {
  getVersion(templateId: string, version: VersionNumber): Promise<TemplateVersion | null>;
}

/**
 * Stable internal machine codes. Storage errors are never propagated: the port
 * outcome is collapsed into `PREFLIGHT_READ_FAILED` so a driver message cannot
 * leak through the preflight error.
 */
export type BindingPreflightErrorCode =
  | 'PREFLIGHT_INPUT_INVALID'
  | 'PREFLIGHT_READ_FAILED'
  | 'PREFLIGHT_VERSION_MISSING'
  | 'PREFLIGHT_VERSION_INVALID'
  | 'PREFLIGHT_VERSION_IDENTITY'
  | 'PREFLIGHT_VERSION_RETIRED'
  | 'PREFLIGHT_CONTENT_HASH_MISMATCH'
  | 'PREFLIGHT_CANONICAL_CONFLICT';

export class BindingPreflightError extends Error {
  constructor(
    public readonly code: BindingPreflightErrorCode,
    public readonly conflicts: readonly BindingPreflightConflict[] = [],
  ) {
    super(code);
    this.name = 'BindingPreflightError';
  }
}

/** One resolved pin, retaining the pin and everything that belongs to that template only. */
export interface BindingPreflightPin {
  /** The pin exactly as supplied (schema-validated copy). */
  pin: TemplatePin;
  /** The pinned immutable version (never the `current` pointer). */
  version: VersionNumber;
  content_hash: HashId;
  /** Stored item snapshots; each carries its own `template_id` ownership. */
  items: TemplateItemVersion[];
  /** Exact immutable releases for this pin, in canonical order. */
  package_composition: PackageCompositionEntry[];
  /** Per-pin parameter schema/defaults — never flattened or merged across pins. */
  parameters: TemplateParameters;
  /** Per-pin trigger references — unresolved; no effective trigger is produced. */
  triggers: TemplateVersion['aggregate']['triggers'];
  /** Per-pin provenance metadata; deliberately outside the content hash. */
  source_chain: SourceChain;
}

/** One provider side of a canonical overlap, identified by pin, template and item. */
export interface BindingPreflightProvider {
  template_id: string;
  item_id: string;
  item_version: VersionNumber;
  pin_version: VersionNumber;
  content_hash: HashId;
  package_release: string;
  canonical_metric: TemplateItemVersion['canonical_metric'];
  unit: TemplateItemVersion['unit'];
  dimensions: TemplateItemVersion['dimensions'];
}

/**
 * Conservative overlap report. `canonical_metric` (id + semantic_version) is the
 * identity; display names and messages are not. Same-value, different-unit and
 * different-dimension providers are all reported, and no provider overwrites
 * another.
 */
export interface BindingPreflightConflict {
  code: 'PREFLIGHT_CANONICAL_CONFLICT';
  canonical_metric: TemplateItemVersion['canonical_metric'];
  providers: BindingPreflightProvider[];
}

/** An explicit legacy branch: no template pins, the existing package pin is kept as-is. */
export interface BindingPreflightLegacy {
  kind: 'legacy';
  compiled: false;
  binding: ResourceBindingCandidate;
  package: PackagePin;
}

/** Template pins resolved; still only an uncompiled preflight candidate. */
export interface BindingPreflightTemplate {
  kind: 'template_preflight';
  compiled: false;
  binding: ResourceBindingCandidate;
  pins: BindingPreflightPin[];
}

export type BindingPreflightOutcome = BindingPreflightLegacy | BindingPreflightTemplate;

const INPUT_INVALID = (): BindingPreflightError => new BindingPreflightError('PREFLIGHT_INPUT_INVALID');

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const providerOf = (pin: TemplatePin, item: TemplateItemVersion): BindingPreflightProvider => ({
  template_id: item.template_id,
  item_id: item.item_id,
  item_version: item.version,
  pin_version: pin.version,
  content_hash: pin.content_hash,
  package_release: item.collector_ref.package_release,
  canonical_metric: item.canonical_metric,
  unit: item.unit,
  dimensions: item.dimensions,
});

/**
 * Canonical provider overlap across the pinned templates. Every group with more
 * than one provider is a conflict — including two items of one template, which is
 * the same duplicate-provider condition observed conservatively.
 */
function canonicalConflicts(pins: BindingPreflightPin[]): BindingPreflightConflict[] {
  const groups = new Map<string, BindingPreflightProvider[]>();
  for (const resolved of pins) {
    for (const item of resolved.items) {
      const key = canonicalKey(item.canonical_metric);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [providerOf(resolved.pin, item)]);
      else group.push(providerOf(resolved.pin, item));
    }
  }
  const conflicts: BindingPreflightConflict[] = [];
  for (const providers of groups.values()) {
    if (providers.length < 2) continue;
    providers.sort((left, right) =>
      compare(left.template_id, right.template_id) || compare(left.item_id, right.item_id));
    conflicts.push({
      code: 'PREFLIGHT_CANONICAL_CONFLICT',
      canonical_metric: { ...providers[0].canonical_metric },
      providers,
    });
  }
  return conflicts.sort((left, right) =>
    compare(left.canonical_metric.id, right.canonical_metric.id)
    || compare(left.canonical_metric.semantic_version, right.canonical_metric.semantic_version));
}

async function readPinnedVersion(
  port: TemplateVersionReadPort,
  pin: TemplatePin,
): Promise<BindingPreflightPin> {
  let raw: unknown;
  try {
    raw = await port.getVersion(pin.template_id, pin.version);
  } catch {
    // Never propagate a storage/driver message through this boundary.
    throw new BindingPreflightError('PREFLIGHT_READ_FAILED');
  }
  if (raw === null || raw === undefined) throw new BindingPreflightError('PREFLIGHT_VERSION_MISSING');

  const parsed = TemplateVersionSchema.safeParse(raw);
  if (!parsed.success) throw new BindingPreflightError('PREFLIGHT_VERSION_INVALID');
  const version = parsed.data;

  if (version.template_id !== pin.template_id || version.version !== pin.version) {
    throw new BindingPreflightError('PREFLIGHT_VERSION_IDENTITY');
  }
  if (version.status !== 'published') throw new BindingPreflightError('PREFLIGHT_VERSION_RETIRED');

  const recomputed = templateContentHash(version.aggregate);
  if (pin.content_hash !== version.content_hash || version.content_hash !== recomputed) {
    throw new BindingPreflightError('PREFLIGHT_CONTENT_HASH_MISMATCH');
  }

  return {
    pin: { template_id: pin.template_id, version: pin.version, content_hash: pin.content_hash },
    version: pin.version,
    content_hash: version.content_hash,
    items: version.items,
    package_composition: version.package_composition,
    parameters: version.aggregate.parameters,
    triggers: version.aggregate.triggers,
    source_chain: version.source_chain,
  };
}

/**
 * Resolve one existing binding snapshot against its fixed template pins.
 *
 * - Input is validated by the accepted `ResourceBindingCandidateSchema`; invalid,
 *   duplicate or out-of-order pins are rejected, never silently normalized.
 * - `template_pins: []` with a package is the explicit legacy branch and never
 *   calls the port.
 * - Every pin is read by `(template_id, version)`, so a moved `current` pointer
 *   cannot change the result.
 * - Any read/identity/status/hash failure throws a stable
 *   `BindingPreflightError`; no partial combination is returned.
 * - A canonical overlap throws `PREFLIGHT_CANONICAL_CONFLICT` carrying the
 *   deterministically ordered providers.
 */
export async function preflightResourceBinding(
  input: unknown,
  port: TemplateVersionReadPort,
): Promise<BindingPreflightOutcome> {
  const parsed = ResourceBindingCandidateSchema.safeParse(input);
  if (!parsed.success) throw INPUT_INVALID();
  const binding = parsed.data;

  if (binding.template_pins.length === 0) {
    // The candidate schema already rejected the empty binding; a package remains.
    if (binding.package === null) throw INPUT_INVALID();
    return { kind: 'legacy', compiled: false, binding, package: binding.package };
  }

  const pins: BindingPreflightPin[] = [];
  for (const pin of binding.template_pins) pins.push(await readPinnedVersion(port, pin));

  const conflicts = canonicalConflicts(pins);
  if (conflicts.length > 0) throw new BindingPreflightError('PREFLIGHT_CANONICAL_CONFLICT', conflicts);

  return { kind: 'template_preflight', compiled: false, binding, pins };
}
