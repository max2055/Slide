import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { readFileSync } from 'node:fs';
import {
  InvestigationSubjectSchema, InvestigationRunSchema, InvestigationStatesSchema,
  InvestigationProfileSchema, InvestigationRecoveryVerificationSchema,
  INVESTIGATION_ERROR_STATUS, INVESTIGATION_PERMISSION_RULES,
  validateOperationalEvent, validateInvestigationStreamEvent, validateInvestigationResult,
  validateInvestigationClosure, validateInvestigationProfile, projectInvestigationRun,
  readInvestigationResult,
  validateInvestigationRunTransition,
} from './contracts.js';
import { buildClientTypes, buildOpenApiDocument } from '../contracts/generate-public-api.js';

const now = '2026-10-11T00:00:00.000Z';
const later = '2026-10-11T00:05:00.000Z';
const subject = { kind: 'resource', resource: { type: 'instance', id: 42 } };
const verification = { method: 'recheck bounded metrics', from: now, to: later, evidenceIds: ['e-1'], verifiedAt: later, verifiedBy: 7 };
const bindings = new Set(['e-1', 'e-2']);
const result = {
  schemaVersion: 2, subject, summary: 'CPU observed; cause unresolved',
  facts: [{ statement: 'CPU 95%', evidenceIds: ['e-1'] }],
  hypotheses: [{ statement: 'Workload changed', status: 'unknown', supportingEvidenceIds: [], contradictingEvidenceIds: ['e-2'] }],
  claims: [{ statement: 'QPS did not increase', kind: 'fact', supportingEvidenceIds: ['e-2'], contradictingEvidenceIds: [] }],
  rootCauseVerification: { status: 'unverified' }, unresolvedQuestions: ['Which process consumed CPU?'],
  recommendations: [{ action: 'Inspect bounded process metrics', priority: 'medium' }],
  problemStatus: 'unconfirmed', provenance: { modelVersion: 'fixture', promptVersion: 'v1', toolVersions: { metrics: '1' }, usageStatus: 'unavailable' }, createdAt: now,
};
const profile = {
  id: 'ops', version: 1, responsibility: 'Read infrastructure evidence', supportedSubjectKinds: ['resource'],
  modelScene: 'fault_diagnosis', prompt: { version: 'v1', hash: 'a'.repeat(64) },
  skills: [{ id: 'metrics', version: '1', hash: 'b'.repeat(64) }], toolAllowlist: ['metrics.read'],
  outputSchemaVersion: 2, resourceBoundary: 'all_required_scopes', readonly: true,
  budget: { deadlineMs: 120000, maxToolCalls: 20, maxProviderAttempts: 8, maxTokens: 32000, maxRows: 100, maxBytes: 100000, maxWindowMs: 3600000 }, outputLanguage: 'zh-CN',
};

describe('Investigation subject and independent states', () => {
  it.each(['instance', 'server', 'network_device'])('accepts real %s refs', type => {
    expect(Value.Check(InvestigationSubjectSchema, { kind: 'resource', resource: { type, id: 1 } })).toBe(true);
  });
  it('accepts platform without a fake infrastructure ID', () => {
    expect(Value.Check(InvestigationSubjectSchema, { kind: 'platform', component: 'api', releaseId: 'release-1' })).toBe(true);
  });
  it.each([
    { kind: 'platform', component: 'api', resource: { type: 'instance', id: 1 } },
    { kind: 'resource', resource: { type: 'database', id: 1 } },
    { kind: 'resource', resource: { type: 'instance', id: 0 } },
    { kind: 'resource', resource: { type: 'server', id: 1.5 } },
    { kind: 'platform', component: ' ' },
    { type: 'instance', id: 1 },
  ])('rejects malformed/disguised subjects %j', value => {
    expect(Value.Check(InvestigationSubjectSchema, value)).toBe(false);
  });
  it.each(['running', 'completed', 'partial', 'failed', 'cancelled', 'timed_out'])('keeps Run state %s', state => {
    expect(Value.Check(InvestigationRunSchema, { state })).toBe(true);
    expect(projectInvestigationRun({ state })).toBe(state);
  });
  it('rejects queued/unknown/success in stored Run and never projects unknown as success', () => {
    for (const state of ['queued', 'unknown', 'success']) expect(Value.Check(InvestigationRunSchema, { state })).toBe(false);
    expect(projectInvestigationRun({ state: 'partial', resolution: 'outcome_unknown' })).toBe('unknown');
    expect(() => projectInvestigationRun({ state: 'completed', resolution: 'outcome_unknown' })).toThrow('INVESTIGATION_INPUT_INVALID');
    expect(Value.Check(InvestigationStatesSchema, { execution: 'completed', lifecycle: 'waiting', problemStatus: 'unconfirmed' })).toBe(true);
    expect(Value.Check(InvestigationStatesSchema, { execution: 'queued', lifecycle: 'open', problemStatus: 'in_progress' })).toBe(true);
  });
  it('refuses unknown to completed and any rewrite of a terminal Run', () => {
    const unknown = { state: 'partial', resolution: 'outcome_unknown' };
    expect(validateInvestigationRunTransition({ state: 'running' }, unknown).ok).toBe(true);
    expect(validateInvestigationRunTransition(unknown, { state: 'completed' }).ok).toBe(false);
    expect(validateInvestigationRunTransition(unknown, { state: 'partial', resolution: 'known' }).ok).toBe(false);
    expect(validateInvestigationRunTransition(unknown, unknown).ok).toBe(true);
    for (const state of ['completed', 'partial', 'failed', 'cancelled', 'timed_out']) {
      expect(validateInvestigationRunTransition({ state }, { state: 'running' }).ok).toBe(false);
    }
  });
});

