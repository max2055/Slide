/** Synthetic inputs only; never count as real qualification. */
import { DAY, HOUR, type BaselineInput, type BaselineSourceWindow } from './source-adapter.js';

export const syntheticInput: BaselineInput = { resource: { type: 'server', id: 1 }, metric: 'host.cpu.used_ratio', dimensions: {}, mode: 'daily', staticThreshold: { operator: '>', value: 80 } };
export function syntheticWindow(mode: BaselineInput['mode'] = 'daily'): BaselineSourceWindow {
  const until = Date.parse('2026-10-17T12:00:00Z'), from = until - (mode === 'daily' ? 14 : 28) * DAY;
  return { identity: { resource: syntheticInput.resource, metric: 'host.cpu.used_ratio@1.0.0', unit: '%', dimensions: {},
    source: { id: 'fixture', bindingId: 'fixture', version: '1' }, configurationVersion: '1', transformVersion: '1', counterEpoch: null },
  from: new Date(from).toISOString(), until: new Date(until).toISOString(), evaluatedAt: new Date(until + 1000).toISOString(),
  validUntil: new Date(until + HOUR).toISOString(), intervalMs: 60_000, maxGapMs: 300_000, reason: null,
  latest: { value: 40, observedAt: new Date(until).toISOString() }, fence: 'fixture',
  buckets: Array.from({ length: (until - from) / HOUR }, (_, i) => ({ contract_version: '1.0.0',
    metric: { id: 'host.cpu.used_ratio', semantic_version: '1.0.0' }, unit: '%', dimensions: {},
    window: { from: new Date(from + i * HOUR).toISOString(), to: new Date(from + (i + 1) * HOUR).toISOString() },
    value: { encoding: 'float64', value: 40 }, quality: { status: 'good', reason: 'none' }, accuracy: 'exact', coverage: 1,
    freshness: 'stale', sample_count: 60, stats: null, sources: [] })) };
}
