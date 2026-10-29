/**
 * MAX-238 / B2C — complete internal multi-template parameter/policy resolution.
 *
 * This is still an **unmounted internal** step. It consumes the raw
 * `payload.binding` candidate plus explicitly trusted resource/group/
 * capabilities/time, always re-walks the accepted B1 preflight and B2A
 * candidate compilation, and returns one resolved view: per-template parameter
 * values and sources, one resource-level settings set with provenance, per-item
 * compatibility/capability decisions and the exact release facts a later plan
 * needs. It persists nothing, applies nothing, resolves no credential, issues no
 * receipt and performs no collection I/O (see
 * `docs/slide/development/MAX-238/b2c-resolver-plan.md`).
 *
 * The legacy single-package branch is delegated untouched: this module does not
 * resolve it, and never fabricates a multi-template plan for it.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CapabilitySchema, ResourceSchema, TimestampSchema, resolveDecision, validateBindings,
  type Capability, type CollectionBinding, type CollectionPolicy, type CollectorDefinition, type MetricBinding,
  type MetricDefinition, type Resource,
} from '../../contracts/metrics/index.js';
import {
  type PackagePin, type ResourceBindingCandidate, type TemplateParameters,
  type TemplatePin, type TemplateVersion, type VersionNumber,
} from '../../contracts/metrics/templates.js';
import { checkApplicability, type ApplicabilityCheck } from '../packages/applicability.js';
import { stable, type PackageRegistry, type PackageRelease } from '../packages/model.js';
import {
  applyPolicyLayer, defaultSettingSources, defaultSettings, resolveItemCapability,
  validatePlatformSettings, PLATFORM_LIMITS, SETTINGS_KEYS, type PolicyLayerState, type SettingsKey,
} from '../policy/resolver.js';
import {
  PolicyError, metricKey, refKey, type Origin, type Settings,
} from '../policy/model.js';
import {
  type MetricRef, type ParameterValue, type PackageReleaseRef,
} from '../templates/model.js';
import { compileBindingCandidate, type BindingCandidateItem } from './compile.js';
import type { TemplateVersionReadPort } from './preflight.js';

export type TemplateResolutionErrorCode =
  | 'RESOLVE_INPUT_INVALID'
  | 'RESOLVE_RESOURCE_INVALID'
  | 'RESOLVE_RESOURCE_IDENTITY'
  | 'RESOLVE_GROUP_INVALID'
  | 'RESOLVE_GROUP_IDENTITY'
  | 'RESOLVE_AT_INVALID'
  | 'RESOLVE_CAPABILITY_INVALID'
  | 'RESOLVE_RELEASE_UNAVAILABLE'
  | 'RESOLVE_RELEASE_RESOURCE'
  | 'RESOLVE_RELEASE_INCONSISTENT'
  | 'RESOLVE_PARAMETERS_INVALID'
  | 'RESOLVE_PARAMETER_TEMPLATE_UNSELECTED'
  | 'RESOLVE_PARAMETER_UNKNOWN'
  | 'RESOLVE_PARAMETER_MISSING'
  | 'RESOLVE_PARAMETER_SPEC'
  | 'RESOLVE_PARAMETER_DEFAULT_INVALID'
  | 'RESOLVE_PARAMETER_TYPE'
  | 'RESOLVE_PARAMETER_RANGE'
  | 'RESOLVE_OVERRIDE_INVALID'
  | 'RESOLVE_SETTING_CONFLICT'
  | 'RESOLVE_SETTINGS_INVALID'
  | 'RESOLVE_VALIDATION';

/** Structured locator; a stable code plus these fields, never a driver message. */
export interface TemplateResolutionLocation {
  pin: TemplatePin | null;
  template_id: string | null;
  parameter: string | null;
  field: SettingsKey | null;
  releases: PackageReleaseRef[];
}
const NO_LOCATION: TemplateResolutionLocation = Object.freeze({
  pin: null, template_id: null, parameter: null, field: null, releases: [],
} as TemplateResolutionLocation);

/** One resource-wide setting whose per-release defaults disagree without an explicit decision. */
export interface TemplateSettingConflict {
  field: SettingsKey;
  values: Array<{ release: PackageReleaseRef; value: number | boolean }>;
}

