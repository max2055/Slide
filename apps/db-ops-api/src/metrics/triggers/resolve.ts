/**
 * MAX-239 — fixed-version trigger resolution.
 *
 * Input is the **real** accepted B2C value (`ResolvedTemplateBinding`, produced
 * by `bindings/resolve.ts` from a schema-valid binding, the installed package
 * registry and the fixed template pins). This module does not accept a
 * hand-built "plan", a display name, a metric guess or an unresolved reference:
 * every trigger reference of every pin is resolved by exact `(rule_id, version)`
 * through an explicit catalog port, and the fixed template pins are re-verified
 * against the same read port B1 uses.
 *
 * It persists nothing, applies nothing, evaluates nothing, emits no event and
 * exposes no route. The result is a **candidate** (`status: 'candidate'`,
 * `applied: false`, `effective: false`); only `compile.ts` turns it into a
 * snapshot, and only trusted applied evidence can make that snapshot evaluable.
 *
 * Rejected with stable codes instead of falling back: a missing rule version, a
 * catalog body whose content hash does not match, a second body for the same
 * identity, a wrong scope/item/template/pin, a metric id or semantic version or
 * unit that disagrees with the fixed template item, unknown or unresolved
 * parameters, and expressions over the declared budget. There is no
 * `latest`-version fallback and no name-based matching.
 */
import {
  TriggerRuleVersionSchema, TRIGGER_LIMITS,
  type ResolvedTriggerExpression, type ResolvedTriggerParameter, type TriggerExpression,
  type TriggerRuleCandidate, type TriggerRuleCandidateSet,
  type TriggerRuleVersion, type TriggerTemplatePin,
} from '../../contracts/metrics/triggers.js';
import type { TemplatePin, TemplateTriggerRefSchema } from '../../contracts/metrics/templates.js';
import type { z } from 'zod';
import { BindingPreflightError, preflightResourceBinding, type TemplateVersionReadPort } from '../bindings/preflight.js';
import { templateResolutionIdentity, type ResolvedTemplateBinding } from '../bindings/resolve.js';
import { expressionBudget, frozenCopy, referencedParameters, triggerRuleContentHash } from './model.js';

/** The trusted rule catalog. It answers one exact identity or `null`; it never lists "latest". */
export interface TriggerRuleCatalogPort {
  getVersion(ruleId: string, version: number): Promise<unknown>;
}

export type TriggerResolutionErrorCode =
  | 'TRIGGER_INPUT_INVALID'
  | 'TRIGGER_RESOLUTION_MISMATCH'
  | 'TRIGGER_TEMPLATE_READ_FAILED'
  | 'TRIGGER_TEMPLATE_VERSION_MISSING'
  | 'TRIGGER_TEMPLATE_VERSION_INVALID'
  | 'TRIGGER_TEMPLATE_IDENTITY'
  | 'TRIGGER_TEMPLATE_VERSION_RETIRED'
  | 'TRIGGER_TEMPLATE_HASH_MISMATCH'
  | 'TRIGGER_RULE_READ_FAILED'
  | 'TRIGGER_RULE_MISSING'
  | 'TRIGGER_RULE_INVALID'
  | 'TRIGGER_RULE_IDENTITY'
  | 'TRIGGER_RULE_HASH_MISMATCH'
  | 'TRIGGER_RULE_CONFLICT'
  | 'TRIGGER_RULE_BUDGET'
  | 'TRIGGER_EXPRESSION_BUDGET'
  | 'TRIGGER_ITEM_UNKNOWN'
  | 'TRIGGER_ITEM_AMBIGUOUS'
  | 'TRIGGER_ITEM_MISMATCH'
  | 'TRIGGER_METRIC_MISMATCH'
  | 'TRIGGER_SEMANTIC_VERSION_MISMATCH'
  | 'TRIGGER_UNIT_MISMATCH'
  | 'TRIGGER_PARAMETER_UNKNOWN'
  | 'TRIGGER_PARAMETER_UNRESOLVED'
  | 'TRIGGER_PARAMETER_TYPE'
  | 'TRIGGER_PARAMETER_RANGE';

/** Structured locator only; never a catalog/driver message. */
export interface TriggerResolutionLocation {
  pin: TemplatePin | null;
  template_id: string | null;
  item_id: string | null;
  rule_id: string | null;
  rule_version: number | null;
  parameter: string | null;
}
const NO_LOCATION: TriggerResolutionLocation = Object.freeze({
  pin: null, template_id: null, item_id: null, rule_id: null, rule_version: null, parameter: null,
} as TriggerResolutionLocation);

