import { describe, expect, it, vi } from 'vitest';
import type { TriggerRuleVersion } from '../../contracts/metrics/triggers.js';
import { resolveTemplateBinding, templateResolutionIdentity, type ResolvedTemplateBinding } from '../bindings/resolve.js';
import {
  AT, FixtureCatalog, alpha, baseline, beta, bindingOf, capabilities, fixtureRegistry, fixtureRelease,
  item, metricRef, pinOf, portOf, resource, templateVersion, thresholdRule, type Baseline,
} from './test-support.js';
import { resolveTriggerRules, TriggerResolutionError, type TriggerRuleCatalogPort } from './resolve.js';

const single = { triggers: [{ rule_id: 'alpha-threshold', scope: 'item:alpha' as const, version: 1 }] };

async function failure(promise: Promise<unknown>): Promise<TriggerResolutionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TriggerResolutionError);
    return error as TriggerResolutionError;
  }
  throw new Error('expected the resolution to reject');
}

function catalogOf(read: (ruleId: string, version: number) => unknown): TriggerRuleCatalogPort {
  return { getVersion: vi.fn(async (ruleId: string, version: number) => read(ruleId, version)) };
}

async function resolveWith(
  base: Baseline,
  rules: TriggerRuleVersion[],
  options: Parameters<typeof resolveTriggerRules>[3] = {},
) {
  return resolveTriggerRules(base.resolution, new FixtureCatalog(rules), portOf([base.version]).port, options);
}

