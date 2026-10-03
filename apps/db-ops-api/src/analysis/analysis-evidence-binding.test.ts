import { describe, expect, it } from 'vitest';
import { freezeEvidence } from './analysis-evidence.js';
import { AnalysisDispatchStore, type OwnedAnalysis } from './analysis-dispatch-store.js';

const envelope = { schemaVersion: 1, analysisType: 'fault_diagnosis', subject: { type: 'instance', id: 42 }, conclusions: ['finding'], hypotheses: [], evidenceRefs: [], confidence: .5, recommendations: [], displayMarkdown: 'finding', provenance: { modelVersion: 'forged', promptVersion: 'forged', toolVersions: {} }, createdAt: '2026-10-03T00:00:00Z' };
const owned = { analysisId: 1, request: { purpose: 'fault_diagnosis', subject: envelope.subject, authorizationVersion: 'a1', evidence: freezeEvidence(envelope.subject as any, 'a1', { database: { qps: 7 } }) } } as unknown as OwnedAnalysis;
// Database work is deliberately forbidden: invalid completion must fail before it.
const store = new AnalysisDispatchStore(() => { throw new Error('UNVALIDATED_DATABASE_WRITE'); });
describe('task-bound analysis completion', () => {
  it('rejects the wrong analysis type before writing', async () => {
    await expect(store.completeEnvelope(owned, { ...envelope, analysisType: 'topsql_analysis' })).resolves.toMatchObject({ success: false, error: 'ANALYSIS_TYPE_MISMATCH' });
  });
  it.each(['/database/madeUp', 'observation:cpu:99', 'a'.repeat(64), 'snapshot:other#/database/qps'])('rejects fabricated or foreign evidence %s before writing', async ref => {
    await expect(store.completeEnvelope(owned, { ...envelope, evidenceRefs: [{ ref, summary: 'claimed' }] })).resolves.toMatchObject({ success: false, error: 'ANALYSIS_EVIDENCE_REF_INVALID' });
  });
  it('rejects a wrong subject', async () => {
    await expect(store.completeEnvelope(owned, { ...envelope, subject: { type: 'instance', id: 43 } })).resolves.toMatchObject({ success: false, error: 'ANALYSIS_SUBJECT_MISMATCH' });
  });
});