export class TriggerResolutionError extends Error {
  constructor(
    public readonly code: TriggerResolutionErrorCode,
    public readonly location: TriggerResolutionLocation = NO_LOCATION,
  ) {
    super(code);
    this.name = 'TriggerResolutionError';
  }
}

export interface TriggerResolutionOptions {
  /**
   * Explicit, caller-supplied rule-parameter values keyed by exact `rule_id`.
   * They are input, not persisted configuration: a parameter that has neither a
   * value here nor a default is unresolved and rejected.
   */
  parameter_overrides?: Record<string, Record<string, unknown>>;
}

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const copyPin = (pin: TemplatePin): TemplatePin => ({
  template_id: pin.template_id, version: pin.version, content_hash: pin.content_hash,
});
const copyTemplatePin = (pin: TemplatePin): TriggerTemplatePin => ({
  template_id: pin.template_id, version: pin.version, content_hash: pin.content_hash,
});

const fail = (
  code: TriggerResolutionErrorCode,
  overrides: Partial<TriggerResolutionLocation> = {},
): never => {
  throw new TriggerResolutionError(code, { ...NO_LOCATION, ...overrides });
};

type RuleRef = z.infer<typeof TemplateTriggerRefSchema>;
type ParameterSpec = TriggerRuleVersion['parameters']['schema'][string];

/**
 * The B2C value is a TypeScript interface, not a schema, so the boundary check is
 * explicit: the required labels and the three arrays a resolution must carry.
 * Anything else (a legacy delegate, a raw plan, a plan-like stub) is rejected
 * before any catalog or template read.
 */
function validateResolution(resolution: unknown): asserts resolution is ResolvedTemplateBinding {
  if (typeof resolution !== 'object' || resolution === null) fail('TRIGGER_INPUT_INVALID');
  const candidate = resolution as Record<string, unknown>;
  const templates = candidate.templates;
  const triggers = candidate.triggers;
  const releases = candidate.releases;
  const resource = candidate.resource as Record<string, unknown> | null;
  if (candidate.kind !== 'template_resolution'
    || candidate.internal !== true
    || candidate.persisted !== false
    || candidate.applied !== false
    || !Array.isArray(templates) || !Array.isArray(triggers) || !Array.isArray(releases)
    || typeof candidate.revision !== 'number'
    || resource === null || typeof resource !== 'object'
    || typeof resource.type !== 'string' || typeof resource.id !== 'string'
    || typeof candidate.binding !== 'object' || candidate.binding === null) {
    fail('TRIGGER_INPUT_INVALID');
  }
}

/** Map a B1 preflight rejection onto the trigger namespace; the raw code stays visible in tests via type. */
function preflightError(error: BindingPreflightError): TriggerResolutionError {
  const code = ((): TriggerResolutionErrorCode => {
    switch (error.code) {
      case 'PREFLIGHT_READ_FAILED': return 'TRIGGER_TEMPLATE_READ_FAILED';
      case 'PREFLIGHT_VERSION_MISSING': return 'TRIGGER_TEMPLATE_VERSION_MISSING';
      case 'PREFLIGHT_VERSION_INVALID': return 'TRIGGER_TEMPLATE_VERSION_INVALID';
      case 'PREFLIGHT_VERSION_IDENTITY': return 'TRIGGER_TEMPLATE_IDENTITY';
      case 'PREFLIGHT_VERSION_RETIRED': return 'TRIGGER_TEMPLATE_VERSION_RETIRED';
      case 'PREFLIGHT_CONTENT_HASH_MISMATCH': return 'TRIGGER_TEMPLATE_HASH_MISMATCH';
      case 'PREFLIGHT_CANONICAL_CONFLICT': return 'TRIGGER_RESOLUTION_MISMATCH';
      default: return 'TRIGGER_INPUT_INVALID';
    }
  })();
  return new TriggerResolutionError(code);
}

/**
 * Re-read every fixed template pin through B1 and prove the resolution being
 * extended is the one those pins produce: same pin set, same content hashes,
 * same trigger references and same device revision. A tampered or stale
 * resolution never reaches the catalog.
 */