describe('fixed-version trigger resolution', () => {
  it('resolves the real B2C resolution into a frozen candidate with resolved parameters', async () => {
    const base = await baseline();
    const before = structuredClone({ resolution: base.resolution, rules: base.rules });

    const candidate = await resolveTriggerRules(base.resolution, base.catalog, portOf([base.version]).port);

    expect(candidate.kind).toBe('trigger_candidate');
    expect(candidate.internal).toBe(true);
    expect(candidate.persisted).toBe(false);
    expect(candidate.applied).toBe(false);
    expect(candidate.effective).toBe(false);
    expect(candidate.status).toBe('candidate');
    expect(candidate.resource).toEqual({ type: 'instance', id: '7' });
    expect(candidate.config_revision).toBe(4);
    expect(candidate.plan_identity).toBe(templateResolutionIdentity(base.resolution));
    expect(candidate.templates).toEqual([pinOf(base.version)]);

    expect(candidate.rules.map(entry => entry.rule_id)).toEqual(['alpha-average', 'alpha-threshold']);
    const threshold = candidate.rules.find(entry => entry.rule_id === 'alpha-threshold')!;
    expect(threshold.item).toEqual({ template_id: 'tpl-monitoring', item_id: 'alpha', item_version: 1 });
    expect(threshold.scope).toBe('item:alpha');
    expect(threshold.metric).toEqual(metricRef(alpha));
    expect(threshold.unit).toBe('1');
    expect(threshold.dimensions).toEqual({});
    expect(threshold.decision).toBe('collect');
    expect(threshold.body_hash).toBe(base.rules.find(rule => rule.rule_id === 'alpha-threshold')!.content_hash);
    expect(threshold.parameters).toEqual([
      { name: 'problem_threshold', type: 'number', value: 90, source: 'default' },
      { name: 'recovery_threshold', type: 'number', value: 70, source: 'default' },
    ]);
    // Parameters are resolved at compile time: no parameter survives in the AST.
    expect(threshold.problem).toEqual({
      node: 'compare', select: { aggregation: 'last' }, operator: '>', threshold: { kind: 'constant', value: 90 },
    });
    expect(threshold.recovery).toEqual({
      node: 'compare', select: { aggregation: 'last' }, operator: '<', threshold: { kind: 'constant', value: 70 },
    });
    expect(threshold.quality.min_coverage).toBe(1);
    expect(threshold.clock).toEqual({ stale_after_ms: 120000, nodata: { enabled: true, after_ms: 300000 } });

    const average = candidate.rules.find(entry => entry.rule_id === 'alpha-average')!;
    expect(average.problem).toEqual({
      node: 'compare', select: { aggregation: 'avg', window_ms: 60000 }, operator: '>=',
      threshold: { kind: 'constant', value: 80 },
    });

    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.rules)).toBe(true);
    expect(Object.isFrozen(candidate.rules[0].problem)).toBe(true);
    expect(structuredClone({ resolution: base.resolution, rules: base.rules })).toEqual(before);
  });

  it('applies an explicit numeric override without leaking it to another rule', async () => {
    const base = await baseline();
    const candidate = await resolveWith(base, base.rules, {
      parameter_overrides: { 'alpha-threshold': { problem_threshold: 95 } },
    });
    const threshold = candidate.rules.find(entry => entry.rule_id === 'alpha-threshold')!;
    expect(threshold.parameters.find(entry => entry.name === 'problem_threshold'))
      .toEqual({ name: 'problem_threshold', type: 'number', value: 95, source: 'override' });
    expect(threshold.problem).toEqual({
      node: 'compare', select: { aggregation: 'last' }, operator: '>', threshold: { kind: 'constant', value: 95 },
    });
    // The other rule keeps its own defaults.
    const average = candidate.rules.find(entry => entry.rule_id === 'alpha-average')!;
    expect(average.parameters.every(entry => entry.source === 'default')).toBe(true);
  });

  it('rejects a missing, invalid, foreign or stale-hash rule version', async () => {
    const base = await baseline(single);

    const missing = await failure(resolveTriggerRules(base.resolution, new FixtureCatalog([]), portOf([base.version]).port));
    expect(missing.code).toBe('TRIGGER_RULE_MISSING');

    const invalid = await failure(resolveTriggerRules(base.resolution,
      catalogOf(() => ({ rule_id: 'alpha-threshold' })), portOf([base.version]).port));
    expect(invalid.code).toBe('TRIGGER_RULE_INVALID');

    const foreign = await failure(resolveTriggerRules(base.resolution,
      catalogOf(() => ({ ...thresholdRule(), rule_id: 'other-rule' })),
      portOf([base.version]).port));
    expect(foreign.code).toBe('TRIGGER_RULE_IDENTITY');

    const staleHash = thresholdRule();
    staleHash.content_hash = `sha256:${'a'.repeat(64)}`;
    const stale = await failure(resolveWith(base, [staleHash]));
    expect(stale.code).toBe('TRIGGER_RULE_HASH_MISMATCH');

    const unreadable = await failure(resolveTriggerRules(base.resolution,
      catalogOf(() => { throw new Error('driver detail must not leak'); }),
      portOf([base.version]).port));
    expect(unreadable.code).toBe('TRIGGER_RULE_READ_FAILED');
    expect(JSON.stringify(unreadable)).not.toContain('driver detail');
  });

  it('rejects one rule identity shared by two item scopes', async () => {
    // A single catalog body has exactly one scope, so it cannot serve two item
    // references of one template. The second reference is a scope mismatch, never
    // a second resolution of the same body.
    const release = fixtureRelease();
    const version = templateVersion({
      template_id: 'tpl-monitoring',
      items: [item('tpl-monitoring', 'alpha', alpha, release), item('tpl-monitoring', 'beta', beta, release)],
      triggers: [
        { rule_id: 'alpha-threshold', scope: 'item:alpha', version: 1 },
        { rule_id: 'alpha-threshold', scope: 'item:beta', version: 1 },
      ],
    });
    const resolution = await resolveTemplateBinding(
      bindingOf([pinOf(version)]),
      { resource: resource(), group: null, capabilities: capabilities(), at: AT },
      portOf([version]).port,
      fixtureRegistry(),
    ) as ResolvedTemplateBinding;
    const first = thresholdRule();
    const revised = thresholdRule({ clock: { stale_after_ms: 60000, nodata: { enabled: false } } });
    let call = 0;
    // The catalog changing between reads cannot hide the scope mismatch.
    const catalog = catalogOf(() => (call++ === 0 ? first : revised));
    const error = await failure(resolveTriggerRules(resolution, catalog, portOf([version]).port));
    expect(error.code).toBe('TRIGGER_RULE_SCOPE');
  });

  it('rejects a rule whose metric, semantic version or unit disagrees with the fixed item', async () => {
    const base = await baseline(single);
    const wrongMetric = await failure(resolveWith(base, [thresholdRule({ metric: { id: 'fixture.beta', semantic_version: '1.0.0' } })]));
    expect(wrongMetric.code).toBe('TRIGGER_METRIC_MISMATCH');

    const wrongVersion = await failure(resolveWith(base, [thresholdRule({ metric: { id: 'fixture.alpha', semantic_version: '2.0.0' } })]));
    expect(wrongVersion.code).toBe('TRIGGER_SEMANTIC_VERSION_MISMATCH');

    const wrongUnit = await failure(resolveWith(base, [thresholdRule({ unit: 'count' })]));
    expect(wrongUnit.code).toBe('TRIGGER_UNIT_MISMATCH');
  });

  it('rejects a catalog body that resolves another item scope', async () => {
    const base = await baseline(single);
    // The reference pins item:alpha; a body whose own scope is item:beta is not
    // that rule even when its metric and unit still match item:alpha.
    const otherScope = thresholdRule({ scope: 'item:beta' });
    const error = await failure(resolveWith(base, [otherScope]));
    expect(error.code).toBe('TRIGGER_RULE_SCOPE');
    expect(error.location.rule_id).toBe('alpha-threshold');
    expect(error.location.item_id).toBe('alpha');
  });

  it('rejects an item the fixed template does not select', async () => {
    const base = await baseline(single);
    const emptied = structuredClone(base.resolution);
    emptied.releases[0].collectors[0].items = [];
    const unknown = await failure(resolveTriggerRules(emptied, base.catalog, portOf([base.version]).port));
    expect(unknown.code).toBe('TRIGGER_ITEM_UNKNOWN');

    const retargeted = structuredClone(base.resolution);
    retargeted.releases[0].collectors[0].items[0].item_version = 2;
    const mismatch = await failure(resolveTriggerRules(retargeted, base.catalog, portOf([base.version]).port));
    expect(mismatch.code).toBe('TRIGGER_ITEM_MISMATCH');
  });

  it('rejects unresolved, unknown, mistyped and out-of-range parameters', async () => {
    const base = await baseline(single);

    const unresolvedRule = thresholdRule({
      parameters: { schema: { problem_threshold: { type: 'number', min: 0, max: 1000 }, recovery_threshold: { type: 'number' } }, defaults: { recovery_threshold: 70 } },
    });
    expect((await failure(resolveWith(base, [unresolvedRule]))).code).toBe('TRIGGER_PARAMETER_UNRESOLVED');

    const unknownRef = thresholdRule({
      problem: { node: 'compare', select: { aggregation: 'last' }, operator: '>', threshold: { kind: 'parameter', name: 'ghost' } },
    });
    expect((await failure(resolveWith(base, [unknownRef]))).code).toBe('TRIGGER_PARAMETER_UNKNOWN');

    const booleanThreshold = thresholdRule({
      parameters: { schema: { problem_threshold: { type: 'boolean' }, recovery_threshold: { type: 'number' } }, defaults: { problem_threshold: true, recovery_threshold: 70 } },
    });
    expect((await failure(resolveWith(base, [booleanThreshold]))).code).toBe('TRIGGER_PARAMETER_TYPE');

    const outOfRange = await failure(resolveWith(base, [thresholdRule()], {
      parameter_overrides: { 'alpha-threshold': { problem_threshold: 5000 } },
    }));
    expect(outOfRange.code).toBe('TRIGGER_PARAMETER_RANGE');

    const wrongType = await failure(resolveWith(base, [thresholdRule()], {
      parameter_overrides: { 'alpha-threshold': { problem_threshold: 'high' } },
    }));
    expect(wrongType.code).toBe('TRIGGER_PARAMETER_TYPE');

    // A declared default is validated the same way: a non-numeric default for a
    // numeric parameter is a type failure, not a range failure.
    const mistypedDefault = thresholdRule({
      parameters: {
        schema: { problem_threshold: { type: 'number', min: 0, max: 1000 }, recovery_threshold: { type: 'number', min: 0, max: 1000 } },
        defaults: { problem_threshold: 'high', recovery_threshold: 70 },
      },
    });
    expect((await failure(resolveWith(base, [mistypedDefault]))).code).toBe('TRIGGER_PARAMETER_TYPE');

    const unknownOverride = await failure(resolveWith(base, [thresholdRule()], {
      parameter_overrides: { 'alpha-threshold': { ghost: 1 } },
    }));
    expect(unknownOverride.code).toBe('TRIGGER_PARAMETER_UNKNOWN');
  });

  it('rejects an expression over the declared depth budget', async () => {
    const base = await baseline(single);
    const leaf = { node: 'compare' as const, select: { aggregation: 'last' as const }, operator: '>' as const, threshold: { kind: 'constant' as const, value: 1 } };
    let expression: TriggerRuleVersion['problem'] = leaf;
    for (let depth = 0; depth < 6; depth += 1) expression = { node: 'all', children: [expression, leaf] };
    const deep = thresholdRule({ problem: expression });
    const error = await failure(resolveWith(base, [deep]));
    expect(error.code).toBe('TRIGGER_EXPRESSION_BUDGET');
  });

  it('rejects a rule set over the snapshot budget', async () => {
    const rules: TriggerRuleVersion[] = [];
    const triggers = [];
    for (let index = 0; index < 65; index += 1) {
      const id = `rule-${String(index).padStart(3, '0')}`;
      rules.push(thresholdRule({ rule_id: id }));
      triggers.push({ rule_id: id, scope: 'item:alpha' as const, version: 1 });
    }
    const base = await baseline({ rules, triggers });
    const error = await failure(resolveWith(base, rules));
    expect(error.code).toBe('TRIGGER_RULE_BUDGET');
  });

  it('rejects a resolution that does not match the fixed pins it claims', async () => {
    const base = await baseline(single);

    const tamperedPin = structuredClone(base.resolution);
    tamperedPin.binding.template_pins[0].content_hash = `sha256:${'b'.repeat(64)}`;
    expect((await failure(resolveTriggerRules(tamperedPin, base.catalog, portOf([base.version]).port))).code)
      .toBe('TRIGGER_TEMPLATE_HASH_MISMATCH');

    const tamperedRefs = structuredClone(base.resolution);
    tamperedRefs.triggers[0].refs = [];
    expect((await failure(resolveTriggerRules(tamperedRefs, base.catalog, portOf([base.version]).port))).code)
      .toBe('TRIGGER_RESOLUTION_MISMATCH');

    const notAResolution = { kind: 'legacy_delegate', internal: true, persisted: false, applied: false };
    expect((await failure(resolveTriggerRules(notAResolution as never, base.catalog, portOf([base.version]).port))).code)
      .toBe('TRIGGER_INPUT_INVALID');
  });
});
