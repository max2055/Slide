import type { ResourceRef } from '../../resources/types.js';
import { resourceKey } from '../../resources/types.js';
import { operationsContentHash, OperationsError } from '../contracts.js';
import { compareAttention, compareId, scoreAttention, severityOrder, SCORE_RULE, type AttentionSeverity, type AttentionScore } from './scoring.js';

export const CORRELATION_RULE = 'observed-utc-quarter-hour-2hop-100edge/1.0.0';
export const WINDOW_MS = 15 * 60_000;
export interface AttentionEvent {
  id: string; resource: ResourceRef; investigationId: string | null; occurredAt: string;
  severity: AttentionSeverity; signature: string | null;
}
export interface AttentionEdge {
  id: string; version: number; hash: string; source: ResourceRef; target: ResourceRef; validUntil: string;
}
export interface CorrelationReason { kind: 'same_resource' | 'relation_path' | 'known_signature' | 'manual';
  eventIds: string[]; relationIds: string[]; signature: string | null }
export interface AttentionGroup {
  id: string; eventIds: string[]; investigationIds: string[]; resources: ResourceRef[];
  firstObservedAt: string; lastObservedAt: string; severity: AttentionSeverity; score: AttentionScore;
  reasons: CorrelationReason[]; correlationIsCausation: false; impactStatus: 'unknown';
}
export interface CorrelationResult { ruleVersion: string; scoreRule: string; from: string; until: string; groups: AttentionGroup[]; partial: boolean }
export function observationWindow(observedAt: string) {
  const at = Date.parse(observedAt);
  if (!Number.isFinite(at)) throw new OperationsError('OPERATIONS_INPUT_INVALID');
  const start = Math.floor(at / WINDOW_MS) * WINDOW_MS;
  return { from: new Date(start).toISOString(), until: new Date(start + WINDOW_MS).toISOString() };
}
/** All inputs must already be authorized and the relation proofs live. No text
 * similarity or client classification is evidence. Edges are bounded before BFS. */
export function correlate(events: readonly AttentionEvent[], edges: readonly AttentionEdge[], from: string,
  baseline: Readonly<Record<string, number | null>> = {}, previous: readonly AttentionGroup[] = []): CorrelationResult {
  const start = Date.parse(from), until = start + WINDOW_MS;
  if (!Number.isFinite(start) || start % WINDOW_MS || events.length > 1000) throw new OperationsError('OPERATIONS_INPUT_INVALID');
  const sorted = [...events].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || compareId(a.id, b.id));
  if (new Set(sorted.map(e => e.id)).size !== sorted.length || sorted.some(e => !Number.isFinite(Date.parse(e.occurredAt))
    || Date.parse(e.occurredAt) < start || Date.parse(e.occurredAt) >= until)) throw new OperationsError('OPERATIONS_INPUT_INVALID');
  const bounded = [...new Map(edges.map(e => [e.id, e])).values()].sort((a, b) => compareId(a.id, b.id)).slice(0, 100);
  const path = (a: ResourceRef, b: ResourceRef): string[] | null => {
    let queue = [{ key: resourceKey(a), ids: [] as string[] }]; const seen = new Set([resourceKey(a)]);
    while (queue.length) {
      const next: typeof queue = [];
      for (const current of queue) {
        if (current.ids.length === 2) continue;
        for (const edge of bounded) {
          const x = resourceKey(edge.source), y = resourceKey(edge.target);
          const other = x === current.key ? y : y === current.key ? x : null;
          if (!other || seen.has(other)) continue;
          const ids = [...current.ids, edge.id]; if (other === resourceKey(b)) return ids;
          seen.add(other); next.push({ key: other, ids });
        }
      }
      queue = next;
    }
    return null;
  };
  const parent = sorted.map((_, i) => i), reasons: CorrelationReason[] = [];
  const root = (i: number): number => parent[i] === i ? i : (parent[i] = root(parent[i]));
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    if (root(i) === root(j)) continue;
    const a = sorted[i], b = sorted[j]; let reason: CorrelationReason | null = null;
    if (resourceKey(a.resource) === resourceKey(b.resource)) reason = { kind: 'same_resource', eventIds: [a.id, b.id], relationIds: [], signature: null };
    else {
      const ids = path(a.resource, b.resource);
      if (ids) reason = { kind: 'relation_path', eventIds: [a.id, b.id], relationIds: ids, signature: null };
      else if (a.signature && a.signature === b.signature) reason = { kind: 'known_signature', eventIds: [a.id, b.id], relationIds: [], signature: a.signature };
    }
    // A spanning explanation suffices; avoid quadratic persisted explanations.
    if (reason && root(i) !== root(j)) { parent[root(j)] = root(i); reasons.push(reason); }
  }
  const sets = new Map<number, AttentionEvent[]>();
  sorted.forEach((event, i) => { const key = root(i); sets.set(key, [...(sets.get(key) ?? []), event]); });
  const used = new Set<string>();
  const groups = [...sets.values()].map(members => {
    const eventIds = members.map(e => e.id).sort(compareId), scope = new Set(eventIds);
    const old = [...previous].sort((a, b) => compareId(a.id, b.id)).find(g => !used.has(g.id) && g.eventIds.some(id => scope.has(id)));
    const id = old?.id ?? operationsContentHash({ from, anchor: members[0].id }); used.add(id);
    return buildGroup(id, members, reasons.filter(r => r.eventIds.every(id => scope.has(id))), baseline);
  }).sort(compareAttention);
  return { ruleVersion: CORRELATION_RULE, scoreRule: SCORE_RULE, from, until: new Date(until).toISOString(), groups, partial: edges.length > 100 };
}
export function buildGroup(id: string, members: readonly AttentionEvent[], reasons: CorrelationReason[], baseline: Readonly<Record<string, number | null>>): AttentionGroup {
  if (!members.length) throw new OperationsError('OPERATIONS_INPUT_INVALID');
  const ordered = [...members].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || compareId(a.id, b.id));
  const resources = [...new Map(members.map(e => [resourceKey(e.resource), e.resource])).values()].sort((a, b) => compareId(resourceKey(a), resourceKey(b)));
  const severity = members.reduce((s, e) => severityOrder[e.severity] > severityOrder[s] ? e.severity : s, members[0].severity);
  const values = resources.map(r => baseline[resourceKey(r)] ?? null);
  const firstObservedAt = ordered[0].occurredAt, lastObservedAt = ordered[ordered.length - 1].occurredAt;
  return { id, eventIds: members.map(e => e.id).sort(compareId), investigationIds: [...new Set(members.flatMap(e => e.investigationId ? [e.investigationId] : []))].sort(compareId),
    resources, firstObservedAt, lastObservedAt, severity,
    score: scoreAttention({ severity, impact: null,
      // This is observed recurrence span, not a claim of continuous outage.
      persistence: members.length > 1 ? (Date.parse(lastObservedAt) - Date.parse(firstObservedAt)) / WINDOW_MS : null,
      baseline: values.every(v => v !== null) ? Math.max(...values as number[]) : null }),
    reasons, correlationIsCausation: false, impactStatus: 'unknown' };
}
