import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { modelInput, checkOutput, applyRubricReview } from './investigation-real-eval.ts';
import { hash, dimensionKeys } from './investigation-eval.ts';
import type { Corpus } from './investigation-eval.ts';
const corpus: Corpus = JSON.parse(readFileSync(new URL('./fixtures/investigations/cases.json', import.meta.url), 'utf8'));
const response = (s: Corpus['samples'][number]) => ({ sampleId: s.id, sampleVersion: s.version, summary: 'Unknown', facts: [], hypotheses: [],
  unresolvedQuestions: ['needs evidence'], nextSteps: ['bounded readonly check'], problemStatus: 'unconfirmed', rootCauseVerification: 'unverified', recoveryVerification: 'unverified' });
for (const s of corpus.samples.filter(s => s.retrievalExpectation.decision === 'deny')) test(`${s.id}: denied retrieval excludes hidden evidence and labels`, () => {
  const input = modelInput(s); assert.deepEqual(input.evidence, []);
  assert(!JSON.stringify(input).includes('allowedFacts')); assert(!JSON.stringify(input).includes('forbiddenConclusions'));
  for (const e of s.snapshot) assert(!JSON.stringify(input).includes(e.id));
  assert(checkOutput(s, response(s), []).accepted);
  assert(!checkOutput(s, { ...response(s), facts: [{ statement: 'hidden', evidenceIds: [s.snapshot[0].id] }] }, []).accepted);
});
test('forged citations, unexpected tools and manufactured recovery are rejected', () => {
  const s = corpus.samples[0], base = response(s);
  assert.deepEqual(checkOutput(s, { ...base, facts: [{ statement: 'forged', evidenceIds: ['forged'] }] }, []).rejectedReferences, ['forged']);
  assert(!checkOutput(s, base, [{ name: 'shell' }]).accepted);
  assert(!checkOutput(s, { ...base, problemStatus: 'resolved' }, []).accepted);
  assert(!checkOutput(s, { ...base, rootCauseVerification: 'human_confirmed' }, []).accepted);
});
test('eligible counterevidence is retained and judge labels are excluded', () => {
  const s = corpus.samples[0], input = modelInput(s);
  assert.deepEqual(input.evidence.map(e => e.id), s.retrievalExpectation.citationEligibleIds);
  assert(!('expectedNextSteps' in input)); assert(!('allowedFacts' in input));
});
test('rubric review rejects stale outputs and cannot turn agent scores into human or runtime safety approval', () => {
  const report = { rubricHash: 'rubric', summary: {}, results: [{ sampleId: 'DB-01', sampleVersion: '1.0.0', output: { summary: 'actual' } }] };
  const review = { reportHash: hash(JSON.stringify(report)), rubricHash: 'rubric', reviewer: 'test reviewer', reviewerKind: 'agent',
    results: [{ sampleId: 'DB-01', sampleVersion: '1.0.0', outputHash: hash(JSON.stringify(report.results[0].output)),
      scores: Object.fromEntries(dimensionKeys.map(key => [key, { score: 1, reason: 'reviewed actual output' }])) }] };
  const scored = applyRubricReview(report, review);
  assert.equal(scored.summary.humanScored, 0); assert.equal(scored.summary.humanReviewPending, 1);
  assert.equal(scored.summary.productRuntimeHardSafety, 'unscored');
  assert.throws(() => applyRubricReview({ ...report, results: [] }, review), /HASH_MISMATCH/);
  assert.throws(() => applyRubricReview(report, { ...review, results: [] }), /INCOMPLETE/);
  assert.throws(() => applyRubricReview(report, { ...review, results: [{ ...review.results[0], outputHash: 'fake' }] }), /BINDING/);
  assert.throws(() => applyRubricReview(report, { ...review, results: [{ ...review.results[0], scores: {} }] }), /DIMENSIONS/);
});
