/**
 * MAX-237 / T1 — read-only view over the *registered* collection capability.
 *
 * This module adds no catalog of its own: it reads the existing
 * `PackageRegistry` (the same store `MetricConfigurationService.catalog()` uses)
 * and the product `canonicalDefinitions`, and answers one question the template
 * editor needs — "which metrics can this pinned release actually collect, with
 * which raw field and transform?" A definition that exists in the catalog but
 * has no collector mapping is *not* selectable, which is exactly the "template
 * entry exists but cannot really be collected" failure the issue calls out.
 */
import type { MetricDefinition } from '../../contracts/metrics/index.js';
import type { z } from 'zod';
import type { MetricRefSchema, UnitSchema } from '../../contracts/metrics/index.js';
import { canonicalDefinitions } from '../packages/builtins.js';
import type { PackageRegistry, PackageRelease, Selection } from '../packages/model.js';
import { TemplateError, type TemplateErrorCode } from './errors.js';
import { canonicalKey, packageReleaseRef } from './model.js';

export type PackagePin = Selection['package'];
type MetricRef = z.infer<typeof MetricRefSchema>;
type Unit = z.infer<typeof UnitSchema>;

export interface DimensionDescriptor {
  name: string;
  meaning: string;
  required: boolean;
}

/** Everything a template item needs to name one collectable metric of one release. */
export interface CapabilityCandidate {
  metric: MetricRef;
  /** Auto-filled default display name; the item may rename without changing `item_id`. */
  display_name_default: string;
  meaning: string;
  unit: Unit;
  kind: MetricDefinition['kind'];
  value_type: MetricDefinition['value_type'];
  temporality: MetricDefinition['temporality'];
  scope: MetricDefinition['scope'];
  resource_type: MetricDefinition['resource_type'];
  dimensions: DimensionDescriptor[];
  /** The pinned release's recommended cadence; templates declare it once at template level. */
  default_interval_ms: number;
  package_release: string;
  package: PackagePin;
  implementation_id: string;
  collector_id: string;
  raw_field: string;
  input_unit: Unit;
  output_unit: Unit;
  transform_version: string;
  steps: string[];
  method: 'sql' | 'ssh' | 'snmp';
  permissions: string[];
  discovery: string;
}

/**
 * `available` is a plain boolean on purpose: this file is type-checked with
 * `strict:false`, where literal-union narrowing is not available.
 */
export interface MetricAvailability {
  available: boolean;
  code?: TemplateErrorCode;
  reason?: string;
}

export interface UnavailableMetric extends MetricRef {
  code: TemplateErrorCode;
  reason: string;
}

export class RegisteredCapabilityCatalog {
  constructor(
    private readonly registry: PackageRegistry,
    private readonly canonical: MetricDefinition[] = canonicalDefinitions,
  ) {}

  private releaseOf(pin: PackagePin, metric?: MetricRef): PackageRelease {
    try {
      return this.registry.get(pin);
    } catch {
      throw new TemplateError('TEMPLATE_PIN_NOT_FOUND',
        `package release ${packageReleaseRef(pin)} is not installed${metric ? ` (needed for ${canonicalKey(metric)})` : ''}`);
    }
  }

  private definitionsOf(release: PackageRelease): MetricDefinition[] {
    return [...this.canonical, ...release.extensions];
  }

  /** Ascending order by release then metric, so two callers see the same list. */
  candidates(): CapabilityCandidate[] {
    const out: CapabilityCandidate[] = [];
    for (const release of this.registry.list()) {
      const pin = { id: release.package.id, version: release.package.version, digest: release.package.digest };
      const definitions = this.definitionsOf(release);
      for (const collector of release.package.collectors) {
        for (const mapping of collector.mappings) {
          const definition = definitions.find(d => canonicalKey(d) === canonicalKey(mapping.metric));
          if (!definition || definition.lifecycle !== 'active') continue;
          if (definition.resource_type !== release.package.resource_type) continue;
          out.push(this.describe(release, pin, definition, collector, mapping));
        }
      }
    }
    return out.sort((a, b) => (a.package_release === b.package_release
      ? canonicalKey(a.metric).localeCompare(canonicalKey(b.metric))
      : a.package_release.localeCompare(b.package_release)));
  }

