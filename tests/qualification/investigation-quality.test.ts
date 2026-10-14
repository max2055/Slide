import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { humanReviewPacket } from './investigation-human-review.js';
import { runtimeResult, verifyPriorRuntimeReport } from './investigation-runtime-eval.js';
import { hash } from './investigation-eval.js';
import { applyRubricReview } from './investigation-real-eval.js';
import { validateMachineResult } from '../../apps/db-ops-api/src/investigations/result-schema.js';
const base = new URL('./fixtures/investigations/', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('cases.json', base), 'utf8'));
const rubric = JSON.parse(readFileSync(new URL('judge-rubric.json', base), 'utf8'));
const answer = { summary: '权限和恢复尚未验证', facts: [], hypotheses: [], claims: [], rootCauseVerification: { status: 'unverified' },
  unresolvedQuestions: ['需要有效证据'], recommendations: [], problemStatus: 'unconfirmed' };
test('DB-06/NW-05 authority facts without citations fail the production result contract', () => {
  for (const id of ['DB-06', 'NW-05']) {
    const s = corpus.samples.find((s: any) => s.id === id);
    const unsafe = runtimeResult({ ...answer, facts: [{ statement: 'no tools enabled', evidenceIds: [] }] }, s.subject, 'run', 'model', true);
    assert.equal(validateMachineResult(unsafe, new Set()).ok, false);
    const safe = runtimeResult(answer, s.subject, 'run', 'model', true);
    assert.equal(validateMachineResult(safe, new Set()).ok, true);
    assert.deepEqual(safe.facts, []);
  }
});
test('server metadata cannot repair forged references or promote model recovery', () => {
  const s = corpus.samples[0];
  const forged = runtimeResult({ ...answer, facts: [{ statement: 'forged', evidenceIds: ['invented'] }] }, s.subject, 'run', 'model', false);
  assert.equal(validateMachineResult(forged, new Set(['actual'])).ok, false);
  assert.equal(forged.provenance.usageStatus, 'unavailable');
  assert.equal(validateMachineResult(runtimeResult({ ...answer, problemStatus: 'resolved' }, s.subject, 'run', 'model', false), new Set()).ok, false);
});
test('human packet retains all failures and cannot be imported unsigned or against changed samples', () => {
  const report = { corpusHash: hash(JSON.stringify(corpus)), rubricHash: hash(JSON.stringify(rubric)), results: corpus.samples.map((s: any) => ({
    sampleId: s.id, sampleVersion: s.version, sampleHash: hash(JSON.stringify(s)), output: answer, receipt: { usage: { input: 1 } }, checks: { accepted: !['DB-06', 'NW-05'].includes(s.id) } })) };
  const packet = humanReviewPacket(report, corpus, rubric);
  assert.equal(packet.results.length, 40); assert.equal(packet.status, 'unsigned_unscored');
  assert.equal(packet.results.filter((r: any) => !r.bindingChecks.accepted).length, 2);
  assert.throws(() => applyRubricReview(report, packet), /REVIEWER_REQUIRED/);
  assert.throws(() => applyRubricReview(report, { ...packet, reviewer: 'actual reviewer' }), /TIMESTAMP_REQUIRED/);
  assert.throws(() => applyRubricReview(report, { ...packet, reviewer: 'actual reviewer', reviewedAt: '2026-02-30T00:00:00.000Z' }), /TIMESTAMP_REQUIRED/);
  assert.throws(() => humanReviewPacket({ ...report, results: report.results.slice(1) }, corpus, rubric), /INCOMPLETE/);
  assert.throws(() => humanReviewPacket({ ...report, results: report.results.map((r: any, i: number) => i ? r : { ...r, sampleVersion: '2.0.0' }) }, corpus, rubric), /SAMPLE_MISMATCH/);
});
test('runtime recovery binds original receipts and rejects edited reused results or missing history', () => {
  const directory = mkdtempSync(join(tmpdir(), 't11-report-chain-'));
  try {
    const result = { sample: { id: 'DB-01' }, hardSafety: { acceptedForgedBindings: 0 }, receipts: [{ sequence: 1, usage: { prompt_tokens: 10, completion_tokens: 2 } }] };
    const journal = JSON.stringify({ kind: 'authorization', baseline: { sha256: 'old' } }) + '\n' + JSON.stringify({ kind: 'receipt', sequence: 1, usage: { inputTokens: 10, outputTokens: 2 } }) + '\n';
    const original = { journal, results: [result] };
    assert.equal(verifyPriorRuntimeReport(original, hash(journal)).length, 1);
    assert.throws(() => verifyPriorRuntimeReport({ ...original, results: [{ ...result, receipts: [{ sequence: 2, usage: { prompt_tokens: 10, completion_tokens: 2 } }] }] }, hash(journal)), /UNMEASURED/);
    const text = JSON.stringify(original), path = join(directory, 'prior.json'); writeFileSync(path, text);
    const nextJournal = JSON.stringify({ kind: 'authorization', baseline: { sha256: hash(journal) } }) + '\n';
    const next = { journal: nextJournal, priorReportPath: path, priorReportHash: hash(text), results: [{ ...result, reusedMeasuredRuntimeEvidence: true }] };
    assert.equal(verifyPriorRuntimeReport(next, hash(nextJournal)).length, 1);
    assert.throws(() => verifyPriorRuntimeReport({ ...next, results: [{ ...next.results[0], hardSafety: { acceptedForgedBindings: 1 } }] }, hash(nextJournal)), /RESULT_CHANGED/);
    assert.throws(() => verifyPriorRuntimeReport({ ...next, priorReportHash: 'changed' }, hash(nextJournal)), /SOURCE_HASH/);
  } finally { rmSync(directory, { recursive: true }); }
});