describe('Recovery, binding and result versions', () => {
  it('requires method, observation window, current bound evidence and authenticated verifier for resolved', () => {
    expect(validateInvestigationClosure({ lifecycle: 'closed', problemStatus: 'resolved' }, bindings).ok).toBe(false);
    expect(validateInvestigationClosure({ lifecycle: 'closed', problemStatus: 'resolved', verification }, bindings).ok).toBe(true);
    for (const invalid of [{ ...verification, method: ' ' }, { ...verification, evidenceIds: [] }, { ...verification, from: later, to: now }, { ...verification, verifiedBy: 0 }, { ...verification, verifiedAt: now }]) {
      expect(validateInvestigationClosure({ lifecycle: 'closed', problemStatus: 'resolved', verification: invalid }, bindings).ok).toBe(false);
    }
    expect(Value.Check(InvestigationRecoveryVerificationSchema, { ...verification, verifiedAt: 'yesterday' })).toBe(false);
    expect(validateInvestigationClosure({ lifecycle: 'closed', problemStatus: 'resolved', verification }).ok).toBe(false);
  });
  it('allows not_applicable without fabricating recovery', () => {
    expect(validateInvestigationClosure({ lifecycle: 'closed', problemStatus: 'not_applicable' }).ok).toBe(true);
  });
  it('accepts scoped v2 results and rejects fabricated or expired evidence IDs', () => {
    expect(validateInvestigationResult(result, bindings)).toEqual({ ok: true, value: result });
    expect(validateInvestigationResult({ ...result, subject: { kind: 'platform', component: 'api' } }, bindings).ok).toBe(true);
    expect(validateInvestigationResult(result).ok).toBe(false);
    expect(validateInvestigationResult({ ...result, facts: [{ statement: 'Fake fact', evidenceIds: ['fabricated'] }] }, bindings).ok).toBe(false);
    expect(validateInvestigationResult({ ...result, claims: [{ ...result.claims[0], supportingEvidenceIds: [] }] }, bindings).ok).toBe(false);
    expect(validateInvestigationResult({ ...result, rootCauseVerification: { status: 'bound' } }, bindings).ok).toBe(false);
    expect(validateInvestigationResult({ ...result, problemStatus: 'resolved' }, bindings).ok).toBe(false);
    expect(validateInvestigationResult({ ...result, problemStatus: 'resolved', recoveryVerification: verification }, bindings).ok).toBe(true);
    expect(validateInvestigationResult({ ...result, rootCauseVerification: { status: 'human_confirmed', ...verification } }, bindings).ok).toBe(true);
    expect(validateInvestigationResult({ ...result, rootCauseVerification: { status: 'experimentally_verified' } }, bindings).ok).toBe(false);
  });
  it('reads v1 as v1 without manufacturing root cause verification or new facts', () => {
    const v1 = { schemaVersion: 1, analysisType: 'alert_rca', subject: { type: 'instance', id: 42 }, conclusions: [], hypotheses: [], evidenceRefs: [], confidence: 0.2, recommendations: [], displayMarkdown: 'Old report', provenance: { modelVersion: 'fixture', promptVersion: 'v1', toolVersions: {} }, verification: 'bound', createdAt: now };
    const view = readInvestigationResult(v1);
    expect(view).toEqual({ kind: 'v1', value: v1 });
    if (view.kind === 'v1') expect(view.value).toBe(v1);
    expect(view).not.toHaveProperty('rootCauseVerification');
    expect(readInvestigationResult(result, '', bindings)).toEqual({ kind: 'v2', value: result });
    expect(readInvestigationResult(null, 'Legacy text')).toEqual({ kind: 'legacy', displayMarkdown: 'Legacy text' });
    expect(readInvestigationResult({ ...result, schemaVersion: 3 }, 'Fallback')).toEqual({ kind: 'legacy', displayMarkdown: 'Fallback' });
  });
});