export class TemplateResolutionError extends Error {
  constructor(
    public readonly code: TemplateResolutionErrorCode,
    public readonly location: TemplateResolutionLocation = NO_LOCATION,
    /** The existing rule code this rejection came from (`POLICY_*`), if any. */
    public readonly rule: string | null = null,
    public readonly conflicts: readonly TemplateSettingConflict[] = [],
  ) {
    super(code);
    this.name = 'TemplateResolutionError';
  }
}

/** Where one effective setting came from. Package defaults list every agreeing release. */
export type TemplateSettingSource =
  | { layer: 'platform'; id: string }
  | { layer: 'package'; releases: PackageReleaseRef[] }
  | { layer: 'group'; id: string; revision: number }
  | { layer: 'resource'; id: string; revision: number };

/** A selected metric's enable toggle provenance; a package default names its own release. */
export type TemplateMetricSource =
  | { layer: 'package'; release: PackageReleaseRef }
  | { layer: 'group'; id: string; revision: number }
  | { layer: 'resource'; id: string; revision: number };

export type ResolvedParameterValue = ParameterValue;

/** One parameter's default, optional override and effective value, each traceable to the pin. */
export interface ResolvedTemplateParameter {
  name: string;
  type: 'number' | 'integer' | 'boolean' | 'string';
  default: ResolvedParameterValue | null;
  override: ResolvedParameterValue | null;
  effective: ResolvedParameterValue;
  source: 'default' | 'override';
}
export interface ResolvedTemplateParameters {
  pin: TemplatePin;
  parameters: ResolvedTemplateParameter[];
}

/** A selected, qualified template item with its exact release and capability decision. */
export interface ResolvedTemplateItem {
  pin: TemplatePin;
  template_id: string;
  item_id: string;
  item_version: VersionNumber;
  canonical_metric: MetricRef;
  unit: BindingCandidateItem['unit'];
  dimensions: BindingCandidateItem['dimensions'];
  release: PackageReleaseRef;
  release_ref: string;
  collector_id: string;
  implementation_id: string;
  method: BindingCandidateItem['method'];
  mapping: BindingCandidateItem['mapping'];
  /** The metric toggle only; `decision` also reflects the collection switch. */
  enabled: boolean;
  decision: 'collect' | 'derive' | 'disabled' | 'unsupported' | 'capability_unknown';
  capability: Capability;
}

/** One selected collector of one exact release; never merged across releases. */
export interface ResolvedTemplateCollector {
  release: PackageReleaseRef;
  release_ref: string;
  collector_id: string;
  implementation_id: string;
  method: BindingCandidateItem['method'];
  estimated_cost: CollectorDefinition['estimated_cost'];
  collector_timeout_ms: number;
  timeout_ms: number;
  timeout_source: TemplateSettingSource;
  items: ResolvedTemplateItem[];
}

export interface ResolvedTemplateRelease {
  release: PackageReleaseRef;
  release_ref: string;
  applicability: ApplicabilityCheck[];
  collectors: ResolvedTemplateCollector[];
}

export type ResolvedTemplateExclusionReason =
  | 'settings_disabled' | 'metric_disabled' | 'capability_unsupported' | 'capability_unknown';
export interface ResolvedTemplateExclusion {
  pin: TemplatePin;
  template_id: string;
  item_id: string;
  item_version: VersionNumber;
  release: PackageReleaseRef;
  metric: MetricRef;
  decision: 'disabled' | 'unsupported' | 'capability_unknown';
  reason: ResolvedTemplateExclusionReason;
  /** Unsupported and unknown are blockers; an explicit disable is not. */
  blocking: boolean;
  capability: Capability;
}

/** A template candidate resolved for this resource; still not an execution plan. */
export interface ResolvedTemplateBinding {
  kind: 'template_resolution';
  internal: true;
  persisted: false;
  applied: false;
  binding: ResourceBindingCandidate;
  resource: { type: Resource['type']; id: string };
  revision: number;
  group: { id: string; revision: number } | null;
  templates: ResolvedTemplateParameters[];
  /** Per-pin trigger references, preserved unresolved; no trigger is evaluated here. */
  triggers: Array<{ pin: TemplatePin; refs: TemplateVersion['aggregate']['triggers'] }>;
  settings: Settings;
  sources: Record<SettingsKey, TemplateSettingSource>;
  metric_sources: Record<string, TemplateMetricSource>;
  platform_limits: Record<string, number>;
  releases: ResolvedTemplateRelease[];
  excluded: ResolvedTemplateExclusion[];
  executable: boolean;
}

