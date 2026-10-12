import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { categoryCounts, dimensionKeys, evaluateOffline, hash, safetyKeys, validateCorpus, validateRubric, type Corpus, type Rubric } from './investigation-eval.ts';

const fixtures = new URL('./fixtures/investigations/', import.meta.url);
const corpus: Corpus = JSON.parse(readFileSync(new URL('cases.json', fixtures), 'utf8'));
const rubric: Rubric = JSON.parse(readFileSync(new URL('judge-rubric.json', fixtures), 'utf8'));
const clone = () => structuredClone(corpus);

test('40 fixed versioned cases retain T01 identities, redacted snapshots and annotations', () => {
  validateCorpus(corpus);
  validateRubric(rubric);
  const source = readFileSync(new URL('../../docs/slide/ai-native-operations/evidence/t01-samples.json', import.meta.url), 'utf8');
  assert.equal(corpus.provenance.sha256, hash(source));
  const baseline: Corpus = JSON.parse(source);
  assert.deepEqual(corpus.samples.map(s => s.id), baseline.samples.map(s => s.id));
  for (const old of baseline.samples) {
    const current = corpus.samples.find(s => s.id === old.id)!;
    for (const e of old.snapshot) assert.deepEqual(current.snapshot.find(item => item.id === e.id), e);
    for (const key of ['allowedFacts', 'supportingEvidenceIds', 'contradictingEvidenceIds', 'forbiddenConclusions', 'expectedNextSteps'] as const) {
      for (const value of old[key]) assert(current[key].includes(value), `${old.id}.${key}: baseline annotation removed`);
    }
    assert.equal(current.version, '1.0.0');
  }
  assert.deepEqual(corpus.counts, categoryCounts);
});

test('offline results expose every annotation and leave every model/safety/soft score unscored', () => {
  const report = evaluateOffline(corpus, rubric);
  assert.equal(report.summary.total, 40);
  assert.equal(report.summary.fixtureValid, 40);
  assert.equal(report.summary.providerCalls, 0);
  assert.equal(report.summary.scored, 0);
  assert.equal(report.summary.unscored, 40);
  assert.equal(report.summary.hardSafetyStatus, 'unscored');
  assert.equal(report.summary.aiQualityGate, 'not_evaluated');
  assert.equal(report.softTargets.observedHumanHelpfulRatio, null);
  assert.equal(report.softTargets.observedFactEvidenceSupportRatio, null);
  for (const [index, row] of report.results.entries()) {
    const sample = corpus.samples[index];
    assert.equal(row.sampleId, sample.id);
    assert.equal(row.sampleVersion, sample.version);
    assert.equal(row.modelEvaluation, 'unscored');
    assert.equal(row.hardSafety.status, 'unscored');
    assert.equal(row.hardSafety.observed, null);
    assert.deepEqual(Object.keys(row.scores), dimensionKeys);
    assert(Object.values(row.scores).every(score => score === null));
    assert.deepEqual(row.allowedFacts, sample.allowedFacts);
    assert.deepEqual(row.supportingEvidence.map(e => e.id), sample.supportingEvidenceIds);
    assert.deepEqual(row.contradictingEvidence.map(e => e.id), sample.contradictingEvidenceIds);
    assert.deepEqual(row.forbiddenConclusions, sample.forbiddenConclusions);
    assert.deepEqual(row.expectedNextSteps, sample.expectedNextSteps);
  }
  assert.deepEqual(evaluateOffline(corpus, rubric), report, 'offline report is deterministic');
});

test('fixture reports preserve denied credential/scope/permission/evidence cases without granting citations', () => {
  const rows = evaluateOffline(corpus, rubric).results;
  for (const id of ['NW-06', 'NG-03', 'NG-05', 'NG-07']) {
    const row = rows.find(r => r.sampleId === id)!;
    assert.equal(row.retrievalExpectation.decision, 'deny');
    assert.deepEqual(row.retrievalExpectation.citationEligibleIds, []);
    assert.equal(row.hardSafety.status, 'unscored', 'offline denial expectation is not live enforcement');
  }
  const forged = rows.find(r => r.sampleId === 'NG-02')!;
  assert(!forged.retrievalExpectation.citationEligibleIds.includes('fabricated-id'));
  assert(forged.forbiddenConclusions.length > 0);
});

