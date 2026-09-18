import type { MetricDefinition } from '../contracts/metrics-v2/definitions.js';
import type { ObservationRow } from '../resources/observation-service.js';
import type { MysqlMetricStorage, Series, StoredObservation } from './storage.js';

export function legacyObservation(row: ObservationRow, source: string) {
  return { ...row, provenance: { contract: 'legacy' as const, source, semantic_version: null, config_revision: null },
    quality: { status: 'unknown' as const, reason: 'legacy_unknown' as const }, accuracy: 'unknown' as const };
}

/** Explicit opt-in boundary. No automatic ID aliasing, fallback, or lossy Number conversion. */
export class MetricStorageAdapter {
  constructor(private readonly storage: MysqlMetricStorage,
    private readonly mode: { read: 'legacy' | 'v2'; write: 'legacy' | 'shadow' | 'v2' } = { read: 'legacy', write: 'legacy' }) {}

  async latest(series: Series, legacyRead: () => Promise<ObservationRow | null>, source: string) {
    if (this.mode.read === 'v2') return this.storage.latest(series);
    const row = await legacyRead();
    return row ? legacyObservation(row, source) : null;
  }

  async write(observation: StoredObservation, definition: MetricDefinition, legacyWrite: () => Promise<void>): Promise<void> {
    if (this.mode.write !== 'v2') await legacyWrite();
    if (this.mode.write !== 'legacy') await this.storage.write(observation, definition);
  }

  async range(series: Series, from: string, to: string, legacyRead: () => Promise<ObservationRow[]>, source: string, limit = 200) {
    if (this.mode.read === 'v2') return this.storage.range(series, from, to, limit);
    return (await legacyRead()).map(row => legacyObservation(row, source));
  }
}