async function verifyPins(resolution: ResolvedTemplateBinding, templates: TemplateVersionReadPort) {
  let preflight;
  try {
    preflight = await preflightResourceBinding(resolution.binding, templates);
  } catch (error) {
    if (error instanceof BindingPreflightError) throw preflightError(error);
    throw new TriggerResolutionError('TRIGGER_INPUT_INVALID');
  }
  if (preflight.kind !== 'template_preflight') fail('TRIGGER_INPUT_INVALID');

  const resolvedPins = resolution.templates.map(entry => entry.pin);
  const preflightPins = preflight.pins.map(entry => entry.pin);
  if (resolvedPins.length !== preflightPins.length) fail('TRIGGER_RESOLUTION_MISMATCH');
  for (const [index, pin] of preflightPins.entries()) {
    const declared = resolvedPins[index];
    if (declared === undefined
      || declared.template_id !== pin.template_id
      || declared.version !== pin.version
      || declared.content_hash !== pin.content_hash) {
      fail('TRIGGER_RESOLUTION_MISMATCH', { pin: copyPin(pin), template_id: pin.template_id });
    }
  }

  const declaredTriggers = new Map(resolution.triggers.map(entry => [entry.pin.template_id, entry]));
  if (declaredTriggers.size !== resolution.triggers.length) fail('TRIGGER_RESOLUTION_MISMATCH');
  for (const pin of preflight.pins) {
    const declared = declaredTriggers.get(pin.pin.template_id);
    if (declared === undefined
      || declared.pin.version !== pin.pin.version
      || declared.pin.content_hash !== pin.pin.content_hash
      || JSON.stringify(declared.refs) !== JSON.stringify(pin.triggers)) {
      fail('TRIGGER_RESOLUTION_MISMATCH', { pin: copyPin(pin.pin), template_id: pin.pin.template_id });
    }
  }

  const binding = resolution.binding;
  if (resolution.revision !== binding.revision
    || resolution.resource.type !== binding.resource.type
    || resolution.resource.id !== String(binding.resource.id)) {
    fail('TRIGGER_RESOLUTION_MISMATCH');
  }
  return preflight;
}

/** One resolved selection of the item a rule names, as B2C reported it. */
interface SelectedItem {
  item_version: number;
  decision: TriggerRuleCandidate['decision'];
  canonical_metric: TriggerRuleCandidate['metric'];
  unit: TriggerRuleCandidate['unit'];
  dimensions: TriggerRuleCandidate['dimensions'];
}

