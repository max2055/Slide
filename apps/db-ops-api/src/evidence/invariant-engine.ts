import type { EvidenceItem } from './evidence-contract.js';
import { canonicalDimensions } from '../resources/types.js';

export interface InvariantRule { id: string; version: number; metricId: string; min?: number; max?: number; dimensions?: Record<string, string> }
export interface InvariantResult { ruleId: string; version: number; status: 'pass' | 'fail' | 'unknown'; evidenceRefs: string[]; reason: string }
export const dimensionsKey = (dimensions?: Record<string, string>) => JSON.stringify(canonicalDimensions(dimensions) ?? {});
export function isFreshNumeric(item: EvidenceItem, now: number): boolean {
  return item.status === 'fact' && item.quality === 'good' && typeof item.payload.value === 'number' && Number.isFinite(item.payload.value)
    && Date.parse(item.observedAt) <= now && Date.parse(item.validUntil) > now;
}
export function evaluateInvariants(items: EvidenceItem[], rules: InvariantRule[], now = Date.now()): InvariantResult[] {
  if (rules.length > 100) throw new Error('INVARIANT_RULE_INVALID');
  return rules.map(rule => {
    if (!rule.id || !Number.isSafeInteger(rule.version) || rule.version < 1 || !rule.metricId
      || (rule.min === undefined && rule.max === undefined) || (rule.min !== undefined && !Number.isFinite(rule.min))
      || (rule.max !== undefined && !Number.isFinite(rule.max)) || (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max)) throw new Error('INVARIANT_RULE_INVALID');
    const item = items.filter(item => item.payload.metricId === rule.metricId && dimensionsKey(item.dimensions) === dimensionsKey(rule.dimensions))
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
    if (!item || !isFreshNumeric(item, now)) return { ruleId: rule.id, version: rule.version, status: 'unknown', evidenceRefs: item ? [item.id] : [], reason: 'FRESH_NUMERIC_EVIDENCE_REQUIRED' };
    const value = item.payload.value as number;
    const pass = (rule.min === undefined || value >= rule.min) && (rule.max === undefined || value <= rule.max);
    return { ruleId: rule.id, version: rule.version, status: pass ? 'pass' : 'fail', evidenceRefs: [item.id], reason: pass ? 'CONSTRAINT_SATISFIED' : 'CONSTRAINT_VIOLATED' };
  });
}