/** The explicit single-package branch; the existing flow keeps owning it. */
export interface LegacyResolutionDelegate {
  kind: 'legacy_delegate';
  internal: true;
  persisted: false;
  applied: false;
  binding: ResourceBindingCandidate;
  package: PackagePin;
}

export type TemplateResolutionOutcome = ResolvedTemplateBinding | LegacyResolutionDelegate;

/** The untrusted caller supplies the raw binding; these four are the trusted context. */
export interface TemplateResolutionContext {
  resource: unknown;
  group: unknown;
  capabilities: unknown;
  at: unknown;
}

const GroupInputSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  policy_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1).optional(),
  overrides: z.record(z.string(), z.unknown()),
});
/** Only the multi-template branch knows this namespace; the old `OverridesSchema` is unchanged. */
const TemplateParameterOverridesSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

type TrustedGroup = z.infer<typeof GroupInputSchema>;
type ParameterSpec = TemplateParameters['schema'][string];

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const copyPin = (pin: TemplatePin): TemplatePin => ({
  template_id: pin.template_id, version: pin.version, content_hash: pin.content_hash,
});
const copyRelease = (release: PackageReleaseRef): PackageReleaseRef => ({
  id: release.id, version: release.version, digest: release.digest,
});

const location = (overrides: Partial<TemplateResolutionLocation> = {}): TemplateResolutionLocation =>
  ({ ...NO_LOCATION, ...overrides });

/** Convert an existing policy origin into the multi-template source shape. */
function settingSource(origin: Origin, releases: PackageReleaseRef[]): TemplateSettingSource {
  if (origin.layer === 'platform') return { layer: 'platform', id: origin.id };
  if (origin.layer === 'package') return { layer: 'package', releases: releases.map(copyRelease) };
  return { layer: origin.layer, id: origin.id, revision: origin.revision! };
}

function metricSource(origin: Origin | undefined, release: PackageReleaseRef): TemplateMetricSource {
  if (origin === undefined || origin.layer === 'package') return { layer: 'package', release: copyRelease(release) };
  return { layer: origin.layer as 'group' | 'resource', id: origin.id, revision: origin.revision! };
}

/** null when the value satisfies the spec, otherwise the stable failure kind. */
function parameterProblem(spec: ParameterSpec, value: unknown): 'type' | 'range' | null {
  if (spec.type === 'boolean') return typeof value === 'boolean' ? null : 'type';
  if (spec.type === 'string') {
    if (typeof value !== 'string') return 'type';
    if (value.length < (spec.min ?? 0) || (spec.max !== undefined && value.length > spec.max)) return 'range';
    return null;
  }
  if (typeof value !== 'number') return 'type';
  if (!Number.isFinite(value)) return 'range';
  if (spec.type === 'integer' && !Number.isInteger(value)) return 'range';
  if (spec.min !== undefined && value < spec.min) return 'range';
  if (spec.max !== undefined && value > spec.max) return 'range';
  return null;
}

/** A spec the schema accepts but this branch cannot honour is rejected, never ignored. */
function checkParameterSpec(pin: TemplatePin, name: string, spec: ParameterSpec): void {
  const fail = (): never => {
    throw new TemplateResolutionError('RESOLVE_PARAMETER_SPEC',
      location({ pin: copyPin(pin), template_id: pin.template_id, parameter: name }));
  };
  if (spec.type === 'boolean') {
    if (spec.min !== undefined || spec.max !== undefined) fail();
    return;
  }
  for (const bound of [spec.min, spec.max]) {
    if (bound === undefined) continue;
    // A string bound is a character length; a numeric bound must be finite.
    if (!Number.isFinite(bound) || (spec.type === 'string' && (!Number.isInteger(bound) || bound < 0))) fail();
  }
}

/**
 * Resolve every declared parameter of one pin. Defaults are validated even when
 * an override exists, so an invalid default is never hidden; an override only
 * applies inside this template's namespace and never reaches another template.
 */
