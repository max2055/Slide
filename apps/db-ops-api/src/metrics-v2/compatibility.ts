import type { MetricDefinition } from '../contracts/metrics-v2/definitions.js';
import type { ObservationRow } from '../resources/observation-service.js';
import type { MysqlMetricStorage, Series, StoredObservation } from './storage.js';
import type { PoolConnection } from 'mysql2/promise';
import type { RolloutControl, Ticket } from './rollout/control.js';

export function legacyObservation(row: ObservationRow, source: string) {
  return { ...row, provenance: { contract: 'legacy' as const, source, semantic_version: null, config_revision: null },
    quality: { status: 'unknown' as const, reason: 'legacy_unknown' as const }, accuracy: 'unknown' as const };
}

/** Explicit opt-in boundary. No automatic ID aliasing, fallback, or lossy Number conversion. */
export class MetricStorageAdapter {
  constructor(private readonly storage: MysqlMetricStorage,
    private readonly mode: { read: 'legacy' | 'v2'; write: 'legacy' | 'shadow' | 'v2' } = { read: 'legacy', write: 'legacy' },
    private readonly controlled?: { control: RolloutControl; ticket: Ticket }) {}

  async latest(series: Series, legacyRead: (connection?: PoolConnection) => Promise<ObservationRow | null>, source: string) {
    if (this.controlled) return this.controlled.control.latest(series, async connection => {
      const row = await legacyRead(connection); return row ? legacyObservation(row, source) : null;
    });
    if (this.mode.read === 'v2') return this.storage.latest(series);
    const row = await legacyRead();
    return row ? legacyObservation(row, source) : null;
  }

  async write(observation: StoredObservation, definition: MetricDefinition, legacyWrite: (connection?: PoolConnection) => Promise<void>): Promise<void> {
    if (this.controlled) {
      // Shadow never invokes the old formal writer or changes the formal pointer.
      if (this.mode.write === 'shadow') return this.storage.write(observation, definition);
      return this.controlled.control.publish(observation, definition, this.controlled.ticket, legacyWrite);
    }
    if (this.mode.write !== 'v2') await legacyWrite();
    if (this.mode.write !== 'legacy') await this.storage.write(observation, definition);
  }

  async range(series: Series, from: string, to: string, legacyRead: (connection?: PoolConnection) => Promise<ObservationRow[]>, source: string, limit = 200) {
    if (this.controlled) return this.controlled.control.range(series, from, to,
      async c => (await legacyRead(c)).map(row => legacyObservation(row, source)), limit);
    if (this.mode.read === 'v2') return this.storage.range(series, from, to, limit);
    return (await legacyRead()).map(row => legacyObservation(row, source));
  }
}