describe('Operational and observation envelopes', () => {
  const event = { schemaVersion: 1, id: 'event-1', source: 'api', sourceEventId: 'request-1', kind: 'api.error', subject: { kind: 'platform', component: 'api' }, occurredAt: now, receivedAt: later, severity: 'error', summary: 'HTTP 500', origin: 'user_operation' };
  it('keeps occurred/received time separate and carries recursion origin', () => {
    expect(validateOperationalEvent(event).ok).toBe(true);
    expect(validateOperationalEvent({ ...event, origin: 'investigation_engine' }).ok).toBe(true);
    expect(validateOperationalEvent({ ...event, receivedAt: '2026-02-30T00:00:00.000Z' }).ok).toBe(false);
    expect(validateOperationalEvent({ ...event, occurredAt: '2026-10-11T08:00:00+08:00' }).ok).toBe(false);
    expect(validateOperationalEvent({ ...event, commitSha: 'main' }).ok).toBe(false);
  });
  it('validates typed payloads and reuses the shared Parts validator', () => {
    const base = { schemaVersion: 1, sequence: 1, investigationId: 'inv-1', runId: 'run-1', occurredAt: now };
    expect(validateInvestigationStreamEvent({ ...base, type: 'run.terminal', payload: { state: 'partial', resolution: 'outcome_unknown' } }).ok).toBe(true);
    expect(validateInvestigationStreamEvent({ ...base, type: 'run.terminal', payload: { state: 'completed', resolution: 'outcome_unknown' } }).ok).toBe(false);
    expect(validateInvestigationStreamEvent({ ...base, sequence: 0, type: 'run.started', payload: {} }).ok).toBe(false);
    expect(validateInvestigationStreamEvent({ ...base, runId: undefined, type: 'run.started', payload: {} }).ok).toBe(false);
    expect(validateInvestigationStreamEvent({ ...base, type: 'run.terminal', payload: { state: 'running' } }).ok).toBe(false);
    expect(validateInvestigationStreamEvent({ schemaVersion: 1, sequence: 1, investigationId: 'inv-1', occurredAt: now, requestId: 'request-1', type: 'request.accepted', payload: { jobId: 'job-1', version: 1 } }).ok).toBe(true);
    expect(validateInvestigationStreamEvent({ ...base, type: 'evidence.added', payload: { evidenceId: 'e-1' } }).ok).toBe(true);
    expect(validateInvestigationStreamEvent({ ...base, type: 'investigation.changed', payload: { version: 2, lifecycle: 'waiting', problemStatus: 'unconfirmed' } }).ok).toBe(true);
    const frame = { version: 1, runId: 'run-1', attempt: 0, sequence: 0, operations: [{ type: 'run.status', phase: 'tools' }] };
    expect(validateInvestigationStreamEvent({ ...base, type: 'parts.operation', payload: frame }).ok).toBe(true);
    expect(validateInvestigationStreamEvent({ ...base, type: 'parts.operation', payload: { ...frame, runId: 'other' } }).ok).toBe(false);
    expect(validateInvestigationStreamEvent({ ...base, type: 'parts.operation', payload: { ...frame, operations: [{ type: 'tool.done' }] } }).ok).toBe(false);
    expect(validateInvestigationStreamEvent({ ...base, type: 'result.persisted', payload: { resultId: 'r1', resultVersion: 1, schemaVersion: 2 } }).ok).toBe(true);
    expect(validateInvestigationStreamEvent({ ...base, type: 'result.persisted', payload: { state: 'completed' } }).ok).toBe(false);
  });
});

