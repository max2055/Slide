import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry, builtinReleases } from '../packages/builtins.js';
import { sealRelease } from '../packages/model.js';
import { resolvePolicy } from './resolver.js';
import { retainCapabilities } from './store.js';
import { binding, resource, capabilities, at } from './test-support.js';
import { OverridesSchema, type Overrides } from './model.js';

describe('policy resolution', () => {
  it.each([
    [{}, {}, 60000, 'package'],
    [{ interval_ms: { mode: 'set', value: 30000 } }, {}, 30000, 'group'],
    [{ interval_ms: { mode: 'set', value: 30000 } }, { interval_ms: { mode: 'set', value: 10000 } }, 10000, 'resource'],
    [{ interval_ms: { mode: 'set', value: 30000 } }, { interval_ms: { mode: 'inherit' } }, 30000, 'group'],
  ])('resolves inheritance with value provenance', (g, r, value, source) => {
    const b = { ...binding(), group_id: 'g', overrides: r as Overrides };
    const group = { id: 'g', revision: 2, overrides: g as Overrides };
    const resolve = () => resolvePolicy(createBuiltinRegistry(), b, group, resource(), capabilities(), at);
    const result = resolve(); expect(result.settings.interval_ms).toBe(value); expect(result.sources.interval_ms.layer).toBe(source);
    expect(result).toEqual(resolve()); expect(result.plan.entries[2].decision).toBe('derive');
    expect(result.plan.entries[0].binding.source).toEqual({ kind: 'collector', collector_id: 'mysql-status', raw_field: 'Uptime' });
  });
  it.each(['inherit', 'enable', 'disable'] as const)('supports enabled tri-state %s', mode => {
    const b = { ...binding(), group_id: 'g', overrides: { enabled: mode } };
    const result = resolvePolicy(createBuiltinRegistry(), b, { id: 'g', revision: 1, overrides: { enabled: 'disable' } }, resource(), capabilities(), at);
    expect(result.settings.enabled).toBe(mode === 'enable');
    expect(result.impact.requests_per_hour_estimate).toBe(mode === 'enable' ? 60 : 0);
  });
  it.each([
    { interval_ms: { mode: 'set', value: 999 } }, { timeout_ms: { mode: 'set', value: 30001 } },
    { timeout_ms: { mode: 'set', value: 20000 }, interval_ms: { mode: 'set', value: 10000 } },
    { stale_after_ms: { mode: 'set', value: 1000 } }, { max_counter_gap_ms: { mode: 'set', value: 1000 } },
    { max_rows: { mode: 'set', value: 101 } }, { max_concurrency: { mode: 'set', value: 17 } },
    { max_series_per_resource: { mode: 'set', value: 10001 } },
    { metrics: { 'mysql.queries.total@1.0.0': 'disable' } },
    { metrics: { 'does.not.exist@1.0.0': 'disable' } },
  ])('rejects invalid timing, budgets or dependencies %#', overrides => {
    expect(() => resolvePolicy(createBuiltinRegistry(), { ...binding(), overrides: overrides as Overrides }, null, resource(), [], at)).toThrow();
  });
  it('disables dependencies explicitly and reports affected metrics without altering registry', () => {
    const registry = createBuiltinRegistry(), before = registry.get(binding().package);
    const overrides: Overrides = { metrics: { 'mysql.queries.total@1.0.0': 'disable', 'mysql.queries.per_second@1.0.0': 'disable' } };
    const result = resolvePolicy(registry, { ...binding(), overrides }, null, resource(), [], at);
    expect(result.impact.disabled_metrics).toHaveLength(2); expect(result.impact.active_collectors).toEqual(['mysql-status']);
    expect(registry.get(binding().package)).toEqual(before);
    expect(resolvePolicy(registry, binding(2), null, resource(2), [], at).impact.disabled_metrics).toEqual([]);
  });
  it('keeps user coverage on upgrade and rollback, inherited values follow the new pin', () => {
    const registry = createBuiltinRegistry(), old = builtinReleases()[0];
    const next = sealRelease({ ...old, package: { ...old.package, version: '1.1.0' }, recommendations: { ...old.recommendations, interval_ms: 90000 } });
    registry.install(next);
    const { id, version, digest } = next.package;
    const b = { ...binding(), overrides: { timeout_ms: { mode: 'set' as const, value: 4000 } } };
    const upgraded = resolvePolicy(registry, { ...b, package: { id, version, digest } }, null, resource(), [], at);
    expect(upgraded.settings.interval_ms).toBe(90000); expect(upgraded.settings.timeout_ms).toBe(4000);
    expect(resolvePolicy(registry, b, null, resource(), [], at).settings.interval_ms).toBe(60000);
  });
  it('distinguishes unknown, permission denied, unsupported and timeout, preserving evidence timestamps', () => {
    const registry = createBuiltinRegistry(), caps = capabilities();
    expect(resolvePolicy(registry, binding(), null, resource(), [], at).plan.entries[0].decision).toBe('capability_unknown');
    caps[0].status = 'unknown'; caps[0].basis = [{ kind: 'permission', evidence: 'permission_denied' }];
    const denied = resolvePolicy(registry, binding(), null, resource(), caps, at).plan.entries[0];
    expect(denied.decision).toBe('capability_unknown'); expect(denied.capability).toEqual(caps[0]);
    const r = resource(); r.attributes['db.engine'].value = 'mariadb';
    expect(resolvePolicy(registry, binding(), null, r, caps, at).plan.entries[0].decision).toBe('unsupported');
    const prior = capabilities(), retained = retainCapabilities(prior, caps, 'timeout');
    expect(retained).toEqual(prior); expect(retained).not.toBe(prior);
    expect(resolvePolicy(registry, binding(), null, resource(), retained, at).plan.entries[0].capability).toEqual(prior[0]);
    expect(resolvePolicy(registry, binding(), null, resource(), prior, '2026-09-20T00:00:00.000Z').plan.entries[0].decision).toBe('capability_unknown');
  });
  it('exposes collector timeout cap and rejects secrets/unknown fields', () => {
    const result = resolvePolicy(createBuiltinRegistry(), { ...binding(), overrides: { timeout_ms: { mode: 'set', value: 10000 } } }, null, resource(), [], at);
    expect(result.collector_timeouts[0]).toMatchObject({ timeout_ms: 5000, source: { layer: 'package' } });
    expect(() => OverridesSchema.parse({ password: 'secret' })).toThrow();
  });
  it.each([1, 2])('resolves the representative SSH/SNMP package %s without fabricating dimensions', index => {
    const release = builtinReleases()[index], p = release.package;
    const b = { ...binding(), resource: { type: p.resource_type, id: 1 }, package: { id: p.id, version: p.version, digest: p.digest } };
    const result = resolvePolicy(createBuiltinRegistry(), b, null, { type: p.resource_type, id: '1', attributes: {} }, [], at);
    expect(result.impact.requests_per_hour_estimate).toBe(index === 1 ? 120 : 60);
    expect(result.metric_templates[0].decision).toBe('capability_unknown');
    if (index === 2) {
      expect(result.plan.entries).toEqual([]);
      expect(result.metric_templates[0].required_dimensions).toEqual(['if_index', 'interface_epoch']);
      expect(result.impact.estimated_series_upper_bound).toBe(100);
    }
  });
  it('rejects a total series budget smaller than the enabled output set', () => {
    expect(() => resolvePolicy(createBuiltinRegistry(), { ...binding(), overrides: { max_series_per_resource: { mode: 'set', value: 1 } } }, null, resource(), [], at)).toThrow('POLICY_SERIES_BUDGET');
  });
});