  /**
   * Resolve one selection to its auto-filled item fields and explicit mapping.
   * Every rejection names the exact reason; nothing is silently defaulted.
   */
  autofill(input: { package: PackagePin; metric: MetricRef }): CapabilityCandidate {
    const release = this.releaseOf(input.package, input.metric);
    const key = canonicalKey(input.metric);
    const definition = this.definitionsOf(release).find(d => canonicalKey(d) === key);
    if (!definition) {
      throw new TemplateError('TEMPLATE_METRIC_UNKNOWN',
        `${key} is not part of package release ${packageReleaseRef(input.package)}`);
    }
    if (definition.lifecycle !== 'active') {
      throw new TemplateError('TEMPLATE_METRIC_DEPRECATED',
        `${key} is ${definition.lifecycle}${definition.replacement_id ? `; use ${definition.replacement_id}` : ''}`);
    }
    if (definition.resource_type !== release.package.resource_type) {
      throw new TemplateError('TEMPLATE_RESOURCE_TYPE_MISMATCH',
        `${key} is a ${definition.resource_type} metric but ${release.package.id} collects ${release.package.resource_type}`);
    }
    const matches = release.package.collectors.flatMap(collector => collector.mappings
      .filter(mapping => canonicalKey(mapping.metric) === key)
      .map(mapping => ({ collector, mapping })));
    if (matches.length === 0) {
      const derived = release.derived.find(d => canonicalKey(d.output) === key);
      throw new TemplateError('TEMPLATE_METRIC_NOT_COLLECTABLE', derived
        ? `${key} is produced by derived metric ${derived.id}; a derived selection needs a reference kind that D1 does not freeze yet`
        : `${key} has no collector mapping in ${packageReleaseRef(input.package)}`);
    }
    const sources = new Set(matches.map(({ collector, mapping }) => `${collector.id}\u0000${mapping.raw_field}`));
    if (sources.size !== 1) {
      throw new TemplateError('TEMPLATE_MAPPING_AMBIGUOUS',
        `${key} is mapped by more than one collector/raw field in ${packageReleaseRef(input.package)}`);
    }
    const [{ collector, mapping }] = matches;
    return this.describe(release, input.package, definition, collector, mapping);
  }

  /** Why a metric is or is not selectable anywhere in the installed capability. */
  explain(metric: MetricRef): MetricAvailability {
    const key = canonicalKey(metric);
    const releases = this.registry.list();
    const definition = [...this.canonical, ...releases.flatMap(release => release.extensions)]
      .find(d => canonicalKey(d) === key);
    if (!definition) {
      return { available: false, code: 'TEMPLATE_METRIC_UNKNOWN', reason: `${key} is not a registered metric definition` };
    }
    if (definition.lifecycle !== 'active') {
      return {
        available: false,
        code: 'TEMPLATE_METRIC_DEPRECATED',
        reason: `${key} is ${definition.lifecycle}${definition.replacement_id ? `; use ${definition.replacement_id}` : ''}`,
      };
    }
    for (const release of releases) {
      const mapped = release.package.collectors.some(c => c.mappings.some(m => canonicalKey(m.metric) === key));
      if (!mapped) continue;
      if (definition.resource_type !== release.package.resource_type) continue;
      return { available: true };
    }
    const derived = releases.find(release => release.derived.some(d => canonicalKey(d.output) === key));
    if (derived) {
      return {
        available: false,
        code: 'TEMPLATE_METRIC_NOT_COLLECTABLE',
        reason: `${key} is derived from other metrics (${derived.package.id}); direct selection needs a reference kind D1 does not freeze yet`,
      };
    }
    return {
      available: false,
      code: 'TEMPLATE_METRIC_NOT_COLLECTABLE',
      reason: `${key} has no collector mapping in any installed package release`,
    };
  }

  /** Every registered definition that cannot be selected, with the exact reason. */
  unavailable(): UnavailableMetric[] {
    const seen = new Map<string, MetricRef>();
    for (const definition of [...this.canonical, ...this.registry.list().flatMap(release => release.extensions)]) {
      const key = canonicalKey(definition);
      if (!seen.has(key)) seen.set(key, { id: definition.id, semantic_version: definition.semantic_version });
    }
    const out: UnavailableMetric[] = [];
    for (const [, metric] of [...seen.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const state = this.explain(metric);
      if (!state.available) out.push({ ...metric, code: state.code!, reason: state.reason! });
    }
    return out;
  }

  private describe(
    release: PackageRelease,
    pin: PackagePin,
    definition: MetricDefinition,
    collector: PackageRelease['package']['collectors'][number],
    mapping: PackageRelease['package']['collectors'][number]['mappings'][number],
  ): CapabilityCandidate {
    const documentation = release.documentation.find(entry => entry.collector_id === collector.id);
    return {
      metric: { id: definition.id, semantic_version: definition.semantic_version },
      display_name_default: definition.id,
      meaning: definition.meaning,
      unit: definition.unit,
      kind: definition.kind,
      value_type: definition.value_type,
      temporality: definition.temporality,
      scope: definition.scope,
      resource_type: definition.resource_type,
      dimensions: definition.dimensions.keys.map(dimension => ({
        name: dimension.name, meaning: dimension.meaning, required: dimension.required,
      })),
      default_interval_ms: release.recommendations.interval_ms,
      package_release: packageReleaseRef(pin),
      package: { ...pin },
      implementation_id: collector.implementation_ref,
      collector_id: collector.id,
      raw_field: mapping.raw_field,
      input_unit: mapping.input_unit,
      output_unit: mapping.output_unit,
      transform_version: mapping.transform_version,
      steps: [...mapping.steps],
      method: collector.method,
      permissions: documentation ? [...documentation.permissions] : [],
      discovery: documentation?.discovery ?? '',
    };
  }
}
