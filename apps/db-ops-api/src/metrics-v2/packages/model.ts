import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CollectorPackageSchema, DerivedMetricSchema, ExtensionMetricDefinitionSchema, VersionSchema,
  validateCatalog, validateDerived, validatePackage, semanticSignature,
  type CollectorDefinition, type CollectorPackage, type MetricDefinition,
} from '../../contracts/metrics-v2/index.js';

export interface ImplementationSpec {
  id: string;
  method: CollectorDefinition['method'];
  resource_type: CollectorPackage['resource_type'];
  applicability: CollectorPackage['applicability'];
  outputs: Array<{ raw_field: string; definition: MetricDefinition; input_unit: MetricDefinition['unit'] }>;
  permissions: string[];
  discovery: string;
}
const SettingsSchema = z.strictObject({
  interval_ms: z.number().int().min(1000).max(86400000),
  timeout_ms: z.number().int().min(250).max(30000),
  stale_after_ms: z.number().int().positive(), max_counter_gap_ms: z.number().int().positive(),
  max_rows: z.number().int().min(1).max(100), enabled: z.boolean(),
});
export const PackageReleaseSchema = z.strictObject({
  package: CollectorPackageSchema,
  extensions: z.array(ExtensionMetricDefinitionSchema),
  derived: z.array(DerivedMetricSchema),
  transforms: z.array(z.strictObject({ id: z.enum(['normalize', 'derive']), version: VersionSchema })).min(1),
  recommendations: SettingsSchema,
  documentation: z.array(z.strictObject({ collector_id: z.string().min(1), permissions: z.array(z.string().min(1)).min(1), discovery: z.string().min(1) })).min(1),
});
export type PackageRelease = z.infer<typeof PackageReleaseSchema>;
export const SelectionSchema = z.strictObject({
  package: z.strictObject({ id: z.string().min(1), version: VersionSchema, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }),
  credential_ref: z.string().regex(/^credential:[A-Za-z0-9_-]{1,128}$/),
  overrides: SettingsSchema.partial(),
});
export type Selection = z.infer<typeof SelectionSchema>;

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function digestRelease(release: PackageRelease): string {
  const { digest: _digest, ...identity } = release.package;
  return `sha256:${createHash('sha256').update(stable({ ...release, package: identity })).digest('hex')}`;
}
export function sealRelease(release: PackageRelease): PackageRelease {
  const result = PackageReleaseSchema.parse(release);
  result.package.digest = digestRelease(result);
  return result;
}
const key = (ref: { id: string; semantic_version: string }) => `${ref.id}@${ref.semantic_version}`;
function requireRule(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
function checkSettings(settings: z.infer<typeof SettingsSchema>): void {
  requireRule(settings.timeout_ms <= settings.interval_ms && settings.stale_after_ms >= settings.interval_ms
    && settings.max_counter_gap_ms >= settings.interval_ms, 'POLICY_TIMING');
}

/** In-process distribution catalog; storage, plan resolution and credential lookup belong to MAX-69. */
export class PackageRegistry {
  private readonly releases = new Map<string, PackageRelease>();
  private readonly definitions: MetricDefinition[];
  private readonly implementations: ImplementationSpec[];
  constructor(canonical: MetricDefinition[], implementations: ImplementationSpec[]) {
    requireRule(canonical.every(d => d.category === 'canonical'), 'CANONICAL_CATALOG');
    this.definitions = structuredClone(validateCatalog(canonical));
    this.implementations = structuredClone(implementations);
    requireRule(new Set(implementations.map(i => i.id)).size === implementations.length, 'IMPLEMENTATION_CONFLICT');
  }
  install(input: unknown): PackageRelease {
    const r = PackageReleaseSchema.parse(input), p = r.package;
    requireRule(digestRelease(r) === p.digest, 'PACKAGE_DIGEST');
    const prior = this.releases.get(`${p.id}@${p.version}`);
    requireRule(!prior || stable(prior) === stable(r), 'IMMUTABLE_PACKAGE');
    requireRule([...this.releases.values()].every(old => old.package.id !== p.id || old.package.resource_type === p.resource_type), 'PACKAGE_RESOURCE_TYPE');
    // Extensions cannot replace or mutate definitions supplied by the product or older releases.
    const all = [...this.definitions, ...[...this.releases.values()].flatMap(v => v.extensions)];
    for (const d of r.extensions) {
      const previous = all.filter(old => old.id === d.id);
      requireRule(previous.every(old => old.category === 'extension' && semanticSignature(old) === semanticSignature(d)), 'IDENTITY_SEMANTIC_CONFLICT');
    }
    const definitions = validateCatalog([...this.definitions, ...r.extensions]);
    validatePackage(p, definitions);
    validateDerived(r.derived, definitions);
    checkSettings(r.recommendations);
    const transforms = new Set(r.transforms.map(t => `${t.id}@${t.version}`));
    requireRule(transforms.size === r.transforms.length && [...transforms].every(t => ['normalize@1.0.0', 'derive@1.0.0'].includes(t)), 'TRANSFORM_DEPENDENCY');
    const outputs = new Set<string>();
    for (const c of p.collectors) {
      requireRule(c.timeout_ms >= 250 && c.timeout_ms <= 30000, 'COLLECTOR_TIMEOUT');
      const impl = this.implementations.find(i => i.id === c.implementation_ref);
      requireRule(impl && impl.method === c.method && impl.resource_type === p.resource_type, 'IMPLEMENTATION_DEPENDENCY');
      requireRule(stable(p.applicability) === stable(impl.applicability), 'IMPLEMENTATION_APPLICABILITY');
      const doc = r.documentation.filter(d => d.collector_id === c.id);
      requireRule(doc.length === 1 && stable(doc[0].permissions) === stable(impl.permissions) && doc[0].discovery === impl.discovery, 'IMPLEMENTATION_DOCUMENTATION');
      for (const m of c.mappings) {
        const field = impl.outputs.find(o => o.raw_field === m.raw_field && key(o.definition) === key(m.metric));
        const definition = definitions.find(d => key(d) === key(m.metric));
        requireRule(field && definition && semanticSignature(field.definition) === semanticSignature(definition), 'MAPPING_SEMANTICS');
        requireRule(m.input_unit === field.input_unit && stable(m.steps) === stable(m.input_unit === m.output_unit ? ['decode', 'normalize'] : ['decode', 'unit_convert', 'normalize']), 'MAPPING_TRANSFORM');
        requireRule(transforms.has(`normalize@${m.transform_version}`), 'TRANSFORM_DEPENDENCY');
        requireRule(!outputs.has(key(m.metric)), 'DUPLICATE_SOURCE'); outputs.add(key(m.metric));
      }
    }
    requireRule(r.documentation.length === p.collectors.length, 'IMPLEMENTATION_DOCUMENTATION');
    const derivedOutputs = new Set(r.derived.map(d => key(d.output)));
    for (const d of r.derived) {
      requireRule(transforms.has(`derive@${d.transform_version}`), 'TRANSFORM_DEPENDENCY');
      requireRule(!outputs.has(key(d.output)), 'DUPLICATE_SOURCE');
      // Packages may only introduce Extension formulas, never redefine Canonical semantics.
      requireRule(r.extensions.some(e => key(e) === key(d.output)), 'DERIVED_EXTENSION_REQUIRED');
      requireRule(d.inputs.every(i => outputs.has(key(i)) || derivedOutputs.has(key(i))), 'MISSING_DEPENDENCY');
    }
    this.releases.set(`${p.id}@${p.version}`, structuredClone(r));
    return structuredClone(r);
  }
  list(): PackageRelease[] { return structuredClone([...this.releases.values()]); }
  get(pin: Selection['package']): PackageRelease {
    const r = this.releases.get(`${pin.id}@${pin.version}`);
    requireRule(r && r.package.digest === pin.digest, 'PACKAGE_PIN');
    return structuredClone(r);
  }
  catalog(pin: Selection['package']): MetricDefinition[] { return [...structuredClone(this.definitions), ...this.get(pin).extensions]; }
  select(input: unknown): { selection: Selection; release: PackageRelease; settings: z.infer<typeof SettingsSchema> } {
    const selection = SelectionSchema.parse(input), release = this.get(selection.package);
    const settings = SettingsSchema.parse({ ...release.recommendations, ...selection.overrides });
    checkSettings(settings);
    return { selection, release, settings };
  }
  switchVersion(input: unknown, pin: Selection['package']): Selection {
    const current = SelectionSchema.parse(input);
    requireRule(current.package.id === pin.id, 'PACKAGE_SWITCH_ID');
    this.get(current.package);
    const next = { ...current, package: { ...pin } };
    this.select(next); // Invalid overrides fail explicitly; never discard them to make an upgrade succeed.
    return structuredClone(next);
  }
}
