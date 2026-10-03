import { createHash, randomUUID } from 'node:crypto';
import { redactSensitiveData, stableJson } from '../security/sensitive-data.js';
import type { ResourceRef } from '../resources/types.js';
import type { AnalysisEnvelope } from './analysis-envelope.js';

export interface EvidenceSnapshot {
  schemaVersion: 1; id: string; hash: string; collectedAt: string;
  subject: ResourceRef; authorizationVersion: string; data: unknown;
  gaps: Array<{ code: string; scope?: string }>;
}
export const evidenceHash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');

/** SQL literals are business data. Keep structure but never persist their contents. */
export function redactEvidence(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveData(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(redactEvidence);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /^(sql|sql_text|query|query_text)$/i.test(key) && typeof entry === 'string'
      ? entry.replace(/'(?:''|\\.|[^'\\])*'/g, "'[REDACTED]'").replace(/\b\d+(?:\.\d+)?\b/g, '?')
      : redactEvidence((redactSensitiveData({ [key]: entry }) as Record<string, unknown>)[key]),
  ]));
}
export function freezeEvidence(subject: ResourceRef, authorizationVersion: string, data: unknown): EvidenceSnapshot {
  const safe = JSON.parse(JSON.stringify(redactEvidence(data)));
  const gaps: EvidenceSnapshot['gaps'] = [];
  const scan = (value: unknown, path: string) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'gaps' && Array.isArray(entry)) for (const gap of entry) gaps.push({ code: String(gap?.code ?? 'EVIDENCE_UNAVAILABLE'), scope: path });
      else scan(entry, `${path}/${key}`);
    }
  };
  scan(safe, '');
  return { schemaVersion: 1, id: randomUUID(), hash: evidenceHash(safe), collectedAt: new Date().toISOString(), subject, authorizationVersion, data: safe, gaps };
}

export type ParsedEvidenceRef = { format: 'pointer'; pointer: string; snapshotId?: string }
  | { format: 'hash'; hash: string } | { format: 'observation'; metricId: string; resourceId: number };
export function parseEvidenceRef(ref: string): ParsedEvidenceRef | null {
  const qualified = /^snapshot:([^#]+)#(\/.*)$/.exec(ref);
  const pointer = qualified?.[2] ?? (ref.startsWith('/') ? ref : undefined);
  if (pointer !== undefined) {
    if (/~(?![01])/.test(pointer)) return null;
    return { format: 'pointer', pointer, ...(qualified ? { snapshotId: qualified[1] } : {}) };
  }
  if (/^[a-f0-9]{64}$/i.test(ref)) return { format: 'hash', hash: ref.toLowerCase() };
  const legacy = /^observation:([^:]+):([1-9]\d*)$/.exec(ref);
  if (legacy && Number.isSafeInteger(Number(legacy[2]))) return { format: 'observation', metricId: legacy[1], resourceId: Number(legacy[2]) };
  return null;
}
function pointerValue(root: unknown, pointer: string): { found: boolean; value?: unknown } {
  let value = root;
  for (const part of pointer.slice(1).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!value || typeof value !== 'object' || ['__proto__', 'prototype', 'constructor'].includes(part)
      || !Object.prototype.hasOwnProperty.call(value, part)) return { found: false };
    value = (value as Record<string, unknown>)[part];
  }
  return { found: true, value };
}
export function resolveEvidenceRef(snapshot: EvidenceSnapshot, ref: string): { found: boolean; value?: unknown } {
  const parsed = parseEvidenceRef(ref);
  if (!parsed) return { found: false };
  if (parsed.format === 'pointer') {
    if (parsed.snapshotId && parsed.snapshotId !== snapshot.id) return { found: false };
    return pointerValue(snapshot.data, parsed.pointer);
  }
  let result: { found: boolean; value?: unknown } = { found: false };
  const scan = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, any>;
    if (parsed.format === 'hash' && ['evidenceRef', 'evidence_ref', 'contentHash', 'id'].some(key => item[key]?.toLowerCase?.() === parsed.hash)) result = { found: true, value };
    if (parsed.format === 'observation' && item.metricId === parsed.metricId && item.resource?.id === parsed.resourceId) result = { found: true, value: item.value };
    for (const entry of Object.values(item)) scan(entry);
  };
  scan(snapshot.data); return result;
}
export function bindEnvelope(envelope: AnalysisEnvelope, request: { purpose: string; subject: ResourceRef; evidence?: EvidenceSnapshot; authorizationVersion?: string }):
  { ok: true; verification: 'bound' | 'partial' | 'unknown' } | { ok: false; error: string } {
  if (envelope.subject.type !== request.subject.type || envelope.subject.id !== request.subject.id) return { ok: false, error: 'ANALYSIS_SUBJECT_MISMATCH' };
  // resource_diagnosis intentionally uses the legacy fault_diagnosis storage type.
  if (envelope.analysisType !== request.purpose) return { ok: false, error: 'ANALYSIS_TYPE_MISMATCH' };
  if (request.evidence && (request.evidence.subject?.type !== request.subject.type || request.evidence.subject?.id !== request.subject.id
    || request.evidence.authorizationVersion !== request.authorizationVersion
    || request.evidence.hash !== evidenceHash(request.evidence.data))) return { ok: false, error: 'ANALYSIS_EVIDENCE_SCOPE_MISMATCH' };
  let usable = 0;
  for (const item of envelope.evidenceRefs) {
    const resolved = request.evidence ? resolveEvidenceRef(request.evidence, item.ref) : { found: false };
    if (!resolved.found) return { ok: false, error: 'ANALYSIS_EVIDENCE_REF_INVALID' };
    if (resolved.value !== null && resolved.value !== undefined && !/\/(?:gaps)(?:\/|$)/.test(item.ref)) usable++;
  }
  return { ok: true, verification: !usable ? 'unknown' : request.evidence?.gaps.length ? 'partial' : 'bound' };
}