describe('Profile and permission contract', () => {
  it('requires finite read-only budgets and rejects caller authority/credentials', () => {
    expect(validateInvestigationProfile(profile).ok).toBe(true);
    for (const value of [{ ...profile, readonly: false }, { ...profile, apiKey: 'forbidden' }, { ...profile, prompt: { version: '1', hash: 'not-a-hash' } }, { ...profile, budget: { ...profile.budget, maxTokens: 0 } }, { ...profile, budget: { ...profile.budget, deadlineMs: Infinity } }, { ...profile, toolAllowlist: ['*'] }]) {
      expect(validateInvestigationProfile(value).ok).toBe(false);
    }
    expect(validateInvestigationProfile({ ...profile, supportedSubjectKinds: ['platform'] }).ok).toBe(false);
    expect(validateInvestigationProfile({ ...profile, modelScene: 'invented_scene' }).ok).toBe(false);
    expect(Value.Check(InvestigationProfileSchema, { ...profile, tools: ['shell'] })).toBe(false);
  });
  it('fixes server-enforced intersection and all-resource visibility without relaxing Chat shares', () => {
    expect(INVESTIGATION_PERMISSION_RULES).toMatchObject({ toolAuthority: ['profile_allowlist', 'live_actor_grants', 'investigation_scope', 'live_tool_policy'], visibility: 'all_required_scopes', revalidate: ['admission', 'execution', 'tool_call', 'model_call', 'subscription', 'content_read'], ordinaryChatReadShareAllowsAppend: false, serviceActorMayInheritAdmin: false, modelMayGrantAuthority: false });
    expect(INVESTIGATION_ERROR_STATUS).toMatchObject({ INVESTIGATION_INPUT_INVALID: 400, INVESTIGATION_OPERATION_FORBIDDEN: 403, INVESTIGATION_NOT_FOUND: 404, INVESTIGATION_ACTIVE_REQUEST: 409, PROFILE_SUBJECT_UNSUPPORTED: 422, INVESTIGATION_QUEUE_UNAVAILABLE: 503 });
  });
  it('publishes the same schemas/types without claiming unimplemented endpoints', () => {
    const document = buildOpenApiDocument() as { components: { schemas: Record<string, unknown> }; paths: Record<string, unknown> };
    expect(document.components.schemas).toHaveProperty('InvestigationSubject');
    expect(document.paths).not.toHaveProperty('/api/investigations');
    expect(buildClientTypes()).toContain('export type InvestigationSubject =');
    expect(buildClientTypes()).toContain('ProjectionFrame');
  });
});

describe('Fixed evaluation sample handoff', () => {
  it('provides 40 unique, shaped subjects and internally consistent redacted snapshots in the planned proportions', () => {
    const index = JSON.parse(readFileSync(new URL('../../../../docs/slide/ai-native-operations/evidence/t01-samples.json', import.meta.url), 'utf8'));
    expect(index.samples).toHaveLength(40);
    expect(new Set(index.samples.map(sample => sample.id)).size).toBe(40);
    for (const [category, count] of Object.entries(index.counts)) {
      expect(index.samples.filter(sample => sample.category === category)).toHaveLength(count as number);
    }
    for (const sample of index.samples) {
      expect(Value.Check(InvestigationSubjectSchema, sample.subject)).toBe(true);
      expect(sample.fixtureKind).toBe('synthetic_redacted');
      expect(sample.runnerStatus).toBe('not_evaluated');
      const ids = new Set(sample.snapshot.map(evidence => evidence.id));
      for (const ref of [...sample.supportingEvidenceIds, ...sample.contradictingEvidenceIds]) expect(ids.has(ref)).toBe(true);
      for (const field of ['allowedFacts', 'forbiddenConclusions', 'expectedNextSteps']) expect(sample[field].length).toBeGreaterThan(0);
      expect(Object.values(sample.hardSafetyExpectations)).toEqual([0, 0, 0, 0]);
    }
  });
});