function selectedItems(resolution: ResolvedTemplateBinding): Map<string, SelectedItem[]> {
  const byKey = new Map<string, SelectedItem[]>();
  for (const release of resolution.releases) {
    for (const collector of release.collectors) {
      for (const item of collector.items) {
        const key = `${item.template_id}\u0000${item.item_id}`;
        const entry: SelectedItem = {
          item_version: item.item_version,
          decision: item.decision,
          canonical_metric: { ...item.canonical_metric },
          unit: item.unit,
          dimensions: { ...item.dimensions },
        };
        const group = byKey.get(key);
        if (group === undefined) byKey.set(key, [entry]);
        else group.push(entry);
      }
    }
  }
  return byKey;
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

interface ResolvedParameters {
  list: ResolvedTriggerParameter[];
  numeric: Map<string, number>;
}

/**
 * Resolve every declared parameter of one rule version. Defaults are validated
 * even when an override exists; an override never leaks in from another rule or
 * another template. A numeric parameter is the only legal threshold source.
 */
function resolveParameters(
  rule: TriggerRuleVersion,
  overrides: Record<string, unknown> | undefined,
  location: TriggerResolutionLocation,
): ResolvedParameters {
  const names = Object.keys(rule.parameters.schema).sort(compare);
  const list: ResolvedTriggerParameter[] = [];
  const numeric = new Map<string, number>();
  for (const name of names) {
    const spec = rule.parameters.schema[name];
    const hasDefault = Object.hasOwn(rule.parameters.defaults, name);
    const defaultValue = hasDefault ? rule.parameters.defaults[name] : null;
    if (defaultValue !== null && parameterProblem(spec, defaultValue) !== null) {
      fail('TRIGGER_PARAMETER_RANGE', { ...location, parameter: name });
    }
    const hasOverride = overrides !== undefined && Object.hasOwn(overrides, name);
    const overrideValue = hasOverride ? overrides![name] : null;
    if (hasOverride) {
      const problem = parameterProblem(spec, overrideValue);
      if (problem !== null) fail(problem === 'type' ? 'TRIGGER_PARAMETER_TYPE' : 'TRIGGER_PARAMETER_RANGE', { ...location, parameter: name });
    }
    if (!hasDefault && !hasOverride) fail('TRIGGER_PARAMETER_UNRESOLVED', { ...location, parameter: name });
    const value = (hasOverride ? overrideValue : defaultValue) as ResolvedTriggerParameter['value'];
    if (spec.type === 'number' || spec.type === 'integer') numeric.set(name, value as number);
    list.push({ name, type: spec.type, value, source: hasOverride ? 'override' : 'default' });
  }
  for (const name of Object.keys(overrides ?? {}).sort(compare)) {
    if (!Object.hasOwn(rule.parameters.schema, name)) {
      fail('TRIGGER_PARAMETER_UNKNOWN', { ...location, parameter: name });
    }
  }
  return { list, numeric };
}

/** Replace parameter thresholds with their resolved value; a surviving parameter is a bug, not a default. */
function resolveExpression(
  expression: TriggerExpression,
  numeric: Map<string, number>,
  location: TriggerResolutionLocation,
): ResolvedTriggerExpression {
  if (expression.node === 'compare') {
    const value = expression.threshold.kind === 'constant'
      ? expression.threshold.value
      : numeric.get(expression.threshold.name);
    if (value === undefined) {
      fail('TRIGGER_PARAMETER_TYPE', {
        ...location,
        parameter: expression.threshold.kind === 'parameter' ? expression.threshold.name : null,
      });
    }
    return {
      node: 'compare',
      select: expression.select,
      operator: expression.operator,
      threshold: { kind: 'constant', value },
    };
  }
  return {
    node: expression.node,
    children: expression.children.map(child => resolveExpression(child, numeric, location)),
  };
}

function checkExpressionBudget(expression: TriggerExpression, location: TriggerResolutionLocation): void {
  const budget = expressionBudget(expression);
  if (budget.nodes > TRIGGER_LIMITS.max_nodes || budget.depth > TRIGGER_LIMITS.max_depth) {
    fail('TRIGGER_EXPRESSION_BUDGET', location);
  }
}

async function readRule(
  catalog: TriggerRuleCatalogPort,
  ref: RuleRef,
  location: TriggerResolutionLocation,
  seen: Map<string, string>,
): Promise<TriggerRuleVersion> {
  let raw: unknown;
  try {
    raw = await catalog.getVersion(ref.rule_id, ref.version);
  } catch {
    fail('TRIGGER_RULE_READ_FAILED', location);
  }
  if (raw === null || raw === undefined) fail('TRIGGER_RULE_MISSING', location);
  const parsed = TriggerRuleVersionSchema.safeParse(raw);
  if (!parsed.success) fail('TRIGGER_RULE_INVALID', location);
  const rule = parsed.data;
  if (rule.rule_id !== ref.rule_id || rule.version !== ref.version) fail('TRIGGER_RULE_IDENTITY', location);
  const { content_hash: declared, ...body } = rule;
  const recomputed = triggerRuleContentHash(body);
  if (declared !== recomputed) fail('TRIGGER_RULE_HASH_MISMATCH', location);

  const key = `${rule.rule_id}@${rule.version}`;
  const cached = seen.get(key);
  // The same identity must denote the same body within one resolution; a catalog
  // that changes under us is a conflict, never "last read wins".
  if (cached !== undefined && cached !== recomputed) fail('TRIGGER_RULE_CONFLICT', location);
  seen.set(key, recomputed);
  return rule;
}

function resolveOne(
  rule: TriggerRuleVersion,
  ref: RuleRef,
  pin: { pin: TemplatePin; items: Array<{ item_id: string; version: number; canonical_metric: TriggerRuleCandidate['metric']; unit: TriggerRuleCandidate['unit']; dimensions: TriggerRuleCandidate['dimensions'] }> },
  selected: Map<string, SelectedItem[]>,
  overrides: Record<string, unknown> | undefined,
): TriggerRuleCandidate {
  const location: TriggerResolutionLocation = {
    pin: copyPin(pin.pin),
    template_id: pin.pin.template_id,
    item_id: ref.scope.slice('item:'.length),
    rule_id: rule.rule_id,
    rule_version: rule.version,
    parameter: null,
  };

  checkExpressionBudget(rule.problem, location);
  checkExpressionBudget(rule.recovery, location);

  const itemId = location.item_id!;
  const stored = pin.items.filter(item => item.item_id === itemId);
  if (stored.length === 0) fail('TRIGGER_ITEM_UNKNOWN', location);
  if (stored.length > 1) fail('TRIGGER_ITEM_AMBIGUOUS', location);
  const item = stored[0];

  const selectedFor = selected.get(`${pin.pin.template_id}\u0000${itemId}`) ?? [];
  if (selectedFor.length === 0) fail('TRIGGER_ITEM_UNKNOWN', location);
  if (selectedFor.length > 1) fail('TRIGGER_ITEM_AMBIGUOUS', location);
  const selection = selectedFor[0];
  if (selection.item_version !== item.version) fail('TRIGGER_ITEM_MISMATCH', location);

  if (rule.metric.id !== item.canonical_metric.id) fail('TRIGGER_METRIC_MISMATCH', location);
  if (rule.metric.semantic_version !== item.canonical_metric.semantic_version) {
    fail('TRIGGER_SEMANTIC_VERSION_MISMATCH', location);
  }
  if (rule.unit !== item.unit) fail('TRIGGER_UNIT_MISMATCH', location);

  for (const name of referencedParameters(rule.problem).concat(referencedParameters(rule.recovery))) {
    const spec = rule.parameters.schema[name];
    if (spec === undefined) fail('TRIGGER_PARAMETER_UNKNOWN', { ...location, parameter: name });
    if (spec.type !== 'number' && spec.type !== 'integer') {
      fail('TRIGGER_PARAMETER_TYPE', { ...location, parameter: name });
    }
  }

  const parameters = resolveParameters(rule, overrides, location);
  const problem = resolveExpression(rule.problem, parameters.numeric, location);
  const recovery = resolveExpression(rule.recovery, parameters.numeric, location);

  return {
    rule_id: rule.rule_id,
    version: rule.version,
    body_hash: rule.content_hash,
    scope: rule.scope,
    item: { template_id: pin.pin.template_id, item_id: item.item_id, item_version: item.version },
    metric: { ...item.canonical_metric },
    unit: item.unit,
    dimensions: { ...item.dimensions },
    decision: selection.decision,
    parameters: parameters.list,
    problem,
    recovery,
    quality: { ...rule.quality, accepted_quality: [...rule.quality.accepted_quality] },
    clock: { ...rule.clock },
  };
}

/**
 * Resolve every trigger reference of an accepted B2C resolution into one
 * candidate set. Contract and behavior:
 *
 * - The resolution is re-verified through the accepted B1 preflight against the
 *   supplied trusted template port; a resolution that does not match the pins,
 *   content hashes or trigger references of the fixed versions is rejected.
 * - Each reference is read by exact identity from the catalog; a hash-mismatched
 *   or duplicate body, a missing version and a wrong scope/item/metric/unit are
 *   stable rejections, never fallbacks.
 * - Parameters come from the rule's own schema/defaults plus explicit caller
 *   input only; unresolved, unknown, mistyped or out-of-range values reject.
 * - The returned value is a candidate, is deeply frozen, mutates neither input,
 *   and is not evidence that any rule is persisted, applied or in effect.
 */
export async function resolveTriggerRules(
  resolution: ResolvedTemplateBinding,
  catalog: TriggerRuleCatalogPort,
  templates: TemplateVersionReadPort,
  options: TriggerResolutionOptions = {},
): Promise<TriggerRuleCandidateSet> {
  validateResolution(resolution);
  const preflight = await verifyPins(resolution, templates);
  const selected = selectedItems(resolution);
  const seen = new Map<string, string>();
  const overrides = options.parameter_overrides ?? {};

  const rules: TriggerRuleCandidate[] = [];
  for (const pin of preflight.pins) {
    for (const ref of pin.triggers) {
      const location: TriggerResolutionLocation = {
        pin: copyPin(pin.pin), template_id: pin.pin.template_id, item_id: ref.scope.slice('item:'.length),
        rule_id: ref.rule_id, rule_version: ref.version, parameter: null,
      };
      const rule = await readRule(catalog, ref, location, seen);
      rules.push(resolveOne(rule, ref, { pin: pin.pin, items: pin.items.map(item => ({
        item_id: item.item_id, version: item.version, canonical_metric: item.canonical_metric,
        unit: item.unit, dimensions: item.dimensions,
      })) }, selected, overrides[rule.rule_id]));
      if (rules.length > TRIGGER_LIMITS.max_rules) fail('TRIGGER_RULE_BUDGET', location);
    }
  }

  rules.sort((left, right) => compare(left.item.template_id, right.item.template_id)
    || compare(left.item.item_id, right.item.item_id)
    || compare(left.rule_id, right.rule_id)
    || left.version - right.version);

  return frozenCopy({
    kind: 'trigger_candidate' as const,
    internal: true as const,
    persisted: false as const,
    applied: false as const,
    effective: false as const,
    status: 'candidate' as const,
    resource: { type: resolution.resource.type, id: resolution.resource.id },
    config_revision: resolution.revision,
    plan_identity: templateResolutionIdentity(resolution),
    templates: preflight.pins.map(pin => copyTemplatePin(pin.pin)),
    rules,
  } as TriggerRuleCandidateSet);
}