function resolveParameters(
  pin: TemplatePin,
  parameters: TemplateParameters,
  overrides: Record<string, unknown> | undefined,
): ResolvedTemplateParameters {
  const names = Object.keys(parameters.schema).sort(compare);
  const resolved: ResolvedTemplateParameter[] = [];
  for (const name of names) {
    const spec = parameters.schema[name];
    checkParameterSpec(pin, name, spec);
    const hasDefault = Object.hasOwn(parameters.defaults, name);
    const defaultValue = hasDefault ? parameters.defaults[name] : null;
    if (defaultValue !== null && parameterProblem(spec, defaultValue) !== null) {
      throw new TemplateResolutionError('RESOLVE_PARAMETER_DEFAULT_INVALID',
        location({ pin: copyPin(pin), template_id: pin.template_id, parameter: name }));
    }
    const hasOverride = overrides !== undefined && Object.hasOwn(overrides, name);
    const overrideValue = hasOverride ? overrides![name] : null;
    if (hasOverride) {
      const problem = parameterProblem(spec, overrideValue);
      if (problem !== null) throw new TemplateResolutionError(
        problem === 'type' ? 'RESOLVE_PARAMETER_TYPE' : 'RESOLVE_PARAMETER_RANGE',
        location({ pin: copyPin(pin), template_id: pin.template_id, parameter: name }),
      );
    }
    if (!hasDefault && !hasOverride) {
      throw new TemplateResolutionError('RESOLVE_PARAMETER_MISSING',
        location({ pin: copyPin(pin), template_id: pin.template_id, parameter: name }));
    }
    resolved.push({
      name, type: spec.type,
      default: defaultValue as ResolvedParameterValue | null,
      override: overrideValue as ResolvedParameterValue | null,
      effective: (hasOverride ? overrideValue : defaultValue) as ResolvedParameterValue,
      source: hasOverride ? 'override' : 'default',
    });
  }
  for (const name of Object.keys(overrides ?? {}).sort(compare)) {
    if (Object.hasOwn(parameters.schema, name)) continue;
    throw new TemplateResolutionError('RESOLVE_PARAMETER_UNKNOWN',
      location({ pin: copyPin(pin), template_id: pin.template_id, parameter: name }));
  }
  return { pin: copyPin(pin), parameters: resolved };
}

function parseResource(context: TemplateResolutionContext): Resource {
  const parsed = ResourceSchema.safeParse(context.resource);
  if (!parsed.success) throw new TemplateResolutionError('RESOLVE_RESOURCE_INVALID');
  return parsed.data;
}

function parseAt(context: TemplateResolutionContext): string {
  const parsed = TimestampSchema.safeParse(context.at);
  if (!parsed.success) throw new TemplateResolutionError('RESOLVE_AT_INVALID');
  return parsed.data;
}

function parseGroup(context: TemplateResolutionContext, groupId: string | null): TrustedGroup | null {
  const raw = context.group;
  if (groupId === null) {
    // A trusted group for an ungrouped binding is an identity mismatch, not a fallback group.
    if (raw !== null && raw !== undefined) throw new TemplateResolutionError('RESOLVE_GROUP_IDENTITY');
    return null;
  }
  if (raw === null || raw === undefined) throw new TemplateResolutionError('RESOLVE_GROUP_IDENTITY');
  const parsed = GroupInputSchema.safeParse(raw);
  if (!parsed.success) throw new TemplateResolutionError('RESOLVE_GROUP_INVALID');
  if (parsed.data.id !== groupId) throw new TemplateResolutionError('RESOLVE_GROUP_IDENTITY');
  return parsed.data;
}

function parseCapabilities(context: TemplateResolutionContext): Capability[] {
  if (!Array.isArray(context.capabilities)) throw new TemplateResolutionError('RESOLVE_CAPABILITY_INVALID');
  return context.capabilities.map((value: unknown) => {
    const parsed = CapabilitySchema.safeParse(value);
    if (!parsed.success) throw new TemplateResolutionError('RESOLVE_CAPABILITY_INVALID');
    return parsed.data;
  });
}

interface Layer { overrides: unknown; origin: Origin }