const invalidCases: Array<[string, (value: Corpus) => void, RegExp]> = [
  ['missing sample', c => { c.samples.pop(); }, /expected 40/],
  ['duplicate ID', c => { c.samples[1].id = c.samples[0].id; }, /duplicate sample ID/],
  ['wrong category', c => { c.samples[0].category = 'server'; }, /category\/ID mismatch/],
  ['wrong distribution', c => { Object.assign(c.counts, { database: 11 }); }, /expected 12\/6\/6\/8\/8/],
  ['invalid version', c => { c.samples[0].version = ''; }, /version/],
  ['unsupported schema', c => { c.schemaVersion = 2 as 1; }, /schemaVersion/],
  ['wrong subject', c => { c.samples[0].subject = { kind: 'resource', resource: { type: 'server', id: 1 } }; }, /subject\/category mismatch/],
  ['fake success', c => { c.samples[0].runnerStatus = 'passed' as 'not_evaluated'; }, /cannot declare evaluation success/],
  ['extra score', c => { Object.assign(c.samples[0], { modelScore: 1 }); }, /unexpected or missing fields/],
  ['cross-sample reference', c => { c.samples[0].supportingEvidenceIds = [c.samples[1].snapshot[0].id]; }, /DB-01.*reference outside/],
  ['forged citation', c => { c.samples[0].retrievalExpectation.citationEligibleIds.push('fabricated-id'); }, /DB-01.*reference outside/],
  ['duplicate evidence', c => { c.samples[0].snapshot[1].id = c.samples[0].snapshot[0].id; }, /duplicate evidence ID/],
  ['missing counterevidence', c => { c.samples[0].contradictingEvidenceIds = []; }, /contradictingEvidenceIds/],
  ['bad calendar date', c => { c.samples[0].snapshot[0].observedFrom = '2026-02-30T00:00:00.000Z'; }, /invalid UTC timestamp/],
  ['reversed window', c => { c.samples[0].snapshot[0].observedFrom = '2026-10-12T00:00:00.000Z'; }, /invalid observation/],
  ['early collection', c => { c.samples[0].snapshot[0].collectedAt = '2026-10-10T00:00:00.000Z'; }, /invalid observation/],
  ['missing unknown marker', c => { c.samples[0].snapshot[0].quality = 'ok' as 'good'; }, /invalid evidence quality/],
  ['array masquerading as quality', c => { Object.assign(c.samples[0].snapshot[0], { quality: ['good'] }); }, /invalid evidence quality/],
  ['missing next steps', c => { c.samples[0].expectedNextSteps = []; }, /expectedNextSteps/],
  ['missing forbidden claims', c => { c.samples[0].forbiddenConclusions = []; }, /forbiddenConclusions/],
  ['relaxed hard safety', c => { c.samples[0].hardSafetyExpectations.credentialLeaks = 1; }, /hard maximum must be zero/],
  ['denial with eligible citation', c => { const s = c.samples.find(s => s.id === 'NG-05')!; s.retrievalExpectation.citationEligibleIds = [s.snapshot[0].id]; }, /denied retrieval cannot grant citations/],
  ['expired permission allowed', c => { c.samples.find(s => s.id === 'NG-05')!.retrievalExpectation = { decision: 'allow', reason: 'current_fixture_scope', citationEligibleIds: [] }; }, /NG-05.*required denial/],
  ['permission not expired', c => { c.samples.find(s => s.id === 'NG-05')!.snapshot[2].data.expiresAt = '2026-10-11T00:06:00.000Z'; }, /must expire before retrieval/],
];
for (const [name, mutate, expected] of invalidCases) {
  test(`rejects ${name}`, () => {
    const value = clone(); mutate(value);
    assert.throws(() => evaluateOffline(value, rubric), expected);
  });
}

test('hashes change with case/rubric versions and annotations', () => {
  const first = evaluateOffline(corpus, rubric);
  const changed = clone(); changed.samples[0].version = '1.0.1'; changed.samples[0].allowedFacts.push('新增限定事实');
  const updatedRubric = structuredClone(rubric); updatedRubric.version = '1.0.1';
  const next = evaluateOffline(changed, updatedRubric);
  assert.notEqual(next.corpusHash, first.corpusHash);
  assert.notEqual(next.results[0].sampleHash, first.results[0].sampleHash);
  assert.equal(next.results[1].sampleHash, first.results[1].sampleHash);
  assert.notEqual(next.rubricHash, first.rubricHash);
});

test('rubric rejects missing dimensions, anchors or hard items and relaxed hard gates', () => {
  const mutations: Array<(r: Rubric) => void> = [
    r => { r.dimensions.pop(); },
    r => { r.dimensions[0].id = r.dimensions[1].id; },
    r => { r.dimensions[0].anchors['0'] = ''; },
    r => { r.hardSafety.pop(); },
    r => { r.hardSafety[0].maximum = 1 as 0; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(rubric); mutate(invalid);
    assert.throws(() => evaluateOffline(corpus, invalid));
  }
  assert.deepEqual(rubric.hardSafety.map(item => item.id), safetyKeys);
});

test('real CLI uses paths relative to its module from any cwd and returns 40 unscored rows', () => {
  const runner = fileURLToPath(new URL('./investigation-eval.ts', import.meta.url));
  const output = execFileSync(process.execPath, [runner], { cwd: fileURLToPath(fixtures), encoding: 'utf8' });
  const report = JSON.parse(output);
  assert.equal(report.results.length, 40);
  assert.equal(report.summary.unscored, 40);
  const badArgs = spawnSync(process.execPath, [runner, '--responses', 'file.json'], { encoding: 'utf8' });
  assert.equal(badArgs.status, 1);
  assert.match(badArgs.stderr, /Usage/);
  const overwrite = spawnSync(process.execPath, [runner, '--report', fileURLToPath(new URL('cases.json', fixtures))], { encoding: 'utf8' });
  assert.equal(overwrite.status, 1);
  assert.match(overwrite.stderr, /must not overwrite/);
  const invalid = spawnSync(process.execPath, [runner, '--fixtures', fileURLToPath(new URL('judge-rubric.json', fixtures))], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '', 'invalid corpus cannot emit a passing report');
});
