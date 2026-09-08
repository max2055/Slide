import type { ActorContext } from '../auth/actor-context.js';
import type { Observation, ResourceRef } from '../resources/types.js';
import { resourceDiagnosticService } from '../resources/resource-diagnostic-service.js';
import { evidenceId, sortEvidence, validateEvidenceItem, type EvidenceItem } from './evidence-contract.js';
import { authorizeEvidence, EvidenceStore, evidenceStore, validateEvidenceQuery } from './evidence-store.js';
export interface EvidenceBundleOptions { from?: string; to?: string; limit?: number; correlationId?: string; }
export interface EvidenceBundle { schemaVersion: 1; resource: ResourceRef; generatedAt: string; facts: EvidenceItem[]; inferences: EvidenceItem[]; hypotheses: EvidenceItem[]; gaps: string[]; truncated: boolean; }
type Collector = (actor: ActorContext, ref: ResourceRef, options: { limit: number }) => Promise<Observation[]>;
export class EvidenceService {
  constructor(private readonly store: EvidenceStore = evidenceStore, private readonly collect: Collector = (actor, ref, options) => resourceDiagnosticService.getObservations(actor, ref, options), private readonly clock: () => Date = () => new Date()) {}
  async getBundle(actor: ActorContext, ref: ResourceRef, options: EvidenceBundleOptions = {}): Promise<EvidenceBundle> {
    authorizeEvidence(actor, ref);
    const now = this.clock();
    const query = { from: options.from ?? new Date(now.getTime() - 86400_000).toISOString(), to: options.to ?? now.toISOString(), limit: options.limit ?? 100, correlationId: options.correlationId };
    validateEvidenceQuery(query);
    const gaps = new Set<string>();
    const fresh: EvidenceItem[] = [];
    // Explicit historical windows only read persisted evidence.
    if (options.from === undefined && options.to === undefined && options.correlationId === undefined) {
      let observations: Observation[] = [];
      try { observations = await this.collect(actor, ref, { limit: query.limit }); }
      catch { gaps.add('OBSERVATIONS_UNAVAILABLE'); }
      for (const observation of observations.slice(0, query.limit)) {
        if (observation.resource.type !== ref.type || observation.resource.id !== ref.id) { gaps.add('OBSERVATION_INVALID'); continue; }
        const observedAt = observation.observedAt instanceof Date && Number.isFinite(observation.observedAt.getTime()) ? observation.observedAt : null;
        const validUntil = observation.validUntil instanceof Date && Number.isFinite(observation.validUntil.getTime()) ? observation.validUntil : null;
        if (!observedAt || !validUntil || observedAt > now) { gaps.add('OBSERVATION_TIME_UNKNOWN'); continue; }
        const content = { schemaVersion: 1 as const, kind: 'observation', status: 'fact' as const, subject: { resource: ref }, quality: observation.value === null ? 'unknown' as const : observation.quality,
          observedAt: observedAt.toISOString(), validUntil: validUntil.toISOString(), source: observation.source, provenance: observation.source,
          correlationId: actor.requestId, ...(observation.dimensions ? { dimensions: observation.dimensions } : {}),
          payload: { metricId: observation.metricId, value: observation.value, ...(observation.reason ? { reason: observation.reason } : {}) } };
        const item = { ...content, id: evidenceId(content) };
        if (!validateEvidenceItem(item)) { gaps.add('OBSERVATION_INVALID'); continue; }
        await this.store.put(actor, item); fresh.push(item);
      }
    }
    const stored = await this.store.query(actor, ref, query);
    const candidates = sortEvidence([...new Map([...stored, ...fresh].map(item => [item.id, item])).values()]);
    const items = candidates.filter(item => item.observedAt >= query.from && item.observedAt <= query.to).slice(0, query.limit);
    if (!items.length) gaps.add('NO_EVIDENCE_IN_WINDOW');
    for (const item of items) {
      if (Date.parse(item.validUntil) <= now.getTime()) gaps.add('EVIDENCE_STALE');
      if (item.quality !== 'good') gaps.add('EVIDENCE_QUALITY_' + item.quality.toUpperCase());
    }
    return { schemaVersion: 1, resource: ref, generatedAt: now.toISOString(), facts: items.filter(item => item.status === 'fact'), inferences: items.filter(item => item.status === 'inference'), hypotheses: items.filter(item => item.status === 'hypothesis'), gaps: [...gaps].sort(), truncated: candidates.length >= query.limit };
  }
  async getItem(actor: ActorContext, ref: ResourceRef, id: string): Promise<EvidenceItem | null> { return this.store.getById(actor, ref, id); }
}
export const evidenceService = new EvidenceService();