/** Apply the existing group/resource layers; a rejected layer never leaks its parse message. */
function applyLayers(state: PolicyLayerState, layers: Layer[]): PolicyLayerState {
  let current = state;
  for (const layer of layers) {
    try {
      const next = applyPolicyLayer(current, layer.overrides, layer.origin);
      current = { settings: next.settings, sources: next.sources, toggles: next.toggles, metricSources: next.metricSources };
    } catch (error) {
      // Zod and POLICY_UNKNOWN_METRIC are both stable rejections; no value or message travels.
      throw new TemplateResolutionError('RESOLVE_OVERRIDE_INVALID', NO_LOCATION,
        error instanceof PolicyError ? error.code : null);
    }
  }
  return current;
}

interface ReleaseState {
  ref: PackageReleaseRef;
  ref_text: string;
  release: PackageRelease;
  definitions: MetricDefinition[];
  settings: Settings;
  sources: Record<SettingsKey, Origin>;
}

function readRelease(registry: PackageRegistry, ref: PackageReleaseRef): { release: PackageRelease; definitions: MetricDefinition[] } {
  try {
    return {
      release: registry.get({ id: ref.id, version: ref.version, digest: ref.digest }),
      definitions: registry.catalog({ id: ref.id, version: ref.version, digest: ref.digest }),
    };
  } catch {
    throw new TemplateResolutionError('RESOLVE_RELEASE_UNAVAILABLE', location({ releases: [copyRelease(ref)] }));
  }
}

/**
 * Resolve one existing binding snapshot into the internal multi-template view.
 * Contract and behavior:
 *
 * - Trusted context (`resource`/`group`/`capabilities`/`at`) is validated before
 *   any template read; the untrusted binding never supplies them.
 * - The raw binding always goes through {@link compileBindingCandidate}, so B1
 *   and B2A rejections propagate and no caller-built candidate is trusted.
 * - A legacy binding returns a `legacy_delegate` untouched: no template read, no
 *   parameter/settings resolution and no fabricated multi-template plan.
 * - Parameters are resolved per pin from that pin's schema/defaults plus the
 *   internal `binding.overrides.template_parameters` namespace only; every
 *   default and effective value is validated and no value crosses a template.
 * - One resource-level settings set is derived with the existing
 *   package→group→resource layering. Agreeing defaults win with all releases
 *   named; an explicit layer resolves a difference; otherwise a stable conflict
 *   rejects instead of picking one release.
 * - Capability/compatibility reuse `checkApplicability`, the existing capability
 *   freshness rule and `resolveDecision`; unsupported or unknown items are
 *   reported and block executability instead of being assumed supported.
 * - The result mutates neither its inputs nor the registry.
 */