import { bindEnvelope, parseEvidenceRef, resolveEvidenceRef } from './analysis-evidence.js';
import { aiAnalysisDatabaseService } from '../ai-analysis-database-service.js';
import { dbConnection } from '../db-connection.js';
import { afterEach, vi } from 'vitest';
const hash = 'c'.repeat(64);
afterEach(() => vi.restoreAllMocks());
describe('frozen references and access', () => {
  const data = { database: { qps: 7, 'a/b': { '~': 9 } }, observations: [{ resource: envelope.subject, metricId: 'cpu', value: 90 }], semantic: { evidenceRef: hash, value: 12 }, absent: null, gaps: [] };
  const snapshot = freezeEvidence(envelope.subject as any, 'a1', data);
  const request = { purpose: 'fault_diagnosis', subject: envelope.subject as any, authorizationVersion: 'a1', evidence: snapshot };
  it.each(['/database/qps', '/database/a~1b/~0', 'observation:cpu:42', hash])('resolves existing historical ref %s only inside this snapshot', ref => {
    expect(resolveEvidenceRef(snapshot, ref).found).toBe(true);
    expect(bindEnvelope({ ...envelope, evidenceRefs: [{ ref, summary: 'observed' }] } as any, request)).toEqual({ ok: true, verification: 'bound' });
  });
  it('supports qualified refs and rejects another task containing an actual existing ref', () => {
    expect(resolveEvidenceRef(snapshot, `snapshot:${snapshot.id}#/database/qps`)).toEqual({ found: true, value: 7 });
    const other = freezeEvidence(envelope.subject as any, 'a1', { database: { qps: 99 } });
    expect(resolveEvidenceRef(other, `snapshot:${snapshot.id}#/database/qps`).found).toBe(false);
    expect(resolveEvidenceRef(other, hash).found).toBe(false);
    data.database.qps = 123;
    expect(resolveEvidenceRef(snapshot, '/database/qps').value).toBe(7);
  });
  it('detects altered content or an altered permission scope', () => {
    expect(bindEnvelope(envelope as any, { ...request, authorizationVersion: 'other' })).toMatchObject({ ok: false, error: 'ANALYSIS_EVIDENCE_SCOPE_MISMATCH' });
    expect(bindEnvelope(envelope as any, { ...request, evidence: { ...snapshot, data: { qps: 999 } } })).toMatchObject({ ok: false, error: 'ANALYSIS_EVIDENCE_SCOPE_MISMATCH' });
  });
  it.each(['/__proto__', '/database/~2', 'observation:cpu:0', 'unknown-format'])('does not resolve malformed refs %s', ref => expect(resolveEvidenceRef(snapshot, ref).found).toBe(false));
  it('missing evidence saves only unknown, and gaps never count as proof', () => {
    expect(bindEnvelope(envelope as any, request)).toMatchObject({ ok: true, verification: 'unknown' });
    expect(bindEnvelope({ ...envelope, evidenceRefs: [{ ref: '/absent', summary: 'null' }] } as any, request)).toMatchObject({ verification: 'unknown' });
    const partial = freezeEvidence(envelope.subject as any, 'a1', { qps: 7, gaps: [{ code: 'HOST_UNAVAILABLE' }] });
    expect(bindEnvelope({ ...envelope, evidenceRefs: [{ ref: '/qps', summary: 'qps' }] } as any, { ...request, evidence: partial })).toMatchObject({ verification: 'partial' });
    expect(bindEnvelope({ ...envelope, evidenceRefs: [{ ref: '/gaps/0', summary: 'gap' }] } as any, { ...request, evidence: partial })).toMatchObject({ verification: 'unknown' });
  });
  it('redacts SQL literals, secrets and preserves acquisition times', () => {
    const frozen = freezeEvidence(envelope.subject as any, 'a1', { sql: "SELECT * FROM t WHERE email='alice@example.invalid' AND id=123", password: 'fake-secret', observedAt: new Date('2026-10-03T00:00:00Z') });
    expect(JSON.stringify(frozen)).not.toContain('alice@example.invalid');
    expect(JSON.stringify(frozen)).not.toContain('fake-secret');
    expect((frozen.data as any).observedAt).toBe('2026-10-03T00:00:00.000Z');
  });
  it('serves the original snapshot only to the originating current authorization scope', async () => {
    const actor = { userId: 7, username: 'op', roles: [], permissions: ['ai:view'], sessionVersion: 1, instanceScopes: { 42: 'read-only' as const }, requestId: 'test' };
    const { analysisAuthorizationVersion } = await import('./analysis-identity.js');
    const permitted = freezeEvidence(envelope.subject as any, analysisAuthorizationVersion(actor), data);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: async () => [[{ request_snapshot: JSON.stringify({ actor, authorizationVersion: permitted.authorizationVersion, subject: envelope.subject, evidence: permitted }) }]] } as any);
    expect(await aiAnalysisDatabaseService.getEvidenceSnapshot(1, actor)).toEqual(permitted);
    expect(await aiAnalysisDatabaseService.getEvidenceSnapshot(1, { ...actor, userId: 8 })).toBeNull();
    expect(await aiAnalysisDatabaseService.getEvidenceSnapshot(1, { ...actor, instanceScopes: {} })).toBeNull();
    expect(await aiAnalysisDatabaseService.getEvidenceSnapshot(1, { ...actor, sessionVersion: 2 })).toBeNull();
  });
});

describe('uncertain evidence quality', () => {
  it('stale and missing observations remain unknown even when their pointer or hash exists', () => {
    const evidence = freezeEvidence(envelope.subject as any, 'a1', { stale: { value: 90, freshness: 'stale', sources: [{ id: hash }] }, missing: { value: null, quality: { status: 'unknown' } } });
    for (const ref of ['/stale/value', hash, '/missing']) expect(bindEnvelope({ ...envelope, evidenceRefs: [{ ref, summary: 'observation' }] } as any, { purpose: 'fault_diagnosis', subject: envelope.subject as any, authorizationVersion: 'a1', evidence })).toMatchObject({ verification: 'unknown' });
  });
});
