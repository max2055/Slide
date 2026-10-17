/** Synthetic samples, separate from real source/SQL/HTTP integration. */
import { describe, expect, it, vi } from 'vitest';
import { identify, sample, definitions } from '../../contracts/metrics/fixtures.js';
import type { NormalizedObservation } from '../../contracts/metrics/index.js';
import { FormalBaselineSource, HOUR, DAY, baselineIdentity, type BaselineInput } from './source-adapter.js';
import { calculateBaseline } from './calculator.js';

describe('P04 formal source adapter synthetic counterexamples', () => {
  const now = Date.parse('2026-10-17T12:00:30Z');
  const input: BaselineInput = { resource: { type: 'instance', id: 1 }, metric: 'db.uptime_seconds', dimensions: {}, mode: 'daily' };
  const setup = (id = input.metric) => {
    const definition = structuredClone(definitions.find(d => d.id === id)!);
    const current = { ...input, metric: id, resource: { type: definition.resource_type, id: 1 }, dimensions: sample(id).dimensions };
    const point = (at: number, value = 30): NormalizedObservation => identify({ ...sample(id), resource_id: '1',
      observed_at: new Date(at).toISOString(), collected_at: new Date(at).toISOString(), stored_at: new Date(at).toISOString(),
      value: definition.kind === 'counter' ? { encoding: 'uint64', value: String(value) } : { encoding: 'float64', value },
      accuracy: 'exact', ...(definition.kind === 'counter' ? { counter: { start_at: '2026-09-01T00:00:00Z', bits: '64' as const } } : {}) });
    const rows = [point(now - 90_000), point(now - 30_000)];
    const catalog: any = { definitions: [definition], effective: { published_revision: 1,
      application: { status: 'applied', applied_revision: 1 }, resolved: { settings: { interval_ms: 60_000, enabled: true, stale_after_ms: 120_000, max_counter_gap_ms: 180_000 },
        metric_templates: [{ metric: { id, semantic_version: definition.semantic_version }, enabled: true,
          capability: { status: 'supported', valid_until: new Date(now + DAY).toISOString() } }] } } };
    const queryWindow = vi.fn(async (_series: any, from: string, to: string) => {
      const fromMs = Date.parse(from), toMs = Date.parse(to);
      return [...rows.filter(p => Date.parse(p.observed_at) < fromMs).slice(-1),
        ...rows.filter(p => Date.parse(p.observed_at) >= fromMs && Date.parse(p.observed_at) < toMs),
        ...rows.filter(p => Date.parse(p.observed_at) >= toMs).slice(0, 1)];
    });
    const consumer = { discover: vi.fn(async () => catalog) };
    const source = new FormalBaselineSource({ queryWindow }, consumer, () => new Date(now));
    return { source, current, rows, catalog, point, definition, queryWindow };
  };
  const actor = { userId: 1, username: 'fixture', roles: [], permissions: ['*'], instanceScopes: {}, sessionVersion: 1, requestId: 'p04' };
  it('reads only the supplied formal query port and preserves missing history as unknown', async () => {
    const f = setup(), result = await f.source.load(actor, f.current, 'fence', 'target');
    expect(result.reason).toBeNull(); expect(result.latest.value).toBe(30);
    expect(result.identity).toMatchObject({ metric: 'db.uptime_seconds@1.0.0', unit: 's', configurationVersion: '1' });
    expect(calculateBaseline(f.current, result)).toMatchObject({ status: 'unknown', reason: 'long_gap' });
    expect(f.queryWindow.mock.calls.every(c => Date.parse(c[2]) - Date.parse(c[1]) <= DAY)).toBe(true);
  });
  it.each(['source', 'unit', 'dimension', 'semantic', 'config', 'transform', 'package'] as const)('never combines a changed %s', async fault => {
    const f = setup(), p = f.rows[0];
    if (fault === 'source') p.source.collector_id = 'replacement';
    if (fault === 'unit') p.unit = 'ms';
    if (fault === 'dimension') p.dimensions = { rogue: '1' };
    if (fault === 'semantic') p.metric.semantic_version = '2.0.0';
    if (fault === 'config') p.versions.config_revision = 2;
    if (fault === 'transform') p.versions.transform_version = '2.0.0';
    if (fault === 'package') p.versions.package_version = '2.0.0';
    expect((await f.source.load(actor, f.current, 'f', 't')).reason).not.toBeNull();
  });
  it.each(['future', 'stale', 'late', 'invalid', 'partial', 'unsafe_integer'] as const)('fails closed for %s input', async fault => {
    const f = setup(), p = f.rows[1];
    if (fault === 'future') { p.observed_at = new Date(now + 1000).toISOString(); p.collected_at = p.observed_at; }
    if (fault === 'stale') { f.rows.splice(0); f.rows.push(f.point(now - HOUR)); }
    if (fault === 'late') { p.observed_at = new Date(now - 180_000).toISOString(); }
    if (fault === 'invalid') p.quality = { status: 'invalid', reason: 'source_error' };
    if (fault === 'partial') p.quality = { status: 'partial', reason: 'partial_input' };
    if (fault === 'unsafe_integer') p.value = { encoding: 'uint64', value: '9007199254740993' };
    expect((await f.source.load(actor, f.current, 'f', 't')).reason).not.toBeNull();
  });
  it('does not enable disabled collection or read values before capability/application readiness', async () => {
    const f = setup(); f.catalog.effective.resolved.settings.enabled = false;
    expect((await f.source.load(actor, f.current, 'f', 't')).reason).toBe('collection_disabled'); expect(f.queryWindow).not.toHaveBeenCalled();
    f.catalog.effective.resolved.settings.enabled = true; f.catalog.effective.resolved.metric_templates[0].capability.status = 'unknown';
    expect((await f.source.load(actor, f.current, 'f', 't')).reason).toBe('capability_unknown');
    f.catalog.effective.resolved.metric_templates[0].capability.status = 'supported'; f.catalog.effective.application.status = 'pending';
    expect((await f.source.load(actor, f.current, 'f', 't')).reason).toBe('configuration_pending');
  });
  it('uses exact cumulative-counter semantics, never subtracts unsafe JS integers', async () => {
    const f = setup('host.network.bytes_total');
    f.rows[0].value = { encoding: 'uint64', value: '9007199254746993' };
    f.rows[1].value = { encoding: 'uint64', value: '9007199254747113' };
    const result = await f.source.load(actor, f.current, 'f', 't');
    expect(result.reason).toBeNull(); expect(result.identity!.unit).toBe('By/s'); expect(result.latest.value).toBe(2);
    const epoch = baselineIdentity(f.rows[1], f.definition, 't').counterEpoch;
    f.rows[1].counter!.start_at = '2026-10-17T00:00:00Z';
    expect(baselineIdentity(f.rows[1], f.definition, 't').counterEpoch).not.toBe(epoch);
    expect((await f.source.load(actor, f.current, 'f', 't')).reason).toBe('series_identity_changed');
  });
  it('detects an unexplained counter decrease even without new epoch metadata', async () => {
    const f = setup('host.network.bytes_total'); f.rows[0].value = { encoding: 'uint64', value: '300' };
    f.rows[1].value = { encoding: 'uint64', value: '5' };
    expect((await f.source.load(actor, f.current, 'f', 't')).reason).toBe('counter_reset');
  });
  it('propagates unrecoverable storage overflow instead of truncating', async () => {
    const f = setup(); f.queryWindow.mockRejectedValue(new Error('QUERY_LIMIT_EXCEEDED'));
    await expect(f.source.load(actor, f.current, 'f', 't')).rejects.toThrow('QUERY_LIMIT_EXCEEDED');
  });
});