export async function resolveTemplateBinding(
  bindingInput: unknown,
  context: TemplateResolutionContext,
  templates: TemplateVersionReadPort,
  registry: PackageRegistry,
): Promise<TemplateResolutionOutcome> {
  const resource = parseResource(context);
  const at = parseAt(context);

  const candidate = await compileBindingCandidate(bindingInput, templates, registry);
  if (resource.type !== candidate.binding.resource.type || resource.id !== String(candidate.binding.resource.id)) {
    throw new TemplateResolutionError('RESOLVE_RESOURCE_IDENTITY');
  }
  if (candidate.kind === 'legacy') {
    // The existing single-package flow owns legacy: no parameter, policy or plan work here.
    return { kind: 'legacy_delegate', internal: true, persisted: false, applied: false,
      binding: candidate.binding, package: candidate.package };
  }

  const group = parseGroup(context, candidate.binding.group_id);
  const capabilities = parseCapabilities(context);

  const { template_parameters: templateParameters, ...restOverrides } = candidate.binding.overrides;
  let parameterOverrides: z.infer<typeof TemplateParameterOverridesSchema> = {};
  if (templateParameters !== undefined) {
    const parsed = TemplateParameterOverridesSchema.safeParse(templateParameters);
    if (!parsed.success) throw new TemplateResolutionError('RESOLVE_PARAMETERS_INVALID');
    parameterOverrides = parsed.data;
  }
  const pinsByTemplate = new Map(candidate.pins.map(entry => [entry.pin.template_id, entry]));
  for (const templateId of Object.keys(parameterOverrides).sort(compare)) {
    if (!pinsByTemplate.has(templateId)) {
      throw new TemplateResolutionError('RESOLVE_PARAMETER_TEMPLATE_UNSELECTED',
        location({ template_id: templateId }));
    }
  }

  const resolvedTemplates = candidate.pins.map(entry => resolveParameters(entry.pin,
    entry.unresolved.parameters, parameterOverrides[entry.pin.template_id]));

  const layers: Layer[] = [];
  if (group !== null) layers.push({ overrides: group.overrides,
    origin: { layer: 'group', id: group.id, revision: group.policy_revision ?? group.revision } });
  layers.push({ overrides: restOverrides,
    origin: { layer: 'resource', id: refKey(candidate.binding.resource), revision: candidate.binding.revision } });

  const initialToggles = new Map<string, boolean>();
  const ownMetricSources = new Map<string, TemplateMetricSource>();
  for (const collector of candidate.collectors) for (const item of collector.items) {
    initialToggles.set(metricKey(item.canonical_metric), true);
    ownMetricSources.set(metricKey(item.canonical_metric), { layer: 'package', release: copyRelease(collector.release) });
  }

  const states = new Map<string, ReleaseState>();
  let lastLayers: PolicyLayerState | null = null;
  for (const collector of candidate.collectors) {
    if (states.has(collector.release_ref)) continue;
    const { release, definitions } = readRelease(registry, collector.release);
    if (resource.type !== release.package.resource_type) {
      throw new TemplateResolutionError('RESOLVE_RELEASE_RESOURCE', location({ releases: [copyRelease(collector.release)] }));
    }
    const applied = applyLayers({
      settings: defaultSettings(release, definitions),
      sources: defaultSettingSources(release),
      toggles: initialToggles,
      metricSources: {},
    }, layers);
    lastLayers = applied;
    states.set(collector.release_ref, {
      ref: copyRelease(collector.release), ref_text: collector.release_ref, release, definitions,
      settings: applied.settings, sources: applied.sources,
    });
  }

  const refs = [...states.keys()].sort(compare);
  const orderedReleases = refs.map(ref => states.get(ref)!.ref);
  const settings = {} as Settings;
  const sources = {} as Record<SettingsKey, TemplateSettingSource>;
  const conflicts: TemplateSettingConflict[] = [];
  for (const key of SETTINGS_KEYS) {
    const values = refs.map(ref => ({ release: states.get(ref)!.ref, value: states.get(ref)!.settings[key] }));
    if (new Set(values.map(entry => `${entry.value}`)).size > 1) { conflicts.push({ field: key, values }); continue; }
    (settings as unknown as Record<SettingsKey, number | boolean>)[key] = values[0].value;
    // Agreeing defaults name every release; an explicit layer names the group/resource.
    sources[key] = settingSource(states.get(refs[0])!.sources[key], orderedReleases);
  }
  if (conflicts.length > 0) {
    throw new TemplateResolutionError('RESOLVE_SETTING_CONFLICT',
      location({ releases: orderedReleases.map(copyRelease) }), null, conflicts);
  }
  try {
    validatePlatformSettings(settings);
  } catch (error) {
    throw new TemplateResolutionError('RESOLVE_SETTINGS_INVALID', location({ releases: orderedReleases.map(copyRelease) }),
      error instanceof PolicyError ? error.code : null);
  }

  const toggles = lastLayers!.toggles;
  const toggleOrigins = lastLayers!.metricSources;
  const policyId = group?.id ?? `resource:${refKey(candidate.binding.resource)}`;
  // A pending plan is recorded at the revision it will become. An unbound
  // resource names base 0, which is never a recorded configuration, so its first
  // plan carries revision 1 (the target) instead of an impossible 0.
  const recordedRevision = Math.max(candidate.binding.revision, 1);
  const policyRevision = group ? group.policy_revision ?? group.revision : recordedRevision;

  const resolvedReleases: ResolvedTemplateRelease[] = [];
  const excluded: ResolvedTemplateExclusion[] = [];
  for (const releaseRef of refs) {
    const state = states.get(releaseRef)!;
    const applicability = checkApplicability(state.release.package, resource, at);
    const collection: CollectionBinding = {
      id: `${refKey(candidate.binding.resource)}:${releaseRef}`, resource_id: resource.id, resource_type: resource.type,
      package: { id: state.release.package.id, version: state.release.package.version, digest: state.release.package.digest },
      policy_id: policyId, policy_revision: policyRevision, config_revision: recordedRevision, enabled: settings.enabled,
    };
    const { max_rows: _rows, ...policySettings } = settings;
    const policy: CollectionPolicy = { id: policyId, revision: policyRevision, ...policySettings };
    const metricBindings: MetricBinding[] = [];
    const collectors: ResolvedTemplateCollector[] = candidate.collectors
      .filter(entry => entry.release_ref === releaseRef)
      .map(entry => {
        const definition = state.release.package.collectors.find(collector => collector.id === entry.collector_id
          && collector.implementation_ref === entry.implementation_id && collector.method === entry.method);
        if (definition === undefined) {
          throw new TemplateResolutionError('RESOLVE_RELEASE_INCONSISTENT', location({ releases: [state.ref] }));
        }
        const capped = definition.timeout_ms < settings.timeout_ms;
        const items = entry.items.map(item => {
          const enabled = toggles.get(metricKey(item.canonical_metric)) ?? false;
          const capability = resolveItemCapability({ resource, metric: item.canonical_metric, method: item.method,
            capabilities, applicability, at, stale_after_ms: settings.stale_after_ms });
          const metricBinding: MetricBinding = {
            id: `${refKey(candidate.binding.resource)}:${entry.release_ref}:${item.template_id}/${item.item_id}@${item.item_version}`,
            collection_binding_id: collection.id, resource_id: resource.id, metric: item.canonical_metric,
            dimensions: item.dimensions, enabled, source: { kind: 'collector', collector_id: entry.collector_id, raw_field: item.mapping.raw_field },
          };
          metricBindings.push(metricBinding);
          const decision = resolveDecision(collection, policy, metricBinding, capability, at);
          // Template items always name a collector provider; a derived decision would be inconsistent.
          if (decision === 'derive') {
            throw new TemplateResolutionError('RESOLVE_RELEASE_INCONSISTENT', location({ releases: [state.ref] }));
          }
          const resolvedItem: ResolvedTemplateItem = {
            pin: copyPin(item.pin), template_id: item.template_id, item_id: item.item_id, item_version: item.item_version,
            canonical_metric: { ...item.canonical_metric }, unit: item.unit, dimensions: { ...item.dimensions },
            release: copyRelease(item.release), release_ref: item.release_ref, collector_id: item.collector_id,
            implementation_id: item.implementation_id, method: item.method, mapping: item.mapping, enabled, decision, capability,
          };
          if (decision !== 'collect') {
            const reason: ResolvedTemplateExclusionReason = decision === 'disabled'
              ? (settings.enabled ? 'metric_disabled' : 'settings_disabled')
              : decision === 'unsupported' ? 'capability_unsupported' : 'capability_unknown';
            excluded.push({ pin: copyPin(item.pin), template_id: item.template_id, item_id: item.item_id,
              item_version: item.item_version, release: copyRelease(item.release), metric: { ...item.canonical_metric },
              decision, reason, blocking: decision !== 'disabled', capability });
          }
          return resolvedItem;
        });
        items.sort((left, right) => compare(left.template_id, right.template_id) || compare(left.item_id, right.item_id)
          || left.item_version - right.item_version);
        const timeoutSource: TemplateSettingSource = capped
          ? { layer: 'package', releases: [copyRelease(entry.release)] } : sources.timeout_ms;
        return {
          release: copyRelease(entry.release), release_ref: entry.release_ref, collector_id: entry.collector_id,
          implementation_id: entry.implementation_id, method: entry.method, estimated_cost: definition.estimated_cost,
          collector_timeout_ms: definition.timeout_ms, timeout_ms: Math.min(definition.timeout_ms, settings.timeout_ms),
          timeout_source: timeoutSource,
          items,
        };
      })
      .sort((left, right) => compare(left.collector_id, right.collector_id) || compare(left.implementation_id, right.implementation_id)
        || compare(left.method, right.method));
    // The accepted contract rules (policy timing, package/policy pins, mapping sources,
    // duplicate sources) still validate this release's view; no second validator exists.
    try {
      validateBindings({ collections: [collection], policies: [policy], packages: [state.release.package],
        derived: state.release.derived, metrics: metricBindings }, state.definitions);
    } catch {
      throw new TemplateResolutionError('RESOLVE_VALIDATION', location({ releases: [state.ref] }));
    }
    resolvedReleases.push({ release: copyRelease(state.ref), release_ref: releaseRef, applicability, collectors });
  }
  excluded.sort((left, right) => compare(left.release.id, right.release.id) || compare(left.release.version, right.release.version)
    || compare(left.template_id, right.template_id) || compare(left.item_id, right.item_id) || left.item_version - right.item_version);

  const collectible = resolvedReleases.some(entry => entry.collectors.some(collector =>
    collector.items.some(item => item.decision === 'collect')));
  // An explicit disable is not a blocker; unsupported/unknown is a never-executable condition.
  const executable = settings.enabled && collectible && !excluded.some(entry => entry.blocking);

  const metricSources: Record<string, TemplateMetricSource> = {};
  for (const key of [...ownMetricSources.keys()].sort(compare)) {
    const own = ownMetricSources.get(key) as { layer: 'package'; release: PackageReleaseRef };
    metricSources[key] = metricSource(toggleOrigins[key], own.release);
  }

  return {
    kind: 'template_resolution', internal: true, persisted: false, applied: false,
    binding: candidate.binding, resource: { type: resource.type, id: resource.id }, revision: candidate.binding.revision,
    group: group === null ? null : { id: group.id, revision: group.revision },
    templates: resolvedTemplates,
    triggers: candidate.pins.map(entry => ({ pin: copyPin(entry.pin), refs: entry.unresolved.trigger_refs })),
    settings, sources, metric_sources: metricSources, platform_limits: { ...PLATFORM_LIMITS },
    releases: resolvedReleases, excluded, executable,
  };
}

