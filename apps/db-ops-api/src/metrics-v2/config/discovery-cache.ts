import { createHash } from 'node:crypto';
import { SnmpDiscovery } from '../snmp/collector.js';

/** Bounded, process-local continuity. Eviction/restart resets baselines; never extrapolate lost evidence. */
export class SnmpDiscoveryCache {
  private readonly entries = new Map<number, { fingerprint: string; discovery: SnmpDiscovery }>();
  constructor(private readonly limit = 4096) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('DISCOVERY_CACHE_LIMIT');
  }
  get(id: number, identity: unknown): SnmpDiscovery {
    // The cache retains neither addresses nor decrypted credentials.
    const fingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const previous = this.entries.get(id);
    const entry = previous?.fingerprint === fingerprint ? previous : { fingerprint, discovery: new SnmpDiscovery() };
    this.entries.delete(id); this.entries.set(id, entry);
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return entry.discovery;
  }
  forget(id: number): void { this.entries.delete(id); }
}