/** The resolution identity format; changing covered fields requires a new value. */
export const TEMPLATE_RESOLUTION_IDENTITY_FORMAT = 'max238.template-resolution.v1';

/**
 * Identity of one resolved multi-template view. It covers the resource and
 * revision, group identity, fixed pins and hashes, every resolved parameter
 * (default/override/effective/source), the effective settings and their
 * provenance, unresolved trigger references, and per-item release, qualified
 * identity, dimensions, ordered mapping steps, capability and decision.
 *
 * `at` itself is not covered: the same resolved semantics at another instant
 * keep the same identity, while a changed pin/hash, parameter, override,
 * dependency or capability inventory changes it. Ordered arrays (mapping steps)
 * keep their order; only true sets are sorted.
 */
export function templateResolutionIdentity(resolution: ResolvedTemplateBinding): string {
  const identity = {
    format: TEMPLATE_RESOLUTION_IDENTITY_FORMAT,
    resource: resolution.resource,
    revision: resolution.revision,
    group: resolution.group,
    templates: resolution.templates.map(entry => ({ pin: entry.pin, parameters: entry.parameters })),
    triggers: resolution.triggers,
    settings: resolution.settings,
    sources: resolution.sources,
    metric_sources: resolution.metric_sources,
    executable: resolution.executable,
    releases: resolution.releases.map(entry => ({
      release: entry.release,
      applicability: entry.applicability,
      collectors: entry.collectors.map(collector => ({
        collector_id: collector.collector_id, implementation_id: collector.implementation_id, method: collector.method,
        estimated_cost: collector.estimated_cost, collector_timeout_ms: collector.collector_timeout_ms,
        timeout_ms: collector.timeout_ms, timeout_source: collector.timeout_source,
        items: collector.items.map(item => ({
          pin: item.pin, template_id: item.template_id, item_id: item.item_id, item_version: item.item_version,
          canonical_metric: item.canonical_metric, unit: item.unit, dimensions: item.dimensions,
          mapping: item.mapping, enabled: item.enabled, decision: item.decision, capability: item.capability,
        })),
      })),
    })),
    excluded: resolution.excluded,
  };
  return `sha256:${createHash('sha256').update(stable(identity)).digest('hex')}`;
}
